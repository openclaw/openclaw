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

/* ── Onboarding refresh route-stable environment regression tests ── */

static OnboardingRefreshSnapshotInput make_onboarding_snapshot_seed(void) {
    OnboardingRefreshSnapshotInput snap = {0};
    snap.state = 1;
    snap.route = 2;
    snap.stage_configuration = 1;
    snap.stage_service_gateway = 1;
    snap.stage_connection = 0;
    snap.operational_ready = FALSE;
    snap.config_valid = TRUE;
    snap.setup_detected = TRUE;
    snap.sys_installed = TRUE;
    snap.sys_active = TRUE;
    snap.config_file_exists = TRUE;
    snap.state_dir_exists = TRUE;
    snap.next_action = "do thing";
    return snap;
}

static void test_onboarding_refresh_route_stable_env_change_refreshes_live(void) {
    OnboardingRefreshSnapshotInput prev = make_onboarding_snapshot_seed();
    OnboardingRefreshSnapshotInput next = prev;

    next.config_file_exists = FALSE;

    gboolean equal = onboarding_refresh_snapshot_equal(&prev, &next);
    g_assert_false(equal);

    OnboardingRefreshAction action = onboarding_refresh_action_decide(equal, FALSE);
    g_assert_cmpint(action, ==, ONBOARDING_REFRESH_ACTION_REFRESH_LIVE);
}

static void test_onboarding_refresh_route_stable_state_dir_change_refreshes_live(void) {
    OnboardingRefreshSnapshotInput prev = make_onboarding_snapshot_seed();
    OnboardingRefreshSnapshotInput next = prev;

    next.state_dir_exists = FALSE;

    gboolean equal = onboarding_refresh_snapshot_equal(&prev, &next);
    g_assert_false(equal);

    OnboardingRefreshAction action = onboarding_refresh_action_decide(equal, FALSE);
    g_assert_cmpint(action, ==, ONBOARDING_REFRESH_ACTION_REFRESH_LIVE);
}

static void test_onboarding_refresh_route_changed_rebuilds_pages(void) {
    OnboardingRefreshSnapshotInput prev = make_onboarding_snapshot_seed();
    OnboardingRefreshSnapshotInput next = prev;

    next.route = 3;

    gboolean equal = onboarding_refresh_snapshot_equal(&prev, &next);
    g_assert_false(equal);

    OnboardingRefreshAction action = onboarding_refresh_action_decide(equal, TRUE);
    g_assert_cmpint(action, ==, ONBOARDING_REFRESH_ACTION_REBUILD_PAGES);
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

/*
 * Chat requests must resolve to the dedicated chat-window action regardless
 * of onboarding visibility — the chat window lives independently of the
 * main settings / diagnostics window and must not be redirected through
 * the onboarding-aware settings path.
 */
static void test_tray_dispatch_chat_onboarding_visible(void) {
    TrayUiAction action = tray_ui_dispatch_decide(TRAY_UI_REQUEST_CHAT, TRUE);
    g_assert_cmpint(action, ==, TRAY_UI_ACTION_SHOW_CHAT);
}

static void test_tray_dispatch_chat_onboarding_hidden(void) {
    TrayUiAction action = tray_ui_dispatch_decide(TRAY_UI_REQUEST_CHAT, FALSE);
    g_assert_cmpint(action, ==, TRAY_UI_ACTION_SHOW_CHAT);
}

/* ── Chat window show-decision tests ── */

/* No GApplication bound: the show request must be ignored entirely so the
 * tray action never triggers window construction during early startup /
 * late shutdown. */
static void test_chat_window_show_no_application(void) {
    g_assert_cmpint(chat_window_show_decide(FALSE, FALSE), ==, CHAT_WINDOW_ACTION_IGNORE_NO_APP);
    g_assert_cmpint(chat_window_show_decide(FALSE, TRUE),  ==, CHAT_WINDOW_ACTION_IGNORE_NO_APP);
}

/* App bound, no window yet: build + present a new standalone window. */
static void test_chat_window_show_builds_when_absent(void) {
    g_assert_cmpint(chat_window_show_decide(TRUE, FALSE), ==, CHAT_WINDOW_ACTION_BUILD_AND_PRESENT);
}

/* App bound, window already exists: reuse the singleton; never rebuild. */
static void test_chat_window_show_presents_existing_singleton(void) {
    g_assert_cmpint(chat_window_show_decide(TRUE, TRUE), ==, CHAT_WINDOW_ACTION_PRESENT_EXISTING);
}

/*
 * Full chat lifecycle through the decision seam.
 *
 * Models, in order, the sequence `chat_window.c` walks when the user
 * opens chat, clicks the tray icon a second time, closes the window,
 * and reopens it:
 *
 *   1. first open:        no window  → BUILD_AND_PRESENT
 *   2. second tray click: window up  → PRESENT_EXISTING (no rebuild)
 *   3. close:             window gone
 *   4. re-open:           no window  → BUILD_AND_PRESENT (fresh controller)
 *
 * This is the headless analogue of "open builds the controller, a
 * second show presents the existing window, close destroys the
 * controller, re-open creates a fresh controller cleanly". The
 * instance-scoped ChatController state itself lives behind a GTK-heavy
 * monolith (`chat_controller.c`) that we can't link into a pure unit
 * test, but the decision seam captures the only externally-observable
 * property of the lifecycle contract: whether the host is told to
 * build vs. present.
 */
static void test_chat_window_show_full_lifecycle_cycle(void) {
    gboolean window_exists = FALSE;

    /* 1. First open. */
    g_assert_cmpint(chat_window_show_decide(TRUE, window_exists),
                    ==, CHAT_WINDOW_ACTION_BUILD_AND_PRESENT);
    window_exists = TRUE; /* host builds + tracks it */

    /* 2. Second request while live: must NOT rebuild. */
    g_assert_cmpint(chat_window_show_decide(TRUE, window_exists),
                    ==, CHAT_WINDOW_ACTION_PRESENT_EXISTING);
    g_assert_cmpint(chat_window_show_decide(TRUE, window_exists),
                    ==, CHAT_WINDOW_ACTION_PRESENT_EXISTING);

    /* 3. Operator closes window → host drops its pointer. */
    window_exists = FALSE;

    /* 4. Re-open must behave exactly like a first open: build a fresh
     *    controller, do not try to reuse whatever was last on screen. */
    g_assert_cmpint(chat_window_show_decide(TRUE, window_exists),
                    ==, CHAT_WINDOW_ACTION_BUILD_AND_PRESENT);
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
    g_test_add_func("/seams/tray_dispatch/chat_onboarding_visible", test_tray_dispatch_chat_onboarding_visible);
    g_test_add_func("/seams/tray_dispatch/chat_onboarding_hidden", test_tray_dispatch_chat_onboarding_hidden);

    /* chat window show-decision tests */
    g_test_add_func("/seams/chat_window_show/no_application", test_chat_window_show_no_application);
    g_test_add_func("/seams/chat_window_show/builds_when_absent", test_chat_window_show_builds_when_absent);
    g_test_add_func("/seams/chat_window_show/presents_existing_singleton", test_chat_window_show_presents_existing_singleton);
    g_test_add_func("/seams/chat_window_show/full_lifecycle_cycle", test_chat_window_show_full_lifecycle_cycle);

    /* onboarding refresh regression tests */
    g_test_add_func("/seams/onboarding_refresh/route_stable_config_change_refreshes_live",
                    test_onboarding_refresh_route_stable_env_change_refreshes_live);
    g_test_add_func("/seams/onboarding_refresh/route_stable_state_dir_change_refreshes_live",
                    test_onboarding_refresh_route_stable_state_dir_change_refreshes_live);
    g_test_add_func("/seams/onboarding_refresh/route_changed_rebuilds_pages",
                    test_onboarding_refresh_route_changed_rebuilds_pages);

    return g_test_run();
}
