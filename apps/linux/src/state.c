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
static guint64 current_health_generation = 0;
static gboolean initial_hydration_done = FALSE;
static gboolean initial_refresh_fired = FALSE;

/* Defined in runtime_mode.c — internal to the state module */
extern RuntimeMode runtime_mode_compute(const SystemdState *sys, const HealthState *health);

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
    initial_hydration_done = FALSE;
    initial_refresh_fired = FALSE;

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
    OC_LOG_DEBUG(OPENCLAW_LOG_CAT_STATE, "trigger_updates pre-tray state=%s",
              state_enum_to_string(current_state));
    tray_update_from_state(current_state);
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

    gboolean should_trigger_refresh = (!initial_refresh_fired || became_active || became_inactive || unit_changed);
    if (should_trigger_refresh) {
        initial_refresh_fired = TRUE;
        g_idle_add(idle_request_gateway_refresh, NULL);
    }

    trigger_updates(new_state);
    initial_hydration_done = TRUE;
}

void state_update_health(const HealthState *health_state) {
    g_free(current_health_state.endpoint_host);
    g_free(current_health_state.gateway_version);
    g_free(current_health_state.auth_source);
    g_free(current_health_state.last_error);

    current_health_state.last_updated = health_state->last_updated;
    current_health_state.http_ok = health_state->http_ok;
    current_health_state.http_probe_result = health_state->http_probe_result;
    current_health_state.ws_connected = health_state->ws_connected;
    current_health_state.rpc_ok = health_state->rpc_ok;
    current_health_state.auth_ok = health_state->auth_ok;
    current_health_state.config_valid = health_state->config_valid;
    current_health_state.setup_detected = health_state->setup_detected;
    current_health_state.endpoint_port = health_state->endpoint_port;
    current_health_state.config_audit_ok = health_state->config_audit_ok;
    current_health_state.config_issues_count = health_state->config_issues_count;

    current_health_state.endpoint_host = g_strdup(health_state->endpoint_host);
    current_health_state.gateway_version = g_strdup(health_state->gateway_version);
    current_health_state.auth_source = g_strdup(health_state->auth_source);
    current_health_state.last_error = g_strdup(health_state->last_error);

    AppState new_state = compute_state();
    current_runtime_mode = runtime_mode_compute(&current_sys_state, &current_health_state);
    trigger_updates(new_state);
}

AppState state_get_current(void) {
    return current_state;
}

const char* state_get_current_string(void) {
    switch (current_state) {
        case STATE_NEEDS_SETUP: return "Setup Required";
        case STATE_NEEDS_GATEWAY_INSTALL: return "Gateway Not Installed";
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
