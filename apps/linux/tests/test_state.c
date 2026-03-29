#include <glib.h>
#include "../src/state.h"

// Stubs for callbacks
void notify_on_transition(AppState old_state, AppState new_state) {
    (void)old_state;
    (void)new_state;
}
void tray_update_from_state(AppState state) {
    (void)state;
}
void state_on_gateway_refresh_requested(void) {}

/* ── Basic systemd-only state tests ── */

static void test_initial_state(void) {
    state_init();
    g_assert_cmpint(state_get_current(), ==, STATE_NEEDS_SETUP);
}

static void test_installed_inactive(void) {
    state_init();
    SystemdState sys = {0};
    sys.installed = TRUE;
    sys.active = FALSE;
    state_update_systemd(&sys);
    g_assert_cmpint(state_get_current(), ==, STATE_STOPPED);
}

static void test_active_without_fresh_health(void) {
    state_init();
    SystemdState sys = {0};
    sys.installed = TRUE;
    sys.active = TRUE;
    state_update_systemd(&sys);
    // Startup hydration guard: systemd active + no health data → STARTING (transitional, not RUNNING)
    g_assert_cmpint(state_get_current(), ==, STATE_STARTING);
}

/* ── Native gateway connectivity tests ── */

static void test_full_connectivity_running(void) {
    state_init();
    SystemdState sys = {0};
    sys.installed = TRUE;
    sys.active = TRUE;
    state_update_systemd(&sys);

    HealthState hs = {0};
    hs.last_updated = 12345;
    hs.http_ok = TRUE;
    hs.ws_connected = TRUE;
    hs.rpc_ok = TRUE;
    hs.auth_ok = TRUE;
    hs.config_valid = TRUE;
    state_update_health(&hs);

    g_assert_cmpint(state_get_current(), ==, STATE_RUNNING);
}

static void test_warning_health(void) {
    state_init();
    SystemdState sys = {0};
    sys.installed = TRUE;
    sys.active = TRUE;
    state_update_systemd(&sys);

    HealthState hs = {0};
    hs.last_updated = 12345;
    hs.http_ok = TRUE;
    hs.ws_connected = TRUE;
    hs.rpc_ok = TRUE;
    hs.auth_ok = TRUE;
    hs.config_audit_ok = FALSE;
    hs.config_issues_count = 1;
    state_update_health(&hs);

    g_assert_cmpint(state_get_current(), ==, STATE_RUNNING_WITH_WARNING);
}

static void test_degraded_rpc_fail(void) {
    state_init();
    SystemdState sys = {0};
    sys.installed = TRUE;
    sys.active = TRUE;
    state_update_systemd(&sys);

    HealthState hs = {0};
    hs.last_updated = 12345;
    hs.http_ok = TRUE;
    hs.ws_connected = TRUE;
    hs.rpc_ok = FALSE;
    hs.auth_ok = TRUE;
    state_update_health(&hs);

    g_assert_cmpint(state_get_current(), ==, STATE_DEGRADED);
}

static void test_http_ok_ws_disconnected_is_degraded(void) {
    state_init();
    SystemdState sys = {0};
    sys.installed = TRUE;
    sys.active = TRUE;
    state_update_systemd(&sys);

    HealthState hs = {0};
    hs.last_updated = 12345;
    hs.http_ok = TRUE;
    hs.ws_connected = FALSE;
    state_update_health(&hs);

    // HTTP reachable but WS not connected → partial health → DEGRADED
    g_assert_cmpint(state_get_current(), ==, STATE_DEGRADED);
}

/* ── STATUS PRECEDENCE: Runtime connectivity overrides systemd ── */

static void test_precedence_systemd_inactive_native_connected(void) {
    // CRITICAL: systemd says inactive, but native client is connected → RUNNING
    state_init();
    SystemdState sys = {0};
    sys.installed = TRUE;
    sys.active = FALSE; // systemd says stopped
    state_update_systemd(&sys);
    g_assert_cmpint(state_get_current(), ==, STATE_STOPPED);

    // Now the native gateway client connects
    HealthState hs = {0};
    hs.last_updated = 12345;
    hs.http_ok = TRUE;
    hs.ws_connected = TRUE;
    hs.rpc_ok = TRUE;
    hs.auth_ok = TRUE;
    state_update_health(&hs);

    // Runtime connectivity takes precedence → RUNNING
    g_assert_cmpint(state_get_current(), ==, STATE_RUNNING);
}

static void test_precedence_systemd_unavailable_native_connected(void) {
    // CRITICAL: systemd unavailable, but native client is connected → RUNNING
    state_init();
    SystemdState sys = {0};
    sys.systemd_unavailable = TRUE;
    state_update_systemd(&sys);
    g_assert_cmpint(state_get_current(), ==, STATE_USER_SYSTEMD_UNAVAILABLE);

    // Now the native gateway client connects
    HealthState hs = {0};
    hs.last_updated = 12345;
    hs.http_ok = TRUE;
    hs.ws_connected = TRUE;
    hs.rpc_ok = TRUE;
    hs.auth_ok = TRUE;
    state_update_health(&hs);

    // Runtime connectivity takes precedence → RUNNING
    g_assert_cmpint(state_get_current(), ==, STATE_RUNNING);
}

static void test_precedence_systemd_active_http_down(void) {
    // systemd says active, but HTTP unreachable → DEGRADED
    state_init();
    SystemdState sys = {0};
    sys.installed = TRUE;
    sys.active = TRUE;
    state_update_systemd(&sys);
    g_assert_cmpint(state_get_current(), ==, STATE_STARTING);

    // HTTP health check fails (config is valid but gateway unreachable)
    HealthState hs = {0};
    hs.last_updated = 12345;
    hs.http_ok = FALSE;
    hs.ws_connected = FALSE;
    hs.config_valid = TRUE;
    state_update_health(&hs);

    g_assert_cmpint(state_get_current(), ==, STATE_DEGRADED);
}

static void test_precedence_not_installed_native_connected(void) {
    // Systemd says not installed, but a manually started gateway is connected
    state_init();
    SystemdState sys = {0};
    sys.installed = FALSE;
    state_update_systemd(&sys);
    g_assert_cmpint(state_get_current(), ==, STATE_NEEDS_SETUP);

    HealthState hs = {0};
    hs.last_updated = 12345;
    hs.http_ok = TRUE;
    hs.ws_connected = TRUE;
    hs.rpc_ok = TRUE;
    hs.auth_ok = TRUE;
    state_update_health(&hs);

    // Runtime connectivity takes precedence → RUNNING
    g_assert_cmpint(state_get_current(), ==, STATE_RUNNING);
}

static void test_precedence_native_connected_with_warning(void) {
    // systemd inactive + native connected with config issues → RUNNING_WITH_WARNING
    state_init();
    SystemdState sys = {0};
    sys.installed = TRUE;
    sys.active = FALSE;
    state_update_systemd(&sys);

    HealthState hs = {0};
    hs.last_updated = 12345;
    hs.http_ok = TRUE;
    hs.ws_connected = TRUE;
    hs.rpc_ok = TRUE;
    hs.auth_ok = TRUE;
    hs.config_audit_ok = FALSE;
    hs.config_issues_count = 2;
    state_update_health(&hs);

    g_assert_cmpint(state_get_current(), ==, STATE_RUNNING_WITH_WARNING);
}

static void test_precedence_native_connected_auth_fail(void) {
    // systemd inactive + native HTTP+WS connected but auth failed → DEGRADED
    state_init();
    SystemdState sys = {0};
    sys.installed = TRUE;
    sys.active = FALSE;
    state_update_systemd(&sys);

    HealthState hs = {0};
    hs.last_updated = 12345;
    hs.http_ok = TRUE;
    hs.ws_connected = TRUE;
    hs.rpc_ok = TRUE;
    hs.auth_ok = FALSE;
    state_update_health(&hs);

    g_assert_cmpint(state_get_current(), ==, STATE_DEGRADED);
}

/* ── Lifecycle and generation tests ── */

static void test_unit_retarget_bumps_generation(void) {
    state_init();
    SystemdState sys = {0};
    sys.installed = TRUE;
    sys.active = TRUE;
    sys.unit_name = "unitA.service";
    state_update_systemd(&sys);

    guint64 gen1 = state_get_health_generation();

    sys.unit_name = "unitB.service";
    state_update_systemd(&sys);

    guint64 gen2 = state_get_health_generation();
    g_assert_cmpuint(gen2, >, gen1);
}

static void test_repeated_running_stopped_transitions(void) {
    state_init();
    SystemdState sys = {0};
    sys.installed = TRUE;

    sys.active = TRUE;
    state_update_systemd(&sys);
    g_assert_cmpint(state_get_current(), ==, STATE_STARTING);

    sys.active = FALSE;
    state_update_systemd(&sys);
    g_assert_cmpint(state_get_current(), ==, STATE_STOPPED);

    sys.active = TRUE;
    state_update_systemd(&sys);
    g_assert_cmpint(state_get_current(), ==, STATE_STARTING);

    sys.active = FALSE;
    state_update_systemd(&sys);
    g_assert_cmpint(state_get_current(), ==, STATE_STOPPED);
}

static void test_transition_into_systemd_unavailable(void) {
    state_init();
    SystemdState sys = {0};
    sys.installed = TRUE;
    sys.active = TRUE;
    state_update_systemd(&sys);
    g_assert_cmpint(state_get_current(), ==, STATE_STARTING);

    sys.systemd_unavailable = TRUE;
    state_update_systemd(&sys);
    // No native connectivity → systemd context used → UNAVAILABLE
    g_assert_cmpint(state_get_current(), ==, STATE_USER_SYSTEMD_UNAVAILABLE);
}

static void test_repeated_unit_retargets(void) {
    state_init();
    SystemdState sys = {0};
    sys.installed = TRUE;
    sys.active = TRUE;

    sys.unit_name = "unitA.service";
    state_update_systemd(&sys);
    guint64 gen1 = state_get_health_generation();

    sys.unit_name = "unitB.service";
    state_update_systemd(&sys);
    guint64 gen2 = state_get_health_generation();
    g_assert_cmpuint(gen2, >, gen1);

    sys.unit_name = "unitC.service";
    state_update_systemd(&sys);
    guint64 gen3 = state_get_health_generation();
    g_assert_cmpuint(gen3, >, gen2);

    // Same unit → no generation bump
    sys.unit_name = "unitC.service";
    state_update_systemd(&sys);
    guint64 gen4 = state_get_health_generation();
    g_assert_cmpuint(gen4, ==, gen3);
}

static void test_health_zero_timestamp_preserves_systemd_running(void) {
    state_init();
    SystemdState sys = {0};
    sys.installed = TRUE;
    sys.active = TRUE;
    state_update_systemd(&sys);

    // Push a healthy state first
    HealthState hs1 = {0};
    hs1.last_updated = 12345;
    hs1.http_ok = TRUE;
    hs1.ws_connected = TRUE;
    hs1.rpc_ok = TRUE;
    hs1.auth_ok = TRUE;
    state_update_health(&hs1);
    g_assert_cmpint(state_get_current(), ==, STATE_RUNNING);

    // Simulate zero-timestamp health update (e.g. during reinit)
    HealthState hs_zero = {0};
    hs_zero.last_updated = 0;
    state_update_health(&hs_zero);

    // Systemd still active + no valid health data → startup hydration guard → STARTING
    g_assert_cmpint(state_get_current(), ==, STATE_STARTING);
}

static void test_activation_boundary_health_persists_through_stop(void) {
    /*
     * Health data now persists through systemd stop. The native client is
     * the authoritative source — a refresh is triggered on stop so the
     * native client will discover the real state. Until then, the old
     * health data remains and compute_state uses it.
     */
    state_init();
    SystemdState sys = {0};
    sys.installed = TRUE;
    sys.active = TRUE;
    state_update_systemd(&sys);

    // Seed connected state (degraded because rpc_ok=FALSE)
    HealthState hs = {0};
    hs.last_updated = 12345;
    hs.http_ok = TRUE;
    hs.ws_connected = TRUE;
    hs.rpc_ok = FALSE;
    hs.auth_ok = TRUE;
    state_update_health(&hs);
    g_assert_cmpint(state_get_current(), ==, STATE_DEGRADED);

    // Stop: health persists, native connectivity takes precedence → still DEGRADED
    sys.active = FALSE;
    state_update_systemd(&sys);
    g_assert_cmpint(state_get_current(), ==, STATE_DEGRADED);

    // Simulate native refresh detecting gateway is gone
    HealthState hs_down = {0};
    hs_down.last_updated = 12346;
    hs_down.http_ok = FALSE;
    hs_down.ws_connected = FALSE;
    hs_down.config_valid = TRUE;
    state_update_health(&hs_down);
    // Now systemd says stopped + native says unreachable → STOPPED
    g_assert_cmpint(state_get_current(), ==, STATE_STOPPED);
}

static void test_systemd_stop_does_not_regress_native_connected(void) {
    /*
     * CRITICAL: If the gateway is still reachable after systemd reports stop
     * (e.g. started out-of-band), native connectivity must take precedence.
     */
    state_init();
    SystemdState sys = {0};
    sys.installed = TRUE;
    sys.active = TRUE;
    state_update_systemd(&sys);

    HealthState hs = {0};
    hs.last_updated = 12345;
    hs.http_ok = TRUE;
    hs.ws_connected = TRUE;
    hs.rpc_ok = TRUE;
    hs.auth_ok = TRUE;
    state_update_health(&hs);
    g_assert_cmpint(state_get_current(), ==, STATE_RUNNING);

    // Systemd says stopped, but native health persists → RUNNING
    sys.active = FALSE;
    state_update_systemd(&sys);
    g_assert_cmpint(state_get_current(), ==, STATE_RUNNING);
}

/* ── Readiness decision table tests ── */

static void test_readiness_needs_setup(void) {
    // No unit installed, no setup detected → NEEDS_SETUP
    state_init();
    SystemdState sys = {0};
    sys.installed = FALSE;
    state_update_systemd(&sys);

    HealthState hs = {0};
    hs.last_updated = 12345;
    hs.setup_detected = FALSE;
    hs.config_valid = FALSE;
    state_update_health(&hs);

    g_assert_cmpint(state_get_current(), ==, STATE_NEEDS_SETUP);
}

static void test_readiness_needs_gateway_install(void) {
    // No unit installed, but setup is detected → NEEDS_GATEWAY_INSTALL
    state_init();
    SystemdState sys = {0};
    sys.installed = FALSE;
    state_update_systemd(&sys);

    HealthState hs = {0};
    hs.last_updated = 12345;
    hs.setup_detected = TRUE;
    hs.config_valid = TRUE;
    state_update_health(&hs);

    g_assert_cmpint(state_get_current(), ==, STATE_NEEDS_GATEWAY_INSTALL);
}

static void test_readiness_config_invalid_when_stopped(void) {
    // Unit installed, stopped, config invalid → CONFIG_INVALID
    state_init();
    SystemdState sys = {0};
    sys.installed = TRUE;
    sys.active = FALSE;
    state_update_systemd(&sys);

    HealthState hs = {0};
    hs.last_updated = 12345;
    hs.config_valid = FALSE;
    state_update_health(&hs);

    g_assert_cmpint(state_get_current(), ==, STATE_CONFIG_INVALID);
}

static void test_readiness_config_invalid_when_active_unreachable(void) {
    // Unit installed, systemd active, HTTP unreachable, config invalid → CONFIG_INVALID
    // (config invalidity surfaces when runtime truth has not proven usability)
    state_init();
    SystemdState sys = {0};
    sys.installed = TRUE;
    sys.active = TRUE;
    state_update_systemd(&sys);

    HealthState hs = {0};
    hs.last_updated = 12345;
    hs.http_ok = FALSE;
    hs.config_valid = FALSE;
    state_update_health(&hs);

    g_assert_cmpint(state_get_current(), ==, STATE_CONFIG_INVALID);
}

static void test_readiness_startup_hydration_is_starting(void) {
    // Systemd active, no health data yet → STARTING (not RUNNING)
    state_init();
    SystemdState sys = {0};
    sys.installed = TRUE;
    sys.active = TRUE;
    state_update_systemd(&sys);

    g_assert_cmpint(state_get_current(), ==, STATE_STARTING);
}

static void test_readiness_startup_hydration_to_running(void) {
    // Hydration → STARTING, then health confirms → RUNNING
    state_init();
    SystemdState sys = {0};
    sys.installed = TRUE;
    sys.active = TRUE;
    state_update_systemd(&sys);
    g_assert_cmpint(state_get_current(), ==, STATE_STARTING);

    HealthState hs = {0};
    hs.last_updated = 12345;
    hs.http_ok = TRUE;
    hs.ws_connected = TRUE;
    hs.rpc_ok = TRUE;
    hs.auth_ok = TRUE;
    hs.config_valid = TRUE;
    state_update_health(&hs);
    g_assert_cmpint(state_get_current(), ==, STATE_RUNNING);
}

int main(int argc, char **argv) {
    g_test_init(&argc, &argv, NULL);

    /* Basic systemd state tests */
    g_test_add_func("/state/initial_state", test_initial_state);
    g_test_add_func("/state/installed_inactive", test_installed_inactive);
    g_test_add_func("/state/active_without_fresh_health", test_active_without_fresh_health);

    /* Native gateway connectivity tests */
    g_test_add_func("/state/full_connectivity_running", test_full_connectivity_running);
    g_test_add_func("/state/warning_health", test_warning_health);
    g_test_add_func("/state/degraded_rpc_fail", test_degraded_rpc_fail);
    g_test_add_func("/state/http_ok_ws_disconnected_is_degraded", test_http_ok_ws_disconnected_is_degraded);

    /* Status precedence tests (runtime connectivity overrides systemd) */
    g_test_add_func("/state/precedence/systemd_inactive_native_connected", test_precedence_systemd_inactive_native_connected);
    g_test_add_func("/state/precedence/systemd_unavailable_native_connected", test_precedence_systemd_unavailable_native_connected);
    g_test_add_func("/state/precedence/systemd_active_http_down", test_precedence_systemd_active_http_down);
    g_test_add_func("/state/precedence/not_installed_native_connected", test_precedence_not_installed_native_connected);
    g_test_add_func("/state/precedence/native_connected_with_warning", test_precedence_native_connected_with_warning);
    g_test_add_func("/state/precedence/native_connected_auth_fail", test_precedence_native_connected_auth_fail);

    /* Lifecycle and generation tests */
    g_test_add_func("/state/unit_retarget_bumps_generation", test_unit_retarget_bumps_generation);
    g_test_add_func("/state/repeated_running_stopped_transitions", test_repeated_running_stopped_transitions);
    g_test_add_func("/state/transition_into_systemd_unavailable", test_transition_into_systemd_unavailable);
    g_test_add_func("/state/repeated_unit_retargets", test_repeated_unit_retargets);
    g_test_add_func("/state/health_zero_timestamp_preserves_systemd_running", test_health_zero_timestamp_preserves_systemd_running);
    g_test_add_func("/state/activation_boundary_health_persists_through_stop", test_activation_boundary_health_persists_through_stop);
    g_test_add_func("/state/systemd_stop_does_not_regress_native_connected", test_systemd_stop_does_not_regress_native_connected);

    /* Readiness decision table tests */
    g_test_add_func("/state/readiness/needs_setup", test_readiness_needs_setup);
    g_test_add_func("/state/readiness/needs_gateway_install", test_readiness_needs_gateway_install);
    g_test_add_func("/state/readiness/config_invalid_when_stopped", test_readiness_config_invalid_when_stopped);
    g_test_add_func("/state/readiness/config_invalid_when_active_unreachable", test_readiness_config_invalid_when_active_unreachable);
    g_test_add_func("/state/readiness/startup_hydration_is_starting", test_readiness_startup_hydration_is_starting);
    g_test_add_func("/state/readiness/startup_hydration_to_running", test_readiness_startup_hydration_to_running);

    return g_test_run();
}
