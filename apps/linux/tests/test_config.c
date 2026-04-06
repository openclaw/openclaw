/*
 * test_config.c
 *
 * Tests for gateway config parsing, specifically the wizard onboarding marker.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include <glib.h>
#include <glib/gstdio.h>
#include <string.h>
#include "../src/gateway_config.h"
#include <json-glib/json-glib.h>

/* Mock the gateway_config_load internals for testing just the parsing */
extern gboolean detect_has_model_config(JsonObject *root_obj);

/* Since gateway_config.c's parsing is inside a large function, we test 
 * by creating temporary JSON files and loading them.
 */
static GatewayConfig* load_config_from_json(const gchar *json_content) {
    gchar *tmp_file = g_build_filename(g_get_tmp_dir(), "openclaw_test_config.json", NULL);
    g_file_set_contents(tmp_file, json_content, -1, NULL);

    GatewayConfigContext ctx = {0};
    ctx.explicit_config_path = tmp_file;
    
    GatewayConfig *cfg = gateway_config_load(&ctx);
    
    g_unlink(tmp_file);
    g_free(tmp_file);
    
    return cfg;
}

static void test_wizard_present_valid(void) {
    const gchar *json = "{\"gateway\":{\"port\":18789,\"auth\":{\"mode\":\"none\"}},\"wizard\": {\"lastRunCommand\": \"onboard\", \"lastRunAt\": \"2023-10-27T10:00:00Z\"}}";
    GatewayConfig *cfg = load_config_from_json(json);
    
    g_assert_true(cfg->has_wizard_onboard_marker);
    g_assert_cmpstr(cfg->wizard_last_run_command, ==, "onboard");
    g_assert_cmpstr(cfg->wizard_last_run_at, ==, "2023-10-27T10:00:00Z");
    g_assert_false(cfg->wizard_is_local);
    
    gateway_config_free(cfg);
}

static void test_wizard_absent(void) {
    const gchar *json = "{\"gateway\":{\"port\":18789,\"auth\":{\"mode\":\"none\"}},\"other\": \"data\"}";
    GatewayConfig *cfg = load_config_from_json(json);
    
    g_assert_false(cfg->has_wizard_onboard_marker);
    g_assert_null(cfg->wizard_last_run_command);
    g_assert_null(cfg->wizard_last_run_at);
    g_assert_false(cfg->wizard_is_local);
    
    gateway_config_free(cfg);
}

static void test_wizard_wrong_command(void) {
    const gchar *json = "{\"gateway\":{\"port\":18789,\"auth\":{\"mode\":\"none\"}},\"wizard\": {\"lastRunCommand\": \"setup\", \"lastRunAt\": \"2023-10-27T10:00:00Z\"}}";
    GatewayConfig *cfg = load_config_from_json(json);
    
    g_assert_false(cfg->has_wizard_onboard_marker);
    g_assert_cmpstr(cfg->wizard_marker_fail_reason, ==, "lastRunCommand is not 'onboard'");
    
    gateway_config_free(cfg);
}

static void test_wizard_missing_last_run_at(void) {
    const gchar *json = "{\"gateway\":{\"port\":18789,\"auth\":{\"mode\":\"none\"}},\"wizard\": {\"lastRunCommand\": \"onboard\"}}";
    GatewayConfig *cfg = load_config_from_json(json);
    
    g_assert_false(cfg->has_wizard_onboard_marker);
    g_assert_cmpstr(cfg->wizard_marker_fail_reason, ==, "lastRunAt missing or empty");
    
    gateway_config_free(cfg);
}

static void test_wizard_local_mode(void) {
    const gchar *json = "{\"gateway\":{\"port\":18789,\"auth\":{\"mode\":\"none\"}},\"wizard\": {\"lastRunCommand\": \"onboard\", \"lastRunMode\": \"local\", \"lastRunAt\": \"2023-10-27T10:00:00Z\"}}";
    GatewayConfig *cfg = load_config_from_json(json);
    
    g_assert_true(cfg->has_wizard_onboard_marker);
    g_assert_cmpstr(cfg->wizard_last_run_mode, ==, "local");
    g_assert_true(cfg->wizard_is_local);
    
    gateway_config_free(cfg);
}

static void test_wizard_remote_mode(void) {
    const gchar *json = "{\"gateway\":{\"port\":18789,\"auth\":{\"mode\":\"none\"}},\"wizard\": {\"lastRunCommand\": \"onboard\", \"lastRunMode\": \"remote\", \"lastRunAt\": \"2023-10-27T10:00:00Z\"}}";
    GatewayConfig *cfg = load_config_from_json(json);
    
    g_assert_true(cfg->has_wizard_onboard_marker);
    g_assert_cmpstr(cfg->wizard_last_run_mode, ==, "remote");
    g_assert_false(cfg->wizard_is_local);
    
    gateway_config_free(cfg);
}

static void test_wizard_absent_model_present(void) {
    const gchar *json = "{\"gateway\":{\"port\":18789,\"auth\":{\"mode\":\"none\"}},\"agents\": {\"default\": {\"model\": \"llama-2\"}}}";
    GatewayConfig *cfg = load_config_from_json(json);
    
    g_assert_false(cfg->has_wizard_onboard_marker);
    g_assert_true(cfg->has_model_config); /* model config exists, but wizard marker does not */
    
    gateway_config_free(cfg);
}

static void test_wizard_empty_last_run_at(void) {
    const gchar *json = "{\"gateway\":{\"port\":18789,\"auth\":{\"mode\":\"none\"}},\"wizard\": {\"lastRunCommand\": \"onboard\", \"lastRunAt\": \"\"}}";
    GatewayConfig *cfg = load_config_from_json(json);
    
    g_assert_false(cfg->has_wizard_onboard_marker);
    g_assert_cmpstr(cfg->wizard_marker_fail_reason, ==, "lastRunAt missing or empty");
    
    gateway_config_free(cfg);
}

int main(int argc, char **argv) {
    g_test_init(&argc, &argv, NULL);

    g_test_add_func("/config/wizard/present_valid", test_wizard_present_valid);
    g_test_add_func("/config/wizard/absent", test_wizard_absent);
    g_test_add_func("/config/wizard/wrong_command", test_wizard_wrong_command);
    g_test_add_func("/config/wizard/missing_last_run_at", test_wizard_missing_last_run_at);
    g_test_add_func("/config/wizard/local_mode", test_wizard_local_mode);
    g_test_add_func("/config/wizard/remote_mode", test_wizard_remote_mode);
    g_test_add_func("/config/wizard/absent_model_present", test_wizard_absent_model_present);
    g_test_add_func("/config/wizard/empty_last_run_at", test_wizard_empty_last_run_at);

    return g_test_run();
}
