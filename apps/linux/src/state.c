/*
 * state.c
 *
 * Normalized state machine for the OpenClaw Linux Companion App.
 *
 * Computes an explicit 8-case normalized operational state (e.g. Running,
 * Degraded, Error) based on systemd properties and JSON status outputs.
 * Preserves secondary deep probe (gateway probe) data for diagnostics
 * without allowing it to falsely override the primary tray state.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include <glib.h>
#include "state.h"

extern void health_probe_gateway_eager(void);
extern void health_run_deep_probe_eager(void);

static AppState current_state = STATE_NOT_INSTALLED;
static SystemdState current_sys_state = {0};
static HealthState current_health_state = {0};
static ProbeState current_probe_state = {0};
static guint64 current_health_generation = 0;
static gboolean initial_hydration_done = FALSE;
static gboolean initial_probe_fired = FALSE;

static gboolean is_probe_disabled_state(AppState state) {
    return state == STATE_NOT_INSTALLED || 
           state == STATE_USER_SYSTEMD_UNAVAILABLE || 
           state == STATE_SYSTEM_UNSUPPORTED || 
           state == STATE_STOPPED;
}

static AppState compute_state(void) {
    // Note: The primary normalized state is computed strictly from:
    // 1. systemd properties
    // 2. `gateway status --json` output (health lane)
    // The deep probe lane is intentionally excluded from the main tray truth
    // to avoid false negatives from network timeouts.
    if (current_sys_state.systemd_unavailable) {
        return STATE_USER_SYSTEMD_UNAVAILABLE;
    }
    if (!current_sys_state.installed) {
        if (current_sys_state.system_installed_unsupported) {
            return STATE_SYSTEM_UNSUPPORTED;
        }
        return STATE_NOT_INSTALLED;
    }
    if (current_sys_state.failed) return STATE_ERROR;
    if (current_sys_state.activating) return STATE_STARTING;
    if (current_sys_state.deactivating) return STATE_STOPPING;
    
    if (current_sys_state.active) {
        // Startup Hydration Guard:
        // If the systemd service is active, but we haven't received a real health payload
        // from the gateway yet (last_updated == 0), we default to STATE_RUNNING.
        // This intentional startup rule prevents the tray from flashing 'STATE_DEGRADED'
        // momentarily while waiting for lane 2 (health probe) to produce its first sample.
        if (current_health_state.last_updated > 0) {
            if (!current_health_state.loaded) {
                return STATE_DEGRADED;
            }
            if (!current_health_state.rpc_ok || !current_health_state.health_healthy) {
                return STATE_DEGRADED;
            }
            if (!current_health_state.config_audit_ok && current_health_state.config_issues_count > 0) {
                return STATE_RUNNING_WITH_WARNING;
            }
        }
        return STATE_RUNNING;
    }
    
    return STATE_STOPPED;
}

void state_init(void) {
    current_state = STATE_NOT_INSTALLED;
    initial_hydration_done = FALSE;
    initial_probe_fired = FALSE;
}

static void trigger_updates(AppState new_state) {
    if (new_state != current_state) {
        AppState old_state = current_state;
        current_state = new_state;
        if (initial_hydration_done) {
            notify_on_transition(old_state, new_state);
        }
    }
    // Note: Tray/UI updates may still occur even when the normalized state enum
    // does not change. This is intentional because detailed lane data (like
    // in_flight flags, timestamps, probe summary) can still change and needs rendering.
    tray_update_from_state(current_state);
}

static gboolean idle_trigger_health_probe(gpointer user_data) {
    (void)user_data;
    health_probe_gateway_eager();
    return G_SOURCE_REMOVE;
}

static gboolean idle_trigger_deep_probe(gpointer user_data) {
    (void)user_data;
    health_run_deep_probe_eager();
    return G_SOURCE_REMOVE;
}

void state_update_systemd(SystemdState *sys_state) {
    AppState old_state = current_state;
    gboolean became_active = (!current_sys_state.active && sys_state->active);
    gboolean unit_changed = (g_strcmp0(current_sys_state.unit_name, sys_state->unit_name) != 0);

    g_free(current_sys_state.active_state);
    g_free(current_sys_state.sub_state);
    g_free(current_sys_state.unit_name);
    g_free(current_sys_state.working_directory);
    g_strfreev(current_sys_state.exec_start_argv);
    g_strfreev(current_sys_state.environment);
    
    current_sys_state = *sys_state;
    current_sys_state.systemd_unavailable = sys_state->systemd_unavailable;
    current_sys_state.active_state = g_strdup(sys_state->active_state);
    current_sys_state.sub_state = g_strdup(sys_state->sub_state);
    current_sys_state.unit_name = g_strdup(sys_state->unit_name);
    current_sys_state.working_directory = g_strdup(sys_state->working_directory);
    if (sys_state->exec_start_argv) {
        current_sys_state.exec_start_argv = g_strdupv(sys_state->exec_start_argv);
    } else {
        current_sys_state.exec_start_argv = NULL;
    }
    if (sys_state->environment) {
        current_sys_state.environment = g_strdupv(sys_state->environment);
    } else {
        current_sys_state.environment = NULL;
    }
    
    AppState new_state = compute_state();
    
    // Clear stale diagnostics when entering a state where background probes are disabled.
    // This prevents the UI from showing old "Healthy" or "Reachable" strings for dead services.
    if (!is_probe_disabled_state(old_state) && is_probe_disabled_state(new_state)) {
        current_health_state.last_updated = 0;
        current_probe_state.last_updated = 0;
        g_free(current_probe_state.summary);
        current_probe_state.summary = NULL;
        current_health_generation++;
    } else if (became_active || unit_changed) {
        // Reset the health snapshot explicitly on the relevant systemd transition
        // or unit retargeting so the state model has a clear freshness boundary.
        current_health_state.last_updated = 0;
        current_health_generation++;
    }
    
    gboolean is_supported = (new_state != STATE_NOT_INSTALLED && new_state != STATE_SYSTEM_UNSUPPORTED && new_state != STATE_USER_SYSTEMD_UNAVAILABLE);
    gboolean should_trigger_probes = is_supported && (!initial_probe_fired || became_active || unit_changed);

    if (should_trigger_probes) {
        initial_probe_fired = TRUE;
        // Re-run immediate probes on any freshness-boundary transition (first hydration,
        // activation, or unit retargeting) to avoid leaving the UI in a stale or generic 
        // "Running" state until the next periodic timer fires.
        // Defer probes asynchronously to keep state mutation fast and decoupled
        g_idle_add(idle_trigger_health_probe, NULL);
        g_idle_add(idle_trigger_deep_probe, NULL);
    }
    
    trigger_updates(new_state);
    initial_hydration_done = TRUE;
}

void state_set_health_in_flight(gboolean in_flight) {
    current_health_state.in_flight = in_flight;
}

void state_update_health(HealthState *health_state) {
    g_free(current_health_state.bind_host);
    g_free(current_health_state.probe_url);
    
    // Only update the snapshot payload and timestamp.
    // The in_flight flag is strictly owned by state_set_health_in_flight.
    current_health_state.last_updated = health_state->last_updated;
    current_health_state.loaded = health_state->loaded;
    current_health_state.rpc_ok = health_state->rpc_ok;
    current_health_state.health_healthy = health_state->health_healthy;
    current_health_state.config_audit_ok = health_state->config_audit_ok;
    current_health_state.config_issues_count = health_state->config_issues_count;
    current_health_state.port = health_state->port;
    
    current_health_state.bind_host = g_strdup(health_state->bind_host);
    current_health_state.probe_url = g_strdup(health_state->probe_url);
    
    trigger_updates(compute_state());
}

void state_set_probe_in_flight(gboolean in_flight) {
    current_probe_state.in_flight = in_flight;
}

void state_update_probe(ProbeState *probe_state) {
    g_free(current_probe_state.summary);
    
    // Note: Probe updates do not feed compute_state(). 
    // Deep probe remains diagnostics-only by design.
    
    // Only update the snapshot payload and timestamp.
    // The in_flight flag is strictly owned by state_set_probe_in_flight.
    current_probe_state.last_updated = probe_state->last_updated;
    current_probe_state.ran = probe_state->ran;
    current_probe_state.reachable = probe_state->reachable;
    current_probe_state.connect_ok = probe_state->connect_ok;
    current_probe_state.rpc_ok = probe_state->rpc_ok;
    current_probe_state.timed_out = probe_state->timed_out;
    
    current_probe_state.summary = g_strdup(probe_state->summary);
}

AppState state_get_current(void) {
    return current_state;
}

const char* state_get_current_string(void) {
    switch (current_state) {
        case STATE_NOT_INSTALLED: return "Not Installed";
        case STATE_USER_SYSTEMD_UNAVAILABLE: return "User Systemd Unavailable";
        case STATE_SYSTEM_UNSUPPORTED: return "System Service (Unsupported)";
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

SystemdState* state_get_systemd(void) {
    return &current_sys_state;
}

guint64 state_get_health_generation(void) {
    return current_health_generation;
}

HealthState* state_get_health(void) {
    return &current_health_state;
}

ProbeState* state_get_probe(void) {
    return &current_probe_state;
}
