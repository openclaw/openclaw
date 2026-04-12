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
#include "../src/config_setup_transform.h"
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

static void test_setup_apply_provider_writes_richer_shape(void) {
    const gchar *raw = "{\"gateway\":{\"port\":18789,\"auth\":{\"mode\":\"none\"}},\"models\":{\"providers\":{\"openai\":{\"organization\":\"acme\"}}}}";
    g_autoptr(GError) err = NULL;
    g_autofree gchar *updated = config_setup_apply_provider(raw, "openai", "https://api.openai.com/v1", &err);
    g_assert_no_error(err);
    g_assert_nonnull(updated);

    g_autoptr(JsonParser) parser = json_parser_new();
    g_assert_true(json_parser_load_from_data(parser, updated, -1, &err));
    JsonObject *root = json_node_get_object(json_parser_get_root(parser));

    JsonObject *models = json_node_get_object(json_object_get_member(root, "models"));
    JsonObject *providers = json_node_get_object(json_object_get_member(models, "providers"));
    JsonObject *openai = json_node_get_object(json_object_get_member(providers, "openai"));
    g_assert_cmpstr(json_object_get_string_member(openai, "baseUrl"), ==, "https://api.openai.com/v1");
    g_assert_cmpstr(json_object_get_string_member(openai, "api"), ==, "openai-responses");
    g_assert_cmpstr(json_object_get_string_member(openai, "organization"), ==, "acme");

    JsonObject *plugins = json_node_get_object(json_object_get_member(root, "plugins"));
    JsonObject *entries = json_node_get_object(json_object_get_member(plugins, "entries"));
    JsonObject *provider_entry = json_node_get_object(json_object_get_member(entries, "openai"));
    g_assert_true(json_object_get_boolean_member(provider_entry, "enabled"));

    JsonObject *auth = json_node_get_object(json_object_get_member(root, "auth"));
    JsonObject *profiles = json_node_get_object(json_object_get_member(auth, "profiles"));
    JsonObject *profile = json_node_get_object(json_object_get_member(profiles, "openai:default"));
    g_assert_cmpstr(json_object_get_string_member(profile, "provider"), ==, "openai");
    g_assert_cmpstr(json_object_get_string_member(profile, "mode"), ==, "api_key");

    JsonObject *order = json_node_get_object(json_object_get_member(auth, "order"));
    JsonArray *openai_order = json_node_get_array(json_object_get_member(order, "openai"));
    g_assert_cmpuint(json_array_get_length(openai_order), ==, 1);
    g_assert_cmpstr(json_array_get_string_element(openai_order, 0), ==, "openai:default");
}

static void test_setup_apply_default_model_writes_models_map(void) {
    const gchar *raw = "{\"gateway\":{\"port\":18789,\"auth\":{\"mode\":\"none\"}},\"agents\":{\"defaults\":{\"model\":{\"primary\":\"old/model\"},\"models\":{\"old/model\":{\"temperature\":0.1}}}}}";
    g_autoptr(GError) err = NULL;
    g_autofree gchar *updated = config_setup_apply_default_model(raw, "openai", "openai/gpt-4.1", &err);
    g_assert_no_error(err);
    g_assert_nonnull(updated);

    g_autoptr(JsonParser) parser = json_parser_new();
    g_assert_true(json_parser_load_from_data(parser, updated, -1, &err));
    JsonObject *root = json_node_get_object(json_parser_get_root(parser));
    JsonObject *agents = json_node_get_object(json_object_get_member(root, "agents"));
    JsonObject *defaults = json_node_get_object(json_object_get_member(agents, "defaults"));
    JsonObject *model = json_node_get_object(json_object_get_member(defaults, "model"));
    JsonObject *models_map = json_node_get_object(json_object_get_member(defaults, "models"));

    g_assert_cmpstr(json_object_get_string_member(model, "primary"), ==, "openai/gpt-4.1");
    g_assert_cmpstr(json_object_get_string_member(defaults, "modelProvider"), ==, "openai");
    g_assert_true(json_object_has_member(models_map, "openai/gpt-4.1"));
    g_assert_true(json_object_has_member(models_map, "old/model"));
}

static void test_setup_apply_provider_malformed_recoverable(void) {
    const gchar *raw = "{\"gateway\":{\"port\":18789,\"auth\":{\"mode\":\"none\"}},\"models\":{\"providers\":\"oops\"},\"plugins\":\"oops\",\"auth\":{\"profiles\":\"oops\"}}";
    g_autoptr(GError) err = NULL;
    g_autofree gchar *updated = config_setup_apply_provider(raw, "ollama", "http://127.0.0.1:11434", &err);
    g_assert_no_error(err);
    g_assert_nonnull(updated);

    g_autoptr(JsonParser) parser = json_parser_new();
    g_assert_true(json_parser_load_from_data(parser, updated, -1, &err));
    JsonObject *root = json_node_get_object(json_parser_get_root(parser));

    JsonObject *models = json_node_get_object(json_object_get_member(root, "models"));
    JsonObject *providers = json_node_get_object(json_object_get_member(models, "providers"));
    JsonObject *ollama = json_node_get_object(json_object_get_member(providers, "ollama"));
    g_assert_cmpstr(json_object_get_string_member(ollama, "baseUrl"), ==, "http://127.0.0.1:11434");
    g_assert_cmpstr(json_object_get_string_member(ollama, "api"), ==, "ollama");
    g_assert_cmpstr(json_object_get_string_member(ollama, "apiKey"), ==, "ollama-local");

    JsonObject *plugins = json_node_get_object(json_object_get_member(root, "plugins"));
    JsonObject *entries = json_node_get_object(json_object_get_member(plugins, "entries"));
    g_assert_true(json_object_has_member(entries, "ollama"));

    JsonObject *auth = json_node_get_object(json_object_get_member(root, "auth"));
    JsonObject *profiles = json_node_get_object(json_object_get_member(auth, "profiles"));
    JsonObject *profile = json_node_get_object(json_object_get_member(profiles, "ollama:default"));
    g_assert_cmpstr(json_object_get_string_member(profile, "provider"), ==, "ollama");
    g_assert_cmpstr(json_object_get_string_member(profile, "mode"), ==, "api_key");
}

static void test_setup_apply_provider_preserves_auth_order(void) {
    const gchar *raw =
        "{\"gateway\":{\"port\":18789,\"auth\":{\"mode\":\"none\"}},"
        "\"auth\":{\"order\":{\"openai\":[\"openai:work\"]}},"
        "\"models\":{\"providers\":{\"openai\":{}}}}";
    g_autoptr(GError) err = NULL;
    g_autofree gchar *updated = config_setup_apply_provider(raw, "openai", NULL, &err);
    g_assert_no_error(err);
    g_assert_nonnull(updated);

    g_autoptr(JsonParser) parser = json_parser_new();
    g_assert_true(json_parser_load_from_data(parser, updated, -1, &err));
    JsonObject *root = json_node_get_object(json_parser_get_root(parser));

    JsonObject *auth = json_node_get_object(json_object_get_member(root, "auth"));
    JsonObject *order = json_node_get_object(json_object_get_member(auth, "order"));
    JsonArray *openai_order = json_node_get_array(json_object_get_member(order, "openai"));
    g_assert_cmpuint(json_array_get_length(openai_order), ==, 2);
    g_assert_cmpstr(json_array_get_string_element(openai_order, 0), ==, "openai:work");
    g_assert_cmpstr(json_array_get_string_element(openai_order, 1), ==, "openai:default");
}

static void test_model_config_default_present_provider_malformed(void) {
    const gchar *json = "{\"gateway\":{\"port\":18789,\"auth\":{\"mode\":\"none\"}},\"models\":{\"providers\":\"invalid\"},\"agents\":{\"defaults\":{\"model\":{\"primary\":\"openai/gpt-4.1\"}}}}";
    GatewayConfig *cfg = load_config_from_json(json);

    g_assert_false(cfg->has_provider_config);
    g_assert_true(cfg->has_default_model_config);
    g_assert_true(cfg->has_model_config);
    gateway_config_free(cfg);
}

static void test_model_config_agents_defaults_model_primary(void) {
    const gchar *json = "{\"gateway\":{\"port\":18789,\"auth\":{\"mode\":\"none\"}},\"agents\":{\"defaults\":{\"model\":{\"primary\":\"ollama/gpt-oss:20b\"}}}}";
    GatewayConfig *cfg = load_config_from_json(json);

    g_assert_true(cfg->has_model_config);
    g_assert_false(cfg->has_provider_config);
    g_assert_true(cfg->has_default_model_config);
    gateway_config_free(cfg);
}

static void test_model_config_minimal_onboard_false(void) {
    const gchar *json = "{\"gateway\":{\"port\":18789,\"auth\":{\"mode\":\"none\"}},\"wizard\":{\"lastRunCommand\":\"onboard\",\"lastRunAt\":\"2026-04-01T10:00:00Z\"}}";
    GatewayConfig *cfg = load_config_from_json(json);

    g_assert_false(cfg->has_model_config);
    gateway_config_free(cfg);
}

static void test_model_config_agents_defaults_models_empty_false(void) {
    const gchar *json = "{\"gateway\":{\"port\":18789,\"auth\":{\"mode\":\"none\"}},\"agents\":{\"defaults\":{\"models\":{}}}}";
    GatewayConfig *cfg = load_config_from_json(json);

    g_assert_false(cfg->has_model_config);
    gateway_config_free(cfg);
}

static void test_model_config_root_providers_empty_false(void) {
    const gchar *json = "{\"gateway\":{\"port\":18789,\"auth\":{\"mode\":\"none\"}},\"models\":{\"providers\":{}}}";
    GatewayConfig *cfg = load_config_from_json(json);

    g_assert_false(cfg->has_model_config);
    gateway_config_free(cfg);
}

static void test_model_config_agents_defaults_model_malformed_false(void) {
    const gchar *json = "{\"gateway\":{\"port\":18789,\"auth\":{\"mode\":\"none\"}},\"agents\":{\"defaults\":{\"model\":{\"primary\":42}}}}";
    GatewayConfig *cfg = load_config_from_json(json);

    g_assert_false(cfg->has_model_config);
    gateway_config_free(cfg);
}

static void test_model_config_agents_defaults_models_map(void) {
    const gchar *json = "{\"gateway\":{\"port\":18789,\"auth\":{\"mode\":\"none\"}},\"agents\":{\"defaults\":{\"models\":{\"ollama/gpt-oss:20b\":{}}}}}";
    GatewayConfig *cfg = load_config_from_json(json);

    g_assert_true(cfg->has_model_config);
    gateway_config_free(cfg);
}

static void test_model_config_root_models_providers(void) {
    const gchar *json = "{\"gateway\":{\"port\":18789,\"auth\":{\"mode\":\"none\"}},\"models\":{\"providers\":{\"ollama\":{\"baseUrl\":\"http://127.0.0.1:11434\"}}}}";
    GatewayConfig *cfg = load_config_from_json(json);

    g_assert_true(cfg->has_model_config);
    g_assert_true(cfg->has_provider_config);
    g_assert_false(cfg->has_default_model_config);
    gateway_config_free(cfg);
}

static void test_model_config_provider_present_default_absent(void) {
    const gchar *json = "{\"gateway\":{\"port\":18789,\"auth\":{\"mode\":\"none\"}},\"models\":{\"providers\":{\"openai\":{\"apiKey\":\"test\"}}},\"agents\":{\"defaults\":{}}}";
    GatewayConfig *cfg = load_config_from_json(json);

    g_assert_true(cfg->has_provider_config);
    g_assert_false(cfg->has_default_model_config);
    g_assert_true(cfg->has_model_config);
    gateway_config_free(cfg);
}

static void test_model_config_default_present_provider_absent(void) {
    const gchar *json = "{\"gateway\":{\"port\":18789,\"auth\":{\"mode\":\"none\"}},\"agents\":{\"defaults\":{\"model\":{\"primary\":\"openai/gpt-4.1\"}}}}";
    GatewayConfig *cfg = load_config_from_json(json);

    g_assert_false(cfg->has_provider_config);
    g_assert_true(cfg->has_default_model_config);
    g_assert_true(cfg->has_model_config);
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
    g_test_add_func("/config/model/agents_defaults_model_primary", test_model_config_agents_defaults_model_primary);
    g_test_add_func("/config/model/agents_defaults_models_map", test_model_config_agents_defaults_models_map);
    g_test_add_func("/config/model/root_models_providers", test_model_config_root_models_providers);
    g_test_add_func("/config/model/provider_present_default_absent", test_model_config_provider_present_default_absent);
    g_test_add_func("/config/model/default_present_provider_absent", test_model_config_default_present_provider_absent);
    g_test_add_func("/config/model/default_present_provider_malformed", test_model_config_default_present_provider_malformed);
    g_test_add_func("/config/setup/apply_provider_richer", test_setup_apply_provider_writes_richer_shape);
    g_test_add_func("/config/setup/apply_default_model", test_setup_apply_default_model_writes_models_map);
    g_test_add_func("/config/setup/apply_provider_malformed_recoverable", test_setup_apply_provider_malformed_recoverable);
    g_test_add_func("/config/setup/apply_provider_preserves_auth_order", test_setup_apply_provider_preserves_auth_order);
    g_test_add_func("/config/readiness/model_config_default_present_provider_malformed", test_model_config_default_present_provider_malformed);
    g_test_add_func("/config/model/agents_defaults_models_empty_false", test_model_config_agents_defaults_models_empty_false);
    g_test_add_func("/config/model/root_providers_empty_false", test_model_config_root_providers_empty_false);
    g_test_add_func("/config/model/agents_defaults_model_malformed_false", test_model_config_agents_defaults_model_malformed_false);
    g_test_add_func("/config/model/minimal_onboard_false", test_model_config_minimal_onboard_false);

    return g_test_run();
}
