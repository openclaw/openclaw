/*
 * test_readiness.c
 *
 * Direct tests for the readiness presentation helper (readiness_evaluate).
 *
 * These tests validate the presenter output contract independently from
 * the canonical state derivation logic tested in test_state.c.
 * The presenter consumes AppState — tests pass canonical states directly
 * and do NOT recreate the decision table.
 *
 * Assertions are kept narrow and structural:
 *   - classification: non-NULL, exact text for critical states.
 *   - missing: NULL/non-NULL as appropriate per state contract.
 *   - next_action: NULL/non-NULL as appropriate per state contract.
 *   - Substring checks only where a stable semantic fragment matters.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include <glib.h>
#include <string.h>
#include "../src/readiness.h"

/* ── Helper: assert a string contains a substring ── */
static void assert_contains(const char *haystack, const char *needle, const char *context) {
    if (!haystack || !needle) {
        g_test_message("assert_contains failed (%s): haystack=%p needle=%p", context,
                       (const void *)haystack, (const void *)needle);
        g_assert_not_reached();
    }
    if (!strstr(haystack, needle)) {
        g_test_message("assert_contains failed (%s): '%s' not found in '%s'", context, needle, haystack);
        g_assert_not_reached();
    }
}

/* ── STATE_NEEDS_SETUP ── */

static void test_presenter_needs_setup(void) {
    ReadinessInfo ri;
    HealthState hs = {0};
    SystemdState sys = {0};

    readiness_evaluate(STATE_NEEDS_SETUP, &hs, &sys, &ri);

    g_assert_cmpstr(ri.classification, ==, "Setup Required");
    g_assert_nonnull(ri.missing);
    g_assert_nonnull(ri.next_action);
    assert_contains(ri.next_action, "openclaw setup", "needs_setup.next_action");
}

/* ── STATE_NEEDS_GATEWAY_INSTALL ── */

static void test_presenter_needs_gateway_install(void) {
    ReadinessInfo ri;
    HealthState hs = {0};
    SystemdState sys = {0};

    readiness_evaluate(STATE_NEEDS_GATEWAY_INSTALL, &hs, &sys, &ri);

    g_assert_cmpstr(ri.classification, ==, "Gateway Not Installed");
    g_assert_nonnull(ri.missing);
    g_assert_nonnull(ri.next_action);
    assert_contains(ri.next_action, "gateway install", "needs_install.next_action");
}

/* ── STATE_USER_SYSTEMD_UNAVAILABLE ── */

static void test_presenter_systemd_unavailable(void) {
    ReadinessInfo ri;
    HealthState hs = {0};
    SystemdState sys = {0};

    readiness_evaluate(STATE_USER_SYSTEMD_UNAVAILABLE, &hs, &sys, &ri);

    g_assert_cmpstr(ri.classification, ==, "Systemd Unavailable");
    g_assert_nonnull(ri.missing);
    g_assert_nonnull(ri.next_action);
}

/* ── STATE_SYSTEM_UNSUPPORTED ── */

static void test_presenter_system_unsupported(void) {
    ReadinessInfo ri;
    HealthState hs = {0};
    SystemdState sys = {0};

    readiness_evaluate(STATE_SYSTEM_UNSUPPORTED, &hs, &sys, &ri);

    g_assert_cmpstr(ri.classification, ==, "System Service (Unsupported)");
    g_assert_nonnull(ri.missing);
    g_assert_nonnull(ri.next_action);
}

/* ── STATE_CONFIG_INVALID ── */

static void test_presenter_config_invalid_with_error(void) {
    ReadinessInfo ri;
    HealthState hs = {0};
    hs.last_error = "mode 'remote' is not supported";
    SystemdState sys = {0};

    readiness_evaluate(STATE_CONFIG_INVALID, &hs, &sys, &ri);

    g_assert_cmpstr(ri.classification, ==, "Configuration Invalid");
    /* missing should surface the specific error from health */
    g_assert_nonnull(ri.missing);
    assert_contains(ri.missing, "remote", "config_invalid.missing_error");
    g_assert_nonnull(ri.next_action);
    assert_contains(ri.next_action, "openclaw.json", "config_invalid.next_action");
}

static void test_presenter_config_invalid_no_error(void) {
    ReadinessInfo ri;
    HealthState hs = {0};
    hs.last_error = NULL;
    SystemdState sys = {0};

    readiness_evaluate(STATE_CONFIG_INVALID, &hs, &sys, &ri);

    g_assert_cmpstr(ri.classification, ==, "Configuration Invalid");
    /* fallback missing text when no specific error */
    g_assert_nonnull(ri.missing);
    g_assert_nonnull(ri.next_action);
}

/* ── STATE_STOPPED ── */

static void test_presenter_stopped(void) {
    ReadinessInfo ri;
    HealthState hs = {0};
    SystemdState sys = {0};

    readiness_evaluate(STATE_STOPPED, &hs, &sys, &ri);

    g_assert_cmpstr(ri.classification, ==, "Stopped");
    g_assert_nonnull(ri.missing);
    g_assert_nonnull(ri.next_action);
}

/* ── STATE_STARTING ── */

static void test_presenter_starting(void) {
    ReadinessInfo ri;
    HealthState hs = {0};
    SystemdState sys = {0};

    readiness_evaluate(STATE_STARTING, &hs, &sys, &ri);

    g_assert_cmpstr(ri.classification, ==, "Starting");
    /* transitional: explanation present, no user action needed */
    g_assert_nonnull(ri.missing);
    g_assert_null(ri.next_action);
}

/* ── STATE_RUNNING (fully ready) ── */

static void test_presenter_running(void) {
    ReadinessInfo ri;
    HealthState hs = {0};
    hs.http_ok = TRUE;
    hs.ws_connected = TRUE;
    hs.rpc_ok = TRUE;
    hs.auth_ok = TRUE;
    SystemdState sys = {0};

    readiness_evaluate(STATE_RUNNING, &hs, &sys, &ri);

    g_assert_cmpstr(ri.classification, ==, "Fully Ready");
    g_assert_null(ri.missing);
    g_assert_null(ri.next_action);
}

/* ── STATE_RUNNING_WITH_WARNING ── */

static void test_presenter_running_with_warning(void) {
    ReadinessInfo ri;
    HealthState hs = {0};
    SystemdState sys = {0};

    readiness_evaluate(STATE_RUNNING_WITH_WARNING, &hs, &sys, &ri);

    g_assert_nonnull(ri.classification);
    assert_contains(ri.classification, "Warning", "running_warning.classification");
    g_assert_nonnull(ri.missing);
    g_assert_nonnull(ri.next_action);
}

/* ── STATE_DEGRADED: three distinct missing-text paths ── */

static void test_presenter_degraded_http_ok_ws_disconnected(void) {
    ReadinessInfo ri;
    HealthState hs = {0};
    hs.http_ok = TRUE;
    hs.ws_connected = FALSE;
    SystemdState sys = {0};

    readiness_evaluate(STATE_DEGRADED, &hs, &sys, &ri);

    g_assert_cmpstr(ri.classification, ==, "Degraded");
    g_assert_nonnull(ri.missing);
    assert_contains(ri.missing, "WebSocket", "degraded_ws.missing");
    g_assert_nonnull(ri.next_action);
}

static void test_presenter_degraded_connected_rpc_incomplete(void) {
    ReadinessInfo ri;
    HealthState hs = {0};
    hs.http_ok = TRUE;
    hs.ws_connected = TRUE;
    hs.rpc_ok = FALSE;
    hs.auth_ok = FALSE;
    SystemdState sys = {0};

    readiness_evaluate(STATE_DEGRADED, &hs, &sys, &ri);

    g_assert_cmpstr(ri.classification, ==, "Degraded");
    g_assert_nonnull(ri.missing);
    assert_contains(ri.missing, "RPC", "degraded_rpc.missing");
    g_assert_nonnull(ri.next_action);
}

static void test_presenter_degraded_systemd_active_http_unreachable(void) {
    ReadinessInfo ri;
    HealthState hs = {0};
    hs.http_ok = FALSE;
    SystemdState sys = {0};
    sys.active = TRUE;

    readiness_evaluate(STATE_DEGRADED, &hs, &sys, &ri);

    g_assert_cmpstr(ri.classification, ==, "Degraded");
    g_assert_nonnull(ri.missing);
    assert_contains(ri.missing, "not reachable", "degraded_active_http.missing");
    g_assert_nonnull(ri.next_action);
}

static void test_presenter_degraded_fallback(void) {
    /* No health context at all — fallback path */
    ReadinessInfo ri;
    readiness_evaluate(STATE_DEGRADED, NULL, NULL, &ri);

    g_assert_cmpstr(ri.classification, ==, "Degraded");
    g_assert_nonnull(ri.missing);
    g_assert_nonnull(ri.next_action);
}

/* ── STATE_ERROR ── */

static void test_presenter_error(void) {
    ReadinessInfo ri;
    HealthState hs = {0};
    SystemdState sys = {0};

    readiness_evaluate(STATE_ERROR, &hs, &sys, &ri);

    g_assert_cmpstr(ri.classification, ==, "Error");
    g_assert_nonnull(ri.missing);
    g_assert_nonnull(ri.next_action);
    assert_contains(ri.next_action, "journalctl", "error.next_action");
}

static void test_presenter_error_with_substate(void) {
    ReadinessInfo ri;
    HealthState hs = {0};
    SystemdState sys = {0};
    sys.sub_state = "failed";

    readiness_evaluate(STATE_ERROR, &hs, &sys, &ri);

    g_assert_cmpstr(ri.classification, ==, "Error");
    g_assert_nonnull(ri.missing);
    assert_contains(ri.missing, "journal", "error_substate.missing");
    g_assert_nonnull(ri.next_action);
}

/* ── NULL output pointer guard ── */

static void test_presenter_null_output(void) {
    /* Must not crash when out is NULL */
    readiness_evaluate(STATE_RUNNING, NULL, NULL, NULL);
}

/* ── Registration ── */

int main(int argc, char **argv) {
    g_test_init(&argc, &argv, NULL);

    /* Per-state classification tests */
    g_test_add_func("/readiness/needs_setup", test_presenter_needs_setup);
    g_test_add_func("/readiness/needs_gateway_install", test_presenter_needs_gateway_install);
    g_test_add_func("/readiness/systemd_unavailable", test_presenter_systemd_unavailable);
    g_test_add_func("/readiness/system_unsupported", test_presenter_system_unsupported);
    g_test_add_func("/readiness/config_invalid_with_error", test_presenter_config_invalid_with_error);
    g_test_add_func("/readiness/config_invalid_no_error", test_presenter_config_invalid_no_error);
    g_test_add_func("/readiness/stopped", test_presenter_stopped);
    g_test_add_func("/readiness/starting", test_presenter_starting);
    g_test_add_func("/readiness/running", test_presenter_running);
    g_test_add_func("/readiness/running_with_warning", test_presenter_running_with_warning);

    /* Degraded sub-path tests */
    g_test_add_func("/readiness/degraded/http_ok_ws_disconnected", test_presenter_degraded_http_ok_ws_disconnected);
    g_test_add_func("/readiness/degraded/connected_rpc_incomplete", test_presenter_degraded_connected_rpc_incomplete);
    g_test_add_func("/readiness/degraded/systemd_active_http_unreachable", test_presenter_degraded_systemd_active_http_unreachable);
    g_test_add_func("/readiness/degraded/fallback", test_presenter_degraded_fallback);

    /* Error sub-path tests */
    g_test_add_func("/readiness/error", test_presenter_error);
    g_test_add_func("/readiness/error_with_substate", test_presenter_error_with_substate);

    /* Guard */
    g_test_add_func("/readiness/null_output", test_presenter_null_output);

    return g_test_run();
}
