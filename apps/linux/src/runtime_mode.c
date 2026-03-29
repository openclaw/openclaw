/*
 * runtime_mode.c
 *
 * Proof-oriented runtime-mode derivation for the OpenClaw Linux Companion App.
 *
 * Computes a RuntimeMode classification from the available evidence
 * (SystemdState + HealthState). This is a separate semantic dimension
 * from AppState: AppState answers "what lifecycle/readiness class?"
 * while RuntimeMode answers "what kind of runtime situation was observed?"
 *
 * These classifications describe what the app can actually infer from
 * its evidence model. They do NOT claim lifecycle ownership ("started
 * by us") or macOS-style attach knowledge ("adopted existing").
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "state.h"
#include <stddef.h>

gboolean health_state_listener_proven(const HealthState *hs) {
    if (!hs) return FALSE;
    return hs->http_probe_result == HTTP_PROBE_OK
        || hs->http_probe_result == HTTP_PROBE_TIMED_OUT_AFTER_CONNECT
        || hs->http_probe_result == HTTP_PROBE_INVALID_RESPONSE;
}

RuntimeMode runtime_mode_compute(const SystemdState *sys, const HealthState *health) {
    gboolean has_health_data = (health && health->last_updated > 0);
    gboolean expected_service_active = (sys && sys->installed && sys->active);

    /*
     * Runtime evidence: at least one actual probe or transport signal
     * beyond config/setup checks. Health state can be populated from
     * config parsing alone (setup_detected, config_valid) without any
     * runtime probe — that does NOT count as runtime evidence.
     */
    gboolean has_runtime_evidence = has_health_data && (
        health->http_probe_result != HTTP_PROBE_NONE ||
        health->ws_connected ||
        health->rpc_ok ||
        health->auth_ok
    );

    gboolean gateway_fully_healthy = has_runtime_evidence
        && health->http_ok
        && health->ws_connected
        && health->rpc_ok
        && health->auth_ok;

    gboolean listener_proven = has_runtime_evidence && health_state_listener_proven(health);

    /* No runtime evidence gathered yet */
    if (!has_runtime_evidence) {
        if (expected_service_active) {
            return RUNTIME_SERVICE_ACTIVE_NOT_PROVEN;
        }
        return RUNTIME_NONE;
    }

    /* Fully healthy endpoint */
    if (gateway_fully_healthy) {
        if (expected_service_active) {
            return RUNTIME_EXPECTED_SERVICE_HEALTHY;
        }
        return RUNTIME_HEALTHY_OUTSIDE_EXPECTED_SERVICE;
    }

    /* Listener proven present but not fully healthy */
    if (listener_proven) {
        if (health->http_probe_result == HTTP_PROBE_INVALID_RESPONSE) {
            return RUNTIME_LISTENER_PRESENT_UNVERIFIED;
        }
        if (health->http_probe_result == HTTP_PROBE_TIMED_OUT_AFTER_CONNECT) {
            return RUNTIME_LISTENER_PRESENT_UNRESPONSIVE;
        }
        /* HTTP_PROBE_OK but not fully healthy → partial protocol */
        return RUNTIME_LISTENER_PRESENT_UNRESPONSIVE;
    }

    /* Service active but no listener proof */
    if (expected_service_active) {
        return RUNTIME_SERVICE_ACTIVE_NOT_PROVEN;
    }

    return RUNTIME_UNKNOWN;
}

void runtime_mode_describe(RuntimeMode mode, RuntimeModePresentation *out) {
    if (!out) return;

    out->label = NULL;
    out->explanation = NULL;

    switch (mode) {
    case RUNTIME_NONE:
        out->label = "No Runtime Detected";
        out->explanation = "No gateway runtime evidence has been gathered.";
        break;

    case RUNTIME_EXPECTED_SERVICE_HEALTHY:
        out->label = "Expected Service Healthy";
        out->explanation =
            "The expected user systemd service path is active and the "
            "configured endpoint is healthy.";
        break;

    case RUNTIME_HEALTHY_OUTSIDE_EXPECTED_SERVICE:
        out->label = "Healthy (Outside Expected Service)";
        out->explanation =
            "A healthy gateway is reachable at the configured endpoint, "
            "but the expected user systemd service is not the active "
            "explanation.";
        break;

    case RUNTIME_LISTENER_PRESENT_UNRESPONSIVE:
        out->label = "Listener Present (Unresponsive)";
        out->explanation =
            "A listener accepted a connection on the configured endpoint, "
            "but health/protocol readiness was not established.";
        break;

    case RUNTIME_LISTENER_PRESENT_UNVERIFIED:
        out->label = "Listener Present (Unverified)";
        out->explanation =
            "Something is listening on the configured endpoint, but it "
            "was not validated as a healthy OpenClaw gateway.";
        break;

    case RUNTIME_SERVICE_ACTIVE_NOT_PROVEN:
        out->label = "Service Active (Not Proven)";
        out->explanation =
            "The systemd service reports active, but runtime health has "
            "not been confirmed yet.";
        break;

    case RUNTIME_UNKNOWN:
    default:
        out->label = "Unknown";
        out->explanation = "Runtime state could not be classified.";
        break;
    }
}
