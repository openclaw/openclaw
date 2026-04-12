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

const char* readiness_chat_block_reason_to_string(ChatBlockReason reason) {
    switch (reason) {
    case CHAT_BLOCK_NONE:
        return "Ready";
    case CHAT_BLOCK_NO_CONFIG:
        return "No config detected";
    case CHAT_BLOCK_CONFIG_INVALID:
        return "Config invalid";
    case CHAT_BLOCK_BOOTSTRAP_INCOMPLETE:
        return "Bootstrap incomplete";
    case CHAT_BLOCK_SERVICE_INACTIVE:
        return "Service inactive";
    case CHAT_BLOCK_GATEWAY_UNREACHABLE:
        return "Gateway unreachable";
    case CHAT_BLOCK_AUTH_INVALID:
        return "Auth not usable";
    case CHAT_BLOCK_PROVIDER_MISSING:
        return "Provider missing";
    case CHAT_BLOCK_DEFAULT_MODEL_MISSING:
        return "Default model missing";
    case CHAT_BLOCK_MODEL_CATALOG_EMPTY:
        return "Model catalog unavailable";
    case CHAT_BLOCK_SELECTED_MODEL_UNRESOLVED:
        return "Selected model unresolved";
    case CHAT_BLOCK_AGENTS_UNAVAILABLE:
        return "Agents unavailable";
    case CHAT_BLOCK_UNKNOWN:
    default:
        return "Unknown";
    }
}

void readiness_describe_chat_gate(const DesktopReadinessSnapshot *snapshot,
                                  ChatGateInfo *out) {
    if (!out) return;

    out->ready = FALSE;
    out->reason = CHAT_BLOCK_UNKNOWN;
    out->status = "Chat readiness unknown.";
    out->next_action = "Refresh gateway status.";

    if (!snapshot) {
        return;
    }

    out->ready = snapshot->desktop_chat_ready;
    out->reason = snapshot->chat_block_reason;

    switch (snapshot->chat_block_reason) {
    case CHAT_BLOCK_NONE:
        out->status = "Chat is ready.";
        out->next_action = NULL;
        break;
    case CHAT_BLOCK_NO_CONFIG:
        out->status = "No OpenClaw config detected.";
        out->next_action = "Run 'openclaw onboard --install-daemon' to bootstrap OpenClaw.";
        break;
    case CHAT_BLOCK_CONFIG_INVALID:
        out->status = "Gateway configuration is invalid.";
        out->next_action = "Open Config and fix validation errors in openclaw.json.";
        break;
    case CHAT_BLOCK_BOOTSTRAP_INCOMPLETE:
        out->status = "Gateway bootstrapped, but onboarding is incomplete.";
        out->next_action = "Complete onboarding setup, then configure provider/model.";
        break;
    case CHAT_BLOCK_SERVICE_INACTIVE:
        out->status = "Gateway service is not active.";
        out->next_action = "Start the service from Dashboard or run 'openclaw gateway run'.";
        break;
    case CHAT_BLOCK_GATEWAY_UNREACHABLE:
        out->status = "Gateway connection is not fully established.";
        out->next_action = "Wait for connection or restart the gateway service.";
        break;
    case CHAT_BLOCK_AUTH_INVALID:
        out->status = "Gateway auth handshake is not complete.";
        out->next_action = "Check gateway auth config and reconnect.";
        break;
    case CHAT_BLOCK_PROVIDER_MISSING:
        out->status = "No provider configured yet.";
        out->next_action = "Open Config and add a model provider.";
        break;
    case CHAT_BLOCK_DEFAULT_MODEL_MISSING:
        out->status = "No default model selected yet.";
        out->next_action = "Open Config and select a default model.";
        break;
    case CHAT_BLOCK_MODEL_CATALOG_EMPTY:
        out->status = "Model catalog is unavailable.";
        out->next_action = "Reload models after provider configuration.";
        break;
    case CHAT_BLOCK_SELECTED_MODEL_UNRESOLVED:
        out->status = "Configured default model is not available in the current catalog.";
        out->next_action = "Reload models and choose an available default model.";
        break;
    case CHAT_BLOCK_AGENTS_UNAVAILABLE:
        out->status = "No agents available for chat.";
        out->next_action = "Create or enable an agent in Agents.";
        break;
    case CHAT_BLOCK_UNKNOWN:
    default:
        out->status = "Chat prerequisites are not yet satisfied.";
        out->next_action = "Refresh gateway status and review diagnostics.";
        break;
    }
}

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
        out->next_action = "Run 'openclaw onboard --install-daemon' to set up OpenClaw.";
        break;

    case STATE_NEEDS_GATEWAY_INSTALL:
        out->classification = "Gateway Service Missing";
        out->missing = "The expected user systemd service path is not active and the unit file is missing.";
        out->next_action = "The gateway service is not installed. Run 'openclaw onboard --install-daemon' to set up OpenClaw.";
        break;

    case STATE_NEEDS_ONBOARDING:
        out->classification = "Bootstrap Incomplete";
        out->missing = "OpenClaw bootstrap is incomplete. The onboarding wizard has not been run.";
        out->next_action = "Run 'openclaw onboard --install-daemon' to complete setup.";
        break;

    case STATE_USER_SYSTEMD_UNAVAILABLE:
        out->classification = "Systemd Unavailable";
        out->missing = "Cannot connect to the user systemd session bus.";
        out->next_action = "Ensure your session supports user systemd services (systemctl --user).";
        break;

    case STATE_SYSTEM_UNSUPPORTED:
        out->classification = "System Service (Unsupported)";
        out->missing = "A system-scope gateway unit was found, but only user-scope services are supported.";
        out->next_action = "Use a user-scope OpenClaw service instead of a system-scope unit.";
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
            if (health->http_probe_result == HTTP_PROBE_TIMED_OUT_AFTER_CONNECT) {
                out->missing = "Gateway accepted a connection but did not respond in time.";
                out->next_action = "Gateway process may be hung. Check gateway logs and restart the service.";
            } else {
                out->missing = "Service reports active, but gateway is not reachable via HTTP.";
                out->next_action = "Check gateway logs and network configuration. Try restarting the service.";
            }
        } else {
            out->missing = "Gateway connectivity is partially established.";
        }
        if (!out->next_action) {
            out->next_action = "Check gateway logs and network configuration. Try restarting the service.";
        }
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

void readiness_build_onboarding_progress(AppState state,
                                         const HealthState *health,
                                         const SystemdState *sys,
                                         OnboardingStageProgress *out) {
    if (!out) return;

    out->configuration = ONBOARDING_STAGE_PENDING;
    out->service_gateway = ONBOARDING_STAGE_PENDING;
    out->connection = ONBOARDING_STAGE_PENDING;
    out->operational_ready = (state == STATE_RUNNING || state == STATE_RUNNING_WITH_WARNING);

    gboolean config_complete = (health && health->config_valid);
    gboolean service_installed = (sys && sys->installed);
    gboolean service_active = (sys && sys->active);
    gboolean connection_complete = (health && health->http_ok && health->ws_connected &&
                                    health->rpc_ok && health->auth_ok);

    if (config_complete) {
        out->configuration = ONBOARDING_STAGE_COMPLETE;
    } else if (state == STATE_CONFIG_INVALID || state == STATE_NEEDS_ONBOARDING ||
               state == STATE_NEEDS_GATEWAY_INSTALL || state == STATE_STARTING ||
               state == STATE_DEGRADED || state == STATE_RUNNING ||
               state == STATE_RUNNING_WITH_WARNING) {
        out->configuration = ONBOARDING_STAGE_IN_PROGRESS;
    }

    if (!config_complete) {
        out->service_gateway = ONBOARDING_STAGE_PENDING;
    } else if (service_installed && service_active) {
        out->service_gateway = ONBOARDING_STAGE_COMPLETE;
    } else if (service_installed) {
        out->service_gateway = ONBOARDING_STAGE_IN_PROGRESS;
    } else {
        out->service_gateway = ONBOARDING_STAGE_PENDING;
    }

    if (!(service_installed && service_active)) {
        out->connection = ONBOARDING_STAGE_PENDING;
    } else if (connection_complete) {
        out->connection = ONBOARDING_STAGE_COMPLETE;
    } else {
        out->connection = ONBOARDING_STAGE_IN_PROGRESS;
    }
}
