/*
 * state.c
 *
 * Normalized state machine for the OpenClaw Linux Companion App.
 *
 * Computes an explicit 8-case normalized operational state (e.g. Running,
 * Degraded, Error) based on native gateway client connectivity and
 * systemd service context.
 *
 * Status Precedence Rule:
 *   1. PRIMARY: Runtime connectivity (HTTP + WS + RPC/auth) determines
 *      whether the gateway is operational, regardless of systemd state.
 *   2. SECONDARY: Systemd contributes management/install context only.
 *   3. INVARIANT: compute_state() must NOT return STOPPED, NOT_INSTALLED,
 *      or USER_SYSTEMD_UNAVAILABLE when native gateway connectivity
 *      is established.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include <glib.h>
#include <string.h>
#include "log.h"
#include "state.h"

static AppState current_state = STATE_NEEDS_SETUP;
static RuntimeMode current_runtime_mode = RUNTIME_NONE;
static SystemdState current_sys_state = {0};
static HealthState current_health_state = {0};
static DesktopReadinessSnapshot current_readiness_snapshot = {0};

typedef struct {
    gboolean models_fetch_succeeded;
    guint models_count;
    gboolean selected_model_resolved;
    gboolean agents_fetch_succeeded;
    guint agents_count;
} DesktopResolvedFacts;

static DesktopResolvedFacts current_resolved_facts = {0};

static guint64 current_health_generation = 0;
static gboolean initial_hydration_done = FALSE;
static gboolean initial_refresh_fired = FALSE;
static GatewayConnectionTransitionTracker connection_transition_tracker = {0};

/* Defined in runtime_mode.c — internal to the state module */
extern RuntimeMode runtime_mode_compute(const SystemdState *sys, const HealthState *health);

/* Feature B: Helper to detect if onboarding is still required
 * 
 * Contract: This predicate is independent from setup_detected, 
 * has_model_config, gateway reachability, and service status.
 * It strictly answers whether the local bootstrap wizard has completed.
 */
static gboolean config_requires_onboarding(const HealthState *health) {
    if (!health || !health->config_valid) {
        return FALSE;
    }

    return !health->has_wizard_onboard_marker;
}

static void recompute_resolved_health_fields(void) {
    const gboolean has_health_data = (current_health_state.last_updated > 0);
    const gboolean provider_configured = has_health_data && current_health_state.has_provider_config;
    const gboolean default_model_configured = has_health_data && current_health_state.has_default_model_config;

    current_health_state.model_catalog_available =
        provider_configured &&
        current_resolved_facts.models_fetch_succeeded &&
        current_resolved_facts.models_count > 0;

    current_health_state.selected_model_resolved =
        default_model_configured &&
        current_health_state.model_catalog_available &&
        current_resolved_facts.selected_model_resolved;

    current_health_state.agents_available =
        current_resolved_facts.agents_fetch_succeeded &&
        current_resolved_facts.agents_count > 0;
}

static void compute_readiness_snapshot(void) {
    DesktopReadinessSnapshot snap = {0};

    const gboolean has_health_data = (current_health_state.last_updated > 0);
    const gboolean has_setup = has_health_data && current_health_state.setup_detected;

    snap.config_present = has_setup;
    snap.config_valid = has_health_data && current_health_state.config_valid;
    snap.wizard_completed = snap.config_valid && current_health_state.has_wizard_onboard_marker;
    snap.service_installed = current_sys_state.installed;
    snap.service_active = current_sys_state.active;
    snap.gateway_http_ok = has_health_data && current_health_state.http_ok;
    snap.gateway_ws_ok = has_health_data && current_health_state.ws_connected;
    snap.gateway_rpc_ok = has_health_data && current_health_state.rpc_ok;
    snap.gateway_auth_ok = has_health_data && current_health_state.auth_ok;
    snap.provider_configured = has_health_data && current_health_state.has_provider_config;
    snap.default_model_configured = has_health_data && current_health_state.has_default_model_config;
    snap.model_catalog_available = has_health_data && current_health_state.model_catalog_available;
    snap.selected_model_resolved = has_health_data && current_health_state.selected_model_resolved;
    snap.agents_available = has_health_data && current_health_state.agents_available;
    snap.desktop_chat_ready = FALSE;
    snap.chat_block_reason = CHAT_BLOCK_UNKNOWN;

    if (!snap.config_present) {
        snap.chat_block_reason = CHAT_BLOCK_NO_CONFIG;
    } else if (!snap.config_valid) {
        snap.chat_block_reason = CHAT_BLOCK_CONFIG_INVALID;
    } else if (!snap.wizard_completed) {
        snap.chat_block_reason = CHAT_BLOCK_BOOTSTRAP_INCOMPLETE;
    } else if (!snap.service_active) {
        snap.chat_block_reason = CHAT_BLOCK_SERVICE_INACTIVE;
    } else if (!snap.gateway_http_ok || !snap.gateway_ws_ok || !snap.gateway_rpc_ok) {
        snap.chat_block_reason = CHAT_BLOCK_GATEWAY_UNREACHABLE;
    } else if (!snap.gateway_auth_ok) {
        snap.chat_block_reason = CHAT_BLOCK_AUTH_INVALID;
    } else if (!snap.provider_configured) {
        snap.chat_block_reason = CHAT_BLOCK_PROVIDER_MISSING;
    } else if (!snap.default_model_configured) {
        snap.chat_block_reason = CHAT_BLOCK_DEFAULT_MODEL_MISSING;
    } else if (!snap.model_catalog_available) {
        snap.chat_block_reason = CHAT_BLOCK_MODEL_CATALOG_EMPTY;
    } else if (!snap.selected_model_resolved) {
        snap.chat_block_reason = CHAT_BLOCK_SELECTED_MODEL_UNRESOLVED;
    } else if (!snap.agents_available) {
        snap.chat_block_reason = CHAT_BLOCK_AGENTS_UNAVAILABLE;
    } else {
        snap.chat_block_reason = CHAT_BLOCK_NONE;
        snap.desktop_chat_ready = TRUE;
    }

    current_readiness_snapshot = snap;
}

gboolean state_connection_transition_step(GatewayConnectionTransitionTracker *tracker,
                                          gboolean connected_now,
                                          gboolean *out_connected_now) {
    if (!tracker) return FALSE;
    if (!tracker->initialized) {
        tracker->initialized = TRUE;
        tracker->connected = connected_now;
        return FALSE;
    }
    if (tracker->connected == connected_now) {
        return FALSE;
    }
    tracker->connected = connected_now;
    if (out_connected_now) {
        *out_connected_now = connected_now;
    }
    return TRUE;
}

static AppState compute_state(void) {
    gboolean has_health_data = (current_health_state.last_updated > 0);
    gboolean gateway_reachable = has_health_data && current_health_state.http_ok;
    gboolean gateway_connected = gateway_reachable && current_health_state.ws_connected;

    /*
     * Readiness Decision Table — evaluated top-down, first match wins.
     *
     * Precedence Rule:
     *   1. Runtime reachability and protocol success decide "ready."
     *   2. When runtime truth does not establish readiness, setup/config/install
     *      context determines the user-visible explanation.
     *   3. Systemd contributes lifecycle context but never by itself proves readiness.
     */

    /* ── LAYER 1: RUNTIME TRUTH (rows 1-4) ── */
    if (gateway_connected) {
        if (!current_health_state.rpc_ok || !current_health_state.auth_ok) {
            return STATE_DEGRADED;
        }
        /* TODO(MVP deferral): STATE_RUNNING_WITH_WARNING is intentionally deferred.
         * The Linux MVP does not yet populate config-audit inputs (config_audit_ok,
         * config_issues_count). We explicitly retain this branch to preserve the
         * intended UX shape, but do NOT synthesize warning-state behavior from
         * unrelated config errors just to make it live.
         */
        if (!current_health_state.config_audit_ok && current_health_state.config_issues_count > 0) {
            return STATE_RUNNING_WITH_WARNING;
        }
        return STATE_RUNNING;
    }
    if (gateway_reachable && !gateway_connected) {
        return STATE_DEGRADED;
    }

    /* ── LAYER 2: INFRASTRUCTURE FAILURES (rows 5-6) ── */
    if (current_sys_state.systemd_unavailable) {
        return STATE_USER_SYSTEMD_UNAVAILABLE;
    }
    if (!current_sys_state.installed && current_sys_state.system_installed_unsupported) {
        return STATE_SYSTEM_UNSUPPORTED;
    }

    /* ── LAYER 3: INSTALL STATUS (rows 7-8) ── */
    if (!current_sys_state.installed) {
        if (has_health_data && current_health_state.setup_detected) {
            return STATE_NEEDS_GATEWAY_INSTALL;
        }
        return STATE_NEEDS_SETUP;
    }

    /* ── LAYER 3b: ONBOARDING STATUS (Feature B) ──
     * If setup is complete (config valid, service installed), check if
     * onboarding has established runtime model selections. This state
     * sits between "setup complete" and "fully ready/running".
     */
    if (config_requires_onboarding(&current_health_state)) {
        return STATE_NEEDS_ONBOARDING;
    }

    /* ── LAYER 4: SYSTEMD TRANSITIONS (rows 10-12) ── */
    if (current_sys_state.failed) return STATE_ERROR;
    if (current_sys_state.activating) return STATE_STARTING;
    if (current_sys_state.deactivating) return STATE_STOPPING;

    /* ── LAYER 5: CONFIG VALIDITY (row 9) ──
     * If config is invalid and runtime truth has not proven usability,
     * surface config invalidity as the primary explanation.
     * Only evaluated after health data has arrived (otherwise config_valid
     * is its default zero-value and would falsely trigger).
     */
    if (has_health_data && !current_health_state.config_valid) {
        return STATE_CONFIG_INVALID;
    }

    /* ── LAYER 6: SYSTEMD ACTIVE (rows 14-15) ── */
    if (current_sys_state.active) {
        /*
         * Startup Hydration Guard:
         * Systemd says active but native client hasn't confirmed health yet.
         * This is a transitional state — NOT equivalent to fully ready.
         * If we have health data showing HTTP unreachable, report degraded.
         * Otherwise report STARTING while the native client establishes.
         */
        if (has_health_data && !current_health_state.http_ok) {
            return STATE_DEGRADED;
        }
        if (!has_health_data) {
            return STATE_STARTING;
        }
        /* has_health_data && http_ok implies gateway_reachable, which would
         * have been caught in Layer 1. Should not reach here. */
        return STATE_STARTING;
    }

    /* ── DEFAULT (row 13) ── */
    return STATE_STOPPED;
}

void state_init(void) {
    current_state = STATE_NEEDS_SETUP;
    current_runtime_mode = RUNTIME_NONE;
    memset(&current_readiness_snapshot, 0, sizeof(current_readiness_snapshot));
    current_readiness_snapshot.chat_block_reason = CHAT_BLOCK_UNKNOWN;
    initial_hydration_done = FALSE;
    initial_refresh_fired = FALSE;
    connection_transition_tracker.initialized = FALSE;
    connection_transition_tracker.connected = FALSE;
    memset(&current_resolved_facts, 0, sizeof(current_resolved_facts));

    g_free(current_sys_state.active_state);
    g_free(current_sys_state.sub_state);
    g_free(current_sys_state.unit_name);
    memset(&current_sys_state, 0, sizeof(SystemdState));

    health_state_clear(&current_health_state);
    current_health_generation = 0;
}

static const char* state_enum_to_string(AppState s) {
    switch (s) {
        case STATE_NEEDS_SETUP: return "NEEDS_SETUP";
        case STATE_NEEDS_GATEWAY_INSTALL: return "NEEDS_GATEWAY_INSTALL";
        case STATE_NEEDS_ONBOARDING: return "NEEDS_ONBOARDING";
        case STATE_USER_SYSTEMD_UNAVAILABLE: return "USER_SYSTEMD_UNAVAILABLE";
        case STATE_SYSTEM_UNSUPPORTED: return "SYSTEM_UNSUPPORTED";
        case STATE_CONFIG_INVALID: return "CONFIG_INVALID";
        case STATE_STOPPED: return "STOPPED";
        case STATE_STARTING: return "STARTING";
        case STATE_STOPPING: return "STOPPING";
        case STATE_RUNNING: return "RUNNING";
        case STATE_RUNNING_WITH_WARNING: return "RUNNING_WITH_WARNING";
        case STATE_DEGRADED: return "DEGRADED";
        case STATE_ERROR: return "ERROR";
        default: return "UNKNOWN";
    }
}

static void trigger_updates(AppState new_state) {
    OC_LOG_INFO(OPENCLAW_LOG_CAT_STATE, "trigger_updates entry old=%s new=%s changed=%d hydrated=%d",
              state_enum_to_string(current_state), state_enum_to_string(new_state),
              new_state != current_state, initial_hydration_done);

    if (new_state != current_state) {
        AppState old_state = current_state;
        current_state = new_state;
        if (initial_hydration_done) {
            OC_LOG_DEBUG(OPENCLAW_LOG_CAT_STATE, "trigger_updates pre-notify old=%s new=%s",
                      state_enum_to_string(old_state), state_enum_to_string(new_state));
            notify_on_transition(old_state, new_state);
            OC_LOG_DEBUG(OPENCLAW_LOG_CAT_STATE, "trigger_updates post-notify");
        }
    }

    if (initial_hydration_done) {
        gboolean connected_now = (current_health_state.http_ok && current_health_state.ws_connected);
        gboolean edge_connected = FALSE;
        if (state_connection_transition_step(&connection_transition_tracker,
                                             connected_now,
                                             &edge_connected)) {
            notify_on_gateway_connection_transition(edge_connected);
        }
    }

    OC_LOG_DEBUG(OPENCLAW_LOG_CAT_STATE, "trigger_updates pre-tray state=%s",
              state_enum_to_string(current_state));
    tray_update_from_state(current_state);
    
    /* Feature A: State-driven onboarding refresh
     * Only rebuild onboarding window pages when state materially changes */
    extern void onboarding_refresh(void);
    onboarding_refresh();
    
    OC_LOG_DEBUG(OPENCLAW_LOG_CAT_STATE, "trigger_updates post-tray");
}

static gboolean idle_request_gateway_refresh(gpointer user_data) {
    (void)user_data;
    state_on_gateway_refresh_requested();
    return G_SOURCE_REMOVE;
}

void health_state_clear(HealthState *hs) {
    if (!hs) return;
    g_free(hs->endpoint_host);
    g_free(hs->gateway_version);
    g_free(hs->auth_source);
    g_free(hs->last_error);
    g_free(hs->configured_default_model_id);
    g_free(hs->wizard_last_run_command);
    g_free(hs->wizard_last_run_at);
    g_free(hs->wizard_last_run_mode);
    g_free(hs->wizard_marker_fail_reason);
    memset(hs, 0, sizeof(HealthState));
}

void state_update_systemd(const SystemdState *sys_state) {
    gboolean was_active = current_sys_state.active;
    gboolean became_active = (!was_active && sys_state->active);
    gboolean became_inactive = (was_active && !sys_state->active);
    gboolean unit_changed = (g_strcmp0(current_sys_state.unit_name, sys_state->unit_name) != 0);

    g_free(current_sys_state.active_state);
    g_free(current_sys_state.sub_state);
    g_free(current_sys_state.unit_name);

    current_sys_state = *sys_state;
    current_sys_state.systemd_unavailable = sys_state->systemd_unavailable;
    current_sys_state.active_state = g_strdup(sys_state->active_state);
    current_sys_state.sub_state = g_strdup(sys_state->sub_state);
    current_sys_state.unit_name = g_strdup(sys_state->unit_name);

    if (became_active || unit_changed) {
        current_health_generation++;
    }

    /*
     * When systemd reports the service has stopped, do NOT clear native
     * health data. The native HTTP/WS client is the authoritative source
     * of gateway reachability. Instead, trigger an immediate native health
     * refresh so the client discovers the real state. If the gateway is
     * truly gone, the HTTP check will fail and native state will update
     * naturally. If the gateway is still alive (started out-of-band),
     * native state stays correct.
     */

    AppState new_state = compute_state();
    current_runtime_mode = runtime_mode_compute(&current_sys_state, &current_health_state);
    compute_readiness_snapshot();

    gboolean should_trigger_refresh = (!initial_refresh_fired || became_active || became_inactive || unit_changed);
    if (should_trigger_refresh) {
        initial_refresh_fired = TRUE;
        g_idle_add(idle_request_gateway_refresh, NULL);
    }

    trigger_updates(new_state);
    initial_hydration_done = TRUE;
}

void state_update_health(const HealthState *health_state) {
    current_health_state.config_valid = health_state->config_valid;
    current_health_state.setup_detected = health_state->setup_detected;
    current_health_state.config_audit_ok = health_state->config_audit_ok;
    current_health_state.config_issues_count = health_state->config_issues_count;
    current_health_state.has_model_config = health_state->has_model_config;
    current_health_state.has_provider_config = health_state->has_provider_config;
    current_health_state.has_default_model_config = health_state->has_default_model_config;

    /* Feature B: Wizard onboard marker fields */
    current_health_state.has_wizard_onboard_marker = health_state->has_wizard_onboard_marker;
    current_health_state.wizard_is_local = health_state->wizard_is_local;

    g_free(current_health_state.endpoint_host);
    g_free(current_health_state.gateway_version);
    g_free(current_health_state.auth_source);
    g_free(current_health_state.last_error);
    g_free(current_health_state.configured_default_model_id);
    g_free(current_health_state.wizard_last_run_command);
    g_free(current_health_state.wizard_last_run_at);
    g_free(current_health_state.wizard_last_run_mode);
    g_free(current_health_state.wizard_marker_fail_reason);

    current_health_state.endpoint_host = g_strdup(health_state->endpoint_host);
    current_health_state.gateway_version = g_strdup(health_state->gateway_version);
    current_health_state.auth_source = g_strdup(health_state->auth_source);
    current_health_state.last_error = g_strdup(health_state->last_error);
    current_health_state.configured_default_model_id = g_strdup(health_state->configured_default_model_id);
    current_health_state.wizard_last_run_command = g_strdup(health_state->wizard_last_run_command);
    current_health_state.wizard_last_run_at = g_strdup(health_state->wizard_last_run_at);
    current_health_state.wizard_last_run_mode = g_strdup(health_state->wizard_last_run_mode);
    current_health_state.wizard_marker_fail_reason = g_strdup(health_state->wizard_marker_fail_reason);

    current_health_state.endpoint_port = health_state->endpoint_port;
    current_health_state.last_updated = health_state->last_updated;
    current_health_state.http_ok = health_state->http_ok;
    current_health_state.http_probe_result = health_state->http_probe_result;
    current_health_state.ws_connected = health_state->ws_connected;
    current_health_state.rpc_ok = health_state->rpc_ok;
    current_health_state.auth_ok = health_state->auth_ok;

    if (health_state->model_catalog_available) {
        current_resolved_facts.models_fetch_succeeded = TRUE;
        if (current_resolved_facts.models_count == 0) {
            current_resolved_facts.models_count = 1;
        }
    }
    if (health_state->selected_model_resolved) {
        current_resolved_facts.selected_model_resolved = TRUE;
    }
    if (health_state->agents_available) {
        current_resolved_facts.agents_fetch_succeeded = TRUE;
        if (current_resolved_facts.agents_count == 0) {
            current_resolved_facts.agents_count = 1;
        }
    }

    recompute_resolved_health_fields();

    current_health_generation++;
    OC_LOG_INFO(OPENCLAW_LOG_CAT_STATE, "health updated: gen=%" G_GUINT64_FORMAT " ok=%d ws=%d",
              current_health_generation, health_state->http_ok, health_state->ws_connected);
    AppState new_state = compute_state();
    current_runtime_mode = runtime_mode_compute(&current_sys_state, &current_health_state);
    compute_readiness_snapshot();
    trigger_updates(new_state);
}

void state_set_model_catalog_fact(gboolean fetch_succeeded,
                                  guint model_count,
                                  gboolean selected_model_resolved) {
    current_resolved_facts.models_fetch_succeeded = fetch_succeeded;
    current_resolved_facts.models_count = fetch_succeeded ? model_count : 0;
    current_resolved_facts.selected_model_resolved =
        fetch_succeeded && model_count > 0 && selected_model_resolved;

    recompute_resolved_health_fields();
    compute_readiness_snapshot();
    trigger_updates(current_state);
}

void state_set_agents_fact(gboolean fetch_succeeded,
                           guint agent_count) {
    current_resolved_facts.agents_fetch_succeeded = fetch_succeeded;
    current_resolved_facts.agents_count = fetch_succeeded ? agent_count : 0;

    recompute_resolved_health_fields();
    compute_readiness_snapshot();
    trigger_updates(current_state);
}

void state_reset_resolved_facts(void) {
    memset(&current_resolved_facts, 0, sizeof(current_resolved_facts));
    recompute_resolved_health_fields();
    compute_readiness_snapshot();
    trigger_updates(current_state);
}

AppState state_get_current(void) {
    return current_state;
}

const char* state_get_current_string(void) {
    switch (current_state) {
        case STATE_NEEDS_SETUP: return "Setup Required";
        case STATE_NEEDS_GATEWAY_INSTALL: return "Gateway Not Installed";
        case STATE_NEEDS_ONBOARDING: return "Onboarding Required";
        case STATE_USER_SYSTEMD_UNAVAILABLE: return "User Systemd Unavailable";
        case STATE_SYSTEM_UNSUPPORTED: return "System Service (Unsupported)";
        case STATE_CONFIG_INVALID: return "Configuration Invalid";
        case STATE_STOPPED: return "Stopped";
        case STATE_STARTING: return "Starting";
        case STATE_STOPPING: return "Stopping";
        case STATE_RUNNING: return "Running";
        case STATE_RUNNING_WITH_WARNING: return "Running (Config Warning)";
        case STATE_DEGRADED: return "Degraded / Unreachable";
        case STATE_ERROR: return "Error";
        default: return "Unknown";
    }
}

RuntimeMode state_get_runtime_mode(void) {
    return current_runtime_mode;
}

SystemdState* state_get_systemd(void) {
    return &current_sys_state;
}

guint64 state_get_health_generation(void) {
    return current_health_generation;
}

HealthState* state_get_health(void) {
    return &current_health_state;
}

const DesktopReadinessSnapshot* state_get_readiness_snapshot(void) {
    return &current_readiness_snapshot;
}
