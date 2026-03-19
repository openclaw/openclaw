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

static AppState current_state = STATE_NOT_INSTALLED;
static SystemdState current_sys_state = {0};
static HealthState current_health_state = {0};
static ProbeState current_probe_state = {0};
static gboolean initial_hydration_done = FALSE;

static AppState compute_state(void) {
    // Note: The primary normalized state is computed strictly from:
    // 1. systemd properties
    // 2. `gateway status --json` output (health lane)
    // The deep probe lane is intentionally excluded from the main tray truth
    // to avoid false negatives from network timeouts.
    if (!current_sys_state.installed) return STATE_NOT_INSTALLED;
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

void state_update_systemd(SystemdState *sys_state) {
    g_free(current_sys_state.active_state);
    g_free(current_sys_state.sub_state);
    g_strfreev(current_sys_state.exec_start_argv);
    g_strfreev(current_sys_state.environment);
    
    current_sys_state = *sys_state;
    current_sys_state.active_state = g_strdup(sys_state->active_state);
    current_sys_state.sub_state = g_strdup(sys_state->sub_state);
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
    
    trigger_updates(compute_state());
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

HealthState* state_get_health(void) {
    return &current_health_state;
}

ProbeState* state_get_probe(void) {
    return &current_probe_state;
}
