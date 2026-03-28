#include <glib.h>
#include "../src/systemd_helpers.h"

static void test_gateway_filename_acceptance(void) {
    g_assert_true(systemd_is_gateway_unit("openclaw-gateway.service", ""));
}

static void test_profiled_gateway_filename_acceptance(void) {
    g_assert_true(systemd_is_gateway_unit("openclaw-gateway-work.service", ""));
}

static void test_legacy_gateway_filename_acceptance(void) {
    g_assert_true(systemd_is_gateway_unit("clawdbot-gateway.service", ""));
    g_assert_true(systemd_is_gateway_unit("moltbot-gateway.service", ""));
}

static void test_node_filename_rejection(void) {
    g_assert_false(systemd_is_gateway_unit("openclaw-node.service", ""));
}

static void test_manual_filename_only_without_marker(void) {
    g_assert_true(systemd_is_gateway_unit("openclaw-gateway.service", "[Service]\nExecStart=/usr/bin/openclaw"));
}

static void test_kind_marker_accepts_gateway(void) {
    g_assert_true(systemd_is_gateway_unit("some-custom-name.service", "OPENCLAW_SERVICE_KIND=gateway"));
}

static void test_null_inputs_handled_safely(void) {
    g_assert_false(systemd_is_gateway_unit(NULL, ""));
    g_assert_false(systemd_is_gateway_unit("openclaw-gateway.service", NULL));
    g_assert_false(systemd_is_gateway_unit(NULL, NULL));
    
    g_assert_null(systemd_normalize_unit_override(NULL));
    g_assert_null(systemd_normalize_profile(NULL));
}

static void test_non_gateway_partially_resembling_names(void) {
    // Should fail because it doesn't match the exact prefix
    g_assert_false(systemd_is_gateway_unit("my-openclaw-gateway.service", ""));
    g_assert_false(systemd_is_gateway_unit("openclaw-gatewayd.service", ""));
}

static void test_normalize_explicit_unit_override_without_suffix(void) {
    gchar *res = systemd_normalize_unit_override("my-unit");
    g_assert_cmpstr(res, ==, "my-unit.service");
    g_free(res);
}

static void test_normalize_explicit_unit_override_with_suffix(void) {
    gchar *res = systemd_normalize_unit_override("my-unit.service");
    g_assert_cmpstr(res, ==, "my-unit.service");
    g_free(res);
}

static void test_normalize_trim_whitespace_in_explicit_override(void) {
    gchar *res = systemd_normalize_unit_override("  my-unit  ");
    g_assert_cmpstr(res, ==, "my-unit.service");
    g_free(res);
}

static void test_normalize_whitespace_only_override(void) {
    gchar *res = systemd_normalize_unit_override("   ");
    g_assert_null(res);
}

static void test_normalize_unusual_but_valid_service_names(void) {
    gchar *res1 = systemd_normalize_unit_override("my@unit.service");
    g_assert_cmpstr(res1, ==, "my@unit.service");
    g_free(res1);
    
    gchar *res2 = systemd_normalize_unit_override("my-unit.123");
    g_assert_cmpstr(res2, ==, "my-unit.123.service");
    g_free(res2);
}

static void test_normalize_default_profile(void) {
    gchar *res = systemd_normalize_profile("default");
    g_assert_cmpstr(res, ==, "openclaw-gateway.service");
    g_free(res);
}

static void test_normalize_empty_whitespace_profile(void) {
    gchar *res1 = systemd_normalize_profile("");
    g_assert_cmpstr(res1, ==, "openclaw-gateway.service");
    g_free(res1);

    gchar *res2 = systemd_normalize_profile("   ");
    g_assert_cmpstr(res2, ==, "openclaw-gateway.service");
    g_free(res2);
}

static void test_normalize_named_profile(void) {
    gchar *res = systemd_normalize_profile("work");
    g_assert_cmpstr(res, ==, "openclaw-gateway-work.service");
    g_free(res);
}

static void test_gateway_unit_name_accepts_canonical(void) {
    g_assert_true(systemd_is_gateway_unit_name("openclaw-gateway.service"));
}

static void test_gateway_unit_name_accepts_profiled(void) {
    g_assert_true(systemd_is_gateway_unit_name("openclaw-gateway-work.service"));
}

static void test_gateway_unit_name_accepts_legacy(void) {
    g_assert_true(systemd_is_gateway_unit_name("clawdbot-gateway.service"));
    g_assert_true(systemd_is_gateway_unit_name("clawdbot-gateway-prod.service"));
    g_assert_true(systemd_is_gateway_unit_name("moltbot-gateway.service"));
    g_assert_true(systemd_is_gateway_unit_name("moltbot-gateway-work.service"));
}

static void test_gateway_unit_name_rejects_non_gateway(void) {
    g_assert_false(systemd_is_gateway_unit_name("openclaw-node.service"));
    g_assert_false(systemd_is_gateway_unit_name("some-custom-name.service"));
    g_assert_false(systemd_is_gateway_unit_name("my-openclaw-gateway.service"));
    g_assert_false(systemd_is_gateway_unit_name("openclaw-gatewayd.service"));
}

static void test_gateway_unit_name_null_safe(void) {
    g_assert_false(systemd_is_gateway_unit_name(NULL));
}

static void test_helpers_get_user_unit_paths_contains_all(void) {
    GPtrArray *paths = systemd_helpers_get_user_unit_paths("/home/test");
    
    gboolean found_config = FALSE;
    gboolean found_local_share = FALSE;
    gboolean found_etc = FALSE;
    gboolean found_xdg = FALSE;
    gboolean found_usr_lib = FALSE;
    gboolean found_usr_local_lib = FALSE;
    gboolean found_usr_share = FALSE;
    gboolean found_lib = FALSE;

    for (guint i = 0; i < paths->len; i++) {
        const gchar *path = g_ptr_array_index(paths, i);
        if (g_strcmp0(path, "/home/test/.config/systemd/user") == 0) found_config = TRUE;
        if (g_strcmp0(path, "/home/test/.local/share/systemd/user") == 0) found_local_share = TRUE;
        if (g_strcmp0(path, "/etc/systemd/user") == 0) found_etc = TRUE;
        if (g_strcmp0(path, "/etc/xdg/systemd/user") == 0) found_xdg = TRUE;
        if (g_strcmp0(path, "/usr/lib/systemd/user") == 0) found_usr_lib = TRUE;
        if (g_strcmp0(path, "/usr/local/lib/systemd/user") == 0) found_usr_local_lib = TRUE;
        if (g_strcmp0(path, "/usr/share/systemd/user") == 0) found_usr_share = TRUE;
        if (g_strcmp0(path, "/lib/systemd/user") == 0) found_lib = TRUE;
    }
    
    g_assert_true(found_config);
    g_assert_true(found_local_share);
    g_assert_true(found_etc);
    g_assert_true(found_xdg);
    g_assert_true(found_usr_lib);
    g_assert_true(found_usr_local_lib);
    g_assert_true(found_usr_share);
    g_assert_true(found_lib);
    
    g_ptr_array_free(paths, TRUE);
}

static void test_parse_unit_env_simple(void) {
    const gchar *contents =
        "[Unit]\nDescription=OpenClaw Gateway\n\n"
        "[Service]\nExecStart=/usr/bin/openclaw gateway run\n"
        "Environment=OPENCLAW_STATE_DIR=/home/user/.openclaw-work\n"
        "Environment=OPENCLAW_SERVICE_KIND=gateway\n";

    gchar *state_dir = systemd_helpers_parse_unit_env(contents, "OPENCLAW_STATE_DIR");
    g_assert_cmpstr(state_dir, ==, "/home/user/.openclaw-work");
    g_free(state_dir);

    gchar *kind = systemd_helpers_parse_unit_env(contents, "OPENCLAW_SERVICE_KIND");
    g_assert_cmpstr(kind, ==, "gateway");
    g_free(kind);

    gchar *missing = systemd_helpers_parse_unit_env(contents, "OPENCLAW_CONFIG_PATH");
    g_assert_null(missing);
}

static void test_parse_unit_env_quoted(void) {
    const gchar *contents =
        "[Service]\n"
        "Environment=\"OPENCLAW_STATE_DIR=/home/user/.openclaw-work\"\n"
        "Environment=\"OPENCLAW_CONFIG_PATH=/etc/openclaw/config.json\"\n";

    gchar *state_dir = systemd_helpers_parse_unit_env(contents, "OPENCLAW_STATE_DIR");
    g_assert_cmpstr(state_dir, ==, "/home/user/.openclaw-work");
    g_free(state_dir);

    gchar *config_path = systemd_helpers_parse_unit_env(contents, "OPENCLAW_CONFIG_PATH");
    g_assert_cmpstr(config_path, ==, "/etc/openclaw/config.json");
    g_free(config_path);
}

static void test_parse_unit_env_null_safe(void) {
    g_assert_null(systemd_helpers_parse_unit_env(NULL, "KEY"));
    g_assert_null(systemd_helpers_parse_unit_env("Environment=KEY=val", NULL));
    g_assert_null(systemd_helpers_parse_unit_env("Environment=KEY=val", ""));
}

static void test_parse_unit_env_no_false_prefix_match(void) {
    /* OPENCLAW_STATE_DIR_EXTRA should not match OPENCLAW_STATE_DIR */
    const gchar *contents =
        "[Service]\n"
        "Environment=OPENCLAW_STATE_DIR_EXTRA=/wrong/path\n";

    gchar *result = systemd_helpers_parse_unit_env(contents, "OPENCLAW_STATE_DIR");
    g_assert_null(result);
}

static void test_helpers_get_system_unit_paths_contains_all(void) {
    GPtrArray *paths = systemd_helpers_get_system_unit_paths();
    
    gboolean found_etc = FALSE;
    gboolean found_usr_lib = FALSE;
    gboolean found_usr_local_lib = FALSE;
    gboolean found_lib = FALSE;

    for (guint i = 0; i < paths->len; i++) {
        const gchar *path = g_ptr_array_index(paths, i);
        if (g_strcmp0(path, "/etc/systemd/system") == 0) found_etc = TRUE;
        if (g_strcmp0(path, "/usr/lib/systemd/system") == 0) found_usr_lib = TRUE;
        if (g_strcmp0(path, "/usr/local/lib/systemd/system") == 0) found_usr_local_lib = TRUE;
        if (g_strcmp0(path, "/lib/systemd/system") == 0) found_lib = TRUE;
    }
    
    g_assert_true(found_etc);
    g_assert_true(found_usr_lib);
    g_assert_true(found_usr_local_lib);
    g_assert_true(found_lib);
    
    g_ptr_array_free(paths, TRUE);
}

int main(int argc, char **argv) {
    g_test_init(&argc, &argv, NULL);
    
    g_test_add_func("/systemd/gateway_filename_acceptance", test_gateway_filename_acceptance);
    g_test_add_func("/systemd/profiled_gateway_filename_acceptance", test_profiled_gateway_filename_acceptance);
    g_test_add_func("/systemd/legacy_gateway_filename_acceptance", test_legacy_gateway_filename_acceptance);
    g_test_add_func("/systemd/node_filename_rejection", test_node_filename_rejection);
    g_test_add_func("/systemd/manual_filename_only_without_marker", test_manual_filename_only_without_marker);
    g_test_add_func("/systemd/kind_marker_accepts_gateway", test_kind_marker_accepts_gateway);
    g_test_add_func("/systemd/null_inputs_handled_safely", test_null_inputs_handled_safely);
    g_test_add_func("/systemd/non_gateway_partially_resembling_names", test_non_gateway_partially_resembling_names);
    
    g_test_add_func("/systemd/normalize_explicit_unit_override_without_suffix", test_normalize_explicit_unit_override_without_suffix);
    g_test_add_func("/systemd/normalize_explicit_unit_override_with_suffix", test_normalize_explicit_unit_override_with_suffix);
    g_test_add_func("/systemd/normalize_trim_whitespace_in_explicit_override", test_normalize_trim_whitespace_in_explicit_override);
    g_test_add_func("/systemd/normalize_whitespace_only_override", test_normalize_whitespace_only_override);
    g_test_add_func("/systemd/normalize_unusual_but_valid_service_names", test_normalize_unusual_but_valid_service_names);
    
    g_test_add_func("/systemd/normalize_default_profile", test_normalize_default_profile);
    g_test_add_func("/systemd/normalize_empty_whitespace_profile", test_normalize_empty_whitespace_profile);
    g_test_add_func("/systemd/normalize_named_profile", test_normalize_named_profile);
    
    g_test_add_func("/systemd/gateway_unit_name_accepts_canonical", test_gateway_unit_name_accepts_canonical);
    g_test_add_func("/systemd/gateway_unit_name_accepts_profiled", test_gateway_unit_name_accepts_profiled);
    g_test_add_func("/systemd/gateway_unit_name_accepts_legacy", test_gateway_unit_name_accepts_legacy);
    g_test_add_func("/systemd/gateway_unit_name_rejects_non_gateway", test_gateway_unit_name_rejects_non_gateway);
    g_test_add_func("/systemd/gateway_unit_name_null_safe", test_gateway_unit_name_null_safe);

    g_test_add_func("/systemd/helpers_get_user_unit_paths_contains_all", test_helpers_get_user_unit_paths_contains_all);
    g_test_add_func("/systemd/helpers_get_system_unit_paths_contains_all", test_helpers_get_system_unit_paths_contains_all);

    g_test_add_func("/systemd/parse_unit_env_simple", test_parse_unit_env_simple);
    g_test_add_func("/systemd/parse_unit_env_quoted", test_parse_unit_env_quoted);
    g_test_add_func("/systemd/parse_unit_env_null_safe", test_parse_unit_env_null_safe);
    g_test_add_func("/systemd/parse_unit_env_no_false_prefix_match", test_parse_unit_env_no_false_prefix_match);

    return g_test_run();
}
