/*
 * test_tray_helper_protocol.c
 *
 * Hermetic regression for the helper-side parser/applier that handles
 * MENU_VISIBLE / RADIO:EXEC_APPROVAL / APPROVALS lines. The test
 * installs capture callbacks instead of GTK widgets so the suite runs
 * without a display.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include <glib.h>
#include <string.h>

#include "../src/tray_helper_protocol.h"

typedef struct {
    guint              menu_visible_calls;
    TrayHelperMenuKey  last_menu_key;
    gboolean           last_menu_visible;

    guint              radio_calls;
    gchar             *last_radio_mode;

    guint              approvals_calls;
    guint              last_approvals_count;
} CaptureState;

static void capture_menu_visible(TrayHelperMenuKey key, gboolean visible, gpointer ud) {
    CaptureState *s = ud;
    s->menu_visible_calls++;
    s->last_menu_key = key;
    s->last_menu_visible = visible;
}

static void capture_radio(const char *mode, gpointer ud) {
    CaptureState *s = ud;
    s->radio_calls++;
    g_free(s->last_radio_mode);
    s->last_radio_mode = g_strdup(mode);
}

static void capture_approvals(guint count, gpointer ud) {
    CaptureState *s = ud;
    s->approvals_calls++;
    s->last_approvals_count = count;
}

static TrayHelperProtocolHandlers make_handlers(CaptureState *s) {
    return (TrayHelperProtocolHandlers){
        .set_menu_visible          = capture_menu_visible,
        .set_radio_exec_approval   = capture_radio,
        .set_approvals_count       = capture_approvals,
        .user_data                 = s,
    };
}

static void capture_state_clear(CaptureState *s) {
    g_free(s->last_radio_mode);
    memset(s, 0, sizeof(*s));
}

/* ── menu key parser ───────────────────────────────────────── */

static void test_menu_key_from_string_known(void) {
    g_assert_cmpint(tray_helper_protocol_menu_key_from_string("OPEN_DEBUG"),          ==, TRAY_HELPER_MENU_KEY_OPEN_DEBUG);
    g_assert_cmpint(tray_helper_protocol_menu_key_from_string("EXEC_APPROVAL"),       ==, TRAY_HELPER_MENU_KEY_EXEC_APPROVAL);
    g_assert_cmpint(tray_helper_protocol_menu_key_from_string("APPROVALS_PENDING"),   ==, TRAY_HELPER_MENU_KEY_APPROVALS_PENDING);
    g_assert_cmpint(tray_helper_protocol_menu_key_from_string("RESET_REMOTE_TUNNEL"), ==, TRAY_HELPER_MENU_KEY_RESET_REMOTE_TUNNEL);
    g_assert_cmpint(tray_helper_protocol_menu_key_from_string("RESTART_APP"),         ==, TRAY_HELPER_MENU_KEY_RESTART_APP);
}

static void test_menu_key_from_string_unknown(void) {
    g_assert_cmpint(tray_helper_protocol_menu_key_from_string(NULL),         ==, TRAY_HELPER_MENU_KEY_UNKNOWN);
    g_assert_cmpint(tray_helper_protocol_menu_key_from_string(""),           ==, TRAY_HELPER_MENU_KEY_UNKNOWN);
    g_assert_cmpint(tray_helper_protocol_menu_key_from_string("open_debug"), ==, TRAY_HELPER_MENU_KEY_UNKNOWN);
    g_assert_cmpint(tray_helper_protocol_menu_key_from_string("OTHER"),      ==, TRAY_HELPER_MENU_KEY_UNKNOWN);
}

/* ── apply_line: MENU_VISIBLE ────────────────────────────── */

static void test_apply_menu_visible_show(void) {
    CaptureState s = {0};
    TrayHelperProtocolHandlers h = make_handlers(&s);
    g_assert_true(tray_helper_protocol_apply_line(&h, "MENU_VISIBLE:OPEN_DEBUG:1"));
    g_assert_cmpuint(s.menu_visible_calls, ==, 1);
    g_assert_cmpint(s.last_menu_key, ==, TRAY_HELPER_MENU_KEY_OPEN_DEBUG);
    g_assert_true(s.last_menu_visible);
    capture_state_clear(&s);
}

static void test_apply_menu_visible_hide(void) {
    CaptureState s = {0};
    TrayHelperProtocolHandlers h = make_handlers(&s);
    g_assert_true(tray_helper_protocol_apply_line(&h, "MENU_VISIBLE:RESET_REMOTE_TUNNEL:0"));
    g_assert_cmpuint(s.menu_visible_calls, ==, 1);
    g_assert_cmpint(s.last_menu_key, ==, TRAY_HELPER_MENU_KEY_RESET_REMOTE_TUNNEL);
    g_assert_false(s.last_menu_visible);
    capture_state_clear(&s);
}

static void test_apply_menu_visible_unknown_key_ignored(void) {
    CaptureState s = {0};
    TrayHelperProtocolHandlers h = make_handlers(&s);
    g_assert_false(tray_helper_protocol_apply_line(&h, "MENU_VISIBLE:NOPE:1"));
    g_assert_cmpuint(s.menu_visible_calls, ==, 0);
    capture_state_clear(&s);
}

static void test_apply_menu_visible_invalid_flag(void) {
    CaptureState s = {0};
    TrayHelperProtocolHandlers h = make_handlers(&s);
    g_assert_false(tray_helper_protocol_apply_line(&h, "MENU_VISIBLE:OPEN_DEBUG:2"));
    g_assert_false(tray_helper_protocol_apply_line(&h, "MENU_VISIBLE:OPEN_DEBUG:"));
    g_assert_false(tray_helper_protocol_apply_line(&h, "MENU_VISIBLE:OPEN_DEBUG:11"));
    g_assert_false(tray_helper_protocol_apply_line(&h, "MENU_VISIBLE::1"));
    g_assert_cmpuint(s.menu_visible_calls, ==, 0);
    capture_state_clear(&s);
}

/* ── apply_line: RADIO ──────────────────────────────────── */

static void test_apply_radio_each_mode(void) {
    CaptureState s = {0};
    TrayHelperProtocolHandlers h = make_handlers(&s);

    g_assert_true(tray_helper_protocol_apply_line(&h, "RADIO:EXEC_APPROVAL:deny"));
    g_assert_cmpstr(s.last_radio_mode, ==, "deny");
    g_assert_true(tray_helper_protocol_apply_line(&h, "RADIO:EXEC_APPROVAL:ask"));
    g_assert_cmpstr(s.last_radio_mode, ==, "ask");
    g_assert_true(tray_helper_protocol_apply_line(&h, "RADIO:EXEC_APPROVAL:allow"));
    g_assert_cmpstr(s.last_radio_mode, ==, "allow");

    g_assert_cmpuint(s.radio_calls, ==, 3);
    capture_state_clear(&s);
}

static void test_apply_radio_invalid_mode_ignored(void) {
    CaptureState s = {0};
    TrayHelperProtocolHandlers h = make_handlers(&s);
    g_assert_false(tray_helper_protocol_apply_line(&h, "RADIO:EXEC_APPROVAL:nope"));
    g_assert_false(tray_helper_protocol_apply_line(&h, "RADIO:EXEC_APPROVAL:"));
    g_assert_false(tray_helper_protocol_apply_line(&h, "RADIO:EXEC_APPROVAL:Ask"));
    g_assert_cmpuint(s.radio_calls, ==, 0);
    capture_state_clear(&s);
}

/* ── apply_line: APPROVALS ─────────────────────────────── */

static void test_apply_approvals_zero(void) {
    CaptureState s = {0};
    TrayHelperProtocolHandlers h = make_handlers(&s);
    g_assert_true(tray_helper_protocol_apply_line(&h, "APPROVALS:0"));
    g_assert_cmpuint(s.approvals_calls, ==, 1);
    g_assert_cmpuint(s.last_approvals_count, ==, 0);
    capture_state_clear(&s);
}

static void test_apply_approvals_nonzero(void) {
    CaptureState s = {0};
    TrayHelperProtocolHandlers h = make_handlers(&s);
    g_assert_true(tray_helper_protocol_apply_line(&h, "APPROVALS:7"));
    g_assert_cmpuint(s.last_approvals_count, ==, 7);
    capture_state_clear(&s);
}

static void test_apply_approvals_rejects_garbage(void) {
    CaptureState s = {0};
    TrayHelperProtocolHandlers h = make_handlers(&s);
    g_assert_false(tray_helper_protocol_apply_line(&h, "APPROVALS:"));
    g_assert_false(tray_helper_protocol_apply_line(&h, "APPROVALS:abc"));
    g_assert_false(tray_helper_protocol_apply_line(&h, "APPROVALS:-1"));
    g_assert_false(tray_helper_protocol_apply_line(&h, "APPROVALS:1.5"));
    g_assert_cmpuint(s.approvals_calls, ==, 0);
    capture_state_clear(&s);
}

/* ── apply_line: ignored prefixes ────────────────────── */

static void test_apply_unrecognised_prefix_returns_false(void) {
    CaptureState s = {0};
    TrayHelperProtocolHandlers h = make_handlers(&s);
    g_assert_false(tray_helper_protocol_apply_line(&h, "STATE:Running"));
    g_assert_false(tray_helper_protocol_apply_line(&h, "RUNTIME:foo"));
    g_assert_false(tray_helper_protocol_apply_line(&h, "SENSITIVE:START:1"));
    g_assert_false(tray_helper_protocol_apply_line(&h, ""));
    g_assert_false(tray_helper_protocol_apply_line(&h, NULL));
    g_assert_cmpuint(s.menu_visible_calls + s.radio_calls + s.approvals_calls, ==, 0);
    capture_state_clear(&s);
}

static void test_apply_with_null_handlers_still_classifies(void) {
    /* Passing NULL handlers must not crash: the function still returns
     * TRUE/FALSE based on whether the line shape is recognised. */
    g_assert_true (tray_helper_protocol_apply_line(NULL, "MENU_VISIBLE:OPEN_DEBUG:1"));
    g_assert_true (tray_helper_protocol_apply_line(NULL, "RADIO:EXEC_APPROVAL:ask"));
    g_assert_true (tray_helper_protocol_apply_line(NULL, "APPROVALS:3"));
    g_assert_false(tray_helper_protocol_apply_line(NULL, "STATE:foo"));
}

/* ── pending-approvals label formatter ───────────────── */

static void test_format_approvals_label_zero(void) {
    g_autofree gchar *s = tray_helper_protocol_format_approvals_label(0);
    g_assert_cmpstr(s, ==, "Exec Approvals: 0 pending");
}

static void test_format_approvals_label_one(void) {
    g_autofree gchar *s = tray_helper_protocol_format_approvals_label(1);
    g_assert_cmpstr(s, ==, "Exec Approvals: 1 pending");
}

static void test_format_approvals_label_many(void) {
    g_autofree gchar *s = tray_helper_protocol_format_approvals_label(13);
    g_assert_cmpstr(s, ==, "Exec Approvals: 13 pending");
}

int main(int argc, char **argv) {
    g_test_init(&argc, &argv, NULL);

    g_test_add_func("/tray_helper_protocol/menu_key_from_string_known",
                    test_menu_key_from_string_known);
    g_test_add_func("/tray_helper_protocol/menu_key_from_string_unknown",
                    test_menu_key_from_string_unknown);

    g_test_add_func("/tray_helper_protocol/apply_menu_visible_show",
                    test_apply_menu_visible_show);
    g_test_add_func("/tray_helper_protocol/apply_menu_visible_hide",
                    test_apply_menu_visible_hide);
    g_test_add_func("/tray_helper_protocol/apply_menu_visible_unknown_key_ignored",
                    test_apply_menu_visible_unknown_key_ignored);
    g_test_add_func("/tray_helper_protocol/apply_menu_visible_invalid_flag",
                    test_apply_menu_visible_invalid_flag);

    g_test_add_func("/tray_helper_protocol/apply_radio_each_mode",
                    test_apply_radio_each_mode);
    g_test_add_func("/tray_helper_protocol/apply_radio_invalid_mode_ignored",
                    test_apply_radio_invalid_mode_ignored);

    g_test_add_func("/tray_helper_protocol/apply_approvals_zero",
                    test_apply_approvals_zero);
    g_test_add_func("/tray_helper_protocol/apply_approvals_nonzero",
                    test_apply_approvals_nonzero);
    g_test_add_func("/tray_helper_protocol/apply_approvals_rejects_garbage",
                    test_apply_approvals_rejects_garbage);

    g_test_add_func("/tray_helper_protocol/apply_unrecognised_prefix_returns_false",
                    test_apply_unrecognised_prefix_returns_false);
    g_test_add_func("/tray_helper_protocol/apply_with_null_handlers_still_classifies",
                    test_apply_with_null_handlers_still_classifies);

    g_test_add_func("/tray_helper_protocol/format_approvals_label_zero",
                    test_format_approvals_label_zero);
    g_test_add_func("/tray_helper_protocol/format_approvals_label_one",
                    test_format_approvals_label_one);
    g_test_add_func("/tray_helper_protocol/format_approvals_label_many",
                    test_format_approvals_label_many);

    return g_test_run();
}
