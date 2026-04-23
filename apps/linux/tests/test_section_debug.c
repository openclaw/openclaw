#include <glib.h>

#include "../src/section_debug.h"
#include "../src/gateway_config.h"
#include "../src/runtime_paths.h"
#include "../src/state.h"

void gateway_client_refresh(void) {}
static GatewayConfig stub_cfg = {0};
static gchar *stub_runtime_profile = NULL;
static gchar *stub_runtime_state_dir = NULL;
static gchar *stub_runtime_config_path = NULL;
static gchar *stub_effective_config_path = NULL;

static void reset_debug_path_stubs(void) {
    g_clear_pointer(&stub_cfg.config_path, g_free);
    g_clear_pointer(&stub_runtime_profile, g_free);
    g_clear_pointer(&stub_runtime_state_dir, g_free);
    g_clear_pointer(&stub_runtime_config_path, g_free);
    g_clear_pointer(&stub_effective_config_path, g_free);
}

GatewayConfig* gateway_client_get_config(void) {
    return stub_cfg.config_path ? &stub_cfg : NULL;
}
void product_coordinator_request_rerun_onboarding(void) {}
const gchar* systemd_get_canonical_unit_name(void) {
    return "openclaw-gateway.service";
}
void systemd_get_runtime_context(gchar **out_profile,
                                 gchar **out_state_dir,
                                 gchar **out_config_path) {
    if (out_profile) {
        *out_profile = g_strdup(stub_runtime_profile);
    }
    if (out_state_dir) {
        *out_state_dir = g_strdup(stub_runtime_state_dir);
    }
    if (out_config_path) {
        *out_config_path = g_strdup(stub_runtime_config_path);
    }
}
void runtime_effective_paths_resolve(const GatewayConfig *loaded_config,
                                     const gchar *profile,
                                     const gchar *runtime_state_dir,
                                     const gchar *runtime_config_path,
                                     RuntimeEffectivePaths *out) {
    (void)loaded_config;
    (void)profile;
    (void)runtime_state_dir;
    (void)runtime_config_path;
    out->effective_config_path = g_strdup(stub_effective_config_path);
    out->effective_state_dir = NULL;
}
void runtime_effective_paths_clear(RuntimeEffectivePaths *paths) {
    if (!paths) {
        return;
    }
    g_clear_pointer(&paths->effective_config_path, g_free);
    g_clear_pointer(&paths->effective_state_dir, g_free);
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

static void test_debug_reveal_config_uri_uses_effective_runtime_path(void) {
    reset_debug_path_stubs();
    stub_cfg.config_path = g_strdup("/tmp/openclaw-loaded/openclaw.json");
    stub_runtime_profile = g_strdup("default");
    stub_runtime_state_dir = g_strdup("/tmp/openclaw-state");
    stub_runtime_config_path = g_strdup("/tmp/openclaw-runtime/openclaw.json");
    stub_effective_config_path = g_strdup("/tmp/openclaw-effective/openclaw.json");

    g_autofree gchar *uri = section_debug_test_build_reveal_config_uri();
    g_autofree gchar *expected = g_filename_to_uri("/tmp/openclaw-effective", NULL, NULL);

    g_assert_cmpstr(uri, ==, expected);

    reset_debug_path_stubs();
}

static void test_debug_reveal_config_uri_returns_null_without_effective_path(void) {
    reset_debug_path_stubs();
    stub_cfg.config_path = g_strdup("/tmp/openclaw-loaded/openclaw.json");
    stub_runtime_profile = g_strdup("default");
    stub_runtime_state_dir = g_strdup("/tmp/openclaw-state");
    stub_runtime_config_path = g_strdup("/tmp/openclaw-runtime/openclaw.json");

    g_autofree gchar *uri = section_debug_test_build_reveal_config_uri();

    g_assert_null(uri);

    reset_debug_path_stubs();
}

int main(int argc, char **argv) {
    g_test_init(&argc, &argv, NULL);

    g_test_add_func("/section_debug/actions_exclude_duplicate_diagnostics_affordance",
                    test_debug_actions_exclude_duplicate_diagnostics_affordance);
    g_test_add_func("/section_debug/reveal_config_uri_uses_effective_runtime_path",
                    test_debug_reveal_config_uri_uses_effective_runtime_path);
    g_test_add_func("/section_debug/reveal_config_uri_returns_null_without_effective_path",
                    test_debug_reveal_config_uri_returns_null_without_effective_path);

    int result = g_test_run();
    reset_debug_path_stubs();
    return result;
}
