/*
 * display_model.h
 *
 * Pure display-model helpers for the OpenClaw Linux Companion App.
 *
 * Transforms backend state (AppState, RuntimeMode, ReadinessInfo,
 * HealthState, SystemdState) into UI-ready data structures. These
 * helpers have no GTK dependency and are designed for deterministic
 * automated testing.
 *
 * Control Semantics:
 *   Service control actions (start/stop/restart) target the expected
 *   user systemd service unit. They do NOT universally control
 *   whatever runtime is currently serving the endpoint. The display
 *   model reflects this by gating action visibility/sensitivity on
 *   the expected service relationship, and by providing explicit
 *   service-context guidance when RuntimeMode indicates a runtime
 *   not explained by the expected service.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#pragma once

#include "state.h"
#include "readiness.h"
#include <glib.h>

/* ── Dashboard display model ── */

typedef enum {
    STATUS_COLOR_GREEN,
    STATUS_COLOR_ORANGE,
    STATUS_COLOR_RED,
    STATUS_COLOR_GRAY,
} StatusColor;

typedef struct {
    const char *headline;          /* e.g. "Running", "Setup Required" */
    StatusColor headline_color;

    const char *runtime_label;     /* RuntimeModePresentation.label */
    const char *runtime_detail;    /* RuntimeModePresentation.explanation */

    const char *guidance_text;     /* ReadinessInfo.missing */
    const char *next_action;       /* ReadinessInfo.next_action */

    /*
     * Service control actions target the expected user systemd unit.
     * These flags indicate whether each action should be enabled.
     * When runtime_mode is RUNTIME_HEALTHY_OUTSIDE_EXPECTED_SERVICE,
     * actions may still be enabled (to control the expected service)
     * but service_context_notice will explain the disconnect.
     */
    gboolean can_start;
    gboolean can_stop;
    gboolean can_restart;
    gboolean can_open_dashboard;

    /*
     * Non-NULL when service actions need contextual qualification.
     * e.g. "Service controls target the expected systemd unit, not
     * necessarily the runtime currently serving this endpoint."
     */
    const char *service_context_notice;

    /* Connectivity detail */
    const char *endpoint_display;  /* "host:port" or NULL */
    const char *gateway_version;
    const char *http_probe_label;
    gboolean ws_connected;
    gboolean rpc_ok;
    gboolean auth_ok;
    const char *auth_source;

    /* Systemd context */
    const char *unit_name;
    const char *active_state;
    const char *sub_state;
} DashboardDisplayModel;

void dashboard_display_model_build(
    AppState state,
    RuntimeMode runtime_mode,
    const ReadinessInfo *readiness,
    const HealthState *health,
    const SystemdState *sys,
    DashboardDisplayModel *out);

/* ── Tray display model ── */

typedef struct {
    const char *status_label;      /* e.g. "● Running" */
    const char *runtime_label;     /* RuntimeMode label */

    gboolean start_sensitive;
    gboolean stop_sensitive;
    gboolean restart_sensitive;
    gboolean refresh_sensitive;
    gboolean open_dashboard_sensitive;
} TrayDisplayModel;

void tray_display_model_build(
    AppState state,
    RuntimeMode runtime_mode,
    const HealthState *health,
    TrayDisplayModel *out);

/* ── Config display model ── */

typedef struct {
    gboolean is_valid;
    int issues_count;
    const char *warning_text;      /* NULL if no issues */
    const char *config_path;
} ConfigDisplayModel;

void config_display_model_build(
    const HealthState *health,
    const char *config_path,
    ConfigDisplayModel *out);

/* ── Environment check row ── */

typedef struct {
    const char *label;
    gboolean passed;
    gchar *detail;                 /* owned UTF-8 path or explanation */
} EnvironmentCheckRow;

#define ENV_CHECK_MAX_ROWS 8

typedef struct {
    EnvironmentCheckRow rows[ENV_CHECK_MAX_ROWS];
    int count;
} EnvironmentCheckResult;

typedef struct {
    /* Display-safe UTF-8 values for rendering and diagnostics text. */
    gchar *config_path;
    gchar *config_dir;
    gchar *state_dir;
    gboolean config_path_resolved;
    gboolean config_file_exists;
    gboolean config_dir_exists;
    gboolean state_dir_resolved;
    gboolean state_dir_exists;
} RuntimePathStatus;

void runtime_path_status_build(
    const gchar *runtime_config_path,
    const gchar *runtime_state_dir,
    const gchar *loaded_config_path,
    RuntimePathStatus *out);

void runtime_path_status_clear(RuntimePathStatus *status);

void environment_check_build(
    const SystemdState *sys,
    const char *config_path,
    const char *state_dir,
    EnvironmentCheckResult *out);

void environment_check_result_clear(EnvironmentCheckResult *result);

/* ── Onboarding routing ── */

typedef enum {
    ONBOARDING_SHOW_FULL,       /* first run or recovery: full guidance */
    ONBOARDING_SHOW_SHORTENED,  /* first run but already healthy: welcome + what's next */
    ONBOARDING_SKIP,            /* already completed */
} OnboardingRoute;

OnboardingRoute onboarding_routing_decide(
    AppState state,
    int seen_version,
    int current_version);

/* ── HTTP probe label ── */

const char* http_probe_result_label(HttpProbeResult probe);
