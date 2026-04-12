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
    assert_contains(ri.next_action, "openclaw onboard --install-daemon", "needs_setup.next_action");
}

/* ── STATE_NEEDS_GATEWAY_INSTALL ── */

static void test_presenter_needs_gateway_install(void) {
    ReadinessInfo ri;
    readiness_evaluate(STATE_NEEDS_GATEWAY_INSTALL, NULL, NULL, &ri);

    g_assert_cmpstr(ri.classification, ==, "Gateway Service Missing");
    g_assert_true(g_str_has_prefix(ri.missing, "The expected user systemd service path is not active"));
    assert_contains(ri.next_action, "onboard --install-daemon", "needs_gateway_install.next_action");
}

/* ── STATE_NEEDS_ONBOARDING ── */

static void test_presenter_needs_onboarding(void) {
    ReadinessInfo ri;
    HealthState hs = {0};
    SystemdState sys = {0};

    readiness_evaluate(STATE_NEEDS_ONBOARDING, &hs, &sys, &ri);

    g_assert_cmpstr(ri.classification, ==, "Bootstrap Incomplete");
    g_assert_nonnull(ri.missing);
    g_assert_nonnull(ri.next_action);
    assert_contains(ri.next_action, "openclaw onboard --install-daemon", "needs_onboarding.next_action");
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
    hs.http_probe_result = HTTP_PROBE_CONNECT_REFUSED;
    SystemdState sys = {0};
    sys.active = TRUE;

    readiness_evaluate(STATE_DEGRADED, &hs, &sys, &ri);

    g_assert_cmpstr(ri.classification, ==, "Degraded");
    g_assert_nonnull(ri.missing);
    assert_contains(ri.missing, "not reachable", "degraded_active_http.missing");
    /* Must NOT claim listener present for connect-refused */
    g_assert_null(strstr(ri.missing, "accepted a connection"));
    g_assert_nonnull(ri.next_action);
}

static void test_presenter_degraded_timed_out_after_connect(void) {
    ReadinessInfo ri;
    HealthState hs = {0};
    hs.http_ok = FALSE;
    hs.http_probe_result = HTTP_PROBE_TIMED_OUT_AFTER_CONNECT;
    SystemdState sys = {0};
    sys.active = TRUE;

    readiness_evaluate(STATE_DEGRADED, &hs, &sys, &ri);

    g_assert_cmpstr(ri.classification, ==, "Degraded");
    g_assert_nonnull(ri.missing);
    assert_contains(ri.missing, "accepted a connection", "degraded_timeout_after_connect.missing");
    assert_contains(ri.missing, "did not respond", "degraded_timeout_after_connect.missing2");
    g_assert_nonnull(ri.next_action);
    assert_contains(ri.next_action, "hung", "degraded_timeout_after_connect.next_action");
}

static void test_presenter_degraded_unknown_error_active(void) {
    ReadinessInfo ri;
    HealthState hs = {0};
    hs.http_ok = FALSE;
    hs.http_probe_result = HTTP_PROBE_UNKNOWN_ERROR;
    SystemdState sys = {0};
    sys.active = TRUE;

    readiness_evaluate(STATE_DEGRADED, &hs, &sys, &ri);

    g_assert_cmpstr(ri.classification, ==, "Degraded");
    g_assert_nonnull(ri.missing);
    assert_contains(ri.missing, "not reachable", "degraded_unknown_active.missing");
    /* Must NOT claim listener present for unknown error */
    g_assert_null(strstr(ri.missing, "accepted a connection"));
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

static void test_onboarding_progress_service_inactive(void) {
    HealthState hs = {0};
    SystemdState sys = {0};
    OnboardingStageProgress progress = {0};

    hs.config_valid = TRUE;
    hs.http_ok = FALSE;
    hs.ws_connected = FALSE;
    hs.rpc_ok = FALSE;
    hs.auth_ok = FALSE;

    sys.installed = TRUE;
    sys.active = FALSE;

    readiness_build_onboarding_progress(STATE_STOPPED, &hs, &sys, &progress);

    g_assert_cmpint(progress.configuration, ==, ONBOARDING_STAGE_COMPLETE);
    g_assert_cmpint(progress.service_gateway, ==, ONBOARDING_STAGE_IN_PROGRESS);
    g_assert_cmpint(progress.connection, ==, ONBOARDING_STAGE_PENDING);
    g_assert_false(progress.operational_ready);
}

static void test_onboarding_progress_connecting_service_active(void) {
    HealthState hs = {0};
    SystemdState sys = {0};
    OnboardingStageProgress progress = {0};

    hs.config_valid = TRUE;
    hs.http_ok = TRUE;
    hs.ws_connected = FALSE;
    hs.rpc_ok = FALSE;
    hs.auth_ok = FALSE;

    sys.installed = TRUE;
    sys.active = TRUE;

    readiness_build_onboarding_progress(STATE_DEGRADED, &hs, &sys, &progress);

    g_assert_cmpint(progress.configuration, ==, ONBOARDING_STAGE_COMPLETE);
    g_assert_cmpint(progress.service_gateway, ==, ONBOARDING_STAGE_COMPLETE);
    g_assert_cmpint(progress.connection, ==, ONBOARDING_STAGE_IN_PROGRESS);
    g_assert_false(progress.operational_ready);
}

static void test_onboarding_progress_operational_ready_only_when_running(void) {
    HealthState hs = {0};
    SystemdState sys = {0};
    OnboardingStageProgress progress = {0};

    hs.config_valid = TRUE;
    hs.http_ok = TRUE;
    hs.ws_connected = TRUE;
    hs.rpc_ok = TRUE;
    hs.auth_ok = TRUE;

    sys.installed = TRUE;
    sys.active = TRUE;

    readiness_build_onboarding_progress(STATE_RUNNING, &hs, &sys, &progress);

    g_assert_cmpint(progress.configuration, ==, ONBOARDING_STAGE_COMPLETE);
    g_assert_cmpint(progress.service_gateway, ==, ONBOARDING_STAGE_COMPLETE);
    g_assert_cmpint(progress.connection, ==, ONBOARDING_STAGE_COMPLETE);
    g_assert_true(progress.operational_ready);
}

static void test_chat_gate_bootstrap_complete_but_model_missing(void) {
    DesktopReadinessSnapshot snap = {0};
    snap.config_present = TRUE;
    snap.config_valid = TRUE;
    snap.wizard_completed = TRUE;
    snap.service_installed = TRUE;
    snap.service_active = TRUE;
    snap.gateway_http_ok = TRUE;
    snap.gateway_ws_ok = TRUE;
    snap.gateway_rpc_ok = TRUE;
    snap.gateway_auth_ok = TRUE;
    snap.provider_configured = TRUE;
    snap.default_model_configured = FALSE;
    snap.desktop_chat_ready = FALSE;
    snap.chat_block_reason = CHAT_BLOCK_DEFAULT_MODEL_MISSING;

    ChatGateInfo gate = {0};
    readiness_describe_chat_gate(&snap, &gate);

    g_assert_false(gate.ready);
    g_assert_cmpint(gate.reason, ==, CHAT_BLOCK_DEFAULT_MODEL_MISSING);
    assert_contains(gate.status, "default model", "chat_gate_model_missing.status");
    g_assert_nonnull(gate.next_action);
    assert_contains(gate.next_action, "default model", "chat_gate_model_missing.next_action");
}

static void test_chat_gate_provider_missing(void) {
    DesktopReadinessSnapshot snap = {0};
    snap.config_present = TRUE;
    snap.config_valid = TRUE;
    snap.wizard_completed = TRUE;
    snap.service_installed = TRUE;
    snap.service_active = TRUE;
    snap.gateway_http_ok = TRUE;
    snap.gateway_ws_ok = TRUE;
    snap.gateway_rpc_ok = TRUE;
    snap.gateway_auth_ok = TRUE;
    snap.provider_configured = FALSE;
    snap.default_model_configured = FALSE;
    snap.desktop_chat_ready = FALSE;
    snap.chat_block_reason = CHAT_BLOCK_PROVIDER_MISSING;

    ChatGateInfo gate = {0};
    readiness_describe_chat_gate(&snap, &gate);

    g_assert_false(gate.ready);
    g_assert_cmpint(gate.reason, ==, CHAT_BLOCK_PROVIDER_MISSING);
    assert_contains(gate.status, "provider", "chat_gate_provider_missing.status");
    g_assert_nonnull(gate.next_action);
}

static void test_chat_gate_service_down(void) {
    DesktopReadinessSnapshot snap = {0};
    snap.config_present = TRUE;
    snap.config_valid = TRUE;
    snap.wizard_completed = TRUE;
    snap.service_installed = TRUE;
    snap.service_active = FALSE;
    snap.desktop_chat_ready = FALSE;
    snap.chat_block_reason = CHAT_BLOCK_SERVICE_INACTIVE;

    ChatGateInfo gate = {0};
    readiness_describe_chat_gate(&snap, &gate);

    g_assert_false(gate.ready);
    g_assert_cmpint(gate.reason, ==, CHAT_BLOCK_SERVICE_INACTIVE);
    assert_contains(gate.status, "not active", "chat_gate_service_inactive.status");
}

static void test_chat_gate_catalog_unavailable(void) {
    DesktopReadinessSnapshot snap = {0};
    snap.config_present = TRUE;
    snap.config_valid = TRUE;
    snap.wizard_completed = TRUE;
    snap.service_installed = TRUE;
    snap.service_active = TRUE;
    snap.gateway_http_ok = TRUE;
    snap.gateway_ws_ok = TRUE;
    snap.gateway_rpc_ok = TRUE;
    snap.gateway_auth_ok = TRUE;
    snap.provider_configured = TRUE;
    snap.default_model_configured = TRUE;
    snap.model_catalog_available = FALSE;
    snap.selected_model_resolved = FALSE;
    snap.desktop_chat_ready = FALSE;
    snap.chat_block_reason = CHAT_BLOCK_MODEL_CATALOG_EMPTY;

    ChatGateInfo gate = {0};
    readiness_describe_chat_gate(&snap, &gate);

    g_assert_false(gate.ready);
    g_assert_cmpint(gate.reason, ==, CHAT_BLOCK_MODEL_CATALOG_EMPTY);
    assert_contains(gate.status, "catalog", "chat_gate_catalog_unavailable.status");
    assert_contains(gate.next_action, "Reload models", "chat_gate_catalog_unavailable.next_action");
}

static void test_chat_gate_selected_model_unresolved(void) {
    DesktopReadinessSnapshot snap = {0};
    snap.config_present = TRUE;
    snap.config_valid = TRUE;
    snap.wizard_completed = TRUE;
    snap.service_installed = TRUE;
    snap.service_active = TRUE;
    snap.gateway_http_ok = TRUE;
    snap.gateway_ws_ok = TRUE;
    snap.gateway_rpc_ok = TRUE;
    snap.gateway_auth_ok = TRUE;
    snap.provider_configured = TRUE;
    snap.default_model_configured = TRUE;
    snap.model_catalog_available = TRUE;
    snap.selected_model_resolved = FALSE;
    snap.desktop_chat_ready = FALSE;
    snap.chat_block_reason = CHAT_BLOCK_SELECTED_MODEL_UNRESOLVED;

    ChatGateInfo gate = {0};
    readiness_describe_chat_gate(&snap, &gate);

    g_assert_false(gate.ready);
    g_assert_cmpint(gate.reason, ==, CHAT_BLOCK_SELECTED_MODEL_UNRESOLVED);
    assert_contains(gate.status, "not available", "chat_gate_selected_model_unresolved.status");
    assert_contains(gate.next_action, "choose", "chat_gate_selected_model_unresolved.next_action");
}

static void test_chat_gate_agents_unavailable(void) {
    DesktopReadinessSnapshot snap = {0};
    snap.config_present = TRUE;
    snap.config_valid = TRUE;
    snap.wizard_completed = TRUE;
    snap.service_installed = TRUE;
    snap.service_active = TRUE;
    snap.gateway_http_ok = TRUE;
    snap.gateway_ws_ok = TRUE;
    snap.gateway_rpc_ok = TRUE;
    snap.gateway_auth_ok = TRUE;
    snap.provider_configured = TRUE;
    snap.default_model_configured = TRUE;
    snap.model_catalog_available = TRUE;
    snap.selected_model_resolved = TRUE;
    snap.agents_available = FALSE;
    snap.desktop_chat_ready = FALSE;
    snap.chat_block_reason = CHAT_BLOCK_AGENTS_UNAVAILABLE;

    ChatGateInfo gate = {0};
    readiness_describe_chat_gate(&snap, &gate);

    g_assert_false(gate.ready);
    g_assert_cmpint(gate.reason, ==, CHAT_BLOCK_AGENTS_UNAVAILABLE);
    assert_contains(gate.status, "agents", "chat_gate_agents_unavailable.status");
    assert_contains(gate.next_action, "Agents", "chat_gate_agents_unavailable.next_action");
}

static void test_chat_gate_ready(void) {
    DesktopReadinessSnapshot snap = {0};
    snap.config_present = TRUE;
    snap.config_valid = TRUE;
    snap.wizard_completed = TRUE;
    snap.service_installed = TRUE;
    snap.service_active = TRUE;
    snap.gateway_http_ok = TRUE;
    snap.gateway_ws_ok = TRUE;
    snap.gateway_rpc_ok = TRUE;
    snap.gateway_auth_ok = TRUE;
    snap.provider_configured = TRUE;
    snap.default_model_configured = TRUE;
    snap.model_catalog_available = TRUE;
    snap.selected_model_resolved = TRUE;
    snap.agents_available = TRUE;
    snap.desktop_chat_ready = TRUE;
    snap.chat_block_reason = CHAT_BLOCK_NONE;

    ChatGateInfo gate = {0};
    readiness_describe_chat_gate(&snap, &gate);

    g_assert_true(gate.ready);
    g_assert_cmpint(gate.reason, ==, CHAT_BLOCK_NONE);
    assert_contains(gate.status, "ready", "chat_gate_ready.status");
    g_assert_null(gate.next_action);
}

/* ── Registration ── */

int main(int argc, char **argv) {
    g_test_init(&argc, &argv, NULL);

    /* Per-state classification tests */
    g_test_add_func("/readiness/needs_setup", test_presenter_needs_setup);
    g_test_add_func("/readiness/needs_gateway_install", test_presenter_needs_gateway_install);
    g_test_add_func("/readiness/needs_onboarding", test_presenter_needs_onboarding);
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
    g_test_add_func("/readiness/degraded/timed_out_after_connect", test_presenter_degraded_timed_out_after_connect);
    g_test_add_func("/readiness/degraded/unknown_error_active", test_presenter_degraded_unknown_error_active);
    g_test_add_func("/readiness/degraded/fallback", test_presenter_degraded_fallback);

    /* Error sub-path tests */
    g_test_add_func("/readiness/error", test_presenter_error);
    g_test_add_func("/readiness/error_with_substate", test_presenter_error_with_substate);

    /* Guard */
    g_test_add_func("/readiness/null_output", test_presenter_null_output);

    /* Onboarding stage mapping */
    g_test_add_func("/readiness/onboarding_progress/service_inactive", test_onboarding_progress_service_inactive);
    g_test_add_func("/readiness/onboarding_progress/connecting_service_active", test_onboarding_progress_connecting_service_active);
    g_test_add_func("/readiness/onboarding_progress/operational_ready_running", test_onboarding_progress_operational_ready_only_when_running);
    g_test_add_func("/readiness/chat_gate/bootstrap_complete_model_missing", test_chat_gate_bootstrap_complete_but_model_missing);
    g_test_add_func("/readiness/chat_gate/provider_missing", test_chat_gate_provider_missing);
    g_test_add_func("/readiness/chat_gate/service_inactive", test_chat_gate_service_down);
    g_test_add_func("/readiness/chat_gate/catalog_unavailable", test_chat_gate_catalog_unavailable);
    g_test_add_func("/readiness/chat_gate/selected_model_unresolved", test_chat_gate_selected_model_unresolved);
    g_test_add_func("/readiness/chat_gate/agents_unavailable", test_chat_gate_agents_unavailable);
    g_test_add_func("/readiness/chat_gate/ready", test_chat_gate_ready);

    return g_test_run();
}
