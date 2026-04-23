#include <glib.h>

#include "../src/section_debug.h"
#include "../src/gateway_config.h"
#include "../src/state.h"

void gateway_client_refresh(void) {}
GatewayConfig* gateway_client_get_config(void) {
    return NULL;
}
void product_coordinator_request_rerun_onboarding(void) {}
const gchar* systemd_get_canonical_unit_name(void) {
    return "openclaw-gateway.service";
}
SystemdState* state_get_systemd(void) {
    static SystemdState sys = {0};
    return &sys;
}
void systemd_restart_gateway(void) {}

static void test_debug_actions_exclude_duplicate_diagnostics_affordance(void) {
    g_assert_true(section_debug_test_has_action_label("Trigger Health Refresh"));
    g_assert_true(section_debug_test_has_action_label("Restart Gateway"));
    g_assert_true(section_debug_test_has_action_label("Reveal Config Folder"));
    g_assert_true(section_debug_test_has_action_label("Restart Onboarding"));
    g_assert_false(section_debug_test_has_action_label("Copy Diagnostics Dump"));
    g_assert_false(section_debug_test_has_action_label("Copy Diagnostics"));
}

int main(int argc, char **argv) {
    g_test_init(&argc, &argv, NULL);

    g_test_add_func("/section_debug/actions_exclude_duplicate_diagnostics_affordance",
                    test_debug_actions_exclude_duplicate_diagnostics_affordance);

    return g_test_run();
}
