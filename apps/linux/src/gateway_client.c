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
#include "gateway_ws.h"
#include "state.h"
#include "log.h"
#include <string.h>

typedef struct {
    guint generation;
    gchar *url;
} GatewayHealthContext;

static GatewayConfig *current_config = NULL;
static gchar *current_http_url = NULL;
static gchar *current_ws_url = NULL;
static gboolean health_in_flight = FALSE;
static gboolean initialized = FALSE;
static guint current_health_generation = 0;
static gboolean current_setup_detected = FALSE;

static guint health_poll_timer_id = 0;
#define HEALTH_POLL_INTERVAL_S 10

static void do_health_check(void);

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
    }
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

static void teardown_transport(void) {
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

void gateway_client_init(void) {
    if (initialized) return;
    initialized = TRUE;

    gateway_http_init();
    gateway_ws_init();

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
    teardown_transport();
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

    teardown_transport();
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
