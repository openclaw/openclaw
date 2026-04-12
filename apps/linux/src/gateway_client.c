/*
 * gateway_client.c
 *
 * Gateway client orchestrator for the OpenClaw Linux Companion App.
 *
 * Coordinates config resolution, HTTP health checking, and WebSocket
 * lifecycle into a unified runtime state published to the state machine.
 *
 * After this module is initialized, the runtime source of truth for
 * gateway reachability and protocol status is the native HTTP/WebSocket
 * client, while systemd remains only the service lifecycle/control source.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "gateway_client.h"
#include "gateway_config.h"
#include "gateway_http.h"
#include "gateway_rpc.h"
#include "gateway_ws.h"
#include "json_access.h"
#include "state.h"
#include "log.h"
#include "test_seams.h"
#include <string.h>
#include <gio/gio.h>

typedef struct {
    guint generation;
    gchar *url;
} GatewayHealthContext;

typedef enum {
    DEP_REFRESH_MODELS = 1,
    DEP_REFRESH_AGENTS = 2,
} DependencyRefreshKind;

typedef struct {
    guint generation;
    DependencyRefreshKind kind;
} DependencyRefreshContext;

static GatewayConfig *current_config = NULL;
static gchar *current_http_url = NULL;
static gchar *current_ws_url = NULL;
static gboolean health_in_flight = FALSE;
static gboolean initialized = FALSE;
static guint current_health_generation = 0;
static gboolean current_setup_detected = FALSE;

static guint health_poll_timer_id = 0;
#define HEALTH_POLL_INTERVAL_S 10

static guint dependency_generation = 1;
static gboolean dependency_models_in_flight = FALSE;
static gboolean dependency_agents_in_flight = FALSE;
static gint64 dependency_last_refresh_us = 0;
static gboolean dependency_models_fresh = FALSE;
static gboolean dependency_agents_fresh = FALSE;
static gint64 dependency_models_last_success_us = 0;
static gint64 dependency_agents_last_success_us = 0;
#define DEPENDENCY_REFRESH_MIN_INTERVAL_US (2 * G_TIME_SPAN_SECOND)
#define DEPENDENCY_REFRESH_STALE_AFTER_US (30 * G_TIME_SPAN_SECOND)

/* Config monitor state for live config discovery/reload (Feature A) */
static GFileMonitor *config_dir_monitor = NULL;
static GFileMonitor *config_file_monitor = NULL;
static gchar *monitored_config_path = NULL;
static gchar *monitored_config_dir = NULL;
static guint config_monitor_refresh_source_id = 0;
#define CONFIG_MONITOR_DEBOUNCE_MS 250

static void do_health_check(void);
static void config_monitor_clear(void);
static void config_monitor_rearm(void);
static void dependency_refresh_start(gboolean force);
static void dependency_invalidate(gboolean invalidate_models,
                                  gboolean invalidate_agents,
                                  gboolean cancel_in_flight,
                                  const gchar *reason);

static DependencyRefreshContext* dependency_refresh_context_new(DependencyRefreshKind kind) {
    DependencyRefreshContext *ctx = g_new0(DependencyRefreshContext, 1);
    ctx->generation = dependency_generation;
    ctx->kind = kind;
    return ctx;
}

static gboolean dependency_refresh_context_is_stale(const DependencyRefreshContext *ctx) {
    return !ctx || ctx->generation != dependency_generation;
}

static void dependency_refresh_context_free(gpointer data) {
    g_free(data);
}

static gboolean gateway_can_refresh_dependencies(void) {
    if (!current_config || !current_config->valid) return FALSE;
    return gateway_rpc_is_ready();
}

static gboolean dependency_fact_is_stale(gboolean fresh,
                                         gint64 last_success_us,
                                         gint64 now_us) {
    if (!fresh || last_success_us <= 0) {
        return TRUE;
    }
    return (now_us - last_success_us) >= DEPENDENCY_REFRESH_STALE_AFTER_US;
}

static void dependency_invalidate(gboolean invalidate_models,
                                  gboolean invalidate_agents,
                                  gboolean cancel_in_flight,
                                  const gchar *reason) {
    if (!invalidate_models && !invalidate_agents) {
        return;
    }

    if (cancel_in_flight) {
        dependency_generation++;
        dependency_models_in_flight = FALSE;
        dependency_agents_in_flight = FALSE;
    }

    if (invalidate_models) {
        dependency_models_fresh = FALSE;
        dependency_models_last_success_us = 0;
        state_set_model_catalog_fact(FALSE, 0, FALSE);
    }
    if (invalidate_agents) {
        dependency_agents_fresh = FALSE;
        dependency_agents_last_success_us = 0;
        state_set_agents_fact(FALSE, 0);
    }

    dependency_last_refresh_us = 0;

    OC_LOG_DEBUG(OPENCLAW_LOG_CAT_GATEWAY,
                 "dependency refresh invalidated models=%d agents=%d cancel_in_flight=%d reason=%s",
                 invalidate_models,
                 invalidate_agents,
                 cancel_in_flight,
                 reason ? reason : "(none)");
}

static void on_dependency_models_response(const GatewayRpcResponse *response, gpointer user_data) {
    DependencyRefreshContext *ctx = (DependencyRefreshContext *)user_data;
    if (dependency_refresh_context_is_stale(ctx)) {
        dependency_refresh_context_free(ctx);
        return;
    }
    dependency_refresh_context_free(ctx);
    dependency_models_in_flight = FALSE;

    if (!response || !response->ok || !response->payload || !JSON_NODE_HOLDS_OBJECT(response->payload)) {
        dependency_models_fresh = FALSE;
        dependency_models_last_success_us = 0;
        state_set_model_catalog_fact(FALSE, 0, FALSE);
        return;
    }

    JsonObject *obj = json_node_get_object(response->payload);
    JsonNode *models_node = json_object_get_member(obj, "models");
    if (!models_node || !JSON_NODE_HOLDS_ARRAY(models_node)) {
        dependency_models_fresh = TRUE;
        dependency_models_last_success_us = g_get_real_time();
        state_set_model_catalog_fact(TRUE, 0, FALSE);
        return;
    }

    JsonArray *arr = json_node_get_array(models_node);
    guint model_count = json_array_get_length(arr);
    gboolean selected_resolved = FALSE;
    const gchar *default_model_id =
        (current_config && current_config->configured_default_model_id)
            ? current_config->configured_default_model_id
            : NULL;
    if (default_model_id && default_model_id[0] != '\0') {
        for (guint i = 0; i < model_count; i++) {
            JsonNode *n = json_array_get_element(arr, i);
            if (!n || !JSON_NODE_HOLDS_OBJECT(n)) continue;
            JsonObject *mo = json_node_get_object(n);
            const gchar *id = oc_json_string_member(mo, "id");
            if (id && g_strcmp0(id, default_model_id) == 0) {
                selected_resolved = TRUE;
                break;
            }
        }
    }

    dependency_models_fresh = TRUE;
    dependency_models_last_success_us = g_get_real_time();
    state_set_model_catalog_fact(TRUE, model_count, selected_resolved);
}

static void on_dependency_agents_response(const GatewayRpcResponse *response, gpointer user_data) {
    DependencyRefreshContext *ctx = (DependencyRefreshContext *)user_data;
    if (dependency_refresh_context_is_stale(ctx)) {
        dependency_refresh_context_free(ctx);
        return;
    }
    dependency_refresh_context_free(ctx);
    dependency_agents_in_flight = FALSE;

    if (!response || !response->ok || !response->payload || !JSON_NODE_HOLDS_OBJECT(response->payload)) {
        dependency_agents_fresh = FALSE;
        dependency_agents_last_success_us = 0;
        state_set_agents_fact(FALSE, 0);
        return;
    }

    JsonObject *obj = json_node_get_object(response->payload);
    JsonNode *agents_node = json_object_get_member(obj, "agents");
    if (!agents_node || !JSON_NODE_HOLDS_ARRAY(agents_node)) {
        dependency_agents_fresh = TRUE;
        dependency_agents_last_success_us = g_get_real_time();
        state_set_agents_fact(TRUE, 0);
        return;
    }

    JsonArray *arr = json_node_get_array(agents_node);
    dependency_agents_fresh = TRUE;
    dependency_agents_last_success_us = g_get_real_time();
    state_set_agents_fact(TRUE, json_array_get_length(arr));
}

static void dependency_refresh_start(gboolean force) {
    if (!gateway_can_refresh_dependencies()) return;
    if (dependency_models_in_flight || dependency_agents_in_flight) return;

    gint64 now_us = g_get_real_time();
    if (!force) {
        gboolean models_stale = dependency_fact_is_stale(
            dependency_models_fresh, dependency_models_last_success_us, now_us);
        gboolean agents_stale = dependency_fact_is_stale(
            dependency_agents_fresh, dependency_agents_last_success_us, now_us);
        gboolean freshness_refresh_needed = models_stale || agents_stale;

        if (!freshness_refresh_needed &&
            dependency_last_refresh_us > 0 &&
            (now_us - dependency_last_refresh_us) < DEPENDENCY_REFRESH_MIN_INTERVAL_US) {
            return;
        }
    }
    dependency_last_refresh_us = now_us;

    dependency_models_in_flight = TRUE;
    dependency_agents_in_flight = TRUE;

    DependencyRefreshContext *models_ctx = dependency_refresh_context_new(DEP_REFRESH_MODELS);
    g_autofree gchar *models_rid = gateway_rpc_request("models.list", NULL, 0,
                                                       on_dependency_models_response, models_ctx);
    if (!models_rid) {
        dependency_refresh_context_free(models_ctx);
        dependency_models_in_flight = FALSE;
        dependency_models_fresh = FALSE;
        dependency_models_last_success_us = 0;
        state_set_model_catalog_fact(FALSE, 0, FALSE);
    }

    DependencyRefreshContext *agents_ctx = dependency_refresh_context_new(DEP_REFRESH_AGENTS);
    g_autofree gchar *agents_rid = gateway_rpc_request("agents.list", NULL, 0,
                                                       on_dependency_agents_response, agents_ctx);
    if (!agents_rid) {
        dependency_refresh_context_free(agents_ctx);
        dependency_agents_in_flight = FALSE;
        dependency_agents_fresh = FALSE;
        dependency_agents_last_success_us = 0;
        state_set_agents_fact(FALSE, 0);
    }
}

static GatewayConfig* load_config_with_context(void) {
    GatewayConfigContext ctx = {0};
    gchar *derived_state_dir = NULL;
    gchar *derived_profile = NULL;
    gchar *derived_config_path = NULL;

    systemd_get_runtime_context(&derived_profile, &derived_state_dir, &derived_config_path);

    if (derived_config_path) {
        ctx.explicit_config_path = derived_config_path;
    }
    if (derived_state_dir) {
        ctx.effective_state_dir = derived_state_dir;
    }
    if (derived_profile) {
        ctx.profile = derived_profile;
    }

    GatewayConfig *cfg = gateway_config_load(&ctx);
    
    g_free(derived_config_path);
    g_free(derived_state_dir);
    g_free(derived_profile);
    
    return cfg;
}

static void publish_health_state(gboolean http_ok, HttpProbeResult http_probe_result,
                                  gboolean ws_connected,
                                  gboolean rpc_ok, gboolean auth_ok,
                                  const gchar *gateway_version,
                                  const gchar *auth_source,
                                  const gchar *last_error) {
    HealthState hs = {0};
    hs.last_updated = g_get_real_time();
    hs.http_ok = http_ok;
    hs.http_probe_result = http_probe_result;
    hs.ws_connected = ws_connected;
    hs.rpc_ok = rpc_ok;
    hs.auth_ok = auth_ok;
    hs.config_valid = current_config ? current_config->valid : FALSE;
    hs.setup_detected = current_setup_detected;
    hs.has_model_config = current_config ? current_config->has_model_config : FALSE;
    hs.has_provider_config = current_config ? current_config->has_provider_config : FALSE;
    hs.has_default_model_config = current_config ? current_config->has_default_model_config : FALSE;
    hs.configured_default_model_id = current_config ? current_config->configured_default_model_id : NULL;
    
    /* Feature B: Wizard onboard marker fields */
    hs.has_wizard_onboard_marker = current_config ? current_config->has_wizard_onboard_marker : FALSE;
    hs.wizard_is_local = current_config ? current_config->wizard_is_local : FALSE;
    hs.wizard_last_run_command = current_config ? current_config->wizard_last_run_command : NULL;
    hs.wizard_last_run_at = current_config ? current_config->wizard_last_run_at : NULL;
    hs.wizard_last_run_mode = current_config ? current_config->wizard_last_run_mode : NULL;
    hs.wizard_marker_fail_reason = current_config ? current_config->wizard_marker_fail_reason : NULL;

    /* TODO(MVP deferral): We do not populate config_audit_ok or config_issues_count 
     * here because those are not yet extracted or tracked in the Linux MVP.
     * Do NOT synthesize fake errors into these fields just to activate the
     * STATE_RUNNING_WITH_WARNING branch.
     */

    if (current_config) {
        hs.endpoint_host = g_strdup(current_config->host);
        hs.endpoint_port = current_config->port;
    }
    hs.gateway_version = g_strdup(gateway_version);
    hs.auth_source = g_strdup(auth_source);
    hs.last_error = g_strdup(last_error);

    state_update_health(&hs);

    g_free(hs.endpoint_host);
    g_free(hs.gateway_version);
    g_free(hs.auth_source);
    g_free(hs.last_error);
}

static void publish_invalid_config_state(void) {
    HealthState hs = {0};
    hs.last_updated = g_get_real_time();
    hs.config_valid = FALSE;
    hs.setup_detected = current_setup_detected;
    hs.last_error = g_strdup(current_config ? current_config->error : "Config load failed");
    if (current_config) {
        hs.endpoint_host = g_strdup(current_config->host);
        hs.endpoint_port = current_config->port;
        hs.configured_default_model_id = current_config->configured_default_model_id;
    }
    state_reset_resolved_facts();
    state_update_health(&hs);
    g_free(hs.endpoint_host);
    g_free(hs.last_error);
}

static void on_ws_status(const GatewayWsStatus *status, gpointer user_data) {
    (void)user_data;
    if (!status) return;

    gboolean ws_connected = (status->state == GATEWAY_WS_CONNECTED);
    gboolean auth_ok = ws_connected;
    gboolean auth_failed = (status->state == GATEWAY_WS_AUTH_FAILED);

    OC_LOG_DEBUG(OPENCLAW_LOG_CAT_GATEWAY, "ws status: state=%s rpc_ok=%d auth_source=%s error=%s",
              gateway_ws_state_to_string(status->state),
              status->rpc_ok,
              status->auth_source ? status->auth_source : "(null)",
              status->last_error ? status->last_error : "(null)");

    /* Re-publish health with latest WS state. */
    HealthState *current = state_get_health();
    gboolean http_ok = current ? current->http_ok : FALSE;

    /*
     * Cross-transport coherence rule:
     * If WS is connected with a successful RPC channel, the gateway endpoint
     * is provably reachable. A stale http_ok=FALSE from before the connection
     * was established must not persist — it would create the contradictory
     * snapshot "HTTP unreachable + WS connected + RPC OK" which the readiness
     * model would classify as DEGRADED even though the gateway is fully usable.
     */
    HttpProbeResult probe_result = current ? current->http_probe_result : HTTP_PROBE_NONE;
    if (ws_connected && status->rpc_ok) {
        http_ok = TRUE;
        probe_result = HTTP_PROBE_OK;
    }

    publish_health_state(
        http_ok,
        probe_result,
        ws_connected,
        status->rpc_ok,
        auth_ok,
        current ? current->gateway_version : NULL,
        status->auth_source,
        auth_failed ? status->last_error : (ws_connected ? NULL : status->last_error));

    /*
     * When WS transitions to CONNECTED, trigger an immediate HTTP health
     * check to refresh HTTP-specific fields (gateway version, healthy flag)
     * instead of waiting up to HEALTH_POLL_INTERVAL_S for the next poll.
     */
    if (ws_connected) {
        do_health_check();
        dependency_refresh_start(TRUE);
    }
}

static void on_health_result(const GatewayHealthResult *result, gpointer user_data) {
    GatewayHealthContext *ctx = (GatewayHealthContext *)user_data;
    if (!ctx) return;
    
    gboolean is_current = (ctx->generation == current_health_generation);
    g_free(ctx->url);
    g_free(ctx);

    if (!is_current) {
        /* Drop stale callback; do not mutate health_in_flight or publish state */
        return;
    }

    health_in_flight = FALSE;

    if (!result) return;

    OC_LOG_DEBUG(OPENCLAW_LOG_CAT_GATEWAY, "health result: ok=%d healthy=%d version=%s error=%s",
              result->ok, result->healthy,
              result->version ? result->version : "(null)",
              result->error ? result->error : "(null)");

    /* Merge HTTP health with current WS state */
    GatewayWsState ws_state = gateway_ws_get_state();
    gboolean ws_connected = (ws_state == GATEWAY_WS_CONNECTED);
    HealthState *current = state_get_health();

    /*
     * State-derived error precedence:
     * 1. HTTP error (transport-level failure) takes priority
     * 2. If HTTP is fine but WS is in a failure state, surface the WS error
     * 3. Otherwise no error
     *
     * This prevents the periodic HTTP health poll from clobbering a
     * WS auth rejection, while ensuring stale WS errors clear naturally
     * once WS recovers.
     */
    const gchar *merged_error = result->error;
    if (!merged_error) {
        gboolean ws_has_error = (ws_state == GATEWAY_WS_AUTH_FAILED ||
                                 ws_state == GATEWAY_WS_ERROR);
        if (ws_has_error) {
            merged_error = gateway_ws_get_last_error();
        }
    }

    publish_health_state(
        result->ok,
        result->probe_result,
        ws_connected,
        current ? current->rpc_ok : FALSE,
        current ? current->auth_ok : FALSE,
        result->version,
        current ? current->auth_source : NULL,
        merged_error);

    if (result->ok && ws_connected && current && current->rpc_ok && current->auth_ok) {
        dependency_refresh_start(FALSE);
    }
}

static void do_health_check(void) {
    if (health_in_flight || !current_http_url) return;
    health_in_flight = TRUE;

    GatewayHealthContext *ctx = g_new0(GatewayHealthContext, 1);
    ctx->generation = current_health_generation;
    ctx->url = g_strdup(current_http_url);

    gateway_http_check_health(current_http_url, on_health_result, ctx);
}

static gboolean on_health_poll_timer(gpointer user_data) {
    (void)user_data;
    do_health_check();
    return G_SOURCE_CONTINUE;
}

static void teardown_transport(gboolean invalidate_models,
                              gboolean invalidate_agents) {
    if (health_poll_timer_id) {
        g_source_remove(health_poll_timer_id);
        health_poll_timer_id = 0;
    }
    gateway_ws_disconnect();
    g_free(current_http_url);
    current_http_url = NULL;
    g_free(current_ws_url);
    current_ws_url = NULL;

    /* Reset health gate and increment generation so stale callbacks are ignored */
    health_in_flight = FALSE;
    current_health_generation++;
    dependency_invalidate(invalidate_models,
                          invalidate_agents,
                          TRUE,
                          "transport teardown");
    state_reset_resolved_facts();
}

static void start_transport(void) {
    if (!current_config || !current_config->valid) return;

    current_http_url = gateway_config_http_url(current_config);
    current_ws_url = gateway_config_ws_url(current_config);

    OC_LOG_INFO(OPENCLAW_LOG_CAT_GATEWAY, "start_transport http=%s ws=%s auth_mode=%s",
              current_http_url, current_ws_url,
              current_config->auth_mode ? current_config->auth_mode : "(null)");

    /* Start HTTP health polling */
    do_health_check();
    health_poll_timer_id = g_timeout_add_seconds(HEALTH_POLL_INTERVAL_S, on_health_poll_timer, NULL);

    /* Start WebSocket connection with auth_mode-aware credentials */
    gateway_ws_connect(current_ws_url,
                       current_config->auth_mode,
                       current_config->token,
                       current_config->password,
                       on_ws_status, NULL);
}

static void detect_setup_presence(const GatewayConfig *config) {
    current_setup_detected = FALSE;
    if (!config || !config->config_path) return;
    if (g_file_test(config->config_path, G_FILE_TEST_EXISTS)) {
        current_setup_detected = TRUE;
        return;
    }
    g_autofree gchar *parent = g_path_get_dirname(config->config_path);
    if (parent && g_file_test(parent, G_FILE_TEST_IS_DIR)) {
        current_setup_detected = TRUE;
    }
}

/* ── Config monitor helpers (Feature A) ── */

static gboolean on_config_monitor_debounced_refresh(gpointer user_data) {
    (void)user_data;
    config_monitor_refresh_source_id = 0;
    /* Rearm first to ensure path watch state stays correct, then refresh */
    config_monitor_rearm();
    gateway_client_refresh();
    return G_SOURCE_REMOVE;
}

static void config_monitor_schedule_refresh(void) {
    if (config_monitor_refresh_source_id > 0) {
        /* Already scheduled, do nothing (debounce) */
        return;
    }
    config_monitor_refresh_source_id = g_timeout_add(CONFIG_MONITOR_DEBOUNCE_MS,
                                                      on_config_monitor_debounced_refresh, NULL);
}

static void on_config_dir_changed(GFileMonitor *monitor, GFile *file, GFile *other_file,
                                   GFileMonitorEvent event_type, gpointer user_data) {
    (void)monitor;
    (void)other_file;
    (void)user_data;

    /* Only react if we have a target config basename to compare against */
    if (!monitored_config_path || !monitored_config_dir) {
        config_monitor_schedule_refresh();
        return;
    }

    gchar *changed_path = g_file_get_path(file);
    if (!changed_path) return;

    gchar *target_dir = g_path_get_dirname(monitored_config_path);
    gboolean relevant = FALSE;

    /* Feature A: Ancestor fallback monitoring
     * If we are monitoring an ancestor (e.g. /home/user) because the target dir
     * (e.g. /home/user/.openclaw) didn't exist, we must react to the creation
     * of the target dir or any intermediate dir.
     */
    if (g_strcmp0(monitored_config_dir, target_dir) != 0) {
        /* We are monitoring an ancestor. React if the changed path is a prefix
         * of our ultimate target config path. */
        if (g_str_has_prefix(monitored_config_path, changed_path)) {
            relevant = TRUE;
        }
    } else {
        /* We are monitoring the actual config dir. React only to the target config file. */
        if (g_strcmp0(changed_path, monitored_config_path) == 0) {
            relevant = TRUE;
        }
    }

    g_free(target_dir);
    g_free(changed_path);

    if (relevant) {
        switch (event_type) {
        case G_FILE_MONITOR_EVENT_CREATED:
        case G_FILE_MONITOR_EVENT_DELETED:
        case G_FILE_MONITOR_EVENT_CHANGED:
        case G_FILE_MONITOR_EVENT_CHANGES_DONE_HINT:
        case G_FILE_MONITOR_EVENT_RENAMED:
        case G_FILE_MONITOR_EVENT_MOVED_IN:
        case G_FILE_MONITOR_EVENT_MOVED_OUT:
        case G_FILE_MONITOR_EVENT_ATTRIBUTE_CHANGED:
            OC_LOG_INFO(OPENCLAW_LOG_CAT_GATEWAY, "Config dir monitor event %d triggered refresh", event_type);
            config_monitor_schedule_refresh();
            break;
        default:
            break;
        }
    }
}

static void on_config_file_changed(GFileMonitor *monitor, GFile *file, GFile *other_file,
                                    GFileMonitorEvent event_type, gpointer user_data) {
    (void)monitor;
    (void)file;
    (void)other_file;
    (void)user_data;

    switch (event_type) {
    case G_FILE_MONITOR_EVENT_CHANGED:
    case G_FILE_MONITOR_EVENT_CHANGES_DONE_HINT:
    case G_FILE_MONITOR_EVENT_DELETED:
    case G_FILE_MONITOR_EVENT_RENAMED:
    case G_FILE_MONITOR_EVENT_ATTRIBUTE_CHANGED:
        OC_LOG_INFO(OPENCLAW_LOG_CAT_GATEWAY, "Config file monitor event %d triggered refresh", event_type);
        config_monitor_schedule_refresh();
        break;
    default:
        break;
    }
}

static void config_monitor_clear(void) {
    /* Remove pending debounce source */
    if (config_monitor_refresh_source_id > 0) {
        g_source_remove(config_monitor_refresh_source_id);
        config_monitor_refresh_source_id = 0;
    }

    /* Disconnect and unref monitors */
    if (config_dir_monitor) {
        g_file_monitor_cancel(config_dir_monitor);
        g_object_unref(config_dir_monitor);
        config_dir_monitor = NULL;
    }
    if (config_file_monitor) {
        g_file_monitor_cancel(config_file_monitor);
        g_object_unref(config_file_monitor);
        config_file_monitor = NULL;
    }

    /* Free tracked strings */
    g_free(monitored_config_path);
    monitored_config_path = NULL;
    g_free(monitored_config_dir);
    monitored_config_dir = NULL;
}

static void config_monitor_rearm(void) {
    /* Resolve effective config path using same logic as load */
    gchar *new_config_path = NULL;
    gchar *new_config_dir = NULL;

    /* Build context from current runtime */
    GatewayConfigContext ctx = {0};
    gchar *derived_state_dir = NULL;
    gchar *derived_profile = NULL;
    gchar *derived_config_path = NULL;
    systemd_get_runtime_context(&derived_profile, &derived_state_dir, &derived_config_path);
    if (derived_config_path) ctx.explicit_config_path = derived_config_path;
    if (derived_state_dir) ctx.effective_state_dir = derived_state_dir;
    if (derived_profile) ctx.profile = derived_profile;

    new_config_path = gateway_config_resolve_path(&ctx);
    g_free(derived_config_path);
    g_free(derived_state_dir);
    g_free(derived_profile);

    if (!new_config_path) {
        gateway_config_free_resolved_path(new_config_path);
        return;
    }

    new_config_dir = g_path_get_dirname(new_config_path);

    /* Feature A: Ancestor fallback monitoring
     * If the config dir doesn't exist (e.g. fresh machine pre-onboarding),
     * walk up to the nearest existing ancestor and monitor that.
     */
    gchar *effective_monitor_dir = new_config_dir;
    gchar *ancestor_dir = NULL;
    if (!g_file_test(new_config_dir, G_FILE_TEST_EXISTS | G_FILE_TEST_IS_DIR)) {
        ancestor_dir = find_nearest_existing_ancestor(new_config_dir);
        if (ancestor_dir) {
            effective_monitor_dir = ancestor_dir;
        }
    }

    /* Check if we need to rearm (path changed or first setup) */
    gboolean dir_changed = g_strcmp0(effective_monitor_dir, monitored_config_dir) != 0;
    gboolean file_changed = g_strcmp0(new_config_path, monitored_config_path) != 0;

    /* Feature A: Fix rearm logic bug - must account for file creation/deletion
     * Same paths are NOT enough to skip rearm if file existence changed.
     * We need to ensure file monitor state matches current file existence.
     */
    gboolean file_exists = g_file_test(new_config_path, G_FILE_TEST_EXISTS);
    gboolean need_file_monitor = file_exists;
    gboolean have_file_monitor = (config_file_monitor != NULL);
    gboolean have_dir_monitor = (config_dir_monitor != NULL);

    /* Use pure helper for skip decision - shared with tests */
    if (config_monitor_can_skip_rearm(
            effective_monitor_dir, monitored_config_dir,
            new_config_path, monitored_config_path,
            have_dir_monitor, need_file_monitor, have_file_monitor)) {
        /* Same paths, dir monitor exists, and file monitor state matches need -
         * avoid unnecessary churn */
        g_free(new_config_path);
        g_free(new_config_dir);
        g_free(ancestor_dir);
        return;
    }

    /* Clear old monitors */
    if (dir_changed || !have_dir_monitor) {
        if (config_dir_monitor) {
            g_file_monitor_cancel(config_dir_monitor);
            g_object_unref(config_dir_monitor);
            config_dir_monitor = NULL;
        }
        g_free(monitored_config_dir);
        monitored_config_dir = g_strdup(effective_monitor_dir);

        /* Set up new dir monitor */
        if (monitored_config_dir) {
            GFile *dir_file = g_file_new_for_path(monitored_config_dir);
            GError *error = NULL;
            config_dir_monitor = g_file_monitor_directory(dir_file, G_FILE_MONITOR_WATCH_MOVES, NULL, &error);
            if (config_dir_monitor) {
                g_signal_connect(config_dir_monitor, "changed", G_CALLBACK(on_config_dir_changed), NULL);
            } else {
                OC_LOG_WARN(OPENCLAW_LOG_CAT_GATEWAY, "Failed to monitor config dir: %s", error ? error->message : "unknown");
                g_clear_error(&error);
            }
            g_object_unref(dir_file);
        }
    }

    g_free(new_config_dir);
    g_free(ancestor_dir);

    /* Use same decision logic as helper for consistency */
    gboolean need_file_reconfig = file_changed || (need_file_monitor != have_file_monitor);
    if (need_file_reconfig) {
        if (config_file_monitor) {
            g_file_monitor_cancel(config_file_monitor);
            g_object_unref(config_file_monitor);
            config_file_monitor = NULL;
        }
        g_free(monitored_config_path);
        monitored_config_path = new_config_path;

        /* Set up new file monitor only if file exists */
        if (need_file_monitor && monitored_config_path) {
            GFile *file = g_file_new_for_path(monitored_config_path);
            GError *error = NULL;
            config_file_monitor = g_file_monitor_file(file, G_FILE_MONITOR_WATCH_MOVES, NULL, &error);
            if (config_file_monitor) {
                g_signal_connect(config_file_monitor, "changed", G_CALLBACK(on_config_file_changed), NULL);
            } else {
                OC_LOG_WARN(OPENCLAW_LOG_CAT_GATEWAY, "Failed to monitor config file: %s", error ? error->message : "unknown");
                g_clear_error(&error);
            }
            g_object_unref(file);
        }
    } else {
        g_free(new_config_path);
    }
}

void gateway_client_init(void) {
    if (initialized) return;
    initialized = TRUE;

    gateway_http_init();
    gateway_ws_init();

    /* Start monitoring config file for live reload (Feature A) */
    config_monitor_rearm();

    /* Load config and detect setup presence */
    current_config = load_config_with_context();
    detect_setup_presence(current_config);
    if (!current_config || !current_config->valid) {
        OC_LOG_WARN(OPENCLAW_LOG_CAT_GATEWAY, "gateway config invalid: %s",
                  current_config ? current_config->error : "load failed");
        publish_invalid_config_state();
        return;
    }

    start_transport();
}

void gateway_client_refresh(void) {
    if (!initialized) {
        gateway_client_init();
        return;
    }

    /* Always reload config and re-detect setup presence */
    GatewayConfig *new_config = load_config_with_context();
    detect_setup_presence(new_config);
    gboolean equivalent = gateway_config_equivalent(current_config, new_config);

    if (equivalent) {
        if (new_config->valid) {
            /* F1: Preserve/update metadata fields that matter operationally */
            g_free(current_config->config_path);
            current_config->config_path = g_strdup(new_config->config_path);
            /* Unchanged valid config — lightweight health refresh */
            gateway_config_free(new_config);
            do_health_check();
            dependency_refresh_start(FALSE);
            return;
        }
        /* Unchanged invalid config — republish error state */
        gateway_config_free(current_config);
        current_config = new_config;
        publish_invalid_config_state();
        return;
    }

    OC_LOG_INFO(OPENCLAW_LOG_CAT_GATEWAY,
              "gateway_client_refresh config changed valid=%d->%d error_code=%d->%d",
              current_config ? current_config->valid : -1,
              new_config ? new_config->valid : -1,
              current_config ? (int)current_config->error_code : -1,
              new_config ? (int)new_config->error_code : -1);

    /* Config changed — always replace stored config */
    gboolean invalidate_models = TRUE;
    gboolean invalidate_agents = TRUE;
    if (current_config && new_config && current_config->valid && new_config->valid) {
        gboolean model_context_changed =
            current_config->has_provider_config != new_config->has_provider_config ||
            current_config->has_default_model_config != new_config->has_default_model_config ||
            g_strcmp0(current_config->configured_default_model_id,
                      new_config->configured_default_model_id) != 0;
        if (!model_context_changed) {
            invalidate_models = FALSE;
        }
    }
    teardown_transport(invalidate_models, invalidate_agents);
    gateway_config_free(current_config);
    current_config = new_config;

    if (!current_config->valid) {
        /* New config is invalid — publish error state */
        publish_invalid_config_state();
        return;
    }

    /* New config is valid (may be recovering from invalid, or changed) — rebuild transport */
    start_transport();
}

void gateway_client_shutdown(void) {
    if (!initialized) return;
    initialized = FALSE;

    /* Stop monitoring config file (Feature A) */
    config_monitor_clear();

    teardown_transport(TRUE, TRUE);
    gateway_ws_shutdown();
    gateway_http_shutdown();
    gateway_config_free(current_config);
    current_config = NULL;
}

gboolean gateway_client_is_connected(void) {
    return gateway_ws_get_state() == GATEWAY_WS_CONNECTED;
}

GatewayConfig* gateway_client_get_config(void) {
    return current_config;
}

void gateway_client_request_dependency_refresh(void) {
    dependency_refresh_start(TRUE);
}

void gateway_client_invalidate_dependencies(gboolean invalidate_models,
                                            gboolean invalidate_agents) {
    dependency_invalidate(invalidate_models,
                          invalidate_agents,
                          FALSE,
                          "explicit request");
}
