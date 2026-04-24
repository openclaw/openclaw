/*
 * section_general.c
 *
 * General section controller for the OpenClaw Linux Companion App.
 *
 * Owns the main-window general status page, connection mode controls, and
 * service/runtime summary rendering for the local companion workflow.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "section_general.h"

#include <adwaita.h>

#include "display_model.h"
#include "gateway_client.h"
#include "gateway_config.h"
#include "product_coordinator.h"
#include "product_state.h"
#include "readiness.h"
#include "runtime_paths.h"
#include "runtime_reveal.h"
#include "section_adw_helpers.h"
#include "state.h"
#include "ui_model_utils.h"

extern void systemd_start_gateway(void);
extern void systemd_stop_gateway(void);
extern void systemd_restart_gateway(void);

static GtkWidget *gen_status_label = NULL;
static GtkWidget *gen_runtime_label = NULL;
static GtkWidget *gen_service_notice_row = NULL;
static GtkWidget *gen_connection_mode_dropdown = NULL;
static GtkStringList *gen_connection_mode_dropdown_model = NULL;
static GtkWidget *gen_connection_mode_detail_row = NULL;
static gboolean gen_connection_mode_programmatic_change = FALSE;
static GtkWidget *gen_endpoint_label = NULL;
static GtkWidget *gen_version_label = NULL;
static GtkWidget *gen_auth_mode_label = NULL;
static GtkWidget *gen_auth_source_label = NULL;
static GtkWidget *gen_unit_label = NULL;
static GtkWidget *gen_active_state_label = NULL;
static GtkWidget *gen_sub_state_label = NULL;
static GtkWidget *gen_config_path_label = NULL;
static GtkWidget *gen_state_dir_label = NULL;
static GtkWidget *gen_profile_label = NULL;
static GtkWidget *gen_btn_start = NULL;
static GtkWidget *gen_btn_stop = NULL;
static GtkWidget *gen_btn_restart = NULL;
static GtkWidget *gen_btn_open_dashboard = NULL;

static void on_gen_start(GtkButton *button, gpointer user_data) {
    (void)button;
    (void)user_data;
    systemd_start_gateway();
}

static void on_gen_stop(GtkButton *button, gpointer user_data) {
    (void)button;
    (void)user_data;
    systemd_stop_gateway();
}

static void on_gen_restart(GtkButton *button, gpointer user_data) {
    (void)button;
    (void)user_data;
    systemd_restart_gateway();
}

static void on_gen_open_dashboard(GtkButton *button, gpointer user_data) {
    (void)button;
    (void)user_data;

    GatewayConfig *cfg = gateway_client_get_config();
    if (!cfg) {
        return;
    }

    g_autofree gchar *url = gateway_config_dashboard_url(cfg);
    if (url) {
        g_app_info_launch_default_for_uri(url, NULL, NULL);
    }
}

static void on_gen_rerun_onboarding(GtkButton *button, gpointer user_data) {
    (void)button;
    (void)user_data;
    product_coordinator_request_rerun_onboarding();
}

static void on_gen_quit(GtkButton *button, gpointer user_data) {
    (void)button;
    (void)user_data;

    GApplication *app = g_application_get_default();
    if (app) {
        g_application_quit(app);
    }
}

static guint gen_connection_mode_selection_for_mode(ProductConnectionMode mode) {
    return mode == PRODUCT_CONNECTION_MODE_REMOTE ? 1u : 0u;
}

static ProductConnectionMode gen_connection_mode_for_selection(guint selected) {
    return selected == 1u ? PRODUCT_CONNECTION_MODE_REMOTE : PRODUCT_CONNECTION_MODE_LOCAL;
}

static const gchar* gen_connection_mode_detail_text(ProductConnectionMode stored_mode,
                                                    ProductConnectionMode effective_mode) {
    if (effective_mode == PRODUCT_CONNECTION_MODE_REMOTE) {
        return "Remote mode is saved, but Linux remote connection flow is not implemented yet. Open General for guidance or switch back to Local to use onboarding on this machine.";
    }

    if (stored_mode == PRODUCT_CONNECTION_MODE_UNSPECIFIED) {
        return "Local is currently the effective default on Linux. Choose a mode here to save it explicitly.";
    }

    return "Use this Linux machine's local gateway and onboarding flow.";
}

static void refresh_general_connection_mode_controls(void) {
    ProductConnectionMode stored_mode = product_state_get_connection_mode();
    ProductConnectionMode effective_mode = product_state_get_effective_connection_mode();
    guint selected = gen_connection_mode_selection_for_mode(effective_mode);

    if (gen_connection_mode_dropdown && ADW_IS_COMBO_ROW(gen_connection_mode_dropdown)) {
        gen_connection_mode_programmatic_change = TRUE;
        adw_combo_row_set_selected(ADW_COMBO_ROW(gen_connection_mode_dropdown), selected);
        gen_connection_mode_programmatic_change = FALSE;
    }

    if (gen_connection_mode_detail_row && ADW_IS_ACTION_ROW(gen_connection_mode_detail_row)) {
        adw_action_row_set_subtitle(ADW_ACTION_ROW(gen_connection_mode_detail_row),
                                    gen_connection_mode_detail_text(stored_mode, effective_mode));
    }
}

static void on_gen_connection_mode_selected_notify(GObject *object,
                                                   GParamSpec *pspec,
                                                   gpointer user_data) {
    (void)pspec;
    (void)user_data;

    if (gen_connection_mode_programmatic_change || !ADW_IS_COMBO_ROW(object)) {
        return;
    }

    guint selected = adw_combo_row_get_selected(ADW_COMBO_ROW(object));
    if (selected == GTK_INVALID_LIST_POSITION) {
        refresh_general_connection_mode_controls();
        return;
    }

    if (!product_coordinator_request_set_connection_mode(gen_connection_mode_for_selection(selected))) {
        refresh_general_connection_mode_controls();
    }
}

static void general_resolve_effective_paths(RuntimeEffectivePaths *out) {
    if (!out) {
        return;
    }

    g_autofree gchar *profile = NULL;
    g_autofree gchar *state_dir = NULL;
    g_autofree gchar *config_path = NULL;
    systemd_get_runtime_context(&profile, &state_dir, &config_path);

    GatewayConfig *cfg = gateway_client_get_config();
    runtime_effective_paths_resolve(cfg, profile, state_dir, config_path, out);
}

static void on_gen_reveal_config(GtkButton *button, gpointer user_data) {
    (void)button;
    (void)user_data;

    g_autofree gchar *uri = runtime_reveal_build_config_dir_uri();
    if (uri) {
        g_app_info_launch_default_for_uri(uri, NULL, NULL);
    }
}

static void on_gen_reveal_state_dir(GtkButton *button, gpointer user_data) {
    (void)button;
    (void)user_data;

    g_autofree gchar *uri = runtime_reveal_build_state_dir_uri();
    if (uri) {
        g_app_info_launch_default_for_uri(uri, NULL, NULL);
    }
}

static GtkWidget* general_action_row(const char *title,
                                     const char *subtitle,
                                     GtkWidget *suffix) {
    GtkWidget *row = adw_action_row_new();
    adw_preferences_row_set_title(ADW_PREFERENCES_ROW(row), title);
    if (subtitle && subtitle[0] != '\0') {
        adw_action_row_set_subtitle(ADW_ACTION_ROW(row), subtitle);
    }
    if (suffix) {
        adw_action_row_add_suffix(ADW_ACTION_ROW(row), suffix);
    }
    return row;
}

static GtkWidget* general_note_row(const char *title) {
    GtkWidget *row = adw_action_row_new();
    adw_preferences_row_set_title(ADW_PREFERENCES_ROW(row), title);
    return row;
}

static GtkWidget* general_build(void) {
    GtkWidget *scrolled = gtk_scrolled_window_new();
    gtk_scrolled_window_set_policy(GTK_SCROLLED_WINDOW(scrolled),
                                   GTK_POLICY_NEVER, GTK_POLICY_AUTOMATIC);

    GtkWidget *page = adw_preferences_page_new();
    gtk_widget_set_margin_start(page, 24);
    gtk_widget_set_margin_end(page, 24);
    gtk_widget_set_margin_top(page, 24);
    gtk_widget_set_margin_bottom(page, 24);

    GtkWidget *status_group = adw_preferences_group_new();
    adw_preferences_group_set_title(ADW_PREFERENCES_GROUP(status_group), "Status");
    adw_preferences_page_add(ADW_PREFERENCES_PAGE(page), ADW_PREFERENCES_GROUP(status_group));

    GtkWidget *status_row = section_adw_info_row("Status", &gen_status_label);
    gtk_widget_add_css_class(gen_status_label, "title-3");
    adw_preferences_group_add(ADW_PREFERENCES_GROUP(status_group), status_row);

    GtkWidget *runtime_row = section_adw_info_row("Runtime", &gen_runtime_label);
    gtk_widget_add_css_class(gen_runtime_label, "dim-label");
    adw_preferences_group_add(ADW_PREFERENCES_GROUP(status_group), runtime_row);

    gen_service_notice_row = general_note_row("Service Notice");
    gtk_widget_set_visible(gen_service_notice_row, FALSE);
    adw_preferences_group_add(ADW_PREFERENCES_GROUP(status_group), gen_service_notice_row);

    GtkWidget *connection_group = adw_preferences_group_new();
    adw_preferences_group_set_title(ADW_PREFERENCES_GROUP(connection_group), "Connection");
    adw_preferences_page_add(ADW_PREFERENCES_PAGE(page), ADW_PREFERENCES_GROUP(connection_group));

    gen_connection_mode_dropdown = adw_combo_row_new();
    adw_preferences_row_set_title(ADW_PREFERENCES_ROW(gen_connection_mode_dropdown), "Connection Mode");
    adw_preferences_group_add(ADW_PREFERENCES_GROUP(connection_group), gen_connection_mode_dropdown);

    GtkStringList *connection_mode_model = gtk_string_list_new(NULL);
    gtk_string_list_append(connection_mode_model, "Local (this machine)");
    gtk_string_list_append(connection_mode_model, "Remote (coming soon)");
    ui_combo_row_replace_model(gen_connection_mode_dropdown,
                               (gpointer *)&gen_connection_mode_dropdown_model,
                               G_LIST_MODEL(connection_mode_model),
                               0);
    g_signal_connect(gen_connection_mode_dropdown,
                     "notify::selected",
                     G_CALLBACK(on_gen_connection_mode_selected_notify),
                     NULL);

    gen_connection_mode_detail_row = general_note_row("Availability");
    adw_preferences_group_add(ADW_PREFERENCES_GROUP(connection_group), gen_connection_mode_detail_row);
    refresh_general_connection_mode_controls();

    GtkWidget *gateway_group = adw_preferences_group_new();
    adw_preferences_group_set_title(ADW_PREFERENCES_GROUP(gateway_group), "Gateway");
    adw_preferences_page_add(ADW_PREFERENCES_PAGE(page), ADW_PREFERENCES_GROUP(gateway_group));

    gen_btn_open_dashboard = gtk_button_new_with_label("Open Dashboard");
    gtk_widget_add_css_class(gen_btn_open_dashboard, "suggested-action");
    g_signal_connect(gen_btn_open_dashboard, "clicked", G_CALLBACK(on_gen_open_dashboard), NULL);
    adw_preferences_group_add(ADW_PREFERENCES_GROUP(gateway_group), section_adw_info_row("Endpoint", &gen_endpoint_label));
    adw_preferences_group_add(ADW_PREFERENCES_GROUP(gateway_group), section_adw_info_row("Version", &gen_version_label));
    adw_preferences_group_add(ADW_PREFERENCES_GROUP(gateway_group), section_adw_info_row("Auth Mode", &gen_auth_mode_label));
    adw_preferences_group_add(ADW_PREFERENCES_GROUP(gateway_group), section_adw_info_row("Auth Source", &gen_auth_source_label));
    adw_preferences_group_add(ADW_PREFERENCES_GROUP(gateway_group),
                              general_action_row("Open Dashboard",
                                                 "Open the local gateway dashboard in your browser.",
                                                 gen_btn_open_dashboard));

    GtkWidget *service_group = adw_preferences_group_new();
    adw_preferences_group_set_title(ADW_PREFERENCES_GROUP(service_group), "Expected Service");
    adw_preferences_page_add(ADW_PREFERENCES_PAGE(page), ADW_PREFERENCES_GROUP(service_group));

    adw_preferences_group_add(ADW_PREFERENCES_GROUP(service_group), section_adw_info_row("Unit", &gen_unit_label));
    adw_preferences_group_add(ADW_PREFERENCES_GROUP(service_group), section_adw_info_row("Active State", &gen_active_state_label));
    adw_preferences_group_add(ADW_PREFERENCES_GROUP(service_group), section_adw_info_row("Sub State", &gen_sub_state_label));

    GtkWidget *svc_row = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);

    gen_btn_start = gtk_button_new_with_label("Start");
    g_signal_connect(gen_btn_start, "clicked", G_CALLBACK(on_gen_start), NULL);
    gtk_box_append(GTK_BOX(svc_row), gen_btn_start);

    gen_btn_stop = gtk_button_new_with_label("Stop");
    g_signal_connect(gen_btn_stop, "clicked", G_CALLBACK(on_gen_stop), NULL);
    gtk_box_append(GTK_BOX(svc_row), gen_btn_stop);

    gen_btn_restart = gtk_button_new_with_label("Restart");
    g_signal_connect(gen_btn_restart, "clicked", G_CALLBACK(on_gen_restart), NULL);
    gtk_box_append(GTK_BOX(svc_row), gen_btn_restart);

    adw_preferences_group_add(ADW_PREFERENCES_GROUP(service_group),
                              general_action_row("Service Controls",
                                                 "Manage the local gateway service expected on this machine.",
                                                 svc_row));

    GtkWidget *paths_group = adw_preferences_group_new();
    adw_preferences_group_set_title(ADW_PREFERENCES_GROUP(paths_group), "Paths");
    adw_preferences_page_add(ADW_PREFERENCES_PAGE(page), ADW_PREFERENCES_GROUP(paths_group));

    adw_preferences_group_add(ADW_PREFERENCES_GROUP(paths_group), section_adw_info_row("Config File", &gen_config_path_label));
    gtk_widget_add_css_class(gen_config_path_label, "monospace");

    GtkWidget *reveal_config_btn = gtk_button_new_with_label("Reveal Config Folder");
    g_signal_connect(reveal_config_btn, "clicked", G_CALLBACK(on_gen_reveal_config), NULL);
    adw_preferences_group_add(ADW_PREFERENCES_GROUP(paths_group),
                              general_action_row("Config Folder",
                                                 "Open the folder containing the effective config file.",
                                                 reveal_config_btn));

    adw_preferences_group_add(ADW_PREFERENCES_GROUP(paths_group), section_adw_info_row("State Dir", &gen_state_dir_label));
    gtk_widget_add_css_class(gen_state_dir_label, "monospace");

    GtkWidget *reveal_state_btn = gtk_button_new_with_label("Reveal State Folder");
    g_signal_connect(reveal_state_btn, "clicked", G_CALLBACK(on_gen_reveal_state_dir), NULL);
    adw_preferences_group_add(ADW_PREFERENCES_GROUP(paths_group),
                              general_action_row("State Folder",
                                                 "Open the local state directory used by the companion.",
                                                 reveal_state_btn));

    adw_preferences_group_add(ADW_PREFERENCES_GROUP(paths_group), section_adw_info_row("Profile", &gen_profile_label));

    GtkWidget *companion_group = adw_preferences_group_new();
    adw_preferences_group_set_title(ADW_PREFERENCES_GROUP(companion_group), "Companion");
    adw_preferences_page_add(ADW_PREFERENCES_PAGE(page), ADW_PREFERENCES_GROUP(companion_group));

    GtkWidget *onboard_btn = gtk_button_new_with_label("Re-run Onboarding");
    g_signal_connect(onboard_btn, "clicked", G_CALLBACK(on_gen_rerun_onboarding), NULL);
    adw_preferences_group_add(ADW_PREFERENCES_GROUP(companion_group),
                              general_action_row("Onboarding",
                                                 "Run the local onboarding flow again for this machine.",
                                                 onboard_btn));

    GtkWidget *quit_btn = gtk_button_new_with_label("Quit OpenClaw Companion");
    gtk_widget_add_css_class(quit_btn, "destructive-action");
    g_signal_connect(quit_btn, "clicked", G_CALLBACK(on_gen_quit), NULL);
    adw_preferences_group_add(ADW_PREFERENCES_GROUP(companion_group),
                              general_action_row("Quit",
                                                 "Close the Linux companion app.",
                                                 quit_btn));

    gtk_scrolled_window_set_child(GTK_SCROLLED_WINDOW(scrolled), page);
    return scrolled;
}

static void general_refresh(void) {
    if (!gen_status_label) {
        return;
    }

    AppState current = state_get_current();
    RuntimeMode rm = state_get_runtime_mode();
    HealthState *health = state_get_health();
    SystemdState *sys = state_get_systemd();

    ReadinessInfo ri;
    readiness_evaluate(current, health, sys, &ri);

    DashboardDisplayModel dm;
    dashboard_display_model_build(current, rm, &ri, health, sys, &dm);

    gtk_label_set_text(GTK_LABEL(gen_status_label), dm.headline ? dm.headline : "—");
    gtk_label_set_text(GTK_LABEL(gen_runtime_label), dm.runtime_label ? dm.runtime_label : "—");

    if (dm.service_context_notice && gen_service_notice_row && ADW_IS_ACTION_ROW(gen_service_notice_row)) {
        adw_action_row_set_subtitle(ADW_ACTION_ROW(gen_service_notice_row), dm.service_context_notice);
        gtk_widget_set_visible(gen_service_notice_row, TRUE);
    } else {
        gtk_widget_set_visible(gen_service_notice_row, FALSE);
    }

    GatewayConfig *cfg = gateway_client_get_config();
    if (cfg) {
        g_autofree gchar *endpoint = g_strdup_printf("%s:%d", cfg->host ? cfg->host : "127.0.0.1", cfg->port);
        gtk_label_set_text(GTK_LABEL(gen_endpoint_label), endpoint);
    } else {
        gtk_label_set_text(GTK_LABEL(gen_endpoint_label), "—");
    }
    gtk_label_set_text(GTK_LABEL(gen_version_label), dm.gateway_version ? dm.gateway_version : "—");
    gtk_label_set_text(GTK_LABEL(gen_auth_mode_label), (cfg && cfg->auth_mode) ? cfg->auth_mode : "—");
    gtk_label_set_text(GTK_LABEL(gen_auth_source_label), dm.auth_source ? dm.auth_source : "—");
    gtk_label_set_text(GTK_LABEL(gen_unit_label), dm.unit_name ? dm.unit_name : "—");
    gtk_label_set_text(GTK_LABEL(gen_active_state_label), dm.active_state ? dm.active_state : "—");
    gtk_label_set_text(GTK_LABEL(gen_sub_state_label), dm.sub_state ? dm.sub_state : "—");

    g_autofree gchar *profile = NULL;
    systemd_get_runtime_context(&profile, NULL, NULL);

    RuntimeEffectivePaths effective_paths = {0};
    general_resolve_effective_paths(&effective_paths);

    RuntimePathStatus general_paths = {0};
    runtime_path_status_build(effective_paths.effective_config_path,
                              effective_paths.effective_state_dir,
                              NULL,
                              &general_paths);

    g_autofree gchar *profile_display = NULL;
    if (profile && profile[0] != '\0') {
        if (g_utf8_validate(profile, -1, NULL)) {
            profile_display = g_strdup(profile);
        } else {
            profile_display = g_utf8_make_valid(profile, -1);
        }
    } else {
        profile_display = g_strdup("default");
    }

    gtk_label_set_text(GTK_LABEL(gen_config_path_label),
                       general_paths.config_path_resolved ? general_paths.config_path : "—");
    gtk_label_set_text(GTK_LABEL(gen_state_dir_label),
                       general_paths.state_dir_resolved ? general_paths.state_dir : "—");
    gtk_label_set_text(GTK_LABEL(gen_profile_label), profile_display);

    runtime_path_status_clear(&general_paths);
    runtime_effective_paths_clear(&effective_paths);

    refresh_general_connection_mode_controls();

    gtk_widget_set_sensitive(gen_btn_start, dm.can_start);
    gtk_widget_set_sensitive(gen_btn_stop, dm.can_stop);
    gtk_widget_set_sensitive(gen_btn_restart, dm.can_restart);
    gtk_widget_set_sensitive(gen_btn_open_dashboard, dm.can_open_dashboard);
}

static void general_destroy(void) {
    gen_status_label = NULL;
    gen_runtime_label = NULL;
    gen_service_notice_row = NULL;
    ui_combo_row_detach_model(gen_connection_mode_dropdown, (gpointer *)&gen_connection_mode_dropdown_model);
    gen_connection_mode_dropdown = NULL;
    gen_connection_mode_dropdown_model = NULL;
    gen_connection_mode_detail_row = NULL;
    gen_connection_mode_programmatic_change = FALSE;
    gen_endpoint_label = NULL;
    gen_version_label = NULL;
    gen_auth_mode_label = NULL;
    gen_auth_source_label = NULL;
    gen_unit_label = NULL;
    gen_active_state_label = NULL;
    gen_sub_state_label = NULL;
    gen_config_path_label = NULL;
    gen_state_dir_label = NULL;
    gen_profile_label = NULL;
    gen_btn_start = NULL;
    gen_btn_stop = NULL;
    gen_btn_restart = NULL;
    gen_btn_open_dashboard = NULL;
}

static void general_invalidate(void) {
}

static const SectionController general_controller = {
    .build = general_build,
    .refresh = general_refresh,
    .destroy = general_destroy,
    .invalidate = general_invalidate,
};

const SectionController* section_general_get(void) {
    return &general_controller;
}
