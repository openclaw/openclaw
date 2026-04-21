/*
 * test_product_coordinator.c
 *
 * Focused coverage for Linux companion product coordination policy.
 *
 * Verifies startup presentation, onboarding routing, and connection-mode
 * policy decisions using headless stubs for runtime dependencies.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "../src/product_coordinator.h"

#include "../src/display_model.h"
#include "../src/onboarding.h"
#include "../src/product_state.h"
#include "../src/state.h"

#include <glib.h>

static gint stub_state_init_calls = 0;
static gint stub_product_state_init_calls = 0;
static gint stub_notify_init_calls = 0;
static gint stub_tray_init_calls = 0;
static gint stub_systemd_init_calls = 0;
static gint stub_systemd_refresh_calls = 0;
static gint stub_gateway_client_init_calls = 0;
static gint stub_device_pair_prompter_init_calls = 0;
static gint stub_onboarding_show_calls = 0;
static gint stub_app_window_show_calls = 0;
static gint stub_app_window_navigate_calls = 0;
static gint stub_app_window_refresh_snapshot_calls = 0;
static gint stub_product_state_set_seen_calls = 0;
static gint stub_product_state_set_connection_mode_calls = 0;
static gboolean stub_product_state_set_connection_mode_result = TRUE;
static AppSection stub_last_navigate_section = SECTION_DASHBOARD;
static guint stub_onboarding_seen_version = 0;
static guint stub_last_persisted_onboarding_seen_version = 0;
static AppState stub_current_state = STATE_NEEDS_SETUP;
static ProductConnectionMode stub_connection_mode = PRODUCT_CONNECTION_MODE_LOCAL;
static AppState stub_last_routing_state = STATE_ERROR;
static gint stub_last_routing_seen_version = -1;
static gint stub_last_routing_current_version = -1;
static OnboardingRoute stub_route = ONBOARDING_SKIP;

static void stub_reset(void) {
    product_coordinator_test_reset();
    stub_state_init_calls = 0;
    stub_product_state_init_calls = 0;
    stub_notify_init_calls = 0;
    stub_tray_init_calls = 0;
    stub_systemd_init_calls = 0;
    stub_systemd_refresh_calls = 0;
    stub_gateway_client_init_calls = 0;
    stub_device_pair_prompter_init_calls = 0;
    stub_onboarding_show_calls = 0;
    stub_app_window_show_calls = 0;
    stub_app_window_navigate_calls = 0;
    stub_app_window_refresh_snapshot_calls = 0;
    stub_product_state_set_seen_calls = 0;
    stub_product_state_set_connection_mode_calls = 0;
    stub_product_state_set_connection_mode_result = TRUE;
    stub_last_navigate_section = SECTION_DASHBOARD;
    stub_onboarding_seen_version = 0;
    stub_last_persisted_onboarding_seen_version = 0;
    stub_current_state = STATE_NEEDS_SETUP;
    stub_connection_mode = PRODUCT_CONNECTION_MODE_LOCAL;
    stub_last_routing_state = STATE_ERROR;
    stub_last_routing_seen_version = -1;
    stub_last_routing_current_version = -1;
    stub_route = ONBOARDING_SKIP;
}

void state_init(void) {
    stub_state_init_calls++;
}

AppState state_get_current(void) {
    return stub_current_state;
}

void notify_init(void) {
    stub_notify_init_calls++;
}

void tray_init(void) {
    stub_tray_init_calls++;
}

void systemd_init(void) {
    stub_systemd_init_calls++;
}

void systemd_refresh(void) {
    stub_systemd_refresh_calls++;
}

void gateway_client_init(void) {
    stub_gateway_client_init_calls++;
}

void device_pair_prompter_init(GtkWindow *parent) {
    (void)parent;
    stub_device_pair_prompter_init_calls++;
}

void onboarding_show(void) {
    stub_onboarding_show_calls++;
}

void app_window_show(void) {
    stub_app_window_show_calls++;
}

void app_window_navigate_to(AppSection section) {
    stub_app_window_navigate_calls++;
    stub_last_navigate_section = section;
}

void app_window_refresh_snapshot(void) {
    stub_app_window_refresh_snapshot_calls++;
}

void product_state_init(void) {
    stub_product_state_init_calls++;
}

ProductConnectionMode product_state_get_connection_mode(void) {
    return stub_connection_mode;
}

ProductConnectionMode product_state_get_effective_connection_mode(void) {
    return stub_connection_mode == PRODUCT_CONNECTION_MODE_REMOTE
        ? PRODUCT_CONNECTION_MODE_REMOTE
        : PRODUCT_CONNECTION_MODE_LOCAL;
}

gboolean product_state_set_connection_mode(ProductConnectionMode mode) {
    stub_product_state_set_connection_mode_calls++;
    if (!stub_product_state_set_connection_mode_result) {
        return FALSE;
    }
    stub_connection_mode = mode;
    return TRUE;
}

guint product_state_get_onboarding_seen_version(void) {
    return stub_onboarding_seen_version;
}

gboolean product_state_set_onboarding_seen_version(guint version) {
    stub_product_state_set_seen_calls++;
    stub_last_persisted_onboarding_seen_version = version;
    stub_onboarding_seen_version = version;
    return TRUE;
}

OnboardingRoute onboarding_routing_decide(AppState state,
                                          int seen_version,
                                          int current_version) {
    stub_last_routing_state = state;
    stub_last_routing_seen_version = seen_version;
    stub_last_routing_current_version = current_version;
    return stub_route;
}

static void test_activate_boots_runtime_lanes_once(void) {
    stub_reset();

    product_coordinator_activate();
    product_coordinator_activate();

    g_assert_cmpint(stub_state_init_calls, ==, 1);
    g_assert_cmpint(stub_product_state_init_calls, ==, 1);
    g_assert_cmpint(stub_notify_init_calls, ==, 1);
    g_assert_cmpint(stub_tray_init_calls, ==, 1);
    g_assert_cmpint(stub_systemd_init_calls, ==, 1);
    g_assert_cmpint(stub_systemd_refresh_calls, ==, 1);
    g_assert_cmpint(stub_gateway_client_init_calls, ==, 1);
    g_assert_cmpint(stub_device_pair_prompter_init_calls, ==, 1);
    g_assert_cmpint(stub_onboarding_show_calls, ==, 0);

    stub_reset();
}

static void test_reconcile_startup_presentation_shows_onboarding(void) {
    stub_reset();
    stub_current_state = STATE_NEEDS_ONBOARDING;
    stub_connection_mode = PRODUCT_CONNECTION_MODE_LOCAL;
    stub_onboarding_seen_version = 0;
    stub_route = ONBOARDING_SHOW_FULL;

    product_coordinator_reconcile_startup_presentation();

    g_assert_cmpint(stub_onboarding_show_calls, ==, 1);
    g_assert_cmpint(stub_last_routing_state, ==, STATE_NEEDS_ONBOARDING);
    g_assert_cmpint(stub_last_routing_seen_version, ==, 0);
    g_assert_cmpint(stub_last_routing_current_version, ==, ONBOARDING_CURRENT_VERSION);

    stub_reset();
}

static void test_reconcile_startup_presentation_skips_when_completed(void) {
    stub_reset();
    stub_current_state = STATE_RUNNING;
    stub_connection_mode = PRODUCT_CONNECTION_MODE_LOCAL;
    stub_onboarding_seen_version = ONBOARDING_CURRENT_VERSION;
    stub_route = ONBOARDING_SKIP;

    product_coordinator_reconcile_startup_presentation();

    g_assert_cmpint(stub_onboarding_show_calls, ==, 0);
    g_assert_cmpint(stub_last_routing_state, ==, STATE_RUNNING);
    g_assert_cmpint(stub_last_routing_seen_version, ==, ONBOARDING_CURRENT_VERSION);

    stub_reset();
}

static void test_reconcile_startup_presentation_remote_incomplete_is_noop(void) {
    stub_reset();
    stub_current_state = STATE_NEEDS_ONBOARDING;
    stub_connection_mode = PRODUCT_CONNECTION_MODE_REMOTE;
    stub_onboarding_seen_version = 0;
    stub_route = ONBOARDING_SHOW_FULL;

    product_coordinator_reconcile_startup_presentation();

    g_assert_cmpint(stub_onboarding_show_calls, ==, 0);
    g_assert_cmpint(stub_app_window_show_calls, ==, 0);
    g_assert_cmpint(stub_app_window_navigate_calls, ==, 0);
    g_assert_cmpint(stub_last_routing_state, ==, STATE_ERROR);

    stub_reset();
}

static void test_request_show_main_presents_main_window(void) {
    stub_reset();

    product_coordinator_request_show_main();

    g_assert_cmpint(stub_app_window_show_calls, ==, 1);
    g_assert_cmpint(stub_app_window_navigate_calls, ==, 0);

    stub_reset();
}

static void test_request_show_section_routes_to_main_window(void) {
    stub_reset();

    product_coordinator_request_show_section(SECTION_DIAGNOSTICS);

    g_assert_cmpint(stub_app_window_show_calls, ==, 1);
    g_assert_cmpint(stub_app_window_navigate_calls, ==, 1);
    g_assert_cmpint(stub_last_navigate_section, ==, SECTION_DIAGNOSTICS);

    stub_reset();
}

static void test_request_rerun_onboarding_shows_onboarding(void) {
    stub_reset();
    stub_connection_mode = PRODUCT_CONNECTION_MODE_LOCAL;

    product_coordinator_request_rerun_onboarding();

    g_assert_cmpint(stub_onboarding_show_calls, ==, 1);
    g_assert_cmpint(stub_app_window_show_calls, ==, 0);

    stub_reset();
}

static void test_request_rerun_onboarding_remote_routes_to_general(void) {
    stub_reset();
    stub_connection_mode = PRODUCT_CONNECTION_MODE_REMOTE;

    product_coordinator_request_rerun_onboarding();

    g_assert_cmpint(stub_onboarding_show_calls, ==, 0);
    g_assert_cmpint(stub_app_window_show_calls, ==, 1);
    g_assert_cmpint(stub_app_window_navigate_calls, ==, 1);
    g_assert_cmpint(stub_last_navigate_section, ==, SECTION_GENERAL);

    stub_reset();
}

static void test_notify_onboarding_completed_persists_and_opens_main(void) {
    stub_reset();

    product_coordinator_notify_onboarding_completed();

    g_assert_cmpint(stub_product_state_set_seen_calls, ==, 1);
    g_assert_cmpuint(stub_last_persisted_onboarding_seen_version, ==, ONBOARDING_CURRENT_VERSION);
    g_assert_cmpint(stub_app_window_show_calls, ==, 1);

    stub_reset();
}

static void test_request_set_connection_mode_remote_routes_to_general(void) {
    stub_reset();
    stub_connection_mode = PRODUCT_CONNECTION_MODE_LOCAL;

    g_assert_true(product_coordinator_request_set_connection_mode(PRODUCT_CONNECTION_MODE_REMOTE));

    g_assert_cmpint(stub_product_state_set_connection_mode_calls, ==, 1);
    g_assert_cmpint(stub_connection_mode, ==, PRODUCT_CONNECTION_MODE_REMOTE);
    g_assert_cmpint(stub_onboarding_show_calls, ==, 0);
    g_assert_cmpint(stub_app_window_show_calls, ==, 1);
    g_assert_cmpint(stub_app_window_navigate_calls, ==, 1);
    g_assert_cmpint(stub_last_navigate_section, ==, SECTION_GENERAL);
    g_assert_cmpint(stub_app_window_refresh_snapshot_calls, ==, 0);

    stub_reset();
}

static void test_request_set_connection_mode_local_incomplete_shows_onboarding(void) {
    stub_reset();
    stub_connection_mode = PRODUCT_CONNECTION_MODE_REMOTE;
    stub_onboarding_seen_version = 0;

    g_assert_true(product_coordinator_request_set_connection_mode(PRODUCT_CONNECTION_MODE_LOCAL));

    g_assert_cmpint(stub_product_state_set_connection_mode_calls, ==, 1);
    g_assert_cmpint(stub_connection_mode, ==, PRODUCT_CONNECTION_MODE_LOCAL);
    g_assert_cmpint(stub_app_window_refresh_snapshot_calls, ==, 1);
    g_assert_cmpint(stub_onboarding_show_calls, ==, 1);
    g_assert_cmpint(stub_app_window_navigate_calls, ==, 0);

    stub_reset();
}

static void test_request_set_connection_mode_failure_restores_noop(void) {
    stub_reset();
    stub_product_state_set_connection_mode_result = FALSE;

    g_assert_false(product_coordinator_request_set_connection_mode(PRODUCT_CONNECTION_MODE_REMOTE));

    g_assert_cmpint(stub_product_state_set_connection_mode_calls, ==, 1);
    g_assert_cmpint(stub_connection_mode, ==, PRODUCT_CONNECTION_MODE_LOCAL);
    g_assert_cmpint(stub_onboarding_show_calls, ==, 0);
    g_assert_cmpint(stub_app_window_show_calls, ==, 0);
    g_assert_cmpint(stub_app_window_navigate_calls, ==, 0);
    g_assert_cmpint(stub_app_window_refresh_snapshot_calls, ==, 0);

    stub_reset();
}

int main(int argc, char **argv) {
    g_test_init(&argc, &argv, NULL);
    g_test_add_func("/product_coordinator/activate_boots_runtime_lanes_once", test_activate_boots_runtime_lanes_once);
    g_test_add_func("/product_coordinator/reconcile_startup_presentation_shows_onboarding", test_reconcile_startup_presentation_shows_onboarding);
    g_test_add_func("/product_coordinator/reconcile_startup_presentation_skips_when_completed", test_reconcile_startup_presentation_skips_when_completed);
    g_test_add_func("/product_coordinator/reconcile_startup_presentation_remote_incomplete_is_noop", test_reconcile_startup_presentation_remote_incomplete_is_noop);
    g_test_add_func("/product_coordinator/request_show_main_presents_main_window", test_request_show_main_presents_main_window);
    g_test_add_func("/product_coordinator/request_show_section_routes_to_main_window", test_request_show_section_routes_to_main_window);
    g_test_add_func("/product_coordinator/request_rerun_onboarding_shows_onboarding", test_request_rerun_onboarding_shows_onboarding);
    g_test_add_func("/product_coordinator/request_rerun_onboarding_remote_routes_to_general", test_request_rerun_onboarding_remote_routes_to_general);
    g_test_add_func("/product_coordinator/notify_onboarding_completed_persists_and_opens_main", test_notify_onboarding_completed_persists_and_opens_main);
    g_test_add_func("/product_coordinator/request_set_connection_mode_remote_routes_to_general", test_request_set_connection_mode_remote_routes_to_general);
    g_test_add_func("/product_coordinator/request_set_connection_mode_local_incomplete_shows_onboarding", test_request_set_connection_mode_local_incomplete_shows_onboarding);
    g_test_add_func("/product_coordinator/request_set_connection_mode_failure_restores_noop", test_request_set_connection_mode_failure_restores_noop);
    return g_test_run();
}
