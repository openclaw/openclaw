/*
 * section_dashboard.c
 *
 * Dashboard section controller for the OpenClaw Linux Companion App.
 *
 * Owns the main-window dashboard page widgets and refresh logic for the
 * gateway/service summary, guidance text, and local service actions.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "section_dashboard.h"

#include <adwaita.h>

#include "display_model.h"
#include "gateway_client.h"
#include "gateway_config.h"
#include "readiness.h"
#include "state.h"

extern void systemd_start_gateway(void);
extern void systemd_stop_gateway(void);
extern void systemd_restart_gateway(void);
extern void systemd_refresh(void);

static GtkWidget *dash_headline_label = NULL;
static GtkWidget *dash_runtime_label = NULL;
static GtkWidget *dash_runtime_detail = NULL;
static GtkWidget *dash_guidance_label = NULL;
static GtkWidget *dash_next_action_label = NULL;
static GtkWidget *dash_service_notice_label = NULL;
static GtkWidget *dash_btn_start = NULL;
static GtkWidget *dash_btn_stop = NULL;
static GtkWidget *dash_btn_restart = NULL;
static GtkWidget *dash_btn_open_dashboard = NULL;
static GtkWidget *dash_endpoint_label = NULL;
static GtkWidget *dash_version_label = NULL;
static GtkWidget *dash_http_label = NULL;
static GtkWidget *dash_ws_label = NULL;
static GtkWidget *dash_rpc_label = NULL;
static GtkWidget *dash_auth_label = NULL;
static GtkWidget *dash_auth_source_label = NULL;
static GtkWidget *dash_unit_label = NULL;
static GtkWidget *dash_active_state_label = NULL;
static GtkWidget *dash_sub_state_label = NULL;

static void on_dash_start(GtkButton *button, gpointer user_data) {
    (void)button;
    (void)user_data;
    systemd_start_gateway();
}

static void on_dash_stop(GtkButton *button, gpointer user_data) {
    (void)button;
    (void)user_data;
    systemd_stop_gateway();
}

static void on_dash_restart(GtkButton *button, gpointer user_data) {
    (void)button;
    (void)user_data;
    systemd_restart_gateway();
}

static void on_dash_refresh(GtkButton *button, gpointer user_data) {
    (void)button;
    (void)user_data;
    systemd_refresh();
    gateway_client_refresh();
}

static void on_dash_open_dashboard(GtkButton *button, gpointer user_data) {
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

static GtkWidget* dashboard_detail_row(const char *heading, GtkWidget **out_value) {
    return section_info_row(heading, 130, out_value);
}

static GtkWidget* dashboard_build(void) {
    GtkWidget *scrolled = gtk_scrolled_window_new();
    gtk_scrolled_window_set_policy(GTK_SCROLLED_WINDOW(scrolled),
                                   GTK_POLICY_NEVER, GTK_POLICY_AUTOMATIC);

    GtkWidget *page = gtk_box_new(GTK_ORIENTATION_VERTICAL, 8);
    gtk_widget_set_margin_start(page, 24);
    gtk_widget_set_margin_end(page, 24);
    gtk_widget_set_margin_top(page, 24);
    gtk_widget_set_margin_bottom(page, 24);

    dash_headline_label = gtk_label_new("—");
    gtk_widget_add_css_class(dash_headline_label, "title-1");
    gtk_label_set_xalign(GTK_LABEL(dash_headline_label), 0.0);
    gtk_box_append(GTK_BOX(page), dash_headline_label);

    dash_runtime_label = gtk_label_new("—");
    gtk_widget_add_css_class(dash_runtime_label, "title-4");
    gtk_label_set_xalign(GTK_LABEL(dash_runtime_label), 0.0);
    gtk_box_append(GTK_BOX(page), dash_runtime_label);

    dash_runtime_detail = gtk_label_new("");
    gtk_widget_add_css_class(dash_runtime_detail, "dim-label");
    gtk_label_set_xalign(GTK_LABEL(dash_runtime_detail), 0.0);
    gtk_label_set_wrap(GTK_LABEL(dash_runtime_detail), TRUE);
    gtk_box_append(GTK_BOX(page), dash_runtime_detail);

    dash_guidance_label = gtk_label_new("");
    gtk_label_set_xalign(GTK_LABEL(dash_guidance_label), 0.0);
    gtk_label_set_wrap(GTK_LABEL(dash_guidance_label), TRUE);
    gtk_box_append(GTK_BOX(page), dash_guidance_label);

    dash_next_action_label = gtk_label_new("");
    gtk_widget_add_css_class(dash_next_action_label, "accent");
    gtk_label_set_xalign(GTK_LABEL(dash_next_action_label), 0.0);
    gtk_label_set_wrap(GTK_LABEL(dash_next_action_label), TRUE);
    gtk_box_append(GTK_BOX(page), dash_next_action_label);

    dash_service_notice_label = gtk_label_new("");
    gtk_widget_add_css_class(dash_service_notice_label, "dim-label");
    gtk_label_set_xalign(GTK_LABEL(dash_service_notice_label), 0.0);
    gtk_label_set_wrap(GTK_LABEL(dash_service_notice_label), TRUE);
    gtk_widget_set_visible(dash_service_notice_label, FALSE);
    gtk_box_append(GTK_BOX(page), dash_service_notice_label);

    GtkWidget *sep1 = gtk_separator_new(GTK_ORIENTATION_HORIZONTAL);
    gtk_widget_set_margin_top(sep1, 8);
    gtk_widget_set_margin_bottom(sep1, 4);
    gtk_box_append(GTK_BOX(page), sep1);

    GtkWidget *product_actions = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
    gtk_widget_set_margin_top(product_actions, 4);

    dash_btn_open_dashboard = gtk_button_new_with_label("Open Dashboard");
    gtk_widget_add_css_class(dash_btn_open_dashboard, "suggested-action");
    g_signal_connect(dash_btn_open_dashboard, "clicked", G_CALLBACK(on_dash_open_dashboard), NULL);
    gtk_box_append(GTK_BOX(product_actions), dash_btn_open_dashboard);

    GtkWidget *refresh_btn = gtk_button_new_with_label("Refresh");
    g_signal_connect(refresh_btn, "clicked", G_CALLBACK(on_dash_refresh), NULL);
    gtk_box_append(GTK_BOX(product_actions), refresh_btn);

    gtk_box_append(GTK_BOX(page), product_actions);

    GtkWidget *svc_label = gtk_label_new("Expected Service");
    gtk_widget_add_css_class(svc_label, "heading");
    gtk_label_set_xalign(GTK_LABEL(svc_label), 0.0);
    gtk_widget_set_margin_top(svc_label, 12);
    gtk_box_append(GTK_BOX(page), svc_label);

    GtkWidget *service_actions = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
    gtk_widget_set_margin_top(service_actions, 4);

    dash_btn_start = gtk_button_new_with_label("Start");
    g_signal_connect(dash_btn_start, "clicked", G_CALLBACK(on_dash_start), NULL);
    gtk_box_append(GTK_BOX(service_actions), dash_btn_start);

    dash_btn_stop = gtk_button_new_with_label("Stop");
    g_signal_connect(dash_btn_stop, "clicked", G_CALLBACK(on_dash_stop), NULL);
    gtk_box_append(GTK_BOX(service_actions), dash_btn_stop);

    dash_btn_restart = gtk_button_new_with_label("Restart");
    g_signal_connect(dash_btn_restart, "clicked", G_CALLBACK(on_dash_restart), NULL);
    gtk_box_append(GTK_BOX(service_actions), dash_btn_restart);

    gtk_box_append(GTK_BOX(page), service_actions);

    GtkWidget *sep2 = gtk_separator_new(GTK_ORIENTATION_HORIZONTAL);
    gtk_widget_set_margin_top(sep2, 12);
    gtk_widget_set_margin_bottom(sep2, 4);
    gtk_box_append(GTK_BOX(page), sep2);

    GtkWidget *conn_label = gtk_label_new("Connectivity");
    gtk_widget_add_css_class(conn_label, "heading");
    gtk_label_set_xalign(GTK_LABEL(conn_label), 0.0);
    gtk_box_append(GTK_BOX(page), conn_label);

    gtk_box_append(GTK_BOX(page), dashboard_detail_row("Endpoint", &dash_endpoint_label));
    gtk_box_append(GTK_BOX(page), dashboard_detail_row("Gateway Version", &dash_version_label));
    gtk_box_append(GTK_BOX(page), dashboard_detail_row("HTTP Health", &dash_http_label));
    gtk_box_append(GTK_BOX(page), dashboard_detail_row("WebSocket", &dash_ws_label));
    gtk_box_append(GTK_BOX(page), dashboard_detail_row("RPC", &dash_rpc_label));
    gtk_box_append(GTK_BOX(page), dashboard_detail_row("Auth", &dash_auth_label));
    gtk_box_append(GTK_BOX(page), dashboard_detail_row("Auth Source", &dash_auth_source_label));

    GtkWidget *sep3 = gtk_separator_new(GTK_ORIENTATION_HORIZONTAL);
    gtk_widget_set_margin_top(sep3, 12);
    gtk_widget_set_margin_bottom(sep3, 4);
    gtk_box_append(GTK_BOX(page), sep3);

    GtkWidget *sys_label = gtk_label_new("Systemd Service");
    gtk_widget_add_css_class(sys_label, "heading");
    gtk_label_set_xalign(GTK_LABEL(sys_label), 0.0);
    gtk_box_append(GTK_BOX(page), sys_label);

    gtk_box_append(GTK_BOX(page), dashboard_detail_row("Unit", &dash_unit_label));
    gtk_box_append(GTK_BOX(page), dashboard_detail_row("Active State", &dash_active_state_label));
    gtk_box_append(GTK_BOX(page), dashboard_detail_row("Sub State", &dash_sub_state_label));

    gtk_scrolled_window_set_child(GTK_SCROLLED_WINDOW(scrolled), page);
    return scrolled;
}

static void dashboard_refresh(void) {
    if (!dash_headline_label) {
        return;
    }

    AppState current = state_get_current();
    RuntimeMode rm = state_get_runtime_mode();
    SystemdState *sys = state_get_systemd();
    HealthState *health = state_get_health();

    ReadinessInfo ri;
    readiness_evaluate(current, health, sys, &ri);

    DashboardDisplayModel dm;
    dashboard_display_model_build(current, rm, &ri, health, sys, &dm);

    gtk_label_set_text(GTK_LABEL(dash_headline_label), dm.headline ? dm.headline : "—");
    gtk_label_set_text(GTK_LABEL(dash_runtime_label), dm.runtime_label ? dm.runtime_label : "—");
    gtk_label_set_text(GTK_LABEL(dash_runtime_detail), dm.runtime_detail ? dm.runtime_detail : "");
    gtk_label_set_text(GTK_LABEL(dash_guidance_label), dm.guidance_text ? dm.guidance_text : "");
    gtk_widget_set_visible(dash_guidance_label, dm.guidance_text != NULL);
    gtk_label_set_text(GTK_LABEL(dash_next_action_label), dm.next_action ? dm.next_action : "");
    gtk_widget_set_visible(dash_next_action_label, dm.next_action != NULL);

    if (dm.service_context_notice) {
        gtk_label_set_text(GTK_LABEL(dash_service_notice_label), dm.service_context_notice);
        gtk_widget_set_visible(dash_service_notice_label, TRUE);
    } else {
        gtk_widget_set_visible(dash_service_notice_label, FALSE);
    }

    gtk_widget_set_sensitive(dash_btn_start, dm.can_start);
    gtk_widget_set_sensitive(dash_btn_stop, dm.can_stop);
    gtk_widget_set_sensitive(dash_btn_restart, dm.can_restart);
    gtk_widget_set_sensitive(dash_btn_open_dashboard, dm.can_open_dashboard);

    if (health && health->endpoint_host) {
        g_autofree gchar *endpoint = g_strdup_printf("%s:%d", health->endpoint_host, health->endpoint_port);
        gtk_label_set_text(GTK_LABEL(dash_endpoint_label), endpoint);
    } else {
        gtk_label_set_text(GTK_LABEL(dash_endpoint_label), "—");
    }

    gtk_label_set_text(GTK_LABEL(dash_version_label), dm.gateway_version ? dm.gateway_version : "—");
    gtk_label_set_text(GTK_LABEL(dash_http_label), dm.http_probe_label ? dm.http_probe_label : "—");
    gtk_label_set_text(GTK_LABEL(dash_ws_label), dm.ws_connected ? "Connected" : "Disconnected");
    gtk_label_set_text(GTK_LABEL(dash_rpc_label), dm.rpc_ok ? "OK" : "Not established");
    gtk_label_set_text(GTK_LABEL(dash_auth_label), dm.auth_ok ? "OK" : "Not established");
    gtk_label_set_text(GTK_LABEL(dash_auth_source_label), dm.auth_source ? dm.auth_source : "—");
    gtk_label_set_text(GTK_LABEL(dash_unit_label), dm.unit_name ? dm.unit_name : "—");
    gtk_label_set_text(GTK_LABEL(dash_active_state_label), dm.active_state ? dm.active_state : "—");
    gtk_label_set_text(GTK_LABEL(dash_sub_state_label), dm.sub_state ? dm.sub_state : "—");
}

static void dashboard_destroy(void) {
    dash_headline_label = NULL;
    dash_runtime_label = NULL;
    dash_runtime_detail = NULL;
    dash_guidance_label = NULL;
    dash_next_action_label = NULL;
    dash_service_notice_label = NULL;
    dash_btn_start = NULL;
    dash_btn_stop = NULL;
    dash_btn_restart = NULL;
    dash_btn_open_dashboard = NULL;
    dash_endpoint_label = NULL;
    dash_version_label = NULL;
    dash_http_label = NULL;
    dash_ws_label = NULL;
    dash_rpc_label = NULL;
    dash_auth_label = NULL;
    dash_auth_source_label = NULL;
    dash_unit_label = NULL;
    dash_active_state_label = NULL;
    dash_sub_state_label = NULL;
}

static void dashboard_invalidate(void) {
}

static const SectionController dashboard_controller = {
    .build = dashboard_build,
    .refresh = dashboard_refresh,
    .destroy = dashboard_destroy,
    .invalidate = dashboard_invalidate,
};

const SectionController* section_dashboard_get(void) {
    return &dashboard_controller;
}
