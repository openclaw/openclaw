/*
 * test_runtime_mode_presentation.c
 *
 * Tests for RuntimeMode presentation strings and the
 * health_state_listener_proven() helper.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include <glib.h>
#include "../src/state.h"

/* ── runtime_mode_describe: every mode produces non-NULL label + explanation ── */

static void test_describe_none(void) {
    RuntimeModePresentation p;
    runtime_mode_describe(RUNTIME_NONE, &p);
    g_assert_cmpstr(p.label, ==, "No Runtime Detected");
    g_assert_nonnull(p.explanation);
}

static void test_describe_expected_service_healthy(void) {
    RuntimeModePresentation p;
    runtime_mode_describe(RUNTIME_EXPECTED_SERVICE_HEALTHY, &p);
    g_assert_cmpstr(p.label, ==, "Expected Service Healthy");
    g_assert_nonnull(p.explanation);
}

static void test_describe_healthy_outside_expected_service(void) {
    RuntimeModePresentation p;
    runtime_mode_describe(RUNTIME_HEALTHY_OUTSIDE_EXPECTED_SERVICE, &p);
    g_assert_cmpstr(p.label, ==, "Healthy (Outside Expected Service)");
    g_assert_nonnull(p.explanation);
}

static void test_describe_listener_unresponsive(void) {
    RuntimeModePresentation p;
    runtime_mode_describe(RUNTIME_LISTENER_PRESENT_UNRESPONSIVE, &p);
    g_assert_cmpstr(p.label, ==, "Listener Present (Unresponsive)");
    g_assert_nonnull(p.explanation);
}

static void test_describe_listener_unverified(void) {
    RuntimeModePresentation p;
    runtime_mode_describe(RUNTIME_LISTENER_PRESENT_UNVERIFIED, &p);
    g_assert_cmpstr(p.label, ==, "Listener Present (Unverified)");
    g_assert_nonnull(p.explanation);
}

static void test_describe_service_active_not_proven(void) {
    RuntimeModePresentation p;
    runtime_mode_describe(RUNTIME_SERVICE_ACTIVE_NOT_PROVEN, &p);
    g_assert_cmpstr(p.label, ==, "Service Active (Not Proven)");
    g_assert_nonnull(p.explanation);
}

static void test_describe_unknown(void) {
    RuntimeModePresentation p;
    runtime_mode_describe(RUNTIME_UNKNOWN, &p);
    g_assert_cmpstr(p.label, ==, "Unknown");
    g_assert_nonnull(p.explanation);
}

static void test_describe_null_output(void) {
    /* Must not crash when out is NULL */
    runtime_mode_describe(RUNTIME_NONE, NULL);
}

/* ── health_state_listener_proven: per-probe-result truth table ── */

static void test_listener_proven_ok(void) {
    HealthState hs = {0};
    hs.http_probe_result = HTTP_PROBE_OK;
    g_assert_true(health_state_listener_proven(&hs));
}

static void test_listener_proven_timed_out_after_connect(void) {
    HealthState hs = {0};
    hs.http_probe_result = HTTP_PROBE_TIMED_OUT_AFTER_CONNECT;
    g_assert_true(health_state_listener_proven(&hs));
}

static void test_listener_proven_invalid_response(void) {
    HealthState hs = {0};
    hs.http_probe_result = HTTP_PROBE_INVALID_RESPONSE;
    g_assert_true(health_state_listener_proven(&hs));
}

static void test_listener_not_proven_none(void) {
    HealthState hs = {0};
    hs.http_probe_result = HTTP_PROBE_NONE;
    g_assert_false(health_state_listener_proven(&hs));
}

static void test_listener_not_proven_connect_refused(void) {
    HealthState hs = {0};
    hs.http_probe_result = HTTP_PROBE_CONNECT_REFUSED;
    g_assert_false(health_state_listener_proven(&hs));
}

static void test_listener_not_proven_connect_timeout(void) {
    HealthState hs = {0};
    hs.http_probe_result = HTTP_PROBE_CONNECT_TIMEOUT;
    g_assert_false(health_state_listener_proven(&hs));
}

static void test_listener_not_proven_unknown_error(void) {
    HealthState hs = {0};
    hs.http_probe_result = HTTP_PROBE_UNKNOWN_ERROR;
    g_assert_false(health_state_listener_proven(&hs));
}

static void test_listener_proven_null_health(void) {
    g_assert_false(health_state_listener_proven(NULL));
}

/* ── Registration ── */

int main(int argc, char **argv) {
    g_test_init(&argc, &argv, NULL);

    /* Presentation strings */
    g_test_add_func("/runtime_mode_presentation/describe_none", test_describe_none);
    g_test_add_func("/runtime_mode_presentation/describe_expected_service_healthy", test_describe_expected_service_healthy);
    g_test_add_func("/runtime_mode_presentation/describe_healthy_outside_expected_service", test_describe_healthy_outside_expected_service);
    g_test_add_func("/runtime_mode_presentation/describe_listener_unresponsive", test_describe_listener_unresponsive);
    g_test_add_func("/runtime_mode_presentation/describe_listener_unverified", test_describe_listener_unverified);
    g_test_add_func("/runtime_mode_presentation/describe_service_active_not_proven", test_describe_service_active_not_proven);
    g_test_add_func("/runtime_mode_presentation/describe_unknown", test_describe_unknown);
    g_test_add_func("/runtime_mode_presentation/describe_null_output", test_describe_null_output);

    /* Listener-proven truth table */
    g_test_add_func("/runtime_mode_presentation/listener_proven_ok", test_listener_proven_ok);
    g_test_add_func("/runtime_mode_presentation/listener_proven_timed_out_after_connect", test_listener_proven_timed_out_after_connect);
    g_test_add_func("/runtime_mode_presentation/listener_proven_invalid_response", test_listener_proven_invalid_response);
    g_test_add_func("/runtime_mode_presentation/listener_not_proven_none", test_listener_not_proven_none);
    g_test_add_func("/runtime_mode_presentation/listener_not_proven_connect_refused", test_listener_not_proven_connect_refused);
    g_test_add_func("/runtime_mode_presentation/listener_not_proven_connect_timeout", test_listener_not_proven_connect_timeout);
    g_test_add_func("/runtime_mode_presentation/listener_not_proven_unknown_error", test_listener_not_proven_unknown_error);
    g_test_add_func("/runtime_mode_presentation/listener_proven_null_health", test_listener_proven_null_health);

    return g_test_run();
}
