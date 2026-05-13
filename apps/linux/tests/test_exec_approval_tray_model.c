/*
 * test_exec_approval_tray_model.c
 *
 * Pure-C regression for the OcExecQuickMode <-> wire token mapping
 * exposed by `exec_approval_tray_model.{c,h}`. Locks down the canonical
 * lower-case "deny" / "ask" / "allow" tokens so the tray protocol stays
 * stable across renames or refactors of the underlying enum.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include <glib.h>

#include "../src/exec_approval_tray_model.h"

static void test_to_string_roundtrip(void) {
    g_assert_cmpstr(exec_approval_tray_mode_to_string(OC_EXEC_QUICK_MODE_DENY),  ==, "deny");
    g_assert_cmpstr(exec_approval_tray_mode_to_string(OC_EXEC_QUICK_MODE_ASK),   ==, "ask");
    g_assert_cmpstr(exec_approval_tray_mode_to_string(OC_EXEC_QUICK_MODE_ALLOW), ==, "allow");
}

static void test_to_string_unknown_returns_null(void) {
    g_assert_null(exec_approval_tray_mode_to_string((OcExecQuickMode)999));
    g_assert_null(exec_approval_tray_mode_to_string((OcExecQuickMode)-1));
}

static void test_from_string_known_modes(void) {
    OcExecQuickMode out = (OcExecQuickMode)999;

    g_assert_true(exec_approval_tray_mode_from_string("deny", &out));
    g_assert_cmpint(out, ==, OC_EXEC_QUICK_MODE_DENY);

    g_assert_true(exec_approval_tray_mode_from_string("ask", &out));
    g_assert_cmpint(out, ==, OC_EXEC_QUICK_MODE_ASK);

    g_assert_true(exec_approval_tray_mode_from_string("allow", &out));
    g_assert_cmpint(out, ==, OC_EXEC_QUICK_MODE_ALLOW);
}

static void test_from_string_rejects_unknown(void) {
    OcExecQuickMode out = OC_EXEC_QUICK_MODE_ASK;
    g_assert_false(exec_approval_tray_mode_from_string(NULL, &out));
    g_assert_false(exec_approval_tray_mode_from_string("", &out));
    g_assert_false(exec_approval_tray_mode_from_string("Deny", &out));    /* case sensitive */
    g_assert_false(exec_approval_tray_mode_from_string("ALLOW", &out));
    g_assert_false(exec_approval_tray_mode_from_string("never", &out));
    g_assert_false(exec_approval_tray_mode_from_string("ask ", &out));    /* trailing space */
    /* `out` must be untouched on failure. */
    g_assert_cmpint(out, ==, OC_EXEC_QUICK_MODE_ASK);
}

static void test_from_string_accepts_null_out(void) {
    g_assert_true(exec_approval_tray_mode_from_string("ask", NULL));
    g_assert_false(exec_approval_tray_mode_from_string("nope", NULL));
}

static void test_round_trip_for_each_mode(void) {
    const OcExecQuickMode modes[] = {
        OC_EXEC_QUICK_MODE_DENY, OC_EXEC_QUICK_MODE_ASK, OC_EXEC_QUICK_MODE_ALLOW,
    };
    for (gsize i = 0; i < G_N_ELEMENTS(modes); i++) {
        const char *token = exec_approval_tray_mode_to_string(modes[i]);
        g_assert_nonnull(token);
        OcExecQuickMode roundtrip = (OcExecQuickMode)999;
        g_assert_true(exec_approval_tray_mode_from_string(token, &roundtrip));
        g_assert_cmpint(roundtrip, ==, modes[i]);
    }
}

int main(int argc, char **argv) {
    g_test_init(&argc, &argv, NULL);

    g_test_add_func("/exec_approval_tray_model/to_string_roundtrip",         test_to_string_roundtrip);
    g_test_add_func("/exec_approval_tray_model/to_string_unknown_returns_null",
                    test_to_string_unknown_returns_null);
    g_test_add_func("/exec_approval_tray_model/from_string_known_modes",     test_from_string_known_modes);
    g_test_add_func("/exec_approval_tray_model/from_string_rejects_unknown", test_from_string_rejects_unknown);
    g_test_add_func("/exec_approval_tray_model/from_string_accepts_null_out", test_from_string_accepts_null_out);
    g_test_add_func("/exec_approval_tray_model/round_trip_for_each_mode",    test_round_trip_for_each_mode);

    return g_test_run();
}
