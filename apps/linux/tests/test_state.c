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
void state_on_probe_refresh_requested(void) {}

static void test_initial_state(void) {
    state_init();
    g_assert_cmpint(state_get_current(), ==, STATE_NOT_INSTALLED);
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
    hs.loaded = TRUE;
    hs.rpc_ok = TRUE;
    hs.health_healthy = TRUE;
    hs.config_audit_ok = FALSE;
    hs.config_issues_count = 1;
    state_update_health(&hs);
    
    g_assert_cmpint(state_get_current(), ==, STATE_RUNNING_WITH_WARNING);
}

static void test_degraded_health(void) {
    state_init();
    SystemdState sys = {0};
    sys.installed = TRUE;
    sys.active = TRUE;
    state_update_systemd(&sys);
    
    HealthState hs = {0};
    hs.last_updated = 12345;
    hs.loaded = TRUE;
    hs.rpc_ok = FALSE; // Degraded
    hs.health_healthy = FALSE;
    state_update_health(&hs);
    
    g_assert_cmpint(state_get_current(), ==, STATE_DEGRADED);
}

static void test_entering_probe_disabled_clears_freshness(void) {
    state_init();
    SystemdState sys = {0};
    sys.installed = TRUE;
    sys.active = TRUE;
    state_update_systemd(&sys);
    
    HealthState hs = {0};
    hs.last_updated = 12345;
    hs.loaded = TRUE;
    hs.rpc_ok = TRUE;
    hs.health_healthy = TRUE;
    state_update_health(&hs);
    
    ProbeState ps = {0};
    ps.last_updated = 12345;
    ps.summary = g_strdup("Fully reachable");
    state_update_probe(&ps);
    g_free(ps.summary);
    
    // Transition to stopped
    sys.active = FALSE;
    state_update_systemd(&sys);
    
    g_assert_cmpint(state_get_health()->last_updated, ==, 0);
    g_assert_cmpint(state_get_probe()->last_updated, ==, 0);
    g_assert_null(state_get_probe()->summary);
}

static void test_activation_boundary_prevents_stale_inheritance(void) {
    state_init();
    SystemdState sys = {0};
    sys.installed = TRUE;
    sys.active = TRUE;
    state_update_systemd(&sys);
    
    // Seed old degraded health
    HealthState hs = {0};
    hs.last_updated = 12345;
    hs.loaded = TRUE;
    hs.rpc_ok = FALSE;
    hs.health_healthy = FALSE;
    state_update_health(&hs);
    g_assert_cmpint(state_get_current(), ==, STATE_DEGRADED);
    
    // Stop it
    sys.active = FALSE;
    state_update_systemd(&sys);
    g_assert_cmpint(state_get_current(), ==, STATE_STOPPED);
    
    // Start it again
    sys.active = TRUE;
    state_update_systemd(&sys);
    
    // Should NOT inherit the degraded state before fresh health arrives
    g_assert_cmpint(state_get_current(), ==, STATE_RUNNING);
}

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

static void test_probe_disabled_transition_bumps_generation(void) {
    state_init();
    SystemdState sys = {0};
    sys.installed = TRUE;
    sys.active = TRUE;
    state_update_systemd(&sys);
    
    guint64 gen1 = state_get_health_generation();
    
    sys.active = FALSE;
    state_update_systemd(&sys);
    
    guint64 gen2 = state_get_health_generation();
    g_assert_cmpuint(gen2, >, gen1);
}

static void test_restart_clears_payload_fields(void) {
    state_init();
    SystemdState sys = {0};
    sys.installed = TRUE;
    sys.active = TRUE;
    state_update_systemd(&sys);
    
    HealthState hs = {0};
    hs.last_updated = 12345;
    hs.loaded = TRUE;
    hs.rpc_ok = TRUE;
    hs.health_healthy = TRUE;
    hs.bind_host = g_strdup("127.0.0.1");
    hs.probe_url = g_strdup("http://localhost");
    state_update_health(&hs);
    
    // Restart (stop then start)
    sys.active = FALSE;
    state_update_systemd(&sys);
    sys.active = TRUE;
    state_update_systemd(&sys);
    
    g_assert_cmpint(state_get_health()->rpc_ok, ==, FALSE);
    g_assert_cmpint(state_get_health()->health_healthy, ==, FALSE);
    g_assert_null(state_get_health()->bind_host);
    g_assert_null(state_get_health()->probe_url);
    
    g_free(hs.bind_host);
    g_free(hs.probe_url);
}

int main(int argc, char **argv) {
    g_test_init(&argc, &argv, NULL);
    
    g_test_add_func("/state/initial_state", test_initial_state);
    g_test_add_func("/state/installed_inactive", test_installed_inactive);
    g_test_add_func("/state/active_without_fresh_health", test_active_without_fresh_health);
    g_test_add_func("/state/warning_health", test_warning_health);
    g_test_add_func("/state/degraded_health", test_degraded_health);
    g_test_add_func("/state/entering_probe_disabled_clears_freshness", test_entering_probe_disabled_clears_freshness);
    g_test_add_func("/state/activation_boundary_prevents_stale_inheritance", test_activation_boundary_prevents_stale_inheritance);
    g_test_add_func("/state/unit_retarget_bumps_generation", test_unit_retarget_bumps_generation);
    g_test_add_func("/state/probe_disabled_transition_bumps_generation", test_probe_disabled_transition_bumps_generation);
    g_test_add_func("/state/restart_clears_payload_fields", test_restart_clears_payload_fields);
    
    return g_test_run();
}
