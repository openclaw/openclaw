/*
 * test_onboarding_controller.c
 *
 * Headless lifecycle coverage for the real onboarding controller module.
 *
 * Exercises `onboarding.c` through the production controller/view seam via
 * `onboarding_test_set_ui_hooks()`, so the test validates build/present,
 * route-stable live refresh, route-change rebuild, and completion teardown
 * behavior without requiring a live GTK display.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "../src/gateway_config.h"
#include "../src/onboarding.h"
#include "../src/onboarding_test.h"
#include "../src/readiness.h"
#include "../src/runtime_paths.h"
#include "../src/state.h"

#include <glib.h>
#include <glib/gstdio.h>

static AppState stub_current_state = STATE_RUNNING;
static guint stub_seen_version = 0;
static gboolean stub_reset_seen_result = TRUE;
static SystemdState stub_systemd = {0};
static HealthState stub_health = {0};
static ReadinessInfo stub_readiness = {0};
static OnboardingStageProgress stub_progress = {0};
static OnboardingRoute stub_route = ONBOARDING_SHOW_SHORTENED;
static gchar *stub_runtime_profile = NULL;
static gchar *stub_runtime_state_dir = NULL;
static gchar *stub_runtime_config_path = NULL;
static gchar *stub_effective_config_path = NULL;
static gchar *stub_effective_state_dir = NULL;
static gchar *stub_tmp_root = NULL;
static gint stub_notify_completed_calls = 0;
static gint stub_reconcile_calls = 0;

static gint ui_get_default_app_calls = 0;
static gint ui_build_calls = 0;
static gint ui_present_calls = 0;
static gint ui_destroy_calls = 0;
static gint ui_rebuild_calls = 0;
static gint ui_refresh_live_calls = 0;
static gint ui_reset_view_calls = 0;
static OnboardingRoute ui_last_build_route = ONBOARDING_SKIP;
static OnboardingRoute ui_last_rebuild_route = ONBOARDING_SKIP;
static OnboardingViewCallbacks ui_last_build_callbacks = {0};
static OnboardingViewCallbacks ui_last_rebuild_callbacks = {0};
static GCallback ui_destroy_callback = NULL;
static gpointer ui_destroy_user_data = NULL;

static gpointer stub_app = (gpointer)0x10;
static gpointer stub_window = (gpointer)0x20;
static gpointer stub_carousel = (gpointer)0x30;
static gpointer stub_indicator = (gpointer)0x40;

static void cleanup_temp_paths(void) {
    if (stub_effective_config_path) {
        g_remove(stub_effective_config_path);
    }
    if (stub_effective_state_dir) {
        g_rmdir(stub_effective_state_dir);
    }
    if (stub_tmp_root) {
        g_rmdir(stub_tmp_root);
    }

    g_clear_pointer(&stub_effective_config_path, g_free);
    g_clear_pointer(&stub_effective_state_dir, g_free);
    g_clear_pointer(&stub_tmp_root, g_free);
    g_clear_pointer(&stub_runtime_profile, g_free);
    g_clear_pointer(&stub_runtime_state_dir, g_free);
    g_clear_pointer(&stub_runtime_config_path, g_free);
}

static void reset_harness(void) {
    onboarding_test_reset();
    cleanup_temp_paths();

    memset(&stub_systemd, 0, sizeof(stub_systemd));
    memset(&stub_health, 0, sizeof(stub_health));
    memset(&stub_readiness, 0, sizeof(stub_readiness));
    memset(&stub_progress, 0, sizeof(stub_progress));

    stub_current_state = STATE_RUNNING;
    stub_seen_version = 0;
    stub_reset_seen_result = TRUE;
    stub_readiness.next_action = "open config";
    stub_progress.configuration = ONBOARDING_STAGE_COMPLETE;
    stub_progress.service_gateway = ONBOARDING_STAGE_COMPLETE;
    stub_progress.connection = ONBOARDING_STAGE_COMPLETE;
    stub_progress.operational_ready = FALSE;
    stub_route = ONBOARDING_SHOW_SHORTENED;
    stub_notify_completed_calls = 0;
    stub_reconcile_calls = 0;

    ui_get_default_app_calls = 0;
    ui_build_calls = 0;
    ui_present_calls = 0;
    ui_destroy_calls = 0;
    ui_rebuild_calls = 0;
    ui_refresh_live_calls = 0;
    ui_reset_view_calls = 0;
    ui_last_build_route = ONBOARDING_SKIP;
    ui_last_rebuild_route = ONBOARDING_SKIP;
    memset(&ui_last_build_callbacks, 0, sizeof(ui_last_build_callbacks));
    memset(&ui_last_rebuild_callbacks, 0, sizeof(ui_last_rebuild_callbacks));
    ui_destroy_callback = NULL;
    ui_destroy_user_data = NULL;

    stub_tmp_root = g_dir_make_tmp("openclaw-onboarding-test-XXXXXX", NULL);
    g_assert_nonnull(stub_tmp_root);

    stub_effective_config_path = g_build_filename(stub_tmp_root, "openclaw.json", NULL);
    g_assert_true(g_file_set_contents(stub_effective_config_path, "{}", -1, NULL));

    stub_effective_state_dir = g_build_filename(stub_tmp_root, "state", NULL);
    g_assert_cmpint(g_mkdir(stub_effective_state_dir, 0700), ==, 0);

    stub_runtime_profile = g_strdup("default");
    stub_runtime_state_dir = g_strdup(stub_effective_state_dir);
    stub_runtime_config_path = g_strdup(stub_effective_config_path);
}

static gpointer test_get_default_application(void) {
    ui_get_default_app_calls++;
    return stub_app;
}

static gpointer test_build_and_present_window(gpointer app,
                                              OnboardingRoute route,
                                              const OnboardingViewCallbacks *callbacks,
                                              GCallback destroy_callback,
                                              gpointer destroy_user_data,
                                              gpointer *out_carousel,
                                              gpointer *out_indicator) {
    g_assert_true(app == stub_app);
    g_assert_nonnull(callbacks);

    ui_build_calls++;
    ui_last_build_route = route;
    ui_last_build_callbacks = *callbacks;
    ui_destroy_callback = destroy_callback;
    ui_destroy_user_data = destroy_user_data;

    if (out_carousel) {
        *out_carousel = stub_carousel;
    }
    if (out_indicator) {
        *out_indicator = stub_indicator;
    }

    return stub_window;
}

static void test_present_window(gpointer window) {
    g_assert_true(window == stub_window);
    ui_present_calls++;
}

static void test_destroy_window(gpointer window) {
    g_assert_true(window == stub_window);
    ui_destroy_calls++;

    if (ui_destroy_callback) {
        GCallback callback = ui_destroy_callback;
        gpointer user_data = ui_destroy_user_data;
        ui_destroy_callback = NULL;
        ui_destroy_user_data = NULL;
        ((void (*)(GtkWindow *, gpointer))callback)((GtkWindow *)window, user_data);
    }
}

static void test_rebuild_pages(gpointer carousel,
                               OnboardingRoute route,
                               const OnboardingViewCallbacks *callbacks) {
    g_assert_true(carousel == stub_carousel);
    g_assert_nonnull(callbacks);

    ui_rebuild_calls++;
    ui_last_rebuild_route = route;
    ui_last_rebuild_callbacks = *callbacks;
}

static void test_refresh_live_content(void) {
    ui_refresh_live_calls++;
}

static void test_reset_view(void) {
    ui_reset_view_calls++;
}

static const OnboardingTestUiHooks test_ui_hooks = {
    .get_default_application = test_get_default_application,
    .build_and_present_window = test_build_and_present_window,
    .present_window = test_present_window,
    .destroy_window = test_destroy_window,
    .rebuild_pages = test_rebuild_pages,
    .refresh_live_content = test_refresh_live_content,
    .reset_view = test_reset_view,
};

guint product_state_get_onboarding_seen_version(void) {
    return stub_seen_version;
}

gboolean product_state_reset_onboarding_seen_version(void) {
    stub_seen_version = 0;
    return stub_reset_seen_result;
}

AppState state_get_current(void) {
    return stub_current_state;
}

SystemdState* state_get_systemd(void) {
    return &stub_systemd;
}

HealthState* state_get_health(void) {
    return &stub_health;
}

void readiness_evaluate(AppState state,
                        const HealthState *health,
                        const SystemdState *sys,
                        ReadinessInfo *out) {
    (void)state;
    (void)health;
    (void)sys;
    *out = stub_readiness;
}

void readiness_build_onboarding_progress(AppState state,
                                         const HealthState *health,
                                         const SystemdState *sys,
                                         OnboardingStageProgress *out) {
    (void)state;
    (void)health;
    (void)sys;
    *out = stub_progress;
}

void systemd_get_runtime_context(gchar **out_profile,
                                 gchar **out_state_dir,
                                 gchar **out_config_path) {
    if (out_profile) {
        *out_profile = g_strdup(stub_runtime_profile);
    }
    if (out_state_dir) {
        *out_state_dir = g_strdup(stub_runtime_state_dir);
    }
    if (out_config_path) {
        *out_config_path = g_strdup(stub_runtime_config_path);
    }
}

GatewayConfig* gateway_client_get_config(void) {
    return NULL;
}

gchar* gateway_config_dashboard_url(const GatewayConfig *config) {
    (void)config;
    return g_strdup("http://127.0.0.1:18789/");
}

void runtime_effective_paths_resolve(const GatewayConfig *loaded_config,
                                     const gchar *profile,
                                     const gchar *runtime_state_dir,
                                     const gchar *runtime_config_path,
                                     RuntimeEffectivePaths *out) {
    (void)loaded_config;
    (void)profile;
    (void)runtime_state_dir;
    (void)runtime_config_path;
    out->effective_config_path = g_strdup(stub_effective_config_path);
    out->effective_state_dir = g_strdup(stub_effective_state_dir);
}

void runtime_effective_paths_clear(RuntimeEffectivePaths *paths) {
    if (!paths) {
        return;
    }
    g_clear_pointer(&paths->effective_config_path, g_free);
    g_clear_pointer(&paths->effective_state_dir, g_free);
}

void product_coordinator_notify_onboarding_completed(void) {
    stub_notify_completed_calls++;
}

void product_coordinator_reconcile_startup_presentation(void) {
    stub_reconcile_calls++;
}

OnboardingRoute onboarding_routing_decide(AppState state,
                                          int seen_version,
                                          int current_version) {
    (void)state;
    (void)seen_version;
    (void)current_version;
    return stub_route;
}

void onboarding_view_reset(void) {}

void onboarding_view_build_pages(GtkWidget *carousel,
                                 OnboardingRoute route,
                                 const OnboardingViewCallbacks *callbacks) {
    (void)carousel;
    (void)route;
    (void)callbacks;
}

void onboarding_view_rebuild_pages(GtkWidget *carousel,
                                   OnboardingRoute route,
                                   const OnboardingViewCallbacks *callbacks) {
    (void)carousel;
    (void)route;
    (void)callbacks;
}

void onboarding_view_refresh_live_content(void) {}

static void test_show_builds_once_and_reuses_existing_window(void) {
    reset_harness();
    onboarding_test_set_ui_hooks(&test_ui_hooks);

    onboarding_show();
    g_assert_true(onboarding_is_visible());
    g_assert_cmpint(ui_get_default_app_calls, ==, 1);
    g_assert_cmpint(ui_build_calls, ==, 1);
    g_assert_cmpint(ui_present_calls, ==, 0);
    g_assert_cmpint(ui_last_build_route, ==, ONBOARDING_SHOW_SHORTENED);
    g_assert_nonnull(ui_last_build_callbacks.finish_clicked);
    g_assert_nonnull(ui_last_build_callbacks.open_dashboard_clicked);
    g_assert_nonnull(ui_last_build_callbacks.close_clicked);

    onboarding_show();
    g_assert_cmpint(ui_build_calls, ==, 1);
    g_assert_cmpint(ui_present_calls, ==, 1);
}

static void test_close_and_finish_callbacks_destroy_controller_window(void) {
    reset_harness();
    onboarding_test_set_ui_hooks(&test_ui_hooks);

    onboarding_show();
    ui_last_build_callbacks.close_clicked(NULL, NULL);

    g_assert_cmpint(ui_destroy_calls, ==, 1);
    g_assert_cmpint(ui_reset_view_calls, ==, 1);
    g_assert_false(onboarding_is_visible());
    g_assert_cmpint(stub_notify_completed_calls, ==, 0);

    onboarding_show();
    ui_last_build_callbacks.finish_clicked(NULL, NULL);

    g_assert_cmpint(ui_destroy_calls, ==, 2);
    g_assert_cmpint(stub_notify_completed_calls, ==, 1);
    g_assert_false(onboarding_is_visible());
}

static void test_route_stable_refresh_updates_live_content(void) {
    reset_harness();
    onboarding_test_set_ui_hooks(&test_ui_hooks);

    onboarding_show();
    onboarding_refresh();
    g_assert_cmpint(ui_refresh_live_calls, ==, 1);

    ui_refresh_live_calls = 0;
    onboarding_refresh();
    g_assert_cmpint(ui_refresh_live_calls, ==, 0);
    g_assert_cmpint(ui_rebuild_calls, ==, 0);

    g_clear_pointer(&stub_effective_config_path, g_free);
    stub_effective_config_path = g_build_filename(stub_tmp_root, "missing.json", NULL);
    onboarding_refresh();

    g_assert_cmpint(ui_refresh_live_calls, ==, 1);
    g_assert_cmpint(ui_rebuild_calls, ==, 0);
}

static void test_route_change_rebuilds_pages(void) {
    reset_harness();
    onboarding_test_set_ui_hooks(&test_ui_hooks);

    onboarding_show();
    onboarding_refresh();

    ui_refresh_live_calls = 0;
    ui_rebuild_calls = 0;
    stub_route = ONBOARDING_SHOW_FULL;

    onboarding_refresh();

    g_assert_cmpint(ui_rebuild_calls, ==, 1);
    g_assert_cmpint(ui_last_rebuild_route, ==, ONBOARDING_SHOW_FULL);
    g_assert_cmpint(ui_refresh_live_calls, ==, 0);
    g_assert_nonnull(ui_last_rebuild_callbacks.finish_clicked);
    g_assert_nonnull(ui_last_rebuild_callbacks.close_clicked);
}

static void test_operational_ready_refresh_completes_and_closes(void) {
    reset_harness();
    onboarding_test_set_ui_hooks(&test_ui_hooks);

    onboarding_show();
    stub_progress.operational_ready = TRUE;

    onboarding_refresh();

    g_assert_cmpint(ui_destroy_calls, ==, 1);
    g_assert_cmpint(stub_notify_completed_calls, ==, 1);
    g_assert_false(onboarding_is_visible());
}

int main(int argc, char **argv) {
    g_test_init(&argc, &argv, NULL);
    g_log_set_always_fatal(G_LOG_LEVEL_ERROR | G_LOG_LEVEL_CRITICAL);

    g_test_add_func("/onboarding_controller/show_builds_once_and_reuses_existing_window",
                    test_show_builds_once_and_reuses_existing_window);
    g_test_add_func("/onboarding_controller/close_and_finish_callbacks_destroy_controller_window",
                    test_close_and_finish_callbacks_destroy_controller_window);
    g_test_add_func("/onboarding_controller/route_stable_refresh_updates_live_content",
                    test_route_stable_refresh_updates_live_content);
    g_test_add_func("/onboarding_controller/route_change_rebuilds_pages",
                    test_route_change_rebuilds_pages);
    g_test_add_func("/onboarding_controller/operational_ready_refresh_completes_and_closes",
                    test_operational_ready_refresh_completes_and_closes);

    int rc = g_test_run();
    reset_harness();
    return rc;
}
