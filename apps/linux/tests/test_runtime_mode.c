/*
 * test_runtime_mode.c
 *
 * Tests for the proof-oriented RuntimeMode derivation (Phase 1.5).
 *
 * Exercises RuntimeMode through the public state update + accessor path.
 * Each test also asserts the AppState invariant: compute_state() output
 * is unchanged by the RuntimeMode addition.
 *
 * Naming convention: no test name, comment, or assertion string claims
 * "started by this app," "managed by us," or "adopted existing."
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include <glib.h>
#include "../src/state.h"

/* Stubs for callbacks (same as test_state.c) */
void notify_on_transition(AppState old_state, AppState new_state) {
    (void)old_state;
    (void)new_state;
}
void tray_update_from_state(AppState state) {
    (void)state;
}
void state_on_gateway_refresh_requested(void) {}

/* ── Scenario A: Fresh machine, no data ── */

static void test_runtime_mode_fresh_machine(void) {
    state_init();
    SystemdState sys = {0};
    sys.installed = FALSE;
    state_update_systemd(&sys);

    g_assert_cmpint(state_get_runtime_mode(), ==, RUNTIME_NONE);
    /* AppState invariant */
    g_assert_cmpint(state_get_current(), ==, STATE_NEEDS_SETUP);
}

/* ── Scenario B: Setup done, no unit ── */

static void test_runtime_mode_setup_done_no_unit(void) {
    state_init();
    SystemdState sys = {0};
    sys.installed = FALSE;
    state_update_systemd(&sys);

    HealthState hs = {0};
    hs.last_updated = 12345;
    hs.setup_detected = TRUE;
    hs.config_valid = TRUE;
    state_update_health(&hs);

    g_assert_cmpint(state_get_runtime_mode(), ==, RUNTIME_NONE);
    /* AppState invariant */
    g_assert_cmpint(state_get_current(), ==, STATE_NEEDS_GATEWAY_INSTALL);
}

/* ── Scenario C: Unit installed, stopped, no health ── */

static void test_runtime_mode_unit_installed_stopped(void) {
    state_init();
    SystemdState sys = {0};
    sys.installed = TRUE;
    sys.active = FALSE;
    state_update_systemd(&sys);

    g_assert_cmpint(state_get_runtime_mode(), ==, RUNTIME_NONE);
    /* AppState invariant */
    g_assert_cmpint(state_get_current(), ==, STATE_STOPPED);
}

/* ── Scenario D: Unit active, no health yet ── */

static void test_runtime_mode_service_active_no_health(void) {
    state_init();
    SystemdState sys = {0};
    sys.installed = TRUE;
    sys.active = TRUE;
    state_update_systemd(&sys);

    g_assert_cmpint(state_get_runtime_mode(), ==, RUNTIME_SERVICE_ACTIVE_NOT_PROVEN);
    /* AppState invariant */
    g_assert_cmpint(state_get_current(), ==, STATE_STARTING);
}

/* ── Scenario E: Unit active, fully healthy ── */

static void test_runtime_mode_expected_service_healthy(void) {
    state_init();
    SystemdState sys = {0};
    sys.installed = TRUE;
    sys.active = TRUE;
    state_update_systemd(&sys);

    HealthState hs = {0};
    hs.last_updated = 12345;
    hs.http_ok = TRUE;
    hs.http_probe_result = HTTP_PROBE_OK;
    hs.ws_connected = TRUE;
    hs.rpc_ok = TRUE;
    hs.auth_ok = TRUE;
    hs.config_valid = TRUE;
    state_update_health(&hs);

    g_assert_cmpint(state_get_runtime_mode(), ==, RUNTIME_EXPECTED_SERVICE_HEALTHY);
    /* AppState invariant */
    g_assert_cmpint(state_get_current(), ==, STATE_RUNNING);
}

/* ── Scenario F: Fully healthy, unit not active ── */

static void test_runtime_mode_healthy_outside_service_inactive(void) {
    state_init();
    SystemdState sys = {0};
    sys.installed = TRUE;
    sys.active = FALSE;
    state_update_systemd(&sys);

    HealthState hs = {0};
    hs.last_updated = 12345;
    hs.http_ok = TRUE;
    hs.http_probe_result = HTTP_PROBE_OK;
    hs.ws_connected = TRUE;
    hs.rpc_ok = TRUE;
    hs.auth_ok = TRUE;
    hs.config_valid = TRUE;
    state_update_health(&hs);

    g_assert_cmpint(state_get_runtime_mode(), ==, RUNTIME_HEALTHY_OUTSIDE_EXPECTED_SERVICE);
    /* AppState invariant */
    g_assert_cmpint(state_get_current(), ==, STATE_RUNNING);
}

/* ── Scenario G: Fully healthy, unit not installed ── */

static void test_runtime_mode_healthy_outside_service_not_installed(void) {
    state_init();
    SystemdState sys = {0};
    sys.installed = FALSE;
    state_update_systemd(&sys);

    HealthState hs = {0};
    hs.last_updated = 12345;
    hs.http_ok = TRUE;
    hs.http_probe_result = HTTP_PROBE_OK;
    hs.ws_connected = TRUE;
    hs.rpc_ok = TRUE;
    hs.auth_ok = TRUE;
    hs.config_valid = TRUE;
    state_update_health(&hs);

    g_assert_cmpint(state_get_runtime_mode(), ==, RUNTIME_HEALTHY_OUTSIDE_EXPECTED_SERVICE);
    /* AppState invariant */
    g_assert_cmpint(state_get_current(), ==, STATE_RUNNING);
}

/* ── Scenario H: Listener present, health times out ── */

static void test_runtime_mode_listener_unresponsive(void) {
    state_init();
    SystemdState sys = {0};
    sys.installed = TRUE;
    sys.active = TRUE;
    state_update_systemd(&sys);

    HealthState hs = {0};
    hs.last_updated = 12345;
    hs.http_ok = FALSE;
    hs.http_probe_result = HTTP_PROBE_TIMED_OUT_AFTER_CONNECT;
    hs.ws_connected = FALSE;
    hs.config_valid = TRUE;
    state_update_health(&hs);

    g_assert_cmpint(state_get_runtime_mode(), ==, RUNTIME_LISTENER_PRESENT_UNRESPONSIVE);
    /* AppState invariant */
    g_assert_cmpint(state_get_current(), ==, STATE_DEGRADED);
}

/* ── Scenario I: Listener present, invalid response ── */

static void test_runtime_mode_listener_unverified(void) {
    state_init();
    SystemdState sys = {0};
    sys.installed = TRUE;
    sys.active = TRUE;
    state_update_systemd(&sys);

    HealthState hs = {0};
    hs.last_updated = 12345;
    hs.http_ok = FALSE;
    hs.http_probe_result = HTTP_PROBE_INVALID_RESPONSE;
    hs.ws_connected = FALSE;
    hs.config_valid = TRUE;
    state_update_health(&hs);

    g_assert_cmpint(state_get_runtime_mode(), ==, RUNTIME_LISTENER_PRESENT_UNVERIFIED);
    /* AppState invariant */
    g_assert_cmpint(state_get_current(), ==, STATE_DEGRADED);
}

/* ── Scenario J: Unit active, connect refused ── */

static void test_runtime_mode_service_active_connect_refused(void) {
    state_init();
    SystemdState sys = {0};
    sys.installed = TRUE;
    sys.active = TRUE;
    state_update_systemd(&sys);

    HealthState hs = {0};
    hs.last_updated = 12345;
    hs.http_ok = FALSE;
    hs.http_probe_result = HTTP_PROBE_CONNECT_REFUSED;
    hs.ws_connected = FALSE;
    hs.config_valid = TRUE;
    state_update_health(&hs);

    g_assert_cmpint(state_get_runtime_mode(), ==, RUNTIME_SERVICE_ACTIVE_NOT_PROVEN);
    /* Regression: systemd active does NOT prove listener presence */
    g_assert_false(health_state_listener_proven(&hs));
    /* AppState invariant */
    g_assert_cmpint(state_get_current(), ==, STATE_DEGRADED);
}

/* ── Scenario K: Config invalid, no health data ── */

static void test_runtime_mode_config_invalid(void) {
    state_init();
    SystemdState sys = {0};
    sys.installed = TRUE;
    sys.active = FALSE;
    state_update_systemd(&sys);

    HealthState hs = {0};
    hs.last_updated = 12345;
    hs.config_valid = FALSE;
    state_update_health(&hs);

    g_assert_cmpint(state_get_runtime_mode(), ==, RUNTIME_NONE);
    /* AppState invariant */
    g_assert_cmpint(state_get_current(), ==, STATE_CONFIG_INVALID);
}

/* ── Regression: state_init resets runtime mode ── */

static void test_runtime_mode_reset_on_init(void) {
    state_init();
    SystemdState sys = {0};
    sys.installed = TRUE;
    sys.active = TRUE;
    state_update_systemd(&sys);

    HealthState hs = {0};
    hs.last_updated = 12345;
    hs.http_ok = TRUE;
    hs.http_probe_result = HTTP_PROBE_OK;
    hs.ws_connected = TRUE;
    hs.rpc_ok = TRUE;
    hs.auth_ok = TRUE;
    hs.config_valid = TRUE;
    state_update_health(&hs);
    g_assert_cmpint(state_get_runtime_mode(), ==, RUNTIME_EXPECTED_SERVICE_HEALTHY);

    state_init();
    g_assert_cmpint(state_get_runtime_mode(), ==, RUNTIME_NONE);
}

/* ── Registration ── */

int main(int argc, char **argv) {
    g_test_init(&argc, &argv, NULL);

    g_test_add_func("/runtime_mode/fresh_machine", test_runtime_mode_fresh_machine);
    g_test_add_func("/runtime_mode/setup_done_no_unit", test_runtime_mode_setup_done_no_unit);
    g_test_add_func("/runtime_mode/unit_installed_stopped", test_runtime_mode_unit_installed_stopped);
    g_test_add_func("/runtime_mode/service_active_no_health", test_runtime_mode_service_active_no_health);
    g_test_add_func("/runtime_mode/expected_service_healthy", test_runtime_mode_expected_service_healthy);
    g_test_add_func("/runtime_mode/healthy_outside_service_inactive", test_runtime_mode_healthy_outside_service_inactive);
    g_test_add_func("/runtime_mode/healthy_outside_service_not_installed", test_runtime_mode_healthy_outside_service_not_installed);
    g_test_add_func("/runtime_mode/listener_unresponsive", test_runtime_mode_listener_unresponsive);
    g_test_add_func("/runtime_mode/listener_unverified", test_runtime_mode_listener_unverified);
    g_test_add_func("/runtime_mode/service_active_connect_refused", test_runtime_mode_service_active_connect_refused);
    g_test_add_func("/runtime_mode/config_invalid", test_runtime_mode_config_invalid);
    g_test_add_func("/runtime_mode/reset_on_init", test_runtime_mode_reset_on_init);

    return g_test_run();
}
