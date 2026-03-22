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
    
    return g_test_run();
}
