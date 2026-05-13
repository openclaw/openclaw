/*
 * test_debug_actions.c
 *
 * Pure-C regression suite for the shared debug-action registry
 * (`apps/linux/src/debug_actions.{c,h}`). The registry is the single
 * source of truth for the operational/debug affordances surfaced by
 * both the tray helper menu and the in-app Debug section, so the tests
 * here lock down:
 *
 *   1. Spec-table integrity (count, unique tray strings, every entry's
 *      label/action surfaces match expectations from the Tranche D
 *      Core scope).
 *   2. `oc_debug_action_from_tray_string` round-trips for every entry
 *      that exposes a `tray_action_string` and rejects unknown / NULL
 *      input cleanly.
 *   3. `oc_debug_action_dispatch` calls through to the right cross-
 *      module entry points (gateway_client_refresh,
 *      systemd_restart_gateway, product_coordinator_request_rerun_*,
 *      notify_send_test_notification) AND through to the production
 *      hooks (URI launcher, clipboard writer, show-section handler).
 *   4. Reveal actions feed the URI launcher, "Copy Journal Command"
 *      formats `journalctl --user -u <unit> -f`, and "Open Logs" /
 *      "Open Debug" route to the right show-section target.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include <glib.h>
#include <string.h>

#include "../src/debug_actions.h"

/* ── Stubs for cross-module entry points ───────────────────────── */

static guint stub_gateway_refresh_calls = 0;
static guint stub_systemd_restart_calls = 0;
static guint stub_rerun_onboarding_calls = 0;
static guint stub_send_test_notification_calls = 0;
static guint stub_app_restart_calls = 0;
static gboolean stub_app_restart_result = TRUE;
static gchar *stub_unit_name = NULL;

void gateway_client_refresh(void) { stub_gateway_refresh_calls++; }
void systemd_restart_gateway(void) { stub_systemd_restart_calls++; }
void product_coordinator_request_rerun_onboarding(void) { stub_rerun_onboarding_calls++; }
gboolean notify_send_test_notification(void) { stub_send_test_notification_calls++; return TRUE; }
const gchar* systemd_get_canonical_unit_name(void) { return stub_unit_name; }

/*
 * Stub for `app_restart_request()` — production path uses g_spawn_async
 * to detach a relaunch shell, which is unsafe to actually invoke from a
 * unit test. The registry only sees the boolean return and the call
 * counter. */
gboolean app_restart_request(void) {
    stub_app_restart_calls++;
    return stub_app_restart_result;
}

/* runtime_reveal stubs — controlled per-test via these globals. The
 * production module is intentionally NOT linked into this test so we
 * can hand-feed the URIs without standing up the runtime-paths and
 * gateway-config dependency tree. */
static gchar *stub_config_uri = NULL;
static gchar *stub_state_uri = NULL;

gchar* runtime_reveal_build_config_dir_uri(void) {
    return stub_config_uri ? g_strdup(stub_config_uri) : NULL;
}

gchar* runtime_reveal_build_state_dir_uri(void) {
    return stub_state_uri ? g_strdup(stub_state_uri) : NULL;
}

/* ── Production-hook capture stubs ───────────────────────────── */

static guint                hook_uri_calls = 0;
static guint                hook_clipboard_calls = 0;
static guint                hook_show_section_calls = 0;
static gchar               *hook_last_uri = NULL;
static gchar               *hook_last_clipboard = NULL;
static OcDebugSectionTarget hook_last_section_target = OC_DEBUG_SECTION_TARGET_LOGS;
static gpointer             hook_last_user_data = NULL;

static void capture_uri_hook(const char *uri, gpointer user_data) {
    hook_uri_calls++;
    g_free(hook_last_uri);
    hook_last_uri = uri ? g_strdup(uri) : NULL;
    hook_last_user_data = user_data;
}

static void capture_clipboard_hook(const char *text, gpointer user_data) {
    hook_clipboard_calls++;
    g_free(hook_last_clipboard);
    hook_last_clipboard = text ? g_strdup(text) : NULL;
    hook_last_user_data = user_data;
}

static void capture_show_section_hook(OcDebugSectionTarget target, gpointer user_data) {
    hook_show_section_calls++;
    hook_last_section_target = target;
    hook_last_user_data = user_data;
}

/* ── Per-test reset ─────────────────────────────────────────── */

static void reset_all(void) {
    stub_gateway_refresh_calls = 0;
    stub_systemd_restart_calls = 0;
    stub_rerun_onboarding_calls = 0;
    stub_send_test_notification_calls = 0;
    stub_app_restart_calls = 0;
    stub_app_restart_result = TRUE;

    g_clear_pointer(&stub_unit_name, g_free);
    g_clear_pointer(&stub_config_uri, g_free);
    g_clear_pointer(&stub_state_uri, g_free);

    hook_uri_calls = 0;
    hook_clipboard_calls = 0;
    hook_show_section_calls = 0;
    g_clear_pointer(&hook_last_uri, g_free);
    g_clear_pointer(&hook_last_clipboard, g_free);
    hook_last_section_target = OC_DEBUG_SECTION_TARGET_LOGS;
    hook_last_user_data = NULL;

    oc_debug_actions_test_reset();
}

/* ── Tests ──────────────────────────────────────────────────── */

static void test_registry_count_matches_enum(void) {
    g_assert_cmpuint(oc_debug_action_count(), ==, (guint)OC_DEBUG_ACTION_COUNT);
    g_assert_cmpuint(oc_debug_action_count(), ==, 11u);
}

static void test_registry_get_returns_consistent_specs(void) {
    for (guint i = 0; i < oc_debug_action_count(); i++) {
        const OcDebugActionSpec *spec = oc_debug_action_get((OcDebugAction)i);
        g_assert_nonnull(spec);
        g_assert_cmpint((gint)spec->id, ==, (gint)i);
    }
    g_assert_null(oc_debug_action_get(OC_DEBUG_ACTION_COUNT));
    g_assert_null(oc_debug_action_get((OcDebugAction)9999));
}

static void test_registry_tray_action_strings_unique(void) {
    GHashTable *seen = g_hash_table_new(g_str_hash, g_str_equal);
    for (guint i = 0; i < oc_debug_action_count(); i++) {
        const OcDebugActionSpec *spec = oc_debug_action_get((OcDebugAction)i);
        if (!spec->tray_action_string) continue;
        if (g_hash_table_contains(seen, spec->tray_action_string)) {
            g_test_message("duplicate tray action string '%s'", spec->tray_action_string);
            g_assert_not_reached();
        }
        g_hash_table_insert(seen, (gpointer)spec->tray_action_string, GINT_TO_POINTER(1));
    }
    g_hash_table_destroy(seen);
}

static void test_registry_expected_labels_exist(void) {
    /* These are the Tranche D Core public labels — the contract Codex
     * promised to ship. Lock them in so a future rename has to come
     * with an explicit test update. */
    const char *expected_debug_labels[] = {
        "Trigger Health Refresh",
        "Restart Gateway",
        "Restart Onboarding",
        "Reveal Config Folder",
        "Reveal State Folder",
        "Copy Journal Command",
        "Send Test Notification",
        "Restart App",
        NULL,
    };
    const char *expected_tray_actions[] = {
        "RESTART_ONBOARDING",
        "REVEAL_CONFIG_FOLDER",
        "REVEAL_STATE_FOLDER",
        "COPY_JOURNAL_COMMAND",
        "SEND_TEST_NOTIFICATION",
        "OPEN_LOGS",
        "OPEN_DEBUG",
        "RESET_REMOTE_TUNNEL",
        "RESTART_APP",
        NULL,
    };
    for (guint i = 0; expected_debug_labels[i]; i++) {
        gboolean found = FALSE;
        for (guint j = 0; j < oc_debug_action_count(); j++) {
            const OcDebugActionSpec *spec = oc_debug_action_get((OcDebugAction)j);
            if (spec->debug_page_label &&
                g_strcmp0(spec->debug_page_label, expected_debug_labels[i]) == 0) {
                found = TRUE; break;
            }
        }
        if (!found) {
            g_test_message("expected debug label not found: %s", expected_debug_labels[i]);
            g_assert_not_reached();
        }
    }
    for (guint i = 0; expected_tray_actions[i]; i++) {
        OcDebugAction id;
        if (!oc_debug_action_from_tray_string(expected_tray_actions[i], &id)) {
            g_test_message("expected tray action not found: %s", expected_tray_actions[i]);
            g_assert_not_reached();
        }
    }
}

static void test_from_tray_string_round_trip(void) {
    for (guint i = 0; i < oc_debug_action_count(); i++) {
        const OcDebugActionSpec *spec = oc_debug_action_get((OcDebugAction)i);
        if (!spec->tray_action_string) continue;
        OcDebugAction out = OC_DEBUG_ACTION_COUNT;
        g_assert_true(oc_debug_action_from_tray_string(spec->tray_action_string, &out));
        g_assert_cmpint((gint)out, ==, (gint)i);
    }
}

static void test_from_tray_string_rejects_unknown(void) {
    OcDebugAction out = OC_DEBUG_ACTION_COUNT;
    g_assert_false(oc_debug_action_from_tray_string(NULL, NULL));
    g_assert_false(oc_debug_action_from_tray_string(NULL, &out));
    g_assert_false(oc_debug_action_from_tray_string("DOES_NOT_EXIST", &out));
    g_assert_false(oc_debug_action_from_tray_string("", &out));
    /* lower-case must NOT match an upper-case action. */
    g_assert_false(oc_debug_action_from_tray_string("open_logs", &out));
}

static void test_from_tray_string_accepts_null_out(void) {
    g_assert_true(oc_debug_action_from_tray_string("OPEN_LOGS", NULL));
    g_assert_true(oc_debug_action_from_tray_string("RESTART_ONBOARDING", NULL));
}

static void test_dispatch_unknown_id(void) {
    reset_all();
    g_assert_false(oc_debug_action_dispatch(OC_DEBUG_ACTION_COUNT));
    g_assert_false(oc_debug_action_dispatch((OcDebugAction)9999));
    /* No side effects fired. */
    g_assert_cmpuint(stub_gateway_refresh_calls, ==, 0);
    g_assert_cmpuint(stub_systemd_restart_calls, ==, 0);
}

static void test_dispatch_trigger_health_refresh(void) {
    reset_all();
    g_assert_true(oc_debug_action_dispatch(OC_DEBUG_ACTION_TRIGGER_HEALTH_REFRESH));
    g_assert_cmpuint(stub_gateway_refresh_calls, ==, 1);
    g_assert_cmpuint(stub_systemd_restart_calls, ==, 0);
}

static void test_dispatch_restart_gateway(void) {
    reset_all();
    g_assert_true(oc_debug_action_dispatch(OC_DEBUG_ACTION_RESTART_GATEWAY));
    g_assert_cmpuint(stub_systemd_restart_calls, ==, 1);
    g_assert_cmpuint(stub_gateway_refresh_calls, ==, 0);
}

static void test_dispatch_restart_onboarding(void) {
    reset_all();
    g_assert_true(oc_debug_action_dispatch(OC_DEBUG_ACTION_RESTART_ONBOARDING));
    g_assert_cmpuint(stub_rerun_onboarding_calls, ==, 1);
}

static void test_dispatch_send_test_notification(void) {
    reset_all();
    g_assert_true(oc_debug_action_dispatch(OC_DEBUG_ACTION_SEND_TEST_NOTIFICATION));
    g_assert_cmpuint(stub_send_test_notification_calls, ==, 1);
}

static void test_dispatch_reveal_config_folder_invokes_uri_hook(void) {
    reset_all();
    stub_config_uri = g_strdup("file:///tmp/openclaw-config");

    oc_debug_actions_set_uri_launcher(capture_uri_hook, GINT_TO_POINTER(0xC));

    g_assert_true(oc_debug_action_dispatch(OC_DEBUG_ACTION_REVEAL_CONFIG_FOLDER));
    g_assert_cmpuint(hook_uri_calls, ==, 1);
    g_assert_cmpstr(hook_last_uri, ==, "file:///tmp/openclaw-config");
    g_assert_cmpstr(oc_debug_actions_test_last_uri(), ==, "file:///tmp/openclaw-config");
    g_assert_cmpint(GPOINTER_TO_INT(hook_last_user_data), ==, 0xC);
}

static void test_dispatch_reveal_state_folder_invokes_uri_hook(void) {
    reset_all();
    stub_state_uri = g_strdup("file:///tmp/openclaw-state");

    oc_debug_actions_set_uri_launcher(capture_uri_hook, NULL);

    g_assert_true(oc_debug_action_dispatch(OC_DEBUG_ACTION_REVEAL_STATE_FOLDER));
    g_assert_cmpuint(hook_uri_calls, ==, 1);
    g_assert_cmpstr(hook_last_uri, ==, "file:///tmp/openclaw-state");
    g_assert_cmpstr(oc_debug_actions_test_last_uri(), ==, "file:///tmp/openclaw-state");
}

static void test_dispatch_reveal_skips_hook_when_uri_unresolved(void) {
    reset_all();
    /* Both stubs return NULL; dispatch must still succeed and must not
     * call the hook with a NULL/empty URI. */
    oc_debug_actions_set_uri_launcher(capture_uri_hook, NULL);

    g_assert_true(oc_debug_action_dispatch(OC_DEBUG_ACTION_REVEAL_CONFIG_FOLDER));
    g_assert_true(oc_debug_action_dispatch(OC_DEBUG_ACTION_REVEAL_STATE_FOLDER));
    g_assert_cmpuint(hook_uri_calls, ==, 0);
    g_assert_null(oc_debug_actions_test_last_uri());
}

static void test_dispatch_copy_journal_command_uses_canonical_unit(void) {
    reset_all();
    stub_unit_name = g_strdup("openclaw-gateway-special.service");

    oc_debug_actions_set_clipboard_writer(capture_clipboard_hook, GINT_TO_POINTER(0xCB));

    g_assert_true(oc_debug_action_dispatch(OC_DEBUG_ACTION_COPY_JOURNAL_COMMAND));
    g_assert_cmpuint(hook_clipboard_calls, ==, 1);
    g_assert_cmpstr(hook_last_clipboard,
                    ==,
                    "journalctl --user -u openclaw-gateway-special.service -f");
    g_assert_cmpstr(oc_debug_actions_test_last_clipboard_text(),
                    ==,
                    "journalctl --user -u openclaw-gateway-special.service -f");
    g_assert_cmpint(GPOINTER_TO_INT(hook_last_user_data), ==, 0xCB);
}

static void test_dispatch_copy_journal_command_falls_back_when_unit_unknown(void) {
    reset_all();
    /* stub_unit_name stays NULL — registry must fall back to default. */
    oc_debug_actions_set_clipboard_writer(capture_clipboard_hook, NULL);

    g_assert_true(oc_debug_action_dispatch(OC_DEBUG_ACTION_COPY_JOURNAL_COMMAND));
    g_assert_cmpstr(hook_last_clipboard,
                    ==,
                    "journalctl --user -u openclaw-gateway.service -f");
}

static void test_dispatch_open_logs_routes_to_logs_target(void) {
    reset_all();
    oc_debug_actions_set_show_section_handler(capture_show_section_hook,
                                              GINT_TO_POINTER(0x1065));

    g_assert_true(oc_debug_action_dispatch(OC_DEBUG_ACTION_OPEN_LOGS));
    g_assert_cmpuint(hook_show_section_calls, ==, 1);
    g_assert_cmpint(hook_last_section_target, ==, OC_DEBUG_SECTION_TARGET_LOGS);
    g_assert_true(oc_debug_actions_test_section_was_requested());
    g_assert_cmpint(oc_debug_actions_test_last_section_target(), ==, OC_DEBUG_SECTION_TARGET_LOGS);
}

static void test_dispatch_open_debug_routes_to_debug_target(void) {
    reset_all();
    oc_debug_actions_set_show_section_handler(capture_show_section_hook, NULL);

    g_assert_true(oc_debug_action_dispatch(OC_DEBUG_ACTION_OPEN_DEBUG));
    g_assert_cmpuint(hook_show_section_calls, ==, 1);
    g_assert_cmpint(hook_last_section_target, ==, OC_DEBUG_SECTION_TARGET_DEBUG);
    g_assert_cmpint(oc_debug_actions_test_last_section_target(), ==, OC_DEBUG_SECTION_TARGET_DEBUG);
}

static void test_dispatch_reset_remote_tunnel_returns_false(void) {
    /* No production reset API exists yet (see TODO in debug_actions.c).
     * Until it does, dispatch must report FALSE so the host treats this
     * as not-implemented. */
    reset_all();
    g_assert_false(oc_debug_action_dispatch(OC_DEBUG_ACTION_RESET_REMOTE_TUNNEL));
}

static void test_dispatch_restart_app_invokes_helper_when_available(void) {
    reset_all();
    stub_app_restart_result = TRUE;
    g_assert_true(oc_debug_action_dispatch(OC_DEBUG_ACTION_RESTART_APP));
    g_assert_cmpuint(stub_app_restart_calls, ==, 1);
}

static void test_dispatch_restart_app_propagates_failure(void) {
    reset_all();
    stub_app_restart_result = FALSE;
    g_assert_false(oc_debug_action_dispatch(OC_DEBUG_ACTION_RESTART_APP));
    g_assert_cmpuint(stub_app_restart_calls, ==, 1);
}

static void test_dispatch_show_section_safe_without_hook(void) {
    reset_all();
    /* No hook installed. Registry should still capture the request and
     * not crash. */
    g_assert_true(oc_debug_action_dispatch(OC_DEBUG_ACTION_OPEN_LOGS));
    g_assert_cmpuint(hook_show_section_calls, ==, 0);
    g_assert_true(oc_debug_actions_test_section_was_requested());
}

static void test_tray_dispatch_via_registry_round_trip(void) {
    /* Simulates `tray.c::handle_helper_action` for an action that the
     * legacy ladder no longer owns: route through the registry by
     * string and ensure the side effect fires exactly once. */
    reset_all();

    OcDebugAction id = OC_DEBUG_ACTION_COUNT;
    g_assert_true(oc_debug_action_from_tray_string("RESTART_ONBOARDING", &id));
    g_assert_cmpint((gint)id, ==, (gint)OC_DEBUG_ACTION_RESTART_ONBOARDING);
    g_assert_true(oc_debug_action_dispatch(id));
    g_assert_cmpuint(stub_rerun_onboarding_calls, ==, 1);
}

static void test_tray_dispatch_unknown_action_is_harmless(void) {
    reset_all();
    OcDebugAction id = OC_DEBUG_ACTION_COUNT;
    g_assert_false(oc_debug_action_from_tray_string("PROBABLY_NOT_A_REAL_ACTION", &id));
    g_assert_cmpuint(stub_rerun_onboarding_calls, ==, 0);
    g_assert_cmpuint(stub_gateway_refresh_calls, ==, 0);
    g_assert_cmpuint(stub_systemd_restart_calls, ==, 0);
}

int main(int argc, char **argv) {
    g_test_init(&argc, &argv, NULL);

    g_test_add_func("/debug_actions/registry_count_matches_enum",
                    test_registry_count_matches_enum);
    g_test_add_func("/debug_actions/registry_get_returns_consistent_specs",
                    test_registry_get_returns_consistent_specs);
    g_test_add_func("/debug_actions/registry_tray_action_strings_unique",
                    test_registry_tray_action_strings_unique);
    g_test_add_func("/debug_actions/registry_expected_labels_exist",
                    test_registry_expected_labels_exist);
    g_test_add_func("/debug_actions/from_tray_string_round_trip",
                    test_from_tray_string_round_trip);
    g_test_add_func("/debug_actions/from_tray_string_rejects_unknown",
                    test_from_tray_string_rejects_unknown);
    g_test_add_func("/debug_actions/from_tray_string_accepts_null_out",
                    test_from_tray_string_accepts_null_out);
    g_test_add_func("/debug_actions/dispatch_unknown_id",
                    test_dispatch_unknown_id);
    g_test_add_func("/debug_actions/dispatch_trigger_health_refresh",
                    test_dispatch_trigger_health_refresh);
    g_test_add_func("/debug_actions/dispatch_restart_gateway",
                    test_dispatch_restart_gateway);
    g_test_add_func("/debug_actions/dispatch_restart_onboarding",
                    test_dispatch_restart_onboarding);
    g_test_add_func("/debug_actions/dispatch_send_test_notification",
                    test_dispatch_send_test_notification);
    g_test_add_func("/debug_actions/dispatch_reveal_config_folder",
                    test_dispatch_reveal_config_folder_invokes_uri_hook);
    g_test_add_func("/debug_actions/dispatch_reveal_state_folder",
                    test_dispatch_reveal_state_folder_invokes_uri_hook);
    g_test_add_func("/debug_actions/dispatch_reveal_skips_hook_when_uri_unresolved",
                    test_dispatch_reveal_skips_hook_when_uri_unresolved);
    g_test_add_func("/debug_actions/dispatch_copy_journal_command",
                    test_dispatch_copy_journal_command_uses_canonical_unit);
    g_test_add_func("/debug_actions/dispatch_copy_journal_command_fallback",
                    test_dispatch_copy_journal_command_falls_back_when_unit_unknown);
    g_test_add_func("/debug_actions/dispatch_open_logs",
                    test_dispatch_open_logs_routes_to_logs_target);
    g_test_add_func("/debug_actions/dispatch_open_debug",
                    test_dispatch_open_debug_routes_to_debug_target);
    g_test_add_func("/debug_actions/dispatch_reset_remote_tunnel_returns_false",
                    test_dispatch_reset_remote_tunnel_returns_false);
    g_test_add_func("/debug_actions/dispatch_restart_app_invokes_helper_when_available",
                    test_dispatch_restart_app_invokes_helper_when_available);
    g_test_add_func("/debug_actions/dispatch_restart_app_propagates_failure",
                    test_dispatch_restart_app_propagates_failure);
    g_test_add_func("/debug_actions/dispatch_show_section_safe_without_hook",
                    test_dispatch_show_section_safe_without_hook);
    g_test_add_func("/debug_actions/tray_dispatch_via_registry_round_trip",
                    test_tray_dispatch_via_registry_round_trip);
    g_test_add_func("/debug_actions/tray_dispatch_unknown_action_is_harmless",
                    test_tray_dispatch_unknown_action_is_harmless);

    int rc = g_test_run();
    reset_all();
    return rc;
}
