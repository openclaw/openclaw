/*
 * test_pairing_bootstrap_window.c
 *
 * Dedicated coverage for the Linux CLI-first pairing bootstrap window
 * contract introduced to close out the pairing UX work:
 *
 *   - CLI command with a pending requestId.
 *   - CLI command without a requestId (discovery fallback).
 *   - Raise path preserves cached metadata.
 *   - Re-show with partial NULL inputs never downgrades the cache.
 *   - Re-show with a new requestId updates the CLI command.
 *   - Hide + re-show rebuilds correctly from fresh state.
 *
 * Tests run headless: they exercise the cache-ingest / cli-command path
 * via the documented test seams (`_test_update_state`, `_test_clear_state`)
 * so we never call gtk_init() or build a live AdwWindow.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "../src/pairing_bootstrap_window.h"

#include <glib.h>

/*
 * Stub: the "Check again" button's click handler calls into the gateway
 * WS client to resume reconnect. None of these tests drive that button,
 * but the linker still needs the symbol because pairing_bootstrap_window.c
 * references it from the click callback. A no-op stub is sufficient.
 */
void gateway_ws_resume_after_pairing_approved(void) {}

/* ── A. CLI command with request id ── */
static void test_cli_command_with_request_id(void) {
    g_autofree gchar *cmd =
        pairing_bootstrap_cli_command_for_request("req-42");
    g_assert_cmpstr(cmd, ==, "openclaw devices pair approve req-42");
}

/* ── B. CLI command without request id ── */
static void test_cli_command_without_request_id(void) {
    g_autofree gchar *from_null  =
        pairing_bootstrap_cli_command_for_request(NULL);
    g_autofree gchar *from_empty =
        pairing_bootstrap_cli_command_for_request("");
    g_assert_cmpstr(from_null,  ==, "openclaw devices pair list");
    g_assert_cmpstr(from_empty, ==, "openclaw devices pair list");
}

/* ── C. Raise emulation must not downgrade cached metadata ──
 *
 * Regression guard for the specific bug that prompted this hardening
 * pass: the tray "Pairing…" handler used to re-raise the bootstrap
 * window by calling `pairing_bootstrap_window_show(parent, NULL,
 * deviceId, NULL)`. In the old implementation, NULL request_id +
 * NULL detail would silently erase the currently-displayed request
 * id (and with it, the approve-<requestId> CLI command), degrading
 * the user-facing state to the generic `pair list` discovery hint.
 *
 * The fix is twofold:
 *   1. introduce a dedicated `pairing_bootstrap_window_raise()` that
 *      pure-presents without touching the cache (covered by the
 *      prompter-side test in test_device_pair_prompter.c);
 *   2. harden `show()` itself so NULL/empty args never clobber
 *      already-cached non-empty state (covered here).
 *
 * This test exercises #2: feed the same NULL-heavy arg shape the old
 * buggy raise path used, and assert the cache is unchanged.
 */
static void test_show_with_nulls_never_clobbers_cache(void) {
    pairing_bootstrap_window_test_clear_state();
    pairing_bootstrap_window_test_update_state("req-42", "dev-abc",
                                                "Pending approval");

    /* Mimic the exact buggy shape: (NULL, deviceId, NULL). */
    pairing_bootstrap_window_test_update_state(NULL, "dev-abc", NULL);

    g_assert_cmpstr(pairing_bootstrap_window_current_request_id(), ==, "req-42");
    g_assert_cmpstr(pairing_bootstrap_window_current_device_id(),  ==, "dev-abc");
    g_assert_cmpstr(pairing_bootstrap_window_current_detail(),     ==,
                    "Pending approval");
    g_assert_cmpstr(pairing_bootstrap_window_current_cli_command(), ==,
                    "openclaw devices pair approve req-42");
}

/* ── D. Re-show with partial NULLs does not clobber prior state ── */
static void test_reshow_with_null_preserves_state(void) {
    pairing_bootstrap_window_test_clear_state();
    pairing_bootstrap_window_test_update_state("req-42", "dev-abc",
                                                "Pending approval");

    /* Re-show with mostly-NULL: simulating a code path that has lost
     * the original metadata. Only device_id is non-empty this time. */
    pairing_bootstrap_window_test_update_state(NULL, "dev-abc", NULL);

    g_assert_cmpstr(pairing_bootstrap_window_current_request_id(), ==, "req-42");
    g_assert_cmpstr(pairing_bootstrap_window_current_detail(),     ==,
                    "Pending approval");
    g_assert_cmpstr(pairing_bootstrap_window_current_cli_command(), ==,
                    "openclaw devices pair approve req-42");

    /* Also check the empty-string variant: treated identically to NULL. */
    pairing_bootstrap_window_test_update_state("", "", "");
    g_assert_cmpstr(pairing_bootstrap_window_current_request_id(), ==, "req-42");
    g_assert_cmpstr(pairing_bootstrap_window_current_cli_command(), ==,
                    "openclaw devices pair approve req-42");
}

/* ── E. Re-show with a new non-empty request id updates state ── */
static void test_reshow_with_new_request_id_updates_cli(void) {
    pairing_bootstrap_window_test_clear_state();
    pairing_bootstrap_window_test_update_state("req-42", "dev-abc",
                                                "Pending approval");
    g_assert_cmpstr(pairing_bootstrap_window_current_cli_command(), ==,
                    "openclaw devices pair approve req-42");

    /*
     * A *new* non-empty requestId legitimately changes the actionable
     * data; the cache MUST track it and the CLI command MUST re-render.
     * This is the only direction in which show() is allowed to move the
     * displayed state forward.
     */
    pairing_bootstrap_window_test_update_state("req-99", NULL, NULL);

    g_assert_cmpstr(pairing_bootstrap_window_current_request_id(), ==, "req-99");
    g_assert_cmpstr(pairing_bootstrap_window_current_cli_command(), ==,
                    "openclaw devices pair approve req-99");
    /* device_id and detail must remain unchanged from the prior show. */
    g_assert_cmpstr(pairing_bootstrap_window_current_device_id(),  ==, "dev-abc");
    g_assert_cmpstr(pairing_bootstrap_window_current_detail(),     ==,
                    "Pending approval");
}

/* ── F. Hide + re-show rebuilds correctly from fresh state ── */
static void test_hide_then_reshow_starts_from_clean_slate(void) {
    pairing_bootstrap_window_test_clear_state();
    pairing_bootstrap_window_test_update_state("req-42", "dev-abc",
                                                "Pending approval");

    /* Simulate hide → destroy. This mirrors what the weak-ref destroy
     * callback does inside pairing_bootstrap_window.c. */
    pairing_bootstrap_window_test_clear_state();
    g_assert_null(pairing_bootstrap_window_current_request_id());
    g_assert_null(pairing_bootstrap_window_current_device_id());
    g_assert_null(pairing_bootstrap_window_current_detail());
    g_assert_null(pairing_bootstrap_window_current_cli_command());

    /* Re-show with brand-new metadata; the stale state must not leak. */
    pairing_bootstrap_window_test_update_state("req-77", "dev-xyz",
                                                "Approve me");

    g_assert_cmpstr(pairing_bootstrap_window_current_request_id(), ==, "req-77");
    g_assert_cmpstr(pairing_bootstrap_window_current_device_id(),  ==, "dev-xyz");
    g_assert_cmpstr(pairing_bootstrap_window_current_detail(),     ==, "Approve me");
    g_assert_cmpstr(pairing_bootstrap_window_current_cli_command(), ==,
                    "openclaw devices pair approve req-77");
}

int main(int argc, char **argv) {
    g_test_init(&argc, &argv, NULL);
    g_log_set_always_fatal(G_LOG_LEVEL_ERROR | G_LOG_LEVEL_CRITICAL);
    g_log_set_fatal_mask(NULL, G_LOG_LEVEL_ERROR | G_LOG_LEVEL_CRITICAL);

    g_test_add_func("/pairing_bootstrap_window/cli_command_with_request_id",
                    test_cli_command_with_request_id);
    g_test_add_func("/pairing_bootstrap_window/cli_command_without_request_id",
                    test_cli_command_without_request_id);
    g_test_add_func("/pairing_bootstrap_window/show_with_nulls_never_clobbers_cache",
                    test_show_with_nulls_never_clobbers_cache);
    g_test_add_func("/pairing_bootstrap_window/reshow_with_null_preserves_state",
                    test_reshow_with_null_preserves_state);
    g_test_add_func("/pairing_bootstrap_window/reshow_with_new_request_id_updates_cli",
                    test_reshow_with_new_request_id_updates_cli);
    g_test_add_func("/pairing_bootstrap_window/hide_then_reshow_starts_from_clean_slate",
                    test_hide_then_reshow_starts_from_clean_slate);

    int rc = g_test_run();
    pairing_bootstrap_window_test_clear_state();
    return rc;
}
