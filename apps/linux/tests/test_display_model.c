/*
 * test_display_model.c
 *
 * Tests for the pure display-model helpers (display_model.h).
 *
 * These test the deterministic logic layer that transforms backend
 * state into UI-ready data. No GTK dependency.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include <glib.h>
#include <string.h>
#include "../src/display_model.h"
#include "../src/gateway_config.h"

/* ── Helper ── */
static void assert_contains(const char *haystack, const char *needle, const char *ctx) {
    if (!haystack || !needle) {
        g_test_message("assert_contains(%s): haystack=%p needle=%p", ctx,
                       (const void *)haystack, (const void *)needle);
        g_assert_not_reached();
    }
    if (!strstr(haystack, needle)) {
        g_test_message("assert_contains(%s): '%s' not in '%s'", ctx, needle, haystack);
        g_assert_not_reached();
    }
}

/* ══════════════════════════════════════════════════════════════════
 * Dashboard display model tests
 * ══════════════════════════════════════════════════════════════════ */

static void test_dashboard_running_expected_service(void) {
    ReadinessInfo ri;
    HealthState hs = {0};
    hs.http_ok = TRUE; hs.ws_connected = TRUE;
    hs.rpc_ok = TRUE; hs.auth_ok = TRUE;
    hs.config_valid = TRUE;
    hs.has_wizard_onboard_marker = TRUE;
    hs.endpoint_host = "127.0.0.1"; hs.endpoint_port = 18789;
    hs.gateway_version = "1.2.3";

    SystemdState sys = {0};
    sys.installed = TRUE; sys.active = TRUE;
    sys.unit_name = "openclaw-gateway.service";
    sys.active_state = "active"; sys.sub_state = "running";

    readiness_evaluate(STATE_RUNNING, &hs, &sys, &ri);

    DashboardDisplayModel dm;
    dashboard_display_model_build(STATE_RUNNING, RUNTIME_EXPECTED_SERVICE_HEALTHY,
                                  &ri, &hs, &sys, &dm);

    g_assert_cmpstr(dm.headline, ==, "Fully Ready");
    g_assert_cmpint(dm.headline_color, ==, STATUS_COLOR_GREEN);
    g_assert_nonnull(dm.runtime_label);
    assert_contains(dm.runtime_label, "Expected Service", "running.runtime_label");
    g_assert_null(dm.guidance_text);
    g_assert_null(dm.next_action);

    /* Service actions available */
    g_assert_false(dm.can_start);
    g_assert_true(dm.can_stop);
    g_assert_true(dm.can_restart);
    g_assert_true(dm.can_open_dashboard);

    /* No service context notice when expected service is the explanation */
    g_assert_null(dm.service_context_notice);

    /* Connectivity */
    g_assert_cmpstr(dm.gateway_version, ==, "1.2.3");
    g_assert_true(dm.ws_connected);
    g_assert_true(dm.rpc_ok);
    g_assert_true(dm.auth_ok);

    /* Systemd */
    g_assert_cmpstr(dm.unit_name, ==, "openclaw-gateway.service");
    g_assert_cmpstr(dm.active_state, ==, "active");
}

static void test_dashboard_healthy_outside_expected_service(void) {
    ReadinessInfo ri;
    HealthState hs = {0};
    hs.last_updated = 12345;
    hs.http_ok = TRUE;
    hs.http_probe_result = HTTP_PROBE_OK;
    hs.ws_connected = TRUE;
    hs.rpc_ok = TRUE;
    hs.auth_ok = TRUE;
    hs.config_valid = TRUE;
    hs.has_wizard_onboard_marker = TRUE;
    hs.has_wizard_onboard_marker = TRUE; /* Required for STATE_RUNNING */

    SystemdState sys = {0};
    sys.installed = TRUE; sys.active = FALSE;

    readiness_evaluate(STATE_RUNNING, &hs, &sys, &ri);

    DashboardDisplayModel dm;
    dashboard_display_model_build(STATE_RUNNING, RUNTIME_HEALTHY_OUTSIDE_EXPECTED_SERVICE,
                                  &ri, &hs, &sys, &dm);

    g_assert_cmpstr(dm.headline, ==, "Fully Ready");
    g_assert_cmpint(dm.headline_color, ==, STATUS_COLOR_GREEN);

    /* Service context notice must be present */
    g_assert_nonnull(dm.service_context_notice);
    assert_contains(dm.service_context_notice, "expected systemd unit",
                    "external.service_context_notice");

    /* Start should be available (expected service is stopped) */
    g_assert_true(dm.can_start);
    /* Stop/restart should not be available (expected service not active) */
    g_assert_false(dm.can_stop);
    g_assert_false(dm.can_restart);
}

static void test_dashboard_listener_unresponsive(void) {
    ReadinessInfo ri;
    HealthState hs = {0};
    hs.http_ok = FALSE;
    hs.http_probe_result = HTTP_PROBE_TIMED_OUT_AFTER_CONNECT;
    hs.config_valid = TRUE;
    hs.has_wizard_onboard_marker = TRUE;
    hs.last_updated = 1;

    SystemdState sys = {0};
    sys.installed = TRUE; sys.active = TRUE;

    readiness_evaluate(STATE_DEGRADED, &hs, &sys, &ri);

    DashboardDisplayModel dm;
    dashboard_display_model_build(STATE_DEGRADED, RUNTIME_LISTENER_PRESENT_UNRESPONSIVE,
                                  &ri, &hs, &sys, &dm);

    g_assert_cmpstr(dm.headline, ==, "Degraded");
    g_assert_cmpint(dm.headline_color, ==, STATUS_COLOR_ORANGE);

    /* Service context notice for listener-present states */
    g_assert_nonnull(dm.service_context_notice);
    assert_contains(dm.service_context_notice, "expected systemd unit",
                    "listener.service_context_notice");

    /* Restart available (expected service is active) */
    g_assert_true(dm.can_restart);
}

static void test_dashboard_listener_unverified(void) {
    HealthState hs = {0};
    hs.http_ok = FALSE;
    hs.http_probe_result = HTTP_PROBE_INVALID_RESPONSE;
    hs.config_valid = TRUE;
    hs.has_wizard_onboard_marker = TRUE;
    hs.last_updated = 1;

    SystemdState sys = {0};
    sys.installed = TRUE; sys.active = TRUE;

    ReadinessInfo ri;
    readiness_evaluate(STATE_DEGRADED, &hs, &sys, &ri);

    DashboardDisplayModel dm;
    dashboard_display_model_build(STATE_DEGRADED, RUNTIME_LISTENER_PRESENT_UNVERIFIED,
                                  &ri, &hs, &sys, &dm);

    g_assert_nonnull(dm.service_context_notice);
    assert_contains(dm.service_context_notice, "cannot confirm",
                    "unverified.service_context_notice");
}

static void test_dashboard_stopped(void) {
    ReadinessInfo ri;
    HealthState hs = {0};
    SystemdState sys = {0};
    sys.installed = TRUE; sys.active = FALSE;

    readiness_evaluate(STATE_STOPPED, &hs, &sys, &ri);

    DashboardDisplayModel dm;
    dashboard_display_model_build(STATE_STOPPED, RUNTIME_NONE,
                                  &ri, &hs, &sys, &dm);

    g_assert_cmpstr(dm.headline, ==, "Stopped");
    g_assert_cmpint(dm.headline_color, ==, STATUS_COLOR_GRAY);
    g_assert_true(dm.can_start);
    g_assert_false(dm.can_stop);
    g_assert_false(dm.can_restart);
    g_assert_null(dm.service_context_notice);
}

static void test_dashboard_needs_setup(void) {
    ReadinessInfo ri;
    HealthState hs = {0};
    SystemdState sys = {0};
    readiness_evaluate(STATE_NEEDS_SETUP, &hs, &sys, &ri);

    DashboardDisplayModel dm;
    dashboard_display_model_build(STATE_NEEDS_SETUP, RUNTIME_NONE, &ri, &hs, &sys, &dm);

    g_assert_cmpstr(dm.headline, ==, "Setup Required");
    g_assert_cmpint(dm.headline_color, ==, STATUS_COLOR_RED);
    assert_contains(dm.guidance_text, "No OpenClaw configuration", "needs_setup.guidance");
    assert_contains(dm.next_action, "openclaw onboard --install-daemon", "needs_setup.next_action");
}

static void test_dashboard_needs_install(void) {
    ReadinessInfo ri;
    HealthState hs = {0};
    SystemdState sys = {0};
    readiness_evaluate(STATE_NEEDS_GATEWAY_INSTALL, &hs, &sys, &ri);

    DashboardDisplayModel dm;
    dashboard_display_model_build(STATE_NEEDS_GATEWAY_INSTALL, RUNTIME_NONE, &ri, &hs, &sys, &dm);

    g_assert_cmpstr(dm.headline, ==, "Gateway Service Missing");
    g_assert_cmpint(dm.headline_color, ==, STATUS_COLOR_RED);
    assert_contains(dm.guidance_text, "expected user systemd service", "needs_install.guidance");
    assert_contains(dm.next_action, "onboard --install-daemon", "needs_install.next_action");
}

static void test_dashboard_needs_onboarding(void) {
    ReadinessInfo ri;
    HealthState hs = {0};
    SystemdState sys = {0};
    readiness_evaluate(STATE_NEEDS_ONBOARDING, &hs, &sys, &ri);

    DashboardDisplayModel dm;
    dashboard_display_model_build(STATE_NEEDS_ONBOARDING, RUNTIME_NONE, &ri, &hs, &sys, &dm);

    g_assert_cmpstr(dm.headline, ==, "Bootstrap Incomplete");
    g_assert_cmpint(dm.headline_color, ==, STATUS_COLOR_ORANGE);
    assert_contains(dm.next_action, "openclaw onboard --install-daemon", "needs_onboarding.next_action");
}

static void test_dashboard_starting(void) {
    ReadinessInfo ri;
    HealthState hs = {0};
    SystemdState sys = {0};
    sys.installed = TRUE; sys.activating = TRUE;

    readiness_evaluate(STATE_STARTING, &hs, &sys, &ri);

    DashboardDisplayModel dm;
    dashboard_display_model_build(STATE_STARTING, RUNTIME_SERVICE_ACTIVE_NOT_PROVEN,
                                  &ri, &hs, &sys, &dm);

    g_assert_cmpstr(dm.headline, ==, "Starting");
    g_assert_cmpint(dm.headline_color, ==, STATUS_COLOR_ORANGE);
    /* All actions disabled during transition */
    g_assert_false(dm.can_start);
    g_assert_false(dm.can_stop);
    g_assert_false(dm.can_restart);
}

static void test_dashboard_null_output(void) {
    dashboard_display_model_build(STATE_RUNNING, RUNTIME_NONE, NULL, NULL, NULL, NULL);
}

/* ══════════════════════════════════════════════════════════════════
 * Tray display model tests
 * ══════════════════════════════════════════════════════════════════ */

static void test_tray_running(void) {
    HealthState hs = {0};
    hs.config_valid = TRUE;
    hs.has_wizard_onboard_marker = TRUE;
    TrayDisplayModel tm;
    tray_display_model_build(STATE_RUNNING, RUNTIME_EXPECTED_SERVICE_HEALTHY, &hs, &tm);

    assert_contains(tm.status_label, "Running", "tray_running.label");
    g_assert_nonnull(tm.runtime_label);
    g_assert_false(tm.start_sensitive);
    g_assert_true(tm.stop_sensitive);
    g_assert_true(tm.restart_sensitive);
    g_assert_true(tm.open_dashboard_sensitive);
}

static void test_tray_stopped(void) {
    HealthState hs = {0};
    TrayDisplayModel tm;
    tray_display_model_build(STATE_STOPPED, RUNTIME_NONE, &hs, &tm);

    assert_contains(tm.status_label, "Stopped", "tray_stopped.label");
    g_assert_true(tm.start_sensitive);
    g_assert_false(tm.stop_sensitive);
    g_assert_false(tm.restart_sensitive);
    g_assert_false(tm.open_dashboard_sensitive);
}

static void test_tray_starting(void) {
    HealthState hs = {0};
    TrayDisplayModel tm;
    tray_display_model_build(STATE_STARTING, RUNTIME_NONE, &hs, &tm);

    assert_contains(tm.status_label, "Starting", "tray_starting.label");
    /* Transition: all service actions disabled */
    g_assert_false(tm.start_sensitive);
    g_assert_false(tm.stop_sensitive);
    g_assert_false(tm.restart_sensitive);
}

static void test_tray_needs_setup(void) {
    HealthState hs = {0};
    TrayDisplayModel tm;
    tray_display_model_build(STATE_NEEDS_SETUP, RUNTIME_NONE, &hs, &tm);

    assert_contains(tm.status_label, "Setup Required", "tray_setup.label");
    g_assert_false(tm.start_sensitive);
}

static void test_tray_null_output(void) {
    tray_display_model_build(STATE_RUNNING, RUNTIME_NONE, NULL, NULL);
}

/* ══════════════════════════════════════════════════════════════════
 * Config display model tests
 * ══════════════════════════════════════════════════════════════════ */

static void test_config_valid(void) {
    HealthState hs = {0};
    hs.config_valid = TRUE;
    hs.has_wizard_onboard_marker = TRUE;
    hs.config_issues_count = 0;

    ConfigDisplayModel cm;
    config_display_model_build(&hs, "/home/user/.openclaw/openclaw.json", &cm);

    g_assert_true(cm.is_valid);
    g_assert_cmpint(cm.issues_count, ==, 0);
    g_assert_null(cm.warning_text);
    g_assert_cmpstr(cm.config_path, ==, "/home/user/.openclaw/openclaw.json");
}

static void test_config_valid_with_warnings(void) {
    HealthState hs = {0};
    hs.config_valid = TRUE;
    hs.has_wizard_onboard_marker = TRUE;
    hs.config_issues_count = 3;

    ConfigDisplayModel cm;
    config_display_model_build(&hs, "/path", &cm);

    g_assert_true(cm.is_valid);
    g_assert_cmpint(cm.issues_count, ==, 3);
    g_assert_nonnull(cm.warning_text);
    assert_contains(cm.warning_text, "warnings", "config_warn.text");
}

static void test_config_invalid(void) {
    HealthState hs = {0};
    hs.config_valid = FALSE;
    hs.last_error = "parse error at line 5";

    ConfigDisplayModel cm;
    config_display_model_build(&hs, "/path", &cm);

    g_assert_false(cm.is_valid);
    g_assert_nonnull(cm.warning_text);
    assert_contains(cm.warning_text, "parse error", "config_invalid.text");
}

static void test_config_no_health(void) {
    ConfigDisplayModel cm;
    config_display_model_build(NULL, "/path", &cm);

    g_assert_false(cm.is_valid);
    g_assert_nonnull(cm.warning_text);
}

/* ══════════════════════════════════════════════════════════════════
 * Environment check tests
 * ══════════════════════════════════════════════════════════════════ */

static void test_env_all_ok(void) {
    SystemdState sys = {0};
    sys.systemd_unavailable = FALSE;
    sys.installed = TRUE;
    sys.unit_name = "openclaw-gateway.service";

    EnvironmentCheckResult ecr;
    /* Use /tmp as a writable dir and /dev/null as a readable file */
    environment_check_build(&sys, "/dev/null", "/tmp", &ecr);

    g_assert_cmpint(ecr.count, >=, 8);
    /* systemd session */
    g_assert_true(ecr.rows[0].passed);
    /* D-Bus */
    g_assert_true(ecr.rows[1].passed);
    /* Config path resolved */
    g_assert_true(ecr.rows[2].passed);
    /* Config exists */
    g_assert_true(ecr.rows[3].passed);
    /* Config dir exists */
    g_assert_true(ecr.rows[4].passed);
    /* State dir resolved */
    g_assert_true(ecr.rows[5].passed);
    /* State dir exists */
    g_assert_true(ecr.rows[6].passed);
    /* Unit present */
    g_assert_true(ecr.rows[7].passed);

    environment_check_result_clear(&ecr);
}

static void test_env_systemd_unavailable(void) {
    SystemdState sys = {0};
    sys.systemd_unavailable = TRUE;

    EnvironmentCheckResult ecr;
    environment_check_build(&sys, "/dev/null", "/tmp", &ecr);

    g_assert_false(ecr.rows[0].passed); /* systemd */
    g_assert_false(ecr.rows[1].passed); /* D-Bus */

    environment_check_result_clear(&ecr);
}

static void test_env_no_config_path(void) {
    SystemdState sys = {0};
    EnvironmentCheckResult ecr;
    environment_check_build(&sys, NULL, NULL, &ecr);

    g_assert_false(ecr.rows[2].passed); /* config path resolved */
    g_assert_false(ecr.rows[3].passed); /* config exists */
    g_assert_false(ecr.rows[4].passed); /* config dir exists */
    g_assert_false(ecr.rows[5].passed); /* state dir resolved */
    g_assert_false(ecr.rows[6].passed); /* state dir exists */

    g_assert_cmpstr(ecr.rows[2].detail, ==, "No config path resolved.");
    g_assert_cmpstr(ecr.rows[3].detail, ==, "No (path unresolved)");
    g_assert_cmpstr(ecr.rows[4].detail, ==, "No (path unresolved)");
    g_assert_cmpstr(ecr.rows[5].detail, ==, "No state directory resolved.");
    g_assert_cmpstr(ecr.rows[6].detail, ==, "No (path unresolved)");

    environment_check_result_clear(&ecr);
}

static void test_env_resolved_but_missing_targets(void) {
    SystemdState sys = {0};
    EnvironmentCheckResult ecr;

    environment_check_build(&sys,
                            "/tmp/openclaw-missing-config-for-test.json",
                            "/tmp/openclaw-missing-state-dir-for-test",
                            &ecr);

    g_assert_true(ecr.rows[2].passed);  /* config path resolved */
    g_assert_false(ecr.rows[3].passed); /* config exists */
    g_assert_true(ecr.rows[4].passed);  /* config dir exists */
    g_assert_true(ecr.rows[5].passed);  /* state dir resolved */
    g_assert_false(ecr.rows[6].passed); /* state dir exists */

    environment_check_result_clear(&ecr);
}

static void test_runtime_path_status_uses_loaded_path_precedence(void) {
    RuntimePathStatus status = {0};
    runtime_path_status_build("/tmp/runtime-config.json",
                              "/tmp/state-dir",
                              "/tmp/loaded-config.json",
                              &status);

    g_assert_true(status.config_path_resolved);
    g_assert_cmpstr(status.config_path, ==, "/tmp/loaded-config.json");
    g_assert_true(status.state_dir_resolved);
    g_assert_cmpstr(status.state_dir, ==, "/tmp/state-dir");
    runtime_path_status_clear(&status);
}

static void test_runtime_path_status_derives_state_dir_from_config(void) {
    RuntimePathStatus status = {0};
    runtime_path_status_build("/tmp/openclaw-test/config.json", NULL, NULL, &status);

    g_assert_true(status.config_path_resolved);
    g_assert_true(status.state_dir_resolved);
    g_assert_cmpstr(status.state_dir, ==, "/tmp/openclaw-test");
    runtime_path_status_clear(&status);
}

static void test_runtime_path_status_invalid_utf8_paths_are_display_safe(void) {
    const gchar invalid_path[] = {'/', 't', 'm', 'p', '/', 'x', (gchar)0xFF, '\0'};
    RuntimePathStatus status = {0};
    runtime_path_status_build(invalid_path, NULL, NULL, &status);

    g_assert_true(status.config_path_resolved);
    g_assert_nonnull(status.config_path);
    g_assert_true(g_utf8_validate(status.config_path, -1, NULL));
    g_assert_true(status.state_dir_resolved);
    g_assert_nonnull(status.state_dir);
    g_assert_true(g_utf8_validate(status.state_dir, -1, NULL));

    runtime_path_status_clear(&status);
}

static void test_environment_check_result_clear_resets_owned_details(void) {
    SystemdState sys = {0};
    EnvironmentCheckResult ecr;
    environment_check_build(&sys, "/dev/null", "/tmp", &ecr);

    g_assert_cmpint(ecr.count, >, 0);
    g_assert_nonnull(ecr.rows[0].detail);

    environment_check_result_clear(&ecr);
    g_assert_cmpint(ecr.count, ==, 0);
    g_assert_null(ecr.rows[0].detail);
}

/* ══════════════════════════════════════════════════════════════════
 * Onboarding routing tests
 * ══════════════════════════════════════════════════════════════════ */

static void test_onboarding_first_run_healthy(void) {
    OnboardingRoute r = onboarding_routing_decide(STATE_RUNNING, 0, 1);
    g_assert_cmpint(r, ==, ONBOARDING_SHOW_SHORTENED);
}

static void test_onboarding_first_run_needs_setup(void) {
    OnboardingRoute r = onboarding_routing_decide(STATE_NEEDS_SETUP, 0, 1);
    g_assert_cmpint(r, ==, ONBOARDING_SHOW_FULL);
}

static void test_onboarding_first_run_needs_install(void) {
    OnboardingRoute r = onboarding_routing_decide(STATE_NEEDS_GATEWAY_INSTALL, 0, 1);
    g_assert_cmpint(r, ==, ONBOARDING_SHOW_FULL);
}

static void test_onboarding_first_run_stopped(void) {
    OnboardingRoute r = onboarding_routing_decide(STATE_STOPPED, 0, 1);
    g_assert_cmpint(r, ==, ONBOARDING_SHOW_FULL);
}

static void test_onboarding_first_run_starting(void) {
    OnboardingRoute r = onboarding_routing_decide(STATE_STARTING, 0, 1);
    g_assert_cmpint(r, ==, ONBOARDING_SHOW_SHORTENED);
}

static void test_onboarding_already_seen(void) {
    OnboardingRoute r = onboarding_routing_decide(STATE_NEEDS_SETUP, 1, 1);
    g_assert_cmpint(r, ==, ONBOARDING_SKIP);
}

static void test_onboarding_newer_version(void) {
    OnboardingRoute r = onboarding_routing_decide(STATE_RUNNING, 1, 2);
    g_assert_cmpint(r, ==, ONBOARDING_SHOW_SHORTENED);
}

static void test_onboarding_future_seen(void) {
    /* seen_version > current_version → skip */
    OnboardingRoute r = onboarding_routing_decide(STATE_RUNNING, 5, 2);
    g_assert_cmpint(r, ==, ONBOARDING_SKIP);
}

static void test_onboarding_error_state(void) {
    OnboardingRoute r = onboarding_routing_decide(STATE_ERROR, 0, 1);
    g_assert_cmpint(r, ==, ONBOARDING_SHOW_FULL);
}

static void test_onboarding_degraded(void) {
    OnboardingRoute r = onboarding_routing_decide(STATE_DEGRADED, 0, 1);
    g_assert_cmpint(r, ==, ONBOARDING_SHOW_FULL);
}

static void test_onboarding_config_invalid(void) {
    OnboardingRoute r = onboarding_routing_decide(STATE_CONFIG_INVALID, 0, 1);
    g_assert_cmpint(r, ==, ONBOARDING_SHOW_FULL);
}

/* ══════════════════════════════════════════════════════════════════
 * HTTP probe label tests
 * ══════════════════════════════════════════════════════════════════ */

static void test_probe_labels(void) {
    g_assert_cmpstr(http_probe_result_label(HTTP_PROBE_NONE), ==, "No probe yet");
    g_assert_cmpstr(http_probe_result_label(HTTP_PROBE_OK), ==, "OK");
    g_assert_cmpstr(http_probe_result_label(HTTP_PROBE_CONNECT_REFUSED), ==, "Connection refused");
    g_assert_cmpstr(http_probe_result_label(HTTP_PROBE_CONNECT_TIMEOUT), ==, "Connection timed out");
    g_assert_cmpstr(http_probe_result_label(HTTP_PROBE_TIMED_OUT_AFTER_CONNECT), ==, "Timed out after connect");
    g_assert_cmpstr(http_probe_result_label(HTTP_PROBE_INVALID_RESPONSE), ==, "Invalid response");
    g_assert_cmpstr(http_probe_result_label(HTTP_PROBE_UNKNOWN_ERROR), ==, "Unknown error");
}

/* ══════════════════════════════════════════════════════════════════
 * Dashboard URL builder tests
 * ══════════════════════════════════════════════════════════════════ */

static void test_dashboard_url_default(void) {
    GatewayConfig cfg = {0};
    cfg.valid = TRUE;
    cfg.host = "127.0.0.1";
    cfg.port = 18789;
    cfg.control_ui_base_path = NULL;
    cfg.token = NULL;

    g_autofree gchar *url = gateway_config_dashboard_url(&cfg);
    g_assert_cmpstr(url, ==, "http://127.0.0.1:18789/");
}

static void test_dashboard_url_with_base_path(void) {
    GatewayConfig cfg = {0};
    cfg.valid = TRUE;
    cfg.host = "127.0.0.1";
    cfg.port = 18789;
    cfg.control_ui_base_path = "/my-path";
    cfg.token = NULL;

    g_autofree gchar *url = gateway_config_dashboard_url(&cfg);
    g_assert_cmpstr(url, ==, "http://127.0.0.1:18789/my-path/");
}

static void test_dashboard_url_with_token(void) {
    GatewayConfig cfg = {0};
    cfg.valid = TRUE;
    cfg.host = "127.0.0.1";
    cfg.port = 18789;
    cfg.control_ui_base_path = NULL;
    cfg.token = "mytoken123";
    cfg.token_is_secret_ref = FALSE;

    g_autofree gchar *url = gateway_config_dashboard_url(&cfg);
    g_assert_nonnull(url);
    assert_contains(url, "http://127.0.0.1:18789/", "url_token.base");
    assert_contains(url, "#token=mytoken123", "url_token.fragment");
}

static void test_dashboard_url_secret_ref_no_token(void) {
    GatewayConfig cfg = {0};
    cfg.valid = TRUE;
    cfg.host = "127.0.0.1";
    cfg.port = 18789;
    cfg.token = "managed-token";
    cfg.token_is_secret_ref = TRUE;

    g_autofree gchar *url = gateway_config_dashboard_url(&cfg);
    g_assert_nonnull(url);
    /* SecretRef token must NOT be embedded */
    g_assert_null(strstr(url, "token="));
}

static void test_dashboard_url_invalid_config(void) {
    GatewayConfig cfg = {0};
    cfg.valid = FALSE;

    g_autofree gchar *url = gateway_config_dashboard_url(&cfg);
    g_assert_null(url);
}

static void test_dashboard_url_null_config(void) {
    g_autofree gchar *url = gateway_config_dashboard_url(NULL);
    g_assert_null(url);
}

static void test_dashboard_url_base_path_no_leading_slash(void) {
    GatewayConfig cfg = {0};
    cfg.valid = TRUE;
    cfg.host = "127.0.0.1";
    cfg.port = 18789;
    cfg.control_ui_base_path = "dashboard";

    g_autofree gchar *url = gateway_config_dashboard_url(&cfg);
    g_assert_cmpstr(url, ==, "http://127.0.0.1:18789/dashboard/");
}

static void test_dashboard_url_base_path_trailing_slash(void) {
    GatewayConfig cfg = {0};
    cfg.valid = TRUE;
    cfg.host = "127.0.0.1";
    cfg.port = 18789;
    cfg.control_ui_base_path = "/ui/";

    g_autofree gchar *url = gateway_config_dashboard_url(&cfg);
    g_assert_cmpstr(url, ==, "http://127.0.0.1:18789/ui/");
}

/* ══════════════════════════════════════════════════════════════════
 * Registration
 * ══════════════════════════════════════════════════════════════════ */

int main(int argc, char **argv) {
    g_test_init(&argc, &argv, NULL);

    /* Dashboard display model */
    g_test_add_func("/display_model/dashboard/running_expected_service",
                    test_dashboard_running_expected_service);
    g_test_add_func("/display_model/dashboard/healthy_outside_expected_service",
                    test_dashboard_healthy_outside_expected_service);
    g_test_add_func("/display_model/dashboard/listener_unresponsive",
                    test_dashboard_listener_unresponsive);
    g_test_add_func("/display_model/dashboard/listener_unverified",
                    test_dashboard_listener_unverified);
    g_test_add_func("/display_model/dashboard/stopped",
                    test_dashboard_stopped);
    g_test_add_func("/display_model/dashboard/needs_setup",
                    test_dashboard_needs_setup);
    g_test_add_func("/display_model/dashboard/needs_install",
                    test_dashboard_needs_install);
    g_test_add_func("/display_model/dashboard/needs_onboarding",
                    test_dashboard_needs_onboarding);
    g_test_add_func("/display_model/dashboard/starting",
                    test_dashboard_starting);
    g_test_add_func("/display_model/dashboard/null_output",
                    test_dashboard_null_output);

    /* Tray display model */
    g_test_add_func("/display_model/tray/running", test_tray_running);
    g_test_add_func("/display_model/tray/stopped", test_tray_stopped);
    g_test_add_func("/display_model/tray/starting", test_tray_starting);
    g_test_add_func("/display_model/tray/needs_setup", test_tray_needs_setup);
    g_test_add_func("/display_model/tray/null_output", test_tray_null_output);

    /* Config display model */
    g_test_add_func("/display_model/config/valid", test_config_valid);
    g_test_add_func("/display_model/config/valid_with_warnings", test_config_valid_with_warnings);
    g_test_add_func("/display_model/config/invalid", test_config_invalid);
    g_test_add_func("/display_model/config/no_health", test_config_no_health);

    /* Environment checks */
    g_test_add_func("/display_model/env/all_ok", test_env_all_ok);
    g_test_add_func("/display_model/env/systemd_unavailable", test_env_systemd_unavailable);
    g_test_add_func("/display_model/env/no_config_path", test_env_no_config_path);
    g_test_add_func("/display_model/env/resolved_but_missing_targets", test_env_resolved_but_missing_targets);
    g_test_add_func("/display_model/runtime_paths/loaded_path_precedence", test_runtime_path_status_uses_loaded_path_precedence);
    g_test_add_func("/display_model/runtime_paths/derive_state_dir_from_config", test_runtime_path_status_derives_state_dir_from_config);
    g_test_add_func("/display_model/runtime_paths/invalid_utf8_display_safe", test_runtime_path_status_invalid_utf8_paths_are_display_safe);
    g_test_add_func("/display_model/env/result_clear_resets_details", test_environment_check_result_clear_resets_owned_details);

    /* Onboarding routing */
    g_test_add_func("/display_model/onboarding/first_run_healthy",
                    test_onboarding_first_run_healthy);
    g_test_add_func("/display_model/onboarding/first_run_needs_setup",
                    test_onboarding_first_run_needs_setup);
    g_test_add_func("/display_model/onboarding/first_run_needs_install",
                    test_onboarding_first_run_needs_install);
    g_test_add_func("/display_model/onboarding/first_run_stopped",
                    test_onboarding_first_run_stopped);
    g_test_add_func("/display_model/onboarding/first_run_starting",
                    test_onboarding_first_run_starting);
    g_test_add_func("/display_model/onboarding/already_seen",
                    test_onboarding_already_seen);
    g_test_add_func("/display_model/onboarding/newer_version",
                    test_onboarding_newer_version);
    g_test_add_func("/display_model/onboarding/future_seen",
                    test_onboarding_future_seen);
    g_test_add_func("/display_model/onboarding/error_state",
                    test_onboarding_error_state);
    g_test_add_func("/display_model/onboarding/degraded",
                    test_onboarding_degraded);
    g_test_add_func("/display_model/onboarding/config_invalid",
                    test_onboarding_config_invalid);

    /* HTTP probe labels */
    g_test_add_func("/display_model/probe_labels", test_probe_labels);

    /* Dashboard URL builder */
    g_test_add_func("/display_model/dashboard_url/default",
                    test_dashboard_url_default);
    g_test_add_func("/display_model/dashboard_url/with_base_path",
                    test_dashboard_url_with_base_path);
    g_test_add_func("/display_model/dashboard_url/with_token",
                    test_dashboard_url_with_token);
    g_test_add_func("/display_model/dashboard_url/secret_ref_no_token",
                    test_dashboard_url_secret_ref_no_token);
    g_test_add_func("/display_model/dashboard_url/invalid_config",
                    test_dashboard_url_invalid_config);
    g_test_add_func("/display_model/dashboard_url/null_config",
                    test_dashboard_url_null_config);
    g_test_add_func("/display_model/dashboard_url/no_leading_slash",
                    test_dashboard_url_base_path_no_leading_slash);
    g_test_add_func("/display_model/dashboard_url/trailing_slash",
                    test_dashboard_url_base_path_trailing_slash);

    return g_test_run();
}
