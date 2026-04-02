/*
 * display_model.c
 *
 * Pure display-model helpers for the OpenClaw Linux Companion App.
 *
 * Transforms backend state into UI-ready data structures with no GTK
 * dependency. All functions are deterministic pure-logic mappers
 * suitable for automated testing.
 *
 * Control Semantics:
 *   Service control actions (start/stop/restart) target the expected
 *   user systemd service unit. The display model makes this explicit
 *   via service_context_notice when the observed runtime is not
 *   explained by the expected service path.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "display_model.h"
#include <string.h>
#include <unistd.h>
#include <stdio.h>

/* ── HTTP probe labels ── */

const char* http_probe_result_label(HttpProbeResult probe) {
    switch (probe) {
    case HTTP_PROBE_NONE:                   return "No probe yet";
    case HTTP_PROBE_OK:                     return "OK";
    case HTTP_PROBE_CONNECT_REFUSED:        return "Connection refused";
    case HTTP_PROBE_CONNECT_TIMEOUT:        return "Connection timed out";
    case HTTP_PROBE_TIMED_OUT_AFTER_CONNECT: return "Timed out after connect";
    case HTTP_PROBE_INVALID_RESPONSE:       return "Invalid response";
    case HTTP_PROBE_UNKNOWN_ERROR:          return "Unknown error";
    default:                                return "Unknown";
    }
}

/* ── Status color mapping ── */

static StatusColor color_for_state(AppState state) {
    switch (state) {
    case STATE_RUNNING:
        return STATUS_COLOR_GREEN;
    case STATE_RUNNING_WITH_WARNING:
    case STATE_DEGRADED:
    case STATE_STARTING:
    case STATE_STOPPING:
        return STATUS_COLOR_ORANGE;
    case STATE_ERROR:
    case STATE_CONFIG_INVALID:
        return STATUS_COLOR_RED;
    default:
        return STATUS_COLOR_GRAY;
    }
}

/* ── Service context notice constants ── */

static const char *NOTICE_EXTERNAL_GATEWAY =
    "Service controls target the expected systemd unit, not "
    "the runtime currently serving this endpoint.";

static const char *NOTICE_LISTENER_NOT_PROVEN_SERVICE =
    "Service controls target the expected systemd unit. The "
    "companion cannot confirm that the listener on this port "
    "corresponds to the expected service.";

/* ── Dashboard display model ── */

void dashboard_display_model_build(
    AppState state,
    RuntimeMode runtime_mode,
    const ReadinessInfo *readiness,
    const HealthState *health,
    const SystemdState *sys,
    DashboardDisplayModel *out)
{
    if (!out) return;
    memset(out, 0, sizeof(*out));

    /* Headline + color from readiness classification */
    out->headline = readiness ? readiness->classification : "Unknown";
    out->headline_color = color_for_state(state);

    /* Runtime mode presentation */
    RuntimeModePresentation rmp;
    runtime_mode_describe(runtime_mode, &rmp);
    out->runtime_label = rmp.label;
    out->runtime_detail = rmp.explanation;

    /* Readiness guidance */
    if (readiness) {
        out->guidance_text = readiness->missing;
        out->next_action = readiness->next_action;
    }

    /*
     * Service control actions — target the expected systemd unit.
     *
     * Enabled based on whether the expected service is installed and
     * the current lifecycle allows the action. These do NOT claim
     * control over an external/manual runtime.
     */
    gboolean service_installed = sys && sys->installed;
    gboolean service_active = sys && sys->active;
    gboolean service_activating = sys && sys->activating;
    gboolean service_deactivating = sys && sys->deactivating;
    gboolean in_transition = service_activating || service_deactivating;

    out->can_start = service_installed && !service_active && !in_transition;
    out->can_stop = service_installed && service_active && !in_transition;
    out->can_restart = service_installed && service_active && !in_transition;

    /* Dashboard browser action — available when config is valid */
    out->can_open_dashboard = (health && health->config_valid);

    /*
     * Service context notice: qualify service actions when the
     * observed runtime is not explained by the expected service.
     */
    switch (runtime_mode) {
    case RUNTIME_HEALTHY_OUTSIDE_EXPECTED_SERVICE:
        out->service_context_notice = NOTICE_EXTERNAL_GATEWAY;
        break;
    case RUNTIME_LISTENER_PRESENT_UNRESPONSIVE:
    case RUNTIME_LISTENER_PRESENT_UNVERIFIED:
        out->service_context_notice = NOTICE_LISTENER_NOT_PROVEN_SERVICE;
        break;
    default:
        out->service_context_notice = NULL;
        break;
    }

    /* Connectivity detail */
    if (health) {
        out->endpoint_display = health->endpoint_host; /* "host" — port added by UI */
        out->gateway_version = health->gateway_version;
        out->http_probe_label = http_probe_result_label(health->http_probe_result);
        out->ws_connected = health->ws_connected;
        out->rpc_ok = health->rpc_ok;
        out->auth_ok = health->auth_ok;
        out->auth_source = health->auth_source;
    }

    /* Systemd context */
    if (sys) {
        out->unit_name = sys->unit_name;
        out->active_state = sys->active_state;
        out->sub_state = sys->sub_state;
    }
}

/* ── Tray display model ── */

/* Tray status label prefix by AppState */
static const char* tray_status_prefix(AppState state) {
    switch (state) {
    case STATE_RUNNING:                return "\u25CF Running";
    case STATE_RUNNING_WITH_WARNING:   return "\u25C9 Running (Warning)";
    case STATE_DEGRADED:               return "\u25C9 Degraded";
    case STATE_ERROR:                  return "\u25CF Error";
    case STATE_STOPPED:                return "\u25CB Stopped";
    case STATE_STARTING:               return "\u25CC Starting\u2026";
    case STATE_STOPPING:               return "\u25CC Stopping\u2026";
    case STATE_NEEDS_SETUP:            return "\u25CB Setup Required";
    case STATE_NEEDS_GATEWAY_INSTALL:  return "\u25CB Gateway Not Installed";
    case STATE_CONFIG_INVALID:         return "\u25CF Config Invalid";
    case STATE_USER_SYSTEMD_UNAVAILABLE: return "\u25CB Systemd Unavailable";
    case STATE_SYSTEM_UNSUPPORTED:     return "\u25CB System Unsupported";
    default:                           return "\u25CB Unknown";
    }
}

void tray_display_model_build(
    AppState state,
    RuntimeMode runtime_mode,
    const HealthState *health,
    TrayDisplayModel *out)
{
    if (!out) return;
    memset(out, 0, sizeof(*out));

    out->status_label = tray_status_prefix(state);

    RuntimeModePresentation rmp;
    runtime_mode_describe(runtime_mode, &rmp);
    out->runtime_label = rmp.label;

    /* Action sensitivities mirror dashboard logic but simplified */
    gboolean can_act = (state != STATE_STARTING && state != STATE_STOPPING);
    gboolean is_stoppable = (state == STATE_RUNNING ||
                             state == STATE_RUNNING_WITH_WARNING ||
                             state == STATE_DEGRADED);
    gboolean is_startable = (state == STATE_STOPPED ||
                             state == STATE_ERROR);

    out->start_sensitive = is_startable && can_act;
    out->stop_sensitive = is_stoppable && can_act;
    out->restart_sensitive = is_stoppable && can_act;
    out->refresh_sensitive = TRUE;
    out->open_dashboard_sensitive = (health && health->config_valid);
}

/* ── Config display model ── */

void config_display_model_build(
    const HealthState *health,
    const char *config_path,
    ConfigDisplayModel *out)
{
    if (!out) return;
    memset(out, 0, sizeof(*out));

    out->config_path = config_path;

    if (!health) {
        out->is_valid = FALSE;
        out->warning_text = "Health state not available.";
        return;
    }

    out->is_valid = health->config_valid;
    out->issues_count = health->config_issues_count;

    if (!health->config_valid) {
        out->warning_text = health->last_error
            ? health->last_error
            : "Configuration could not be loaded or is invalid.";
    } else if (health->config_issues_count > 0) {
        out->warning_text = "Configuration loaded with warnings.";
    }
}

/* ── Environment check ── */

void environment_check_build(
    const SystemdState *sys,
    const char *config_path,
    const char *state_dir,
    EnvironmentCheckResult *out)
{
    if (!out) return;
    memset(out, 0, sizeof(*out));
    int i = 0;

    /* 1. User systemd session */
    out->rows[i].label = "User systemd session";
    if (sys && !sys->systemd_unavailable) {
        out->rows[i].passed = TRUE;
        out->rows[i].detail = "Available";
    } else {
        out->rows[i].passed = FALSE;
        out->rows[i].detail = "Cannot connect to user systemd session bus.";
    }
    i++;

    /* 2. D-Bus session bus — if systemd works, D-Bus works */
    out->rows[i].label = "D-Bus session bus";
    out->rows[i].passed = (sys && !sys->systemd_unavailable);
    out->rows[i].detail = out->rows[i].passed ? "Reachable" : "Not reachable";
    i++;

    /* 3. Config file readable */
    out->rows[i].label = "Config file";
    if (config_path && config_path[0] != '\0') {
        out->rows[i].passed = (access(config_path, R_OK) == 0);
        out->rows[i].detail = config_path;
    } else {
        out->rows[i].passed = FALSE;
        out->rows[i].detail = "No config path resolved.";
    }
    i++;

    /* 4. State directory writable */
    out->rows[i].label = "State directory";
    if (state_dir && state_dir[0] != '\0') {
        out->rows[i].passed = (access(state_dir, W_OK) == 0);
        out->rows[i].detail = state_dir;
    } else {
        out->rows[i].passed = FALSE;
        out->rows[i].detail = "No state directory resolved.";
    }
    i++;

    /* 5. Expected systemd unit present */
    out->rows[i].label = "Expected systemd unit";
    if (sys && sys->installed) {
        out->rows[i].passed = TRUE;
        out->rows[i].detail = sys->unit_name ? sys->unit_name : "Installed";
    } else if (sys && sys->systemd_unavailable) {
        out->rows[i].passed = FALSE;
        out->rows[i].detail = "Systemd unavailable";
    } else {
        out->rows[i].passed = FALSE;
        out->rows[i].detail = "Not installed";
    }
    i++;

    out->count = i;
}

/* ── Onboarding routing ── */

OnboardingRoute onboarding_routing_decide(
    AppState state,
    int seen_version,
    int current_version)
{
    /* Already completed current or newer version */
    if (seen_version >= current_version) {
        return ONBOARDING_SKIP;
    }

    /* First run or outdated version — decide flow shape */
    switch (state) {
    case STATE_RUNNING:
    case STATE_RUNNING_WITH_WARNING:
        /* Gateway already healthy: shortened flow */
        return ONBOARDING_SHOW_SHORTENED;

    case STATE_NEEDS_SETUP:
    case STATE_NEEDS_GATEWAY_INSTALL:
    case STATE_CONFIG_INVALID:
    case STATE_ERROR:
    case STATE_STOPPED:
    case STATE_DEGRADED:
    case STATE_USER_SYSTEMD_UNAVAILABLE:
    case STATE_SYSTEM_UNSUPPORTED:
        /* Needs guidance: full flow */
        return ONBOARDING_SHOW_FULL;

    case STATE_STARTING:
    case STATE_STOPPING:
        /* Transitional: show shortened, gateway may become healthy */
        return ONBOARDING_SHOW_SHORTENED;

    default:
        return ONBOARDING_SHOW_FULL;
    }
}
