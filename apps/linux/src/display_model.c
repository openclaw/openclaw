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
    case STATE_NEEDS_ONBOARDING:
        return STATUS_COLOR_ORANGE;
    case STATE_ERROR:
    case STATE_CONFIG_INVALID:
    case STATE_NEEDS_SETUP:
    case STATE_NEEDS_GATEWAY_INSTALL:
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
    case STATE_NEEDS_GATEWAY_INSTALL: return "\u25CB Gateway Not Installed";
    case STATE_NEEDS_ONBOARDING:       return "\u25CB Onboarding Required";
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

static gchar* display_safe_path(const gchar *path) {
    if (!path || path[0] == '\0') return NULL;
    if (g_utf8_validate(path, -1, NULL)) {
        return g_strdup(path);
    }
    return g_filename_display_name(path);
}

static void environment_check_row_set(EnvironmentCheckResult *out,
                                      int index,
                                      const char *label,
                                      gboolean passed,
                                      const gchar *detail)
{
    out->rows[index].label = label;
    out->rows[index].passed = passed;
    out->rows[index].detail = g_strdup(detail ? detail : "");
}

void runtime_path_status_build(
    const gchar *runtime_config_path,
    const gchar *runtime_state_dir,
    const gchar *loaded_config_path,
    RuntimePathStatus *out)
{
    if (!out) return;
    memset(out, 0, sizeof(*out));

    const gchar *effective_config_path = NULL;
    gchar *config_dir_raw = NULL;
    const gchar *state_dir_raw = NULL;

    /* Precedence contract: loaded config path (gateway client) wins over
     * runtime context path, which wins over unresolved state. */
    if (loaded_config_path && loaded_config_path[0] != '\0') {
        effective_config_path = loaded_config_path;
    } else if (runtime_config_path && runtime_config_path[0] != '\0') {
        effective_config_path = runtime_config_path;
    }

    if (effective_config_path) {
        out->config_path_resolved = TRUE;
        out->config_file_exists = g_file_test(effective_config_path, G_FILE_TEST_EXISTS);

        config_dir_raw = g_path_get_dirname(effective_config_path);
        if (config_dir_raw && config_dir_raw[0] != '\0') {
            out->config_dir_exists = g_file_test(config_dir_raw, G_FILE_TEST_IS_DIR);
        }

        out->config_path = display_safe_path(effective_config_path);
        out->config_dir = display_safe_path(config_dir_raw);
    }

    if (runtime_state_dir && runtime_state_dir[0] != '\0') {
        state_dir_raw = runtime_state_dir;
    } else if (config_dir_raw && config_dir_raw[0] != '\0') {
        state_dir_raw = config_dir_raw;
    }

    if (state_dir_raw && state_dir_raw[0] != '\0') {
        out->state_dir_resolved = TRUE;
        out->state_dir_exists = g_file_test(state_dir_raw, G_FILE_TEST_IS_DIR);
        out->state_dir = display_safe_path(state_dir_raw);
    }

    g_free(config_dir_raw);
}

void runtime_path_status_clear(RuntimePathStatus *status) {
    if (!status) return;
    g_clear_pointer(&status->config_path, g_free);
    g_clear_pointer(&status->config_dir, g_free);
    g_clear_pointer(&status->state_dir, g_free);
    status->config_path_resolved = FALSE;
    status->config_file_exists = FALSE;
    status->config_dir_exists = FALSE;
    status->state_dir_resolved = FALSE;
    status->state_dir_exists = FALSE;
}

void environment_check_build(
    const SystemdState *sys,
    const char *config_path,
    const char *state_dir,
    EnvironmentCheckResult *out)
{
    if (!out) return;
    memset(out, 0, sizeof(*out));
    int i = 0;

    RuntimePathStatus paths = {0};
    runtime_path_status_build(config_path, state_dir, NULL, &paths);

    /* 1. User systemd session */
    if (sys && !sys->systemd_unavailable) {
        environment_check_row_set(out, i, "User systemd session", TRUE, "Available");
    } else {
        environment_check_row_set(out, i, "User systemd session", FALSE,
                                  "Cannot connect to user systemd session bus.");
    }
    i++;

    /* 2. D-Bus session bus — if systemd works, D-Bus works */
    gboolean dbus_reachable = (sys && !sys->systemd_unavailable);
    environment_check_row_set(out, i, "D-Bus session bus", dbus_reachable,
                              dbus_reachable ? "Reachable" : "Not reachable");
    i++;

    /* 3. Config path resolved */
    if (paths.config_path_resolved) {
        environment_check_row_set(out, i, "Config file", TRUE, paths.config_path);
    } else {
        environment_check_row_set(out, i, "Config file", FALSE, "No config path resolved.");
    }
    i++;

    /* 4. Config file exists */
    if (paths.config_path_resolved) {
        environment_check_row_set(out, i, "Config exists", paths.config_file_exists,
                                  paths.config_file_exists ? "Yes" : "No");
    } else {
        environment_check_row_set(out, i, "Config exists", FALSE, "No (path unresolved)");
    }
    i++;

    /* 5. Config directory exists */
    if (paths.config_path_resolved && paths.config_dir && paths.config_dir[0] != '\0') {
        environment_check_row_set(out, i, "Config dir exists", paths.config_dir_exists,
                                  paths.config_dir_exists ? "Yes" : "No");
    } else {
        environment_check_row_set(out, i, "Config dir exists", FALSE, "No (path unresolved)");
    }
    i++;

    /* 6. State directory resolved */
    if (paths.state_dir_resolved) {
        environment_check_row_set(out, i, "State directory", TRUE, paths.state_dir);
    } else {
        environment_check_row_set(out, i, "State directory", FALSE, "No state directory resolved.");
    }
    i++;

    /* 7. State directory exists */
    if (paths.state_dir_resolved) {
        environment_check_row_set(out, i, "State dir exists", paths.state_dir_exists,
                                  paths.state_dir_exists ? "Yes" : "No");
    } else {
        environment_check_row_set(out, i, "State dir exists", FALSE, "No (path unresolved)");
    }
    i++;

    /* 8. Expected systemd unit present */
    if (sys && sys->installed) {
        environment_check_row_set(out, i, "Expected systemd unit", TRUE,
                                  sys->unit_name ? sys->unit_name : "Installed");
    } else if (sys && sys->systemd_unavailable) {
        environment_check_row_set(out, i, "Expected systemd unit", FALSE, "Systemd unavailable");
    } else {
        environment_check_row_set(out, i, "Expected systemd unit", FALSE, "Not installed");
    }
    i++;

    out->count = i;
    runtime_path_status_clear(&paths);
}

void environment_check_result_clear(EnvironmentCheckResult *result) {
    if (!result) return;
    for (int i = 0; i < ENV_CHECK_MAX_ROWS; i++) {
        g_clear_pointer(&result->rows[i].detail, g_free);
        result->rows[i].label = NULL;
        result->rows[i].passed = FALSE;
    }
    result->count = 0;
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
    case STATE_NEEDS_ONBOARDING:
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
