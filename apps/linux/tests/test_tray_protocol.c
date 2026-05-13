/*
 * test_tray_protocol.c
 *
 * Pure-C regression suite for `tray_protocol.{c,h}`. Locks down the
 * line-format grammar shared between the OpenClaw Linux companion and
 * its private tray helper:
 *
 *   - MENU_VISIBLE formatting (true/false, NULL/empty rejection)
 *   - RADIO:EXEC_APPROVAL formatting (deny/ask/allow only)
 *   - APPROVALS formatting (zero, one, large count)
 *   - EXEC_APPROVAL_SET parsing and validity probes
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include <glib.h>
#include <string.h>

#include "../src/tray_protocol.h"

static void test_format_menu_visible_true(void) {
    g_autofree gchar *line = tray_protocol_format_menu_visible("OPEN_DEBUG", TRUE);
    g_assert_cmpstr(line, ==, "MENU_VISIBLE:OPEN_DEBUG:1\n");
}

static void test_format_menu_visible_false(void) {
    g_autofree gchar *line = tray_protocol_format_menu_visible("RESET_REMOTE_TUNNEL", FALSE);
    g_assert_cmpstr(line, ==, "MENU_VISIBLE:RESET_REMOTE_TUNNEL:0\n");
}

static void test_format_menu_visible_null_action_returns_null(void) {
    g_assert_null(tray_protocol_format_menu_visible(NULL, TRUE));
    g_assert_null(tray_protocol_format_menu_visible("", TRUE));
}

static void test_format_radio_deny(void) {
    g_autofree gchar *line = tray_protocol_format_radio_exec_approval("deny");
    g_assert_cmpstr(line, ==, "RADIO:EXEC_APPROVAL:deny\n");
}

static void test_format_radio_ask(void) {
    g_autofree gchar *line = tray_protocol_format_radio_exec_approval("ask");
    g_assert_cmpstr(line, ==, "RADIO:EXEC_APPROVAL:ask\n");
}

static void test_format_radio_allow(void) {
    g_autofree gchar *line = tray_protocol_format_radio_exec_approval("allow");
    g_assert_cmpstr(line, ==, "RADIO:EXEC_APPROVAL:allow\n");
}

static void test_format_radio_invalid_mode_returns_null(void) {
    g_assert_null(tray_protocol_format_radio_exec_approval(NULL));
    g_assert_null(tray_protocol_format_radio_exec_approval(""));
    g_assert_null(tray_protocol_format_radio_exec_approval("Deny"));   /* case sensitive */
    g_assert_null(tray_protocol_format_radio_exec_approval("ALLOW"));
    g_assert_null(tray_protocol_format_radio_exec_approval("nope"));
    g_assert_null(tray_protocol_format_radio_exec_approval("ask "));   /* trailing space */
}

static void test_format_approvals_zero(void) {
    g_autofree gchar *line = tray_protocol_format_approvals(0);
    g_assert_cmpstr(line, ==, "APPROVALS:0\n");
}

static void test_format_approvals_one(void) {
    g_autofree gchar *line = tray_protocol_format_approvals(1);
    g_assert_cmpstr(line, ==, "APPROVALS:1\n");
}

static void test_format_approvals_large(void) {
    g_autofree gchar *line = tray_protocol_format_approvals(42);
    g_assert_cmpstr(line, ==, "APPROVALS:42\n");
}

static void test_mode_is_valid(void) {
    g_assert_true(tray_protocol_exec_approval_mode_is_valid("deny"));
    g_assert_true(tray_protocol_exec_approval_mode_is_valid("ask"));
    g_assert_true(tray_protocol_exec_approval_mode_is_valid("allow"));
    g_assert_false(tray_protocol_exec_approval_mode_is_valid(NULL));
    g_assert_false(tray_protocol_exec_approval_mode_is_valid(""));
    g_assert_false(tray_protocol_exec_approval_mode_is_valid("Ask"));
    g_assert_false(tray_protocol_exec_approval_mode_is_valid("never"));
}

static void test_parse_exec_approval_action_deny(void) {
    char *mode = NULL;
    g_assert_true(tray_protocol_parse_exec_approval_action("EXEC_APPROVAL_SET:deny", &mode));
    g_assert_cmpstr(mode, ==, "deny");
    g_free(mode);
}

static void test_parse_exec_approval_action_ask(void) {
    char *mode = NULL;
    g_assert_true(tray_protocol_parse_exec_approval_action("EXEC_APPROVAL_SET:ask", &mode));
    g_assert_cmpstr(mode, ==, "ask");
    g_free(mode);
}

static void test_parse_exec_approval_action_allow(void) {
    char *mode = NULL;
    g_assert_true(tray_protocol_parse_exec_approval_action("EXEC_APPROVAL_SET:allow", &mode));
    g_assert_cmpstr(mode, ==, "allow");
    g_free(mode);
}

static void test_parse_exec_approval_action_accepts_null_out(void) {
    g_assert_true(tray_protocol_parse_exec_approval_action("EXEC_APPROVAL_SET:ask", NULL));
}

static void test_parse_exec_approval_action_rejects_invalid(void) {
    char *mode = NULL;
    g_assert_false(tray_protocol_parse_exec_approval_action(NULL, &mode));
    g_assert_false(tray_protocol_parse_exec_approval_action("", &mode));
    g_assert_false(tray_protocol_parse_exec_approval_action("EXEC_APPROVAL_SET:", &mode));
    g_assert_false(tray_protocol_parse_exec_approval_action("EXEC_APPROVAL_SET:never", &mode));
    g_assert_false(tray_protocol_parse_exec_approval_action("EXEC_APPROVAL_SET:Ask", &mode));
    g_assert_false(tray_protocol_parse_exec_approval_action("EXEC_APPROVAL_SET:ask:extra", &mode));
    g_assert_false(tray_protocol_parse_exec_approval_action("OPEN_LOGS", &mode));
    g_assert_false(tray_protocol_parse_exec_approval_action("EXEC_APPROVAL:ask", &mode));
    g_assert_false(tray_protocol_parse_exec_approval_action("EXEC_APPROVAL_SET:ask\n", &mode));
    g_assert_false(tray_protocol_parse_exec_approval_action("EXEC_APPROVAL_SET:ask ", &mode));
    g_assert_null(mode);
}

/* ── CHECK formatter (Tranche E) ─────────────────────────── */

static void test_format_check_true(void) {
    g_autofree gchar *line = tray_protocol_format_check("HEARTBEATS", TRUE);
    g_assert_cmpstr(line, ==, "CHECK:HEARTBEATS:1\n");
}

static void test_format_check_false(void) {
    g_autofree gchar *line = tray_protocol_format_check("BROWSER_CONTROL", FALSE);
    g_assert_cmpstr(line, ==, "CHECK:BROWSER_CONTROL:0\n");
}

static void test_format_check_rejects_invalid_keys(void) {
    g_assert_null(tray_protocol_format_check(NULL, TRUE));
    g_assert_null(tray_protocol_format_check("", TRUE));
    g_assert_null(tray_protocol_format_check("HAS:COLON", TRUE));
    g_assert_null(tray_protocol_format_check("HAS SPACE", TRUE));
    g_assert_null(tray_protocol_format_check("HAS\nNEWLINE", TRUE));
}

/* ── <KEY>_SET parser (Tranche E) ────────────────────────── */

static void test_parse_check_action_zero(void) {
    char *key = NULL;
    gboolean value = TRUE;
    g_assert_true(tray_protocol_parse_check_action("HEARTBEATS_SET:0", &key, &value));
    g_assert_cmpstr(key, ==, "HEARTBEATS");
    g_assert_false(value);
    g_free(key);
}

static void test_parse_check_action_one(void) {
    char *key = NULL;
    gboolean value = FALSE;
    g_assert_true(tray_protocol_parse_check_action("BROWSER_CONTROL_SET:1", &key, &value));
    g_assert_cmpstr(key, ==, "BROWSER_CONTROL");
    g_assert_true(value);
    g_free(key);
}

static void test_parse_check_action_accepts_null_outs(void) {
    g_assert_true(tray_protocol_parse_check_action("HEARTBEATS_SET:1", NULL, NULL));
}

static void test_parse_check_action_rejects_invalid(void) {
    char *key = NULL;
    gboolean value = FALSE;
    g_assert_false(tray_protocol_parse_check_action(NULL, &key, &value));
    g_assert_false(tray_protocol_parse_check_action("", &key, &value));
    g_assert_false(tray_protocol_parse_check_action("HEARTBEATS_SET:", &key, &value));
    g_assert_false(tray_protocol_parse_check_action("HEARTBEATS_SET:yes", &key, &value));
    g_assert_false(tray_protocol_parse_check_action("HEARTBEATS_SET:2", &key, &value));
    g_assert_false(tray_protocol_parse_check_action("HEARTBEATS_SET:11", &key, &value));
    g_assert_false(tray_protocol_parse_check_action("HEARTBEATS_SET:1:0", &key, &value));
    g_assert_false(tray_protocol_parse_check_action("HEARTBEATS_SET: 1", &key, &value));
    g_assert_false(tray_protocol_parse_check_action("HEARTBEATS_SET:1\n", &key, &value));
    /* No trailing `_SET` on the key. */
    g_assert_false(tray_protocol_parse_check_action("HEARTBEATS:1", &key, &value));
    /* Empty key — colon at offset 0 means head_len == 0. */
    g_assert_false(tray_protocol_parse_check_action(":1", &key, &value));
    /* Bare `_SET:1` → empty key. */
    g_assert_false(tray_protocol_parse_check_action("_SET:1", &key, &value));
    g_assert_null(key);
}

int main(int argc, char **argv) {
    g_test_init(&argc, &argv, NULL);

    g_test_add_func("/tray_protocol/format_menu_visible_true", test_format_menu_visible_true);
    g_test_add_func("/tray_protocol/format_menu_visible_false", test_format_menu_visible_false);
    g_test_add_func("/tray_protocol/format_menu_visible_null_action_returns_null",
                    test_format_menu_visible_null_action_returns_null);
    g_test_add_func("/tray_protocol/format_radio_deny", test_format_radio_deny);
    g_test_add_func("/tray_protocol/format_radio_ask", test_format_radio_ask);
    g_test_add_func("/tray_protocol/format_radio_allow", test_format_radio_allow);
    g_test_add_func("/tray_protocol/format_radio_invalid_mode_returns_null",
                    test_format_radio_invalid_mode_returns_null);
    g_test_add_func("/tray_protocol/format_approvals_zero", test_format_approvals_zero);
    g_test_add_func("/tray_protocol/format_approvals_one", test_format_approvals_one);
    g_test_add_func("/tray_protocol/format_approvals_large", test_format_approvals_large);
    g_test_add_func("/tray_protocol/mode_is_valid", test_mode_is_valid);
    g_test_add_func("/tray_protocol/parse_exec_approval_action_deny",
                    test_parse_exec_approval_action_deny);
    g_test_add_func("/tray_protocol/parse_exec_approval_action_ask",
                    test_parse_exec_approval_action_ask);
    g_test_add_func("/tray_protocol/parse_exec_approval_action_allow",
                    test_parse_exec_approval_action_allow);
    g_test_add_func("/tray_protocol/parse_exec_approval_action_accepts_null_out",
                    test_parse_exec_approval_action_accepts_null_out);
    g_test_add_func("/tray_protocol/parse_exec_approval_action_rejects_invalid",
                    test_parse_exec_approval_action_rejects_invalid);

    g_test_add_func("/tray_protocol/format_check_true", test_format_check_true);
    g_test_add_func("/tray_protocol/format_check_false", test_format_check_false);
    g_test_add_func("/tray_protocol/format_check_rejects_invalid_keys",
                    test_format_check_rejects_invalid_keys);
    g_test_add_func("/tray_protocol/parse_check_action_zero", test_parse_check_action_zero);
    g_test_add_func("/tray_protocol/parse_check_action_one", test_parse_check_action_one);
    g_test_add_func("/tray_protocol/parse_check_action_accepts_null_outs",
                    test_parse_check_action_accepts_null_outs);
    g_test_add_func("/tray_protocol/parse_check_action_rejects_invalid",
                    test_parse_check_action_rejects_invalid);

    return g_test_run();
}
