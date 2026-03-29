/*
 * readiness.c
 *
 * Readiness presentation for the OpenClaw Linux Companion App.
 *
 * Derives user-facing readiness information from the canonical AppState.
 * This module consumes the state derivation result from compute_state()
 * and does NOT introduce a second decision table or alternate semantics.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "readiness.h"
#include <stddef.h>

void readiness_evaluate(AppState state, const HealthState *health,
                        const SystemdState *sys, ReadinessInfo *out) {
    if (!out) return;

    out->classification = NULL;
    out->missing = NULL;
    out->next_action = NULL;

    switch (state) {
    case STATE_NEEDS_SETUP:
        out->classification = "Setup Required";
        out->missing = "No OpenClaw configuration or state directory detected.";
        out->next_action = "Run 'openclaw setup' to initialize the OpenClaw environment.";
        break;

    case STATE_NEEDS_GATEWAY_INSTALL:
        out->classification = "Gateway Not Installed";
        out->missing = "OpenClaw is configured, but no gateway service is installed.";
        out->next_action = "Run 'openclaw gateway install' to install the gateway service.";
        break;

    case STATE_USER_SYSTEMD_UNAVAILABLE:
        out->classification = "Systemd Unavailable";
        out->missing = "Cannot connect to the user systemd session bus.";
        out->next_action = "Ensure your session supports user systemd services (systemctl --user).";
        break;

    case STATE_SYSTEM_UNSUPPORTED:
        out->classification = "System Service (Unsupported)";
        out->missing = "A system-scope gateway unit was found, but only user-scope services are supported.";
        out->next_action = "Run 'openclaw gateway install' to install a user-scope service.";
        break;

    case STATE_CONFIG_INVALID:
        out->classification = "Configuration Invalid";
        if (health && health->last_error) {
            out->missing = health->last_error;
        } else {
            out->missing = "Gateway configuration could not be loaded or failed validation.";
        }
        out->next_action = "Check your openclaw.json configuration file and correct any errors.";
        break;

    case STATE_STOPPED:
        out->classification = "Stopped";
        out->missing = "The gateway service is installed but not running.";
        out->next_action = "Start the gateway service from the tray menu or run 'openclaw gateway run'.";
        break;

    case STATE_STARTING:
        out->classification = "Starting";
        out->missing = "The gateway service is starting up. Waiting for connectivity confirmation.";
        out->next_action = NULL;
        break;

    case STATE_STOPPING:
        out->classification = "Stopping";
        out->missing = "The gateway service is shutting down.";
        out->next_action = NULL;
        break;

    case STATE_RUNNING:
        out->classification = "Fully Ready";
        out->missing = NULL;
        out->next_action = NULL;
        break;

    case STATE_RUNNING_WITH_WARNING:
        out->classification = "Running (Config Warning)";
        out->missing = "The gateway is running but configuration audit detected issues.";
        out->next_action = "Review configuration warnings in the diagnostics panel.";
        break;

    case STATE_DEGRADED:
        out->classification = "Degraded";
        if (health && health->http_ok && !health->ws_connected) {
            out->missing = "HTTP health OK, but WebSocket connection not established.";
        } else if (health && health->http_ok && health->ws_connected) {
            out->missing = "Connected, but RPC or auth handshake incomplete.";
        } else if (health && !health->http_ok && sys && sys->active) {
            out->missing = "Service reports active, but gateway is not reachable via HTTP.";
        } else {
            out->missing = "Gateway connectivity is partially established.";
        }
        out->next_action = "Check gateway logs and network configuration. Try restarting the service.";
        break;

    case STATE_ERROR:
        out->classification = "Error";
        out->missing = "The gateway service has entered a failed state.";
        if (sys && sys->sub_state) {
            out->missing = "The gateway service has failed (check systemd journal for details).";
        }
        out->next_action = "Check 'journalctl --user -u <unit>' for failure details, then restart.";
        break;

    default:
        out->classification = "Unknown";
        out->missing = "Unexpected application state.";
        out->next_action = NULL;
        break;
    }
}
