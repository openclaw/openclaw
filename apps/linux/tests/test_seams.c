/*
 * test_seams.c
 *
 * Tests for pure helper functions in test_seams.c.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include <glib.h>
#include <string.h>
#include <json-glib/json-glib.h>
#include "../src/test_seams.h"

/* ── Ancestor Walk Tests (Task 10) ── */

static void test_ancestor_walk_existing_dir(void) {
    gchar *res = find_nearest_existing_ancestor("/tmp");
    g_assert_cmpstr(res, ==, "/tmp");
    g_free(res);
}

static void test_ancestor_walk_nonexistent_child(void) {
    gchar *path = g_strdup_printf("/tmp/openclaw_test_nonexistent_%d/foo/bar", g_random_int());
    gchar *res = find_nearest_existing_ancestor(path);
    g_assert_cmpstr(res, ==, "/tmp");
    g_free(res);
    g_free(path);
}

static void test_ancestor_walk_root(void) {
    gchar *res = find_nearest_existing_ancestor("/");
    g_assert_cmpstr(res, ==, "/");
    g_free(res);
}

static void test_ancestor_walk_null_or_empty(void) {
    gchar *res1 = find_nearest_existing_ancestor(NULL);
    g_assert_null(res1);
    
    gchar *res2 = find_nearest_existing_ancestor("");
    g_assert_null(res2);
}

/* ── Config Monitor Rearm Skip Tests (Task 10) ── */

static void test_monitor_skip_same_paths_all_monitors_exist(void) {
    gboolean skip = config_monitor_can_skip_rearm(
        "/etc/openclaw", "/etc/openclaw",
        "/etc/openclaw/config.json", "/etc/openclaw/config.json",
        TRUE, TRUE, TRUE);
    g_assert_true(skip);
}

static void test_monitor_skip_dir_changed(void) {
    gboolean skip = config_monitor_can_skip_rearm(
        "/new/dir", "/old/dir",
        "/new/dir/config.json", "/old/dir/config.json",
        TRUE, TRUE, TRUE);
    g_assert_false(skip);
}

/* ── Tray dispatch decision tests ── */

static void test_tray_dispatch_settings_onboarding_visible(void) {
    TrayUiAction action = tray_ui_dispatch_decide(TRAY_UI_REQUEST_SETTINGS, TRUE);
    g_assert_cmpint(action, ==, TRAY_UI_ACTION_SHOW_SETTINGS);
}

static void test_tray_dispatch_settings_onboarding_hidden(void) {
    TrayUiAction action = tray_ui_dispatch_decide(TRAY_UI_REQUEST_SETTINGS, FALSE);
    g_assert_cmpint(action, ==, TRAY_UI_ACTION_SHOW_SETTINGS);
}

static void test_tray_dispatch_diagnostics_onboarding_visible(void) {
    TrayUiAction action = tray_ui_dispatch_decide(TRAY_UI_REQUEST_DIAGNOSTICS, TRUE);
    g_assert_cmpint(action, ==, TRAY_UI_ACTION_SHOW_DIAGNOSTICS);
}

static void test_tray_dispatch_repeated_requests_safe(void) {
    for (int i = 0; i < 10; i++) {
        TrayUiAction settings_action = tray_ui_dispatch_decide(TRAY_UI_REQUEST_SETTINGS, TRUE);
        TrayUiAction diagnostics_action = tray_ui_dispatch_decide(TRAY_UI_REQUEST_DIAGNOSTICS, TRUE);
        TrayUiAction startup_action = tray_ui_dispatch_decide(TRAY_UI_REQUEST_SETTINGS, FALSE);
        g_assert_cmpint(settings_action, ==, TRAY_UI_ACTION_SHOW_SETTINGS);
        g_assert_cmpint(diagnostics_action, ==, TRAY_UI_ACTION_SHOW_DIAGNOSTICS);
        g_assert_cmpint(startup_action, ==, TRAY_UI_ACTION_SHOW_SETTINGS);
    }
}

/* ── QR Payload Typed Access Tests ── */

static JsonNode* parse_json_node(const gchar *json_str) {
    g_autoptr(JsonParser) parser = json_parser_new();
    g_assert_true(json_parser_load_from_data(parser, json_str, -1, NULL));
    JsonNode *root = json_parser_get_root(parser);
    g_assert_nonnull(root);
    g_assert_true(JSON_NODE_HOLDS_OBJECT(root));
    return json_node_copy(root);
}

static void test_web_login_start_payload_has_qr_valid_string(void) {
    JsonNode *node = parse_json_node("{\"qrDataUrl\":\"data:image/png;base64,abc\"}");
    JsonObject *obj = json_node_get_object(node);
    const gchar *out_qr = NULL;
    int has_qr = web_login_start_payload_has_qr(obj, &out_qr);
    g_assert_cmpint(has_qr, ==, 1);
    g_assert_nonnull(out_qr);
    g_assert_cmpstr(out_qr, ==, "data:image/png;base64,abc");
    json_node_unref(node);
}

static void test_web_login_start_payload_has_qr_wrong_type(void) {
    JsonNode *node = parse_json_node("{\"qrDataUrl\": 123}");
    JsonObject *obj = json_node_get_object(node);
    const gchar *out_qr = (const gchar *)0x1;
    int has_qr = web_login_start_payload_has_qr(obj, &out_qr);
    g_assert_cmpint(has_qr, ==, 0);
    g_assert_null(out_qr);
    json_node_unref(node);
}

static void test_monitor_skip_file_monitor_needed_but_missing(void) {
    gboolean skip = config_monitor_can_skip_rearm(
        "/etc/openclaw", "/etc/openclaw",
        "/etc/openclaw/config.json", "/etc/openclaw/config.json",
        TRUE, TRUE, FALSE); /* Need file monitor, but don't have it */
    g_assert_false(skip);
}

static void test_monitor_skip_file_monitor_not_needed_but_exists(void) {
    gboolean skip = config_monitor_can_skip_rearm(
        "/etc/openclaw", "/etc/openclaw",
        "/etc/openclaw/config.json", "/etc/openclaw/config.json",
        TRUE, FALSE, TRUE); /* Don't need file monitor, but have it */
    g_assert_false(skip);
}

int main(int argc, char **argv) {
    g_test_init(&argc, &argv, NULL);

    /* Ancestor Walk Tests */
    g_test_add_func("/seams/ancestor_walk/existing_dir", test_ancestor_walk_existing_dir);
    g_test_add_func("/seams/ancestor_walk/nonexistent_child", test_ancestor_walk_nonexistent_child);
    g_test_add_func("/seams/ancestor_walk/root", test_ancestor_walk_root);
    g_test_add_func("/seams/ancestor_walk/null_or_empty", test_ancestor_walk_null_or_empty);

    /* Config Monitor Rearm Skip Tests */
    g_test_add_func("/seams/monitor_skip/same_paths", test_monitor_skip_same_paths_all_monitors_exist);
    g_test_add_func("/seams/monitor_skip/dir_changed", test_monitor_skip_dir_changed);
    g_test_add_func("/seams/monitor_skip/file_monitor_needed_but_missing", test_monitor_skip_file_monitor_needed_but_missing);
    g_test_add_func("/seams/monitor_skip/file_monitor_not_needed_but_exists", test_monitor_skip_file_monitor_not_needed_but_exists);

    /* QR payload typed-access tests */
    g_test_add_func("/seams/web_login_start_payload_has_qr/valid_string", test_web_login_start_payload_has_qr_valid_string);
    g_test_add_func("/seams/web_login_start_payload_has_qr/wrong_type", test_web_login_start_payload_has_qr_wrong_type);

    /* tray dispatch decision tests */
    g_test_add_func("/seams/tray_dispatch/settings_onboarding_visible", test_tray_dispatch_settings_onboarding_visible);
    g_test_add_func("/seams/tray_dispatch/settings_onboarding_hidden", test_tray_dispatch_settings_onboarding_hidden);
    g_test_add_func("/seams/tray_dispatch/diagnostics_onboarding_visible", test_tray_dispatch_diagnostics_onboarding_visible);
    g_test_add_func("/seams/tray_dispatch/repeated_requests_safe", test_tray_dispatch_repeated_requests_safe);

    return g_test_run();
}
