/*
 * onboarding.c
 *
 * Controller/lifecycle layer for the OpenClaw Linux companion onboarding flow.
 *
 * Owns onboarding window lifetime, route selection, refresh snapshot
 * computation, rebuild-vs-live-refresh decisions, and completion handoff
 * to product policy. Page/widget construction and live rendering live in
 * `onboarding_view.c`.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include <gtk/gtk.h>
#include <adwaita.h>

#include "onboarding.h"
#include "onboarding_test.h"
#include "onboarding_view.h"
#include "display_model.h"
#include "gateway_config.h"
#include "gateway_client.h"
#include "product_coordinator.h"
#include "product_state.h"
#include "state.h"
#include "readiness.h"
#include "runtime_paths.h"
#include "test_seams.h"

/* ── Version marker persistence ── */

int onboarding_get_seen_version(void) {
    return (int)product_state_get_onboarding_seen_version();
}

void onboarding_reset(void) {
    (void)product_state_reset_onboarding_seen_version();
}

/* ── Onboarding window ── */

static gpointer onboard_window = NULL;
static gpointer onboard_carousel = NULL;
static gpointer onboard_indicator = NULL;
static OnboardingRoute onboard_current_route = ONBOARDING_SHOW_SHORTENED;

typedef struct {
    AppState state;
    OnboardingRoute route;
    OnboardingStageState stage_configuration;
    OnboardingStageState stage_service_gateway;
    OnboardingStageState stage_connection;
    gboolean operational_ready;
    gboolean config_valid;
    gboolean setup_detected;
    gboolean sys_installed;
    gboolean sys_active;
    gboolean config_file_exists;
    gboolean state_dir_exists;
    gchar *next_action;
} OnboardingRenderSnapshot;

static gboolean onboard_has_render_snapshot = FALSE;
static OnboardingRenderSnapshot onboard_last_snapshot = {0};

static void onboarding_snapshot_to_input(const OnboardingRenderSnapshot *snap,
                                         OnboardingRefreshSnapshotInput *out) {
    if (!snap || !out) return;
    out->state = (gint)snap->state;
    out->route = (gint)snap->route;
    out->stage_configuration = (gint)snap->stage_configuration;
    out->stage_service_gateway = (gint)snap->stage_service_gateway;
    out->stage_connection = (gint)snap->stage_connection;
    out->operational_ready = snap->operational_ready;
    out->config_valid = snap->config_valid;
    out->setup_detected = snap->setup_detected;
    out->sys_installed = snap->sys_installed;
    out->sys_active = snap->sys_active;
    out->config_file_exists = snap->config_file_exists;
    out->state_dir_exists = snap->state_dir_exists;
    out->next_action = snap->next_action;
}

static void snapshot_free(OnboardingRenderSnapshot *snap) {
    g_free(snap->next_action);
    snap->next_action = NULL;
}

static gpointer onboarding_default_get_default_application(void);
static gpointer onboarding_default_build_and_present_window(gpointer app,
                                                            OnboardingRoute route,
                                                            const OnboardingViewCallbacks *callbacks,
                                                            GCallback destroy_callback,
                                                            gpointer destroy_user_data,
                                                            gpointer *out_carousel,
                                                            gpointer *out_indicator);
static void onboarding_default_present_window(gpointer window);
static void onboarding_default_destroy_window(gpointer window);
static void onboarding_default_rebuild_pages(gpointer carousel,
                                             OnboardingRoute route,
                                             const OnboardingViewCallbacks *callbacks);
static void onboarding_default_refresh_live_content(void);
static void onboarding_default_reset_view(void);

static const OnboardingTestUiHooks onboarding_default_ui_hooks = {
    .get_default_application = onboarding_default_get_default_application,
    .build_and_present_window = onboarding_default_build_and_present_window,
    .present_window = onboarding_default_present_window,
    .destroy_window = onboarding_default_destroy_window,
    .rebuild_pages = onboarding_default_rebuild_pages,
    .refresh_live_content = onboarding_default_refresh_live_content,
    .reset_view = onboarding_default_reset_view,
};

static OnboardingTestUiHooks onboarding_ui_hooks = {
    .get_default_application = onboarding_default_get_default_application,
    .build_and_present_window = onboarding_default_build_and_present_window,
    .present_window = onboarding_default_present_window,
    .destroy_window = onboarding_default_destroy_window,
    .rebuild_pages = onboarding_default_rebuild_pages,
    .refresh_live_content = onboarding_default_refresh_live_content,
    .reset_view = onboarding_default_reset_view,
};

static void onboarding_reset_ui_hooks(void) {
    onboarding_ui_hooks = onboarding_default_ui_hooks;
}

static void onboarding_controller_clear_state(void) {
    onboard_window = NULL;
    onboard_carousel = NULL;
    onboard_indicator = NULL;
    onboard_current_route = ONBOARDING_SHOW_SHORTENED;
    onboard_has_render_snapshot = FALSE;
    snapshot_free(&onboard_last_snapshot);
    if (onboarding_ui_hooks.reset_view) {
        onboarding_ui_hooks.reset_view();
    }
}

static void on_onboard_destroy(GtkWindow *window, gpointer user_data) {
    (void)window;
    (void)user_data;
    onboarding_controller_clear_state();
}

static void on_finish_clicked(GtkButton *btn, gpointer data) {
    (void)btn; (void)data;
    if (onboard_window) {
        onboarding_ui_hooks.destroy_window(onboard_window);
    }
    product_coordinator_notify_onboarding_completed();
}

static void on_open_dashboard_clicked(GtkButton *btn, gpointer data) {
    (void)btn; (void)data;
    GatewayConfig *cfg = gateway_client_get_config();
    if (cfg) {
        g_autofree gchar *url = gateway_config_dashboard_url(cfg);
        if (url) {
            g_app_info_launch_default_for_uri(url, NULL, NULL);
        }
    }
}

static void on_close_clicked(GtkButton *btn, gpointer data) {
    (void)btn; (void)data;
    if (onboard_window) {
        onboarding_ui_hooks.destroy_window(onboard_window);
    }
}

static OnboardingViewCallbacks onboarding_make_view_callbacks(void) {
    OnboardingViewCallbacks callbacks = {
        .finish_clicked = on_finish_clicked,
        .open_dashboard_clicked = on_open_dashboard_clicked,
        .close_clicked = on_close_clicked,
    };
    return callbacks;
}

static void onboarding_refresh_live_content(void) {
    if (onboarding_ui_hooks.refresh_live_content) {
        onboarding_ui_hooks.refresh_live_content();
    }
}

static void onboarding_rebuild_pages(OnboardingRoute route) {
    if (!onboard_carousel) return;

    OnboardingViewCallbacks callbacks = onboarding_make_view_callbacks();
    if (onboarding_ui_hooks.rebuild_pages) {
        onboarding_ui_hooks.rebuild_pages(onboard_carousel, route, &callbacks);
    }
    onboard_current_route = route;
}

static gpointer onboarding_default_get_default_application(void) {
    return g_application_get_default();
}

static gpointer onboarding_default_build_and_present_window(gpointer app,
                                                            OnboardingRoute route,
                                                            const OnboardingViewCallbacks *callbacks,
                                                            GCallback destroy_callback,
                                                            gpointer destroy_user_data,
                                                            gpointer *out_carousel,
                                                            gpointer *out_indicator) {
    GtkWidget *window = adw_window_new();
    gtk_window_set_application(GTK_WINDOW(window), GTK_APPLICATION(app));
    gtk_window_set_title(GTK_WINDOW(window), "OpenClaw Setup");
    gtk_window_set_default_size(GTK_WINDOW(window), 560, 480);
    gtk_window_set_modal(GTK_WINDOW(window), TRUE);

    GtkWidget *carousel = adw_carousel_new();
    adw_carousel_set_allow_long_swipes(ADW_CAROUSEL(carousel), TRUE);
    onboarding_view_build_pages(carousel, route, callbacks);

    GtkWidget *indicator = adw_carousel_indicator_dots_new();
    adw_carousel_indicator_dots_set_carousel(ADW_CAROUSEL_INDICATOR_DOTS(indicator),
                                             ADW_CAROUSEL(carousel));

    GtkWidget *vbox = gtk_box_new(GTK_ORIENTATION_VERTICAL, 0);
    gtk_widget_set_vexpand(carousel, TRUE);
    gtk_box_append(GTK_BOX(vbox), carousel);
    gtk_widget_set_margin_bottom(indicator, 12);
    gtk_widget_set_halign(indicator, GTK_ALIGN_CENTER);
    gtk_box_append(GTK_BOX(vbox), indicator);

    adw_window_set_content(ADW_WINDOW(window), vbox);
    g_signal_connect(window, "destroy", destroy_callback, destroy_user_data);
    gtk_window_present(GTK_WINDOW(window));

    if (out_carousel) {
        *out_carousel = carousel;
    }
    if (out_indicator) {
        *out_indicator = indicator;
    }
    return window;
}

static void onboarding_default_present_window(gpointer window) {
    if (window) {
        gtk_window_present(GTK_WINDOW(window));
    }
}

static void onboarding_default_destroy_window(gpointer window) {
    if (window) {
        gtk_window_destroy(GTK_WINDOW(window));
    }
}

static void onboarding_default_rebuild_pages(gpointer carousel,
                                             OnboardingRoute route,
                                             const OnboardingViewCallbacks *callbacks) {
    onboarding_view_rebuild_pages(GTK_WIDGET(carousel), route, callbacks);
}

static void onboarding_default_refresh_live_content(void) {
    onboarding_view_refresh_live_content();
}

static void onboarding_default_reset_view(void) {
    onboarding_view_reset();
}

void onboarding_test_set_ui_hooks(const OnboardingTestUiHooks *hooks) {
    onboarding_ui_hooks = hooks ? *hooks : onboarding_default_ui_hooks;
}

void onboarding_test_reset(void) {
    if (onboard_window && onboarding_ui_hooks.destroy_window) {
        onboarding_ui_hooks.destroy_window(onboard_window);
    }
    onboarding_reset_ui_hooks();
    onboarding_controller_clear_state();
}

/* ── Flow construction ── */

void onboarding_show(void) {
    if (onboard_window) {
        if (onboarding_ui_hooks.present_window) {
            onboarding_ui_hooks.present_window(onboard_window);
        }
        return;
    }

    gpointer app = onboarding_ui_hooks.get_default_application
        ? onboarding_ui_hooks.get_default_application()
        : NULL;
    if (!app) return;

    AppState current = state_get_current();
    OnboardingRoute route = onboarding_routing_decide(
        current, onboarding_get_seen_version(), ONBOARDING_CURRENT_VERSION);

    OnboardingViewCallbacks callbacks = onboarding_make_view_callbacks();
    onboard_window = onboarding_ui_hooks.build_and_present_window
        ? onboarding_ui_hooks.build_and_present_window(app,
                                                       route,
                                                       &callbacks,
                                                       G_CALLBACK(on_onboard_destroy),
                                                       NULL,
                                                       &onboard_carousel,
                                                       &onboard_indicator)
        : NULL;
    if (onboard_window) {
        onboard_current_route = route;
    }
}

void onboarding_check_and_show(void) {
    product_coordinator_reconcile_startup_presentation();
}

gboolean onboarding_is_visible(void) {
    return onboard_window != NULL;
}

void onboarding_refresh(void) {
    if (!onboard_window || !onboard_carousel) {
        return;
    }

    AppState current = state_get_current();
    OnboardingRoute route = onboarding_routing_decide(
        current, onboarding_get_seen_version(), ONBOARDING_CURRENT_VERSION);

    SystemdState *sys = state_get_systemd();
    HealthState *health = state_get_health();

    gchar *profile = NULL;
    gchar *state_dir = NULL;
    gchar *config_path = NULL;
    systemd_get_runtime_context(&profile, &state_dir, &config_path);

    GatewayConfig *cfg = gateway_client_get_config();
    RuntimeEffectivePaths effective_paths = {0};
    runtime_effective_paths_resolve(cfg, profile, state_dir, config_path, &effective_paths);

    gboolean config_file_exists = effective_paths.effective_config_path &&
                                  g_file_test(effective_paths.effective_config_path, G_FILE_TEST_EXISTS);
    gboolean state_dir_exists = effective_paths.effective_state_dir &&
                                g_file_test(effective_paths.effective_state_dir, G_FILE_TEST_IS_DIR);

    ReadinessInfo ri;
    readiness_evaluate(current, health, sys, &ri);

    OnboardingStageProgress progress;
    readiness_build_onboarding_progress(current, health, sys, &progress);

    if (progress.operational_ready) {
        if (onboard_window) {
            onboarding_ui_hooks.destroy_window(onboard_window);
        }
        product_coordinator_notify_onboarding_completed();
        g_free(profile);
        g_free(state_dir);
        g_free(config_path);
        return;
    }

    OnboardingRenderSnapshot new_snap = {
        .state = current,
        .route = route,
        .stage_configuration = progress.configuration,
        .stage_service_gateway = progress.service_gateway,
        .stage_connection = progress.connection,
        .operational_ready = progress.operational_ready,
        .config_valid = health->config_valid,
        .setup_detected = health->setup_detected,
        .sys_installed = sys->installed,
        .sys_active = sys->active,
        .config_file_exists = config_file_exists,
        .state_dir_exists = state_dir_exists,
        .next_action = g_strdup(ri.next_action)
    };

    g_free(profile);
    g_free(state_dir);
    g_free(config_path);
    runtime_effective_paths_clear(&effective_paths);

    gboolean snapshots_equal = FALSE;
    if (onboard_has_render_snapshot) {
        OnboardingRefreshSnapshotInput prev_input = {0};
        OnboardingRefreshSnapshotInput next_input = {0};
        onboarding_snapshot_to_input(&onboard_last_snapshot, &prev_input);
        onboarding_snapshot_to_input(&new_snap, &next_input);
        snapshots_equal = onboarding_refresh_snapshot_equal(&prev_input, &next_input);
    }

    if (snapshots_equal) {
        snapshot_free(&new_snap);
        return; /* No material change, skip rebuild */
    }

    OnboardingRefreshAction action = onboarding_refresh_action_decide(
        snapshots_equal,
        new_snap.route != onboard_current_route);

    if (action == ONBOARDING_REFRESH_ACTION_REBUILD_PAGES) {
        onboarding_rebuild_pages(new_snap.route);
    } else if (action == ONBOARDING_REFRESH_ACTION_REFRESH_LIVE) {
        onboarding_refresh_live_content();
    }

    snapshot_free(&onboard_last_snapshot);
    onboard_last_snapshot = new_snap;
    onboard_has_render_snapshot = TRUE;
    return;
}
