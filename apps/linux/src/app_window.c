/*
 * app_window.c
 *
 * Main companion window for the OpenClaw Linux Companion App.
 *
 * Implements the primary product surface using AdwNavigationSplitView
 * for a sidebar+content information architecture. Each section is a
 * distinct content page; the sidebar provides navigation.
 *
 * Tray-first behavior: the window is not auto-shown on every launch.
 * It opens automatically only for first-run/recovery (onboarding), or
 * when the user invokes "Open OpenClaw" from the tray menu.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include <gtk/gtk.h>
#include <adwaita.h>
#include "app_window.h"
#include "state.h"
#include "readiness.h"
#include "display_model.h"
#include "gateway_config.h"
#include "gateway_client.h"
#include "diagnostics.h"
#include "onboarding.h"
#include "log.h"

/* ── Section metadata ── */

typedef struct {
    const char *id;
    const char *title;
    const char *icon_name;
} SectionMeta;

static const SectionMeta section_meta[SECTION_COUNT] = {
    [SECTION_DASHBOARD]    = { "dashboard",    "Dashboard",    "computer-symbolic" },
    [SECTION_GENERAL]      = { "general",      "General",      "preferences-system-symbolic" },
    [SECTION_CONFIG]       = { "config",       "Config",       "document-properties-symbolic" },
    [SECTION_ENVIRONMENT]  = { "environment",  "Environment",  "system-run-symbolic" },
    [SECTION_DIAGNOSTICS]  = { "diagnostics",  "Diagnostics",  "utilities-system-monitor-symbolic" },
    [SECTION_ABOUT]        = { "about",        "About",        "help-about-symbolic" },
    [SECTION_INSTANCES]    = { "instances",    "Instances",    "network-server-symbolic" },
    [SECTION_DEBUG]        = { "debug",        "Debug",        "emblem-system-symbolic" },
    [SECTION_SESSIONS]     = { "sessions",     "Sessions",     "view-list-symbolic" },
    [SECTION_CRON]         = { "cron",         "Cron",         "alarm-symbolic" },
};

/* ── Window state ── */

static GtkWidget *main_window = NULL;
static GtkWidget *content_stack = NULL;
static GtkWidget *sidebar_list = NULL;
static guint refresh_timer_id = 0;

/* Section content widgets that need updating */
static GtkWidget *section_pages[SECTION_COUNT] = {0};

/* ── Forward declarations ── */

static GtkWidget* build_placeholder_section(AppSection section);
static GtkWidget* build_dashboard_section(void);
static GtkWidget* build_general_section(void);
static GtkWidget* build_config_section(void);
static GtkWidget* build_diagnostics_section(void);
static GtkWidget* build_environment_section(void);
static GtkWidget* build_about_section(void);
static GtkWidget* build_instances_section(void);
static GtkWidget* build_debug_section(void);
static GtkWidget* build_sessions_section(void);
static GtkWidget* build_cron_section(void);
static void refresh_dashboard_content(void);
static void refresh_general_content(void);
static void refresh_config_content(void);
static void refresh_diagnostics_content(void);
static void refresh_environment_content(void);
static void refresh_instances_content(void);
static void refresh_debug_content(void);
static void on_sidebar_row_activated(GtkListBox *box, GtkListBoxRow *row, gpointer user_data);
static void on_window_destroy(GtkWindow *window, gpointer user_data);

/* ── Sidebar construction ── */

static GtkWidget* build_sidebar_row(AppSection section) {
    const SectionMeta *meta = &section_meta[section];

    GtkWidget *box = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 10);
    gtk_widget_set_margin_start(box, 8);
    gtk_widget_set_margin_end(box, 8);
    gtk_widget_set_margin_top(box, 6);
    gtk_widget_set_margin_bottom(box, 6);

    GtkWidget *icon = gtk_image_new_from_icon_name(meta->icon_name);
    gtk_box_append(GTK_BOX(box), icon);

    GtkWidget *label = gtk_label_new(meta->title);
    gtk_label_set_xalign(GTK_LABEL(label), 0.0);
    gtk_widget_set_hexpand(label, TRUE);
    gtk_box_append(GTK_BOX(box), label);

    return box;
}

static GtkWidget* build_sidebar(void) {
    GtkWidget *scrolled = gtk_scrolled_window_new();
    gtk_scrolled_window_set_policy(GTK_SCROLLED_WINDOW(scrolled),
                                   GTK_POLICY_NEVER, GTK_POLICY_AUTOMATIC);
    gtk_widget_set_size_request(scrolled, 200, -1);

    sidebar_list = gtk_list_box_new();
    gtk_list_box_set_selection_mode(GTK_LIST_BOX(sidebar_list), GTK_SELECTION_SINGLE);
    gtk_widget_add_css_class(sidebar_list, "navigation-sidebar");

    for (int i = 0; i < SECTION_COUNT; i++) {
        GtkWidget *row_content = build_sidebar_row((AppSection)i);
        gtk_list_box_append(GTK_LIST_BOX(sidebar_list), row_content);
    }

    g_signal_connect(sidebar_list, "row-activated",
                     G_CALLBACK(on_sidebar_row_activated), NULL);

    gtk_scrolled_window_set_child(GTK_SCROLLED_WINDOW(scrolled), sidebar_list);
    return scrolled;
}

/* ── Content stack ── */

static GtkWidget* build_content_stack(void) {
    content_stack = gtk_stack_new();
    gtk_stack_set_transition_type(GTK_STACK(content_stack), GTK_STACK_TRANSITION_TYPE_CROSSFADE);
    gtk_stack_set_transition_duration(GTK_STACK(content_stack), 150);

    for (int i = 0; i < SECTION_COUNT; i++) {
        GtkWidget *page;
        if (i == SECTION_DASHBOARD) {
            page = build_dashboard_section();
        } else if (i == SECTION_GENERAL) {
            page = build_general_section();
        } else if (i == SECTION_CONFIG) {
            page = build_config_section();
        } else if (i == SECTION_DIAGNOSTICS) {
            page = build_diagnostics_section();
        } else if (i == SECTION_ENVIRONMENT) {
            page = build_environment_section();
        } else if (i == SECTION_ABOUT) {
            page = build_about_section();
        } else if (i == SECTION_INSTANCES) {
            page = build_instances_section();
        } else if (i == SECTION_DEBUG) {
            page = build_debug_section();
        } else if (i == SECTION_SESSIONS) {
            page = build_sessions_section();
        } else if (i == SECTION_CRON) {
            page = build_cron_section();
        } else {
            page = build_placeholder_section((AppSection)i);
        }
        section_pages[i] = page;
        gtk_stack_add_named(GTK_STACK(content_stack), page, section_meta[i].id);
    }

    return content_stack;
}

/* ── Sidebar row activation ── */

static void on_sidebar_row_activated(GtkListBox *box, GtkListBoxRow *row, gpointer user_data) {
    (void)box;
    (void)user_data;

    int idx = gtk_list_box_row_get_index(row);
    if (idx >= 0 && idx < SECTION_COUNT) {
        gtk_stack_set_visible_child_name(GTK_STACK(content_stack), section_meta[idx].id);
    }
}

/* ── Placeholder section (Tier B / deferred) ── */

static GtkWidget* build_placeholder_section(AppSection section) {
    const SectionMeta *meta = &section_meta[section];

    GtkWidget *page = gtk_box_new(GTK_ORIENTATION_VERTICAL, 12);
    gtk_widget_set_margin_start(page, 24);
    gtk_widget_set_margin_end(page, 24);
    gtk_widget_set_margin_top(page, 24);
    gtk_widget_set_margin_bottom(page, 24);

    GtkWidget *title = gtk_label_new(meta->title);
    gtk_widget_add_css_class(title, "title-1");
    gtk_label_set_xalign(GTK_LABEL(title), 0.0);
    gtk_box_append(GTK_BOX(page), title);

    GtkWidget *subtitle = gtk_label_new("This section will be available in a future update.");
    gtk_widget_add_css_class(subtitle, "dim-label");
    gtk_label_set_xalign(GTK_LABEL(subtitle), 0.0);
    gtk_box_append(GTK_BOX(page), subtitle);

    return page;
}

/* ══════════════════════════════════════════════════════════════════
 * Dashboard section (Tier A — must feel finished)
 *
 * Information hierarchy:
 *   1. Status headline + colored indicator
 *   2. Runtime mode row
 *   3. Readiness guidance block
 *   4. Action bar (product actions + expected-service actions)
 *   5. Connectivity detail group
 *   6. Systemd context group
 * ══════════════════════════════════════════════════════════════════ */

/* Dashboard widget refs for refresh */
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

/* Dashboard action callbacks */

extern void systemd_start_gateway(void);
extern void systemd_stop_gateway(void);
extern void systemd_restart_gateway(void);
extern void gateway_client_refresh(void);

static void on_dash_start(GtkButton *btn, gpointer data) {
    (void)btn; (void)data;
    systemd_start_gateway();
}

static void on_dash_stop(GtkButton *btn, gpointer data) {
    (void)btn; (void)data;
    systemd_stop_gateway();
}

static void on_dash_restart(GtkButton *btn, gpointer data) {
    (void)btn; (void)data;
    systemd_restart_gateway();
}

static void on_dash_refresh(GtkButton *btn, gpointer data) {
    (void)btn; (void)data;
    extern void systemd_refresh(void);
    systemd_refresh();
    gateway_client_refresh();
}

static void on_dash_open_dashboard(GtkButton *btn, gpointer data) {
    (void)btn; (void)data;

    extern GatewayConfig* gateway_client_get_config(void);
    GatewayConfig *cfg = gateway_client_get_config();
    if (!cfg) return;

    g_autofree gchar *url = gateway_config_dashboard_url(cfg);
    if (url) {
        g_app_info_launch_default_for_uri(url, NULL, NULL);
    }
}

/* Build helpers for labeled rows */

static GtkWidget* build_detail_row(const char *label_text, GtkWidget **value_out) {
    GtkWidget *row = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 12);
    gtk_widget_set_margin_top(row, 2);
    gtk_widget_set_margin_bottom(row, 2);

    GtkWidget *key = gtk_label_new(label_text);
    gtk_widget_add_css_class(key, "dim-label");
    gtk_label_set_xalign(GTK_LABEL(key), 0.0);
    gtk_widget_set_size_request(key, 130, -1);
    gtk_box_append(GTK_BOX(row), key);

    GtkWidget *val = gtk_label_new("—");
    gtk_label_set_xalign(GTK_LABEL(val), 0.0);
    gtk_label_set_selectable(GTK_LABEL(val), TRUE);
    gtk_widget_set_hexpand(val, TRUE);
    gtk_box_append(GTK_BOX(row), val);

    *value_out = val;
    return row;
}

static GtkWidget* build_dashboard_section(void) {
    GtkWidget *scrolled = gtk_scrolled_window_new();
    gtk_scrolled_window_set_policy(GTK_SCROLLED_WINDOW(scrolled),
                                   GTK_POLICY_NEVER, GTK_POLICY_AUTOMATIC);

    GtkWidget *page = gtk_box_new(GTK_ORIENTATION_VERTICAL, 8);
    gtk_widget_set_margin_start(page, 24);
    gtk_widget_set_margin_end(page, 24);
    gtk_widget_set_margin_top(page, 24);
    gtk_widget_set_margin_bottom(page, 24);

    /* 1. Status headline */
    dash_headline_label = gtk_label_new("—");
    gtk_widget_add_css_class(dash_headline_label, "title-1");
    gtk_label_set_xalign(GTK_LABEL(dash_headline_label), 0.0);
    gtk_box_append(GTK_BOX(page), dash_headline_label);

    /* 2. Runtime mode */
    dash_runtime_label = gtk_label_new("—");
    gtk_widget_add_css_class(dash_runtime_label, "title-4");
    gtk_label_set_xalign(GTK_LABEL(dash_runtime_label), 0.0);
    gtk_box_append(GTK_BOX(page), dash_runtime_label);

    dash_runtime_detail = gtk_label_new("");
    gtk_widget_add_css_class(dash_runtime_detail, "dim-label");
    gtk_label_set_xalign(GTK_LABEL(dash_runtime_detail), 0.0);
    gtk_label_set_wrap(GTK_LABEL(dash_runtime_detail), TRUE);
    gtk_box_append(GTK_BOX(page), dash_runtime_detail);

    /* 3. Readiness guidance */
    dash_guidance_label = gtk_label_new("");
    gtk_label_set_xalign(GTK_LABEL(dash_guidance_label), 0.0);
    gtk_label_set_wrap(GTK_LABEL(dash_guidance_label), TRUE);
    gtk_box_append(GTK_BOX(page), dash_guidance_label);

    dash_next_action_label = gtk_label_new("");
    gtk_widget_add_css_class(dash_next_action_label, "accent");
    gtk_label_set_xalign(GTK_LABEL(dash_next_action_label), 0.0);
    gtk_label_set_wrap(GTK_LABEL(dash_next_action_label), TRUE);
    gtk_box_append(GTK_BOX(page), dash_next_action_label);

    /* Service context notice (visible when actions need qualification) */
    dash_service_notice_label = gtk_label_new("");
    gtk_widget_add_css_class(dash_service_notice_label, "dim-label");
    gtk_label_set_xalign(GTK_LABEL(dash_service_notice_label), 0.0);
    gtk_label_set_wrap(GTK_LABEL(dash_service_notice_label), TRUE);
    gtk_widget_set_visible(dash_service_notice_label, FALSE);
    gtk_box_append(GTK_BOX(page), dash_service_notice_label);

    /* 4. Action bar */
    GtkWidget *sep1 = gtk_separator_new(GTK_ORIENTATION_HORIZONTAL);
    gtk_widget_set_margin_top(sep1, 8);
    gtk_widget_set_margin_bottom(sep1, 4);
    gtk_box_append(GTK_BOX(page), sep1);

    /* Product actions row */
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

    /* Expected service actions row */
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

    /* 5. Connectivity detail group */
    GtkWidget *sep2 = gtk_separator_new(GTK_ORIENTATION_HORIZONTAL);
    gtk_widget_set_margin_top(sep2, 12);
    gtk_widget_set_margin_bottom(sep2, 4);
    gtk_box_append(GTK_BOX(page), sep2);

    GtkWidget *conn_label = gtk_label_new("Connectivity");
    gtk_widget_add_css_class(conn_label, "heading");
    gtk_label_set_xalign(GTK_LABEL(conn_label), 0.0);
    gtk_box_append(GTK_BOX(page), conn_label);

    gtk_box_append(GTK_BOX(page), build_detail_row("Endpoint", &dash_endpoint_label));
    gtk_box_append(GTK_BOX(page), build_detail_row("Gateway Version", &dash_version_label));
    gtk_box_append(GTK_BOX(page), build_detail_row("HTTP Health", &dash_http_label));
    gtk_box_append(GTK_BOX(page), build_detail_row("WebSocket", &dash_ws_label));
    gtk_box_append(GTK_BOX(page), build_detail_row("RPC", &dash_rpc_label));
    gtk_box_append(GTK_BOX(page), build_detail_row("Auth", &dash_auth_label));
    gtk_box_append(GTK_BOX(page), build_detail_row("Auth Source", &dash_auth_source_label));

    /* 6. Systemd context group */
    GtkWidget *sep3 = gtk_separator_new(GTK_ORIENTATION_HORIZONTAL);
    gtk_widget_set_margin_top(sep3, 12);
    gtk_widget_set_margin_bottom(sep3, 4);
    gtk_box_append(GTK_BOX(page), sep3);

    GtkWidget *sys_label = gtk_label_new("Systemd Service");
    gtk_widget_add_css_class(sys_label, "heading");
    gtk_label_set_xalign(GTK_LABEL(sys_label), 0.0);
    gtk_box_append(GTK_BOX(page), sys_label);

    gtk_box_append(GTK_BOX(page), build_detail_row("Unit", &dash_unit_label));
    gtk_box_append(GTK_BOX(page), build_detail_row("Active State", &dash_active_state_label));
    gtk_box_append(GTK_BOX(page), build_detail_row("Sub State", &dash_sub_state_label));

    gtk_scrolled_window_set_child(GTK_SCROLLED_WINDOW(scrolled), page);
    return scrolled;
}

/* ── Dashboard refresh ── */

static void refresh_dashboard_content(void) {
    if (!main_window) return;

    AppState current = state_get_current();
    RuntimeMode rm = state_get_runtime_mode();
    SystemdState *sys = state_get_systemd();
    HealthState *health = state_get_health();

    ReadinessInfo ri;
    readiness_evaluate(current, health, sys, &ri);

    DashboardDisplayModel dm;
    dashboard_display_model_build(current, rm, &ri, health, sys, &dm);

    /* Headline */
    gtk_label_set_text(GTK_LABEL(dash_headline_label), dm.headline ? dm.headline : "—");

    /* Runtime mode */
    gtk_label_set_text(GTK_LABEL(dash_runtime_label), dm.runtime_label ? dm.runtime_label : "—");
    gtk_label_set_text(GTK_LABEL(dash_runtime_detail), dm.runtime_detail ? dm.runtime_detail : "");

    /* Guidance */
    gtk_label_set_text(GTK_LABEL(dash_guidance_label), dm.guidance_text ? dm.guidance_text : "");
    gtk_widget_set_visible(dash_guidance_label, dm.guidance_text != NULL);
    gtk_label_set_text(GTK_LABEL(dash_next_action_label), dm.next_action ? dm.next_action : "");
    gtk_widget_set_visible(dash_next_action_label, dm.next_action != NULL);

    /* Service context notice */
    if (dm.service_context_notice) {
        gtk_label_set_text(GTK_LABEL(dash_service_notice_label), dm.service_context_notice);
        gtk_widget_set_visible(dash_service_notice_label, TRUE);
    } else {
        gtk_widget_set_visible(dash_service_notice_label, FALSE);
    }

    /* Action sensitivities */
    gtk_widget_set_sensitive(dash_btn_start, dm.can_start);
    gtk_widget_set_sensitive(dash_btn_stop, dm.can_stop);
    gtk_widget_set_sensitive(dash_btn_restart, dm.can_restart);
    gtk_widget_set_sensitive(dash_btn_open_dashboard, dm.can_open_dashboard);

    /* Connectivity */
    if (health && health->endpoint_host) {
        g_autofree gchar *ep = g_strdup_printf("%s:%d",
            health->endpoint_host, health->endpoint_port);
        gtk_label_set_text(GTK_LABEL(dash_endpoint_label), ep);
    } else {
        gtk_label_set_text(GTK_LABEL(dash_endpoint_label), "—");
    }

    gtk_label_set_text(GTK_LABEL(dash_version_label),
        dm.gateway_version ? dm.gateway_version : "—");
    gtk_label_set_text(GTK_LABEL(dash_http_label),
        dm.http_probe_label ? dm.http_probe_label : "—");
    gtk_label_set_text(GTK_LABEL(dash_ws_label),
        dm.ws_connected ? "Connected" : "Disconnected");
    gtk_label_set_text(GTK_LABEL(dash_rpc_label),
        dm.rpc_ok ? "OK" : "Not established");
    gtk_label_set_text(GTK_LABEL(dash_auth_label),
        dm.auth_ok ? "OK" : "Not established");
    gtk_label_set_text(GTK_LABEL(dash_auth_source_label),
        dm.auth_source ? dm.auth_source : "—");

    /* Systemd */
    gtk_label_set_text(GTK_LABEL(dash_unit_label),
        dm.unit_name ? dm.unit_name : "—");
    gtk_label_set_text(GTK_LABEL(dash_active_state_label),
        dm.active_state ? dm.active_state : "—");
    gtk_label_set_text(GTK_LABEL(dash_sub_state_label),
        dm.sub_state ? dm.sub_state : "—");
}

/* ══════════════════════════════════════════════════════════════════
 * General section (Tier A — must feel finished)
 *
 * Product job: full gateway/service/context information surface,
 * expected-service controls, and companion preferences.
 *
 * Explicitly separates "Product/navigation actions" from
 * "Expected service actions" to avoid control overclaim.
 * ══════════════════════════════════════════════════════════════════ */

/* General widget refs — status */
static GtkWidget *gen_status_label = NULL;
static GtkWidget *gen_runtime_label = NULL;
static GtkWidget *gen_service_notice_label = NULL;

/* General widget refs — gateway info */
static GtkWidget *gen_endpoint_label = NULL;
static GtkWidget *gen_version_label = NULL;
static GtkWidget *gen_auth_mode_label = NULL;
static GtkWidget *gen_auth_source_label = NULL;

/* General widget refs — service info */
static GtkWidget *gen_unit_label = NULL;
static GtkWidget *gen_active_state_label = NULL;
static GtkWidget *gen_sub_state_label = NULL;

/* General widget refs — paths */
static GtkWidget *gen_config_path_label = NULL;
static GtkWidget *gen_state_dir_label = NULL;
static GtkWidget *gen_profile_label = NULL;

/* General widget refs — buttons */
static GtkWidget *gen_btn_start = NULL;
static GtkWidget *gen_btn_stop = NULL;
static GtkWidget *gen_btn_restart = NULL;
static GtkWidget *gen_btn_open_dashboard = NULL;

static void on_gen_start(GtkButton *b, gpointer d) { (void)b; (void)d; systemd_start_gateway(); }
static void on_gen_stop(GtkButton *b, gpointer d) { (void)b; (void)d; systemd_stop_gateway(); }
static void on_gen_restart(GtkButton *b, gpointer d) { (void)b; (void)d; systemd_restart_gateway(); }

static void on_gen_open_dashboard(GtkButton *b, gpointer d) {
    (void)b; (void)d;
    GatewayConfig *cfg = gateway_client_get_config();
    if (!cfg) return;
    g_autofree gchar *url = gateway_config_dashboard_url(cfg);
    if (url) g_app_info_launch_default_for_uri(url, NULL, NULL);
}

static void on_gen_rerun_onboarding(GtkButton *b, gpointer d) {
    (void)b; (void)d;
    onboarding_show();
}

static void on_gen_quit(GtkButton *b, gpointer d) {
    (void)b; (void)d;
    GApplication *app = g_application_get_default();
    if (app) g_application_quit(app);
}

static void on_gen_reveal_config(GtkButton *b, gpointer d) {
    (void)b; (void)d;
    GatewayConfig *cfg = gateway_client_get_config();
    if (cfg && cfg->config_path) {
        g_autofree gchar *dir = g_path_get_dirname(cfg->config_path);
        g_autofree gchar *uri = g_filename_to_uri(dir, NULL, NULL);
        if (uri) g_app_info_launch_default_for_uri(uri, NULL, NULL);
    }
}

static void on_gen_reveal_state_dir(GtkButton *b, gpointer d) {
    (void)b; (void)d;
    g_autofree gchar *profile = NULL;
    g_autofree gchar *state_dir = NULL;
    g_autofree gchar *config_path = NULL;
    systemd_get_runtime_context(&profile, &state_dir, &config_path);
    if (state_dir) {
        g_autofree gchar *uri = g_filename_to_uri(state_dir, NULL, NULL);
        if (uri) g_app_info_launch_default_for_uri(uri, NULL, NULL);
    }
}

/* Helper: create a row with a bold label and a value label */
static GtkWidget* gen_info_row(const char *heading, GtkWidget **out_value) {
    GtkWidget *row = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
    gtk_widget_set_margin_top(row, 2);

    GtkWidget *h = gtk_label_new(heading);
    gtk_widget_add_css_class(h, "dim-label");
    gtk_label_set_xalign(GTK_LABEL(h), 0.0);
    gtk_widget_set_size_request(h, 120, -1);
    gtk_box_append(GTK_BOX(row), h);

    GtkWidget *v = gtk_label_new("—");
    gtk_label_set_xalign(GTK_LABEL(v), 0.0);
    gtk_label_set_selectable(GTK_LABEL(v), TRUE);
    gtk_label_set_wrap(GTK_LABEL(v), TRUE);
    gtk_widget_set_hexpand(v, TRUE);
    gtk_box_append(GTK_BOX(row), v);

    *out_value = v;
    return row;
}

static GtkWidget* build_general_section(void) {
    GtkWidget *scrolled = gtk_scrolled_window_new();
    gtk_scrolled_window_set_policy(GTK_SCROLLED_WINDOW(scrolled),
                                   GTK_POLICY_NEVER, GTK_POLICY_AUTOMATIC);

    GtkWidget *page = gtk_box_new(GTK_ORIENTATION_VERTICAL, 4);
    gtk_widget_set_margin_start(page, 24);
    gtk_widget_set_margin_end(page, 24);
    gtk_widget_set_margin_top(page, 24);
    gtk_widget_set_margin_bottom(page, 24);

    GtkWidget *title = gtk_label_new("General");
    gtk_widget_add_css_class(title, "title-1");
    gtk_label_set_xalign(GTK_LABEL(title), 0.0);
    gtk_box_append(GTK_BOX(page), title);

    /* ── Status summary ── */
    gen_status_label = gtk_label_new("—");
    gtk_widget_add_css_class(gen_status_label, "title-3");
    gtk_label_set_xalign(GTK_LABEL(gen_status_label), 0.0);
    gtk_widget_set_margin_top(gen_status_label, 4);
    gtk_box_append(GTK_BOX(page), gen_status_label);

    gen_runtime_label = gtk_label_new("—");
    gtk_widget_add_css_class(gen_runtime_label, "dim-label");
    gtk_label_set_xalign(GTK_LABEL(gen_runtime_label), 0.0);
    gtk_box_append(GTK_BOX(page), gen_runtime_label);

    gen_service_notice_label = gtk_label_new("");
    gtk_widget_add_css_class(gen_service_notice_label, "dim-label");
    gtk_label_set_xalign(GTK_LABEL(gen_service_notice_label), 0.0);
    gtk_label_set_wrap(GTK_LABEL(gen_service_notice_label), TRUE);
    gtk_widget_set_visible(gen_service_notice_label, FALSE);
    gtk_box_append(GTK_BOX(page), gen_service_notice_label);

    /* ── Product actions ── */
    GtkWidget *sep1 = gtk_separator_new(GTK_ORIENTATION_HORIZONTAL);
    gtk_widget_set_margin_top(sep1, 8);
    gtk_box_append(GTK_BOX(page), sep1);

    GtkWidget *nav_row = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
    gtk_widget_set_margin_top(nav_row, 8);

    gen_btn_open_dashboard = gtk_button_new_with_label("Open Dashboard");
    gtk_widget_add_css_class(gen_btn_open_dashboard, "suggested-action");
    g_signal_connect(gen_btn_open_dashboard, "clicked", G_CALLBACK(on_gen_open_dashboard), NULL);
    gtk_box_append(GTK_BOX(nav_row), gen_btn_open_dashboard);

    gtk_box_append(GTK_BOX(page), nav_row);

    /* ── Gateway information ── */
    GtkWidget *gw_heading = gtk_label_new("Gateway");
    gtk_widget_add_css_class(gw_heading, "heading");
    gtk_label_set_xalign(GTK_LABEL(gw_heading), 0.0);
    gtk_widget_set_margin_top(gw_heading, 12);
    gtk_box_append(GTK_BOX(page), gw_heading);

    gtk_box_append(GTK_BOX(page), gen_info_row("Endpoint", &gen_endpoint_label));
    gtk_box_append(GTK_BOX(page), gen_info_row("Version", &gen_version_label));
    gtk_box_append(GTK_BOX(page), gen_info_row("Auth Mode", &gen_auth_mode_label));
    gtk_box_append(GTK_BOX(page), gen_info_row("Auth Source", &gen_auth_source_label));

    /* ── Expected service ── */
    GtkWidget *svc_heading = gtk_label_new("Expected Service");
    gtk_widget_add_css_class(svc_heading, "heading");
    gtk_label_set_xalign(GTK_LABEL(svc_heading), 0.0);
    gtk_widget_set_margin_top(svc_heading, 12);
    gtk_box_append(GTK_BOX(page), svc_heading);

    gtk_box_append(GTK_BOX(page), gen_info_row("Unit", &gen_unit_label));
    gtk_box_append(GTK_BOX(page), gen_info_row("Active State", &gen_active_state_label));
    gtk_box_append(GTK_BOX(page), gen_info_row("Sub State", &gen_sub_state_label));

    GtkWidget *svc_row = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
    gtk_widget_set_margin_top(svc_row, 6);

    gen_btn_start = gtk_button_new_with_label("Start");
    g_signal_connect(gen_btn_start, "clicked", G_CALLBACK(on_gen_start), NULL);
    gtk_box_append(GTK_BOX(svc_row), gen_btn_start);

    gen_btn_stop = gtk_button_new_with_label("Stop");
    g_signal_connect(gen_btn_stop, "clicked", G_CALLBACK(on_gen_stop), NULL);
    gtk_box_append(GTK_BOX(svc_row), gen_btn_stop);

    gen_btn_restart = gtk_button_new_with_label("Restart");
    g_signal_connect(gen_btn_restart, "clicked", G_CALLBACK(on_gen_restart), NULL);
    gtk_box_append(GTK_BOX(svc_row), gen_btn_restart);

    gtk_box_append(GTK_BOX(page), svc_row);

    /* ── Paths & profile ── */
    GtkWidget *paths_heading = gtk_label_new("Paths");
    gtk_widget_add_css_class(paths_heading, "heading");
    gtk_label_set_xalign(GTK_LABEL(paths_heading), 0.0);
    gtk_widget_set_margin_top(paths_heading, 12);
    gtk_box_append(GTK_BOX(page), paths_heading);

    gtk_box_append(GTK_BOX(page), gen_info_row("Config File", &gen_config_path_label));
    gtk_widget_add_css_class(gen_config_path_label, "monospace");

    GtkWidget *reveal_config_btn = gtk_button_new_with_label("Reveal Config Folder");
    gtk_widget_set_halign(reveal_config_btn, GTK_ALIGN_START);
    gtk_widget_set_margin_top(reveal_config_btn, 2);
    g_signal_connect(reveal_config_btn, "clicked", G_CALLBACK(on_gen_reveal_config), NULL);
    gtk_box_append(GTK_BOX(page), reveal_config_btn);

    gtk_box_append(GTK_BOX(page), gen_info_row("State Dir", &gen_state_dir_label));
    gtk_widget_add_css_class(gen_state_dir_label, "monospace");

    GtkWidget *reveal_state_btn = gtk_button_new_with_label("Reveal State Folder");
    gtk_widget_set_halign(reveal_state_btn, GTK_ALIGN_START);
    gtk_widget_set_margin_top(reveal_state_btn, 2);
    g_signal_connect(reveal_state_btn, "clicked", G_CALLBACK(on_gen_reveal_state_dir), NULL);
    gtk_box_append(GTK_BOX(page), reveal_state_btn);

    gtk_box_append(GTK_BOX(page), gen_info_row("Profile", &gen_profile_label));

    /* ── Companion ── */
    GtkWidget *sep2 = gtk_separator_new(GTK_ORIENTATION_HORIZONTAL);
    gtk_widget_set_margin_top(sep2, 12);
    gtk_box_append(GTK_BOX(page), sep2);

    GtkWidget *companion_label = gtk_label_new("Companion");
    gtk_widget_add_css_class(companion_label, "heading");
    gtk_label_set_xalign(GTK_LABEL(companion_label), 0.0);
    gtk_widget_set_margin_top(companion_label, 8);
    gtk_box_append(GTK_BOX(page), companion_label);

    GtkWidget *onboard_btn = gtk_button_new_with_label("Re-run Onboarding");
    gtk_widget_set_halign(onboard_btn, GTK_ALIGN_START);
    gtk_widget_set_margin_top(onboard_btn, 4);
    g_signal_connect(onboard_btn, "clicked", G_CALLBACK(on_gen_rerun_onboarding), NULL);
    gtk_box_append(GTK_BOX(page), onboard_btn);

    GtkWidget *quit_btn = gtk_button_new_with_label("Quit OpenClaw Companion");
    gtk_widget_add_css_class(quit_btn, "destructive-action");
    gtk_widget_set_halign(quit_btn, GTK_ALIGN_START);
    gtk_widget_set_margin_top(quit_btn, 8);
    g_signal_connect(quit_btn, "clicked", G_CALLBACK(on_gen_quit), NULL);
    gtk_box_append(GTK_BOX(page), quit_btn);

    gtk_scrolled_window_set_child(GTK_SCROLLED_WINDOW(scrolled), page);
    return scrolled;
}

static void refresh_general_content(void) {
    if (!gen_status_label) return;

    AppState current = state_get_current();
    RuntimeMode rm = state_get_runtime_mode();
    HealthState *health = state_get_health();
    SystemdState *sys = state_get_systemd();

    ReadinessInfo ri;
    readiness_evaluate(current, health, sys, &ri);

    DashboardDisplayModel dm;
    dashboard_display_model_build(current, rm, &ri, health, sys, &dm);

    /* Status headline + runtime */
    gtk_label_set_text(GTK_LABEL(gen_status_label), dm.headline ? dm.headline : "—");
    gtk_label_set_text(GTK_LABEL(gen_runtime_label), dm.runtime_label ? dm.runtime_label : "—");

    if (dm.service_context_notice) {
        gtk_label_set_text(GTK_LABEL(gen_service_notice_label), dm.service_context_notice);
        gtk_widget_set_visible(gen_service_notice_label, TRUE);
    } else {
        gtk_widget_set_visible(gen_service_notice_label, FALSE);
    }

    /* Gateway info */
    GatewayConfig *cfg = gateway_client_get_config();
    if (cfg) {
        g_autofree gchar *ep = g_strdup_printf("%s:%d", cfg->host ? cfg->host : "127.0.0.1", cfg->port);
        gtk_label_set_text(GTK_LABEL(gen_endpoint_label), ep);
    } else {
        gtk_label_set_text(GTK_LABEL(gen_endpoint_label), "—");
    }
    gtk_label_set_text(GTK_LABEL(gen_version_label),
        dm.gateway_version ? dm.gateway_version : "—");
    gtk_label_set_text(GTK_LABEL(gen_auth_mode_label),
        (cfg && cfg->auth_mode) ? cfg->auth_mode : "—");
    gtk_label_set_text(GTK_LABEL(gen_auth_source_label),
        dm.auth_source ? dm.auth_source : "—");

    /* Service info */
    gtk_label_set_text(GTK_LABEL(gen_unit_label),
        dm.unit_name ? dm.unit_name : "—");
    gtk_label_set_text(GTK_LABEL(gen_active_state_label),
        dm.active_state ? dm.active_state : "—");
    gtk_label_set_text(GTK_LABEL(gen_sub_state_label),
        dm.sub_state ? dm.sub_state : "—");

    /* Paths & profile */
    g_autofree gchar *profile = NULL;
    g_autofree gchar *state_dir = NULL;
    g_autofree gchar *config_path = NULL;
    systemd_get_runtime_context(&profile, &state_dir, &config_path);

    gtk_label_set_text(GTK_LABEL(gen_config_path_label),
        config_path ? config_path : "—");
    gtk_label_set_text(GTK_LABEL(gen_state_dir_label),
        state_dir ? state_dir : "—");
    gtk_label_set_text(GTK_LABEL(gen_profile_label),
        profile ? profile : "default");

    /* Button sensitivity */
    gtk_widget_set_sensitive(gen_btn_start, dm.can_start);
    gtk_widget_set_sensitive(gen_btn_stop, dm.can_stop);
    gtk_widget_set_sensitive(gen_btn_restart, dm.can_restart);
    gtk_widget_set_sensitive(gen_btn_open_dashboard, dm.can_open_dashboard);
}

/* ══════════════════════════════════════════════════════════════════
 * Config section (Tier A — must feel finished)
 *
 * Validity-first hierarchy:
 *   1. Validity status
 *   2. Issues count
 *   3. Warning / error text
 *   4. File path + last modified
 *   5. Raw JSON read-only view
 *   6. Copy-to-clipboard action
 * ══════════════════════════════════════════════════════════════════ */

/* Config widget refs */
static GtkWidget *cfg_status_label = NULL;
static GtkWidget *cfg_path_label = NULL;
static GtkWidget *cfg_modified_label = NULL;
static GtkWidget *cfg_warning_label = NULL;
static GtkWidget *cfg_issues_label = NULL;
static GtkWidget *cfg_json_view = NULL;
static GtkWidget *cfg_copy_btn = NULL;
static guint cfg_copy_reset_id = 0;

static void on_cfg_open_file(GtkButton *b, gpointer d) {
    (void)b; (void)d;
    GatewayConfig *cfg = gateway_client_get_config();
    if (cfg && cfg->config_path) {
        g_autofree gchar *uri = g_filename_to_uri(cfg->config_path, NULL, NULL);
        if (uri) g_app_info_launch_default_for_uri(uri, NULL, NULL);
    }
}

static void on_cfg_open_folder(GtkButton *b, gpointer d) {
    (void)b; (void)d;
    GatewayConfig *cfg = gateway_client_get_config();
    if (cfg && cfg->config_path) {
        g_autofree gchar *dir = g_path_get_dirname(cfg->config_path);
        g_autofree gchar *uri = g_filename_to_uri(dir, NULL, NULL);
        if (uri) g_app_info_launch_default_for_uri(uri, NULL, NULL);
    }
}

static gboolean reset_cfg_copy_label(gpointer data) {
    (void)data;
    if (cfg_copy_btn)
        gtk_button_set_label(GTK_BUTTON(cfg_copy_btn), "Copy Config JSON");
    cfg_copy_reset_id = 0;
    return G_SOURCE_REMOVE;
}

static void on_cfg_copy_json(GtkButton *b, gpointer d) {
    (void)b; (void)d;
    GatewayConfig *cfg = gateway_client_get_config();
    if (!cfg || !cfg->config_path) return;
    g_autofree gchar *contents = NULL;
    if (!g_file_get_contents(cfg->config_path, &contents, NULL, NULL)) return;

    GdkClipboard *cb = gdk_display_get_clipboard(gdk_display_get_default());
    gdk_clipboard_set_text(cb, contents);
    if (cfg_copy_btn) {
        gtk_button_set_label(GTK_BUTTON(cfg_copy_btn), "Copied!");
        if (cfg_copy_reset_id > 0) g_source_remove(cfg_copy_reset_id);
        cfg_copy_reset_id = g_timeout_add(2000, reset_cfg_copy_label, NULL);
    }
}

static gchar* cfg_get_modified_text(const char *path) {
    if (!path) return g_strdup("—");
    g_autoptr(GFile) file = g_file_new_for_path(path);
    g_autoptr(GFileInfo) info = g_file_query_info(file,
        G_FILE_ATTRIBUTE_TIME_MODIFIED, G_FILE_QUERY_INFO_NONE, NULL, NULL);
    if (!info) return g_strdup("—");

    g_autoptr(GDateTime) dt = g_file_info_get_modification_date_time(info);
    if (!dt) return g_strdup("—");

    g_autoptr(GDateTime) local = g_date_time_to_local(dt);
    return g_date_time_format(local, "%Y-%m-%d %H:%M:%S");
}

static GtkWidget* build_config_section(void) {
    GtkWidget *page = gtk_box_new(GTK_ORIENTATION_VERTICAL, 8);
    gtk_widget_set_margin_start(page, 24);
    gtk_widget_set_margin_end(page, 24);
    gtk_widget_set_margin_top(page, 24);
    gtk_widget_set_margin_bottom(page, 24);

    GtkWidget *title = gtk_label_new("Config");
    gtk_widget_add_css_class(title, "title-1");
    gtk_label_set_xalign(GTK_LABEL(title), 0.0);
    gtk_box_append(GTK_BOX(page), title);

    /* 1. Validity status */
    cfg_status_label = gtk_label_new("—");
    gtk_widget_add_css_class(cfg_status_label, "title-3");
    gtk_label_set_xalign(GTK_LABEL(cfg_status_label), 0.0);
    gtk_widget_set_margin_top(cfg_status_label, 4);
    gtk_box_append(GTK_BOX(page), cfg_status_label);

    /* 2. Issues count */
    cfg_issues_label = gtk_label_new("");
    gtk_widget_add_css_class(cfg_issues_label, "dim-label");
    gtk_label_set_xalign(GTK_LABEL(cfg_issues_label), 0.0);
    gtk_widget_set_visible(cfg_issues_label, FALSE);
    gtk_box_append(GTK_BOX(page), cfg_issues_label);

    /* 3. Warning / error text */
    cfg_warning_label = gtk_label_new("");
    gtk_label_set_wrap(GTK_LABEL(cfg_warning_label), TRUE);
    gtk_label_set_xalign(GTK_LABEL(cfg_warning_label), 0.0);
    gtk_widget_set_visible(cfg_warning_label, FALSE);
    gtk_box_append(GTK_BOX(page), cfg_warning_label);

    /* 4. File path + last modified */
    GtkWidget *sep1 = gtk_separator_new(GTK_ORIENTATION_HORIZONTAL);
    gtk_widget_set_margin_top(sep1, 8);
    gtk_box_append(GTK_BOX(page), sep1);

    GtkWidget *path_heading = gtk_label_new("Config File");
    gtk_widget_add_css_class(path_heading, "heading");
    gtk_label_set_xalign(GTK_LABEL(path_heading), 0.0);
    gtk_widget_set_margin_top(path_heading, 8);
    gtk_box_append(GTK_BOX(page), path_heading);

    cfg_path_label = gtk_label_new("—");
    gtk_label_set_selectable(GTK_LABEL(cfg_path_label), TRUE);
    gtk_label_set_xalign(GTK_LABEL(cfg_path_label), 0.0);
    gtk_label_set_wrap(GTK_LABEL(cfg_path_label), TRUE);
    gtk_widget_add_css_class(cfg_path_label, "monospace");
    gtk_box_append(GTK_BOX(page), cfg_path_label);

    cfg_modified_label = gtk_label_new("Last modified: —");
    gtk_widget_add_css_class(cfg_modified_label, "dim-label");
    gtk_label_set_xalign(GTK_LABEL(cfg_modified_label), 0.0);
    gtk_box_append(GTK_BOX(page), cfg_modified_label);

    /* File actions */
    GtkWidget *file_row = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
    gtk_widget_set_margin_top(file_row, 6);

    GtkWidget *open_file_btn = gtk_button_new_with_label("Open Config File");
    g_signal_connect(open_file_btn, "clicked", G_CALLBACK(on_cfg_open_file), NULL);
    gtk_box_append(GTK_BOX(file_row), open_file_btn);

    GtkWidget *open_folder_btn = gtk_button_new_with_label("Reveal Folder");
    g_signal_connect(open_folder_btn, "clicked", G_CALLBACK(on_cfg_open_folder), NULL);
    gtk_box_append(GTK_BOX(file_row), open_folder_btn);

    gtk_box_append(GTK_BOX(page), file_row);

    /* 5. Raw JSON read-only view */
    GtkWidget *json_heading = gtk_label_new("Raw Config");
    gtk_widget_add_css_class(json_heading, "heading");
    gtk_label_set_xalign(GTK_LABEL(json_heading), 0.0);
    gtk_widget_set_margin_top(json_heading, 12);
    gtk_box_append(GTK_BOX(page), json_heading);

    GtkTextBuffer *json_buf = gtk_text_buffer_new(NULL);
    cfg_json_view = gtk_text_view_new_with_buffer(json_buf);
    gtk_text_view_set_editable(GTK_TEXT_VIEW(cfg_json_view), FALSE);
    gtk_text_view_set_cursor_visible(GTK_TEXT_VIEW(cfg_json_view), FALSE);
    gtk_text_view_set_wrap_mode(GTK_TEXT_VIEW(cfg_json_view), GTK_WRAP_WORD_CHAR);
    gtk_text_view_set_monospace(GTK_TEXT_VIEW(cfg_json_view), TRUE);
    gtk_widget_set_vexpand(cfg_json_view, TRUE);

    GtkWidget *json_scrolled = gtk_scrolled_window_new();
    gtk_scrolled_window_set_child(GTK_SCROLLED_WINDOW(json_scrolled), cfg_json_view);
    gtk_widget_set_vexpand(json_scrolled, TRUE);
    gtk_scrolled_window_set_min_content_height(GTK_SCROLLED_WINDOW(json_scrolled), 200);
    gtk_box_append(GTK_BOX(page), json_scrolled);

    /* 6. Copy action */
    GtkWidget *copy_row = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
    gtk_widget_set_margin_top(copy_row, 6);

    cfg_copy_btn = gtk_button_new_with_label("Copy Config JSON");
    g_signal_connect(cfg_copy_btn, "clicked", G_CALLBACK(on_cfg_copy_json), NULL);
    gtk_box_append(GTK_BOX(copy_row), cfg_copy_btn);

    gtk_box_append(GTK_BOX(page), copy_row);

    return page;
}

static void refresh_config_content(void) {
    if (!cfg_status_label) return;

    HealthState *health = state_get_health();
    GatewayConfig *cfg = gateway_client_get_config();
    const char *path = cfg ? cfg->config_path : NULL;

    ConfigDisplayModel cm;
    config_display_model_build(health, path, &cm);

    /* 1. Validity */
    gtk_label_set_text(GTK_LABEL(cfg_status_label),
        cm.is_valid ? "Configuration Valid" : "Configuration Invalid");

    /* 2. Issues */
    if (cm.issues_count > 0) {
        g_autofree gchar *issues_text = g_strdup_printf("%d issue(s) detected", cm.issues_count);
        gtk_label_set_text(GTK_LABEL(cfg_issues_label), issues_text);
        gtk_widget_set_visible(cfg_issues_label, TRUE);
    } else {
        gtk_widget_set_visible(cfg_issues_label, FALSE);
    }

    /* 3. Warning / error */
    if (cm.warning_text) {
        gtk_label_set_text(GTK_LABEL(cfg_warning_label), cm.warning_text);
        gtk_widget_set_visible(cfg_warning_label, TRUE);
    } else {
        gtk_widget_set_visible(cfg_warning_label, FALSE);
    }

    /* 4. Path + last modified */
    gtk_label_set_text(GTK_LABEL(cfg_path_label), cm.config_path ? cm.config_path : "—");
    g_autofree gchar *mod_text = cfg_get_modified_text(path);
    g_autofree gchar *mod_label = g_strdup_printf("Last modified: %s", mod_text);
    gtk_label_set_text(GTK_LABEL(cfg_modified_label), mod_label);

    /* 5. Raw JSON */
    if (cfg_json_view && path) {
        g_autofree gchar *contents = NULL;
        if (g_file_get_contents(path, &contents, NULL, NULL)) {
            GtkTextBuffer *buf = gtk_text_view_get_buffer(GTK_TEXT_VIEW(cfg_json_view));
            gtk_text_buffer_set_text(buf, contents, -1);
        }
    }
}

/* ══════════════════════════════════════════════════════════════════
 * Diagnostics section (integrated)
 *
 * Reuses the canonical build_diagnostics_text() from diagnostics.c.
 * Provides an inline text view + copy button.
 * ══════════════════════════════════════════════════════════════════ */

static GtkWidget *diag_text_view = NULL;
static GtkWidget *diag_copy_btn = NULL;
static guint diag_copy_reset_id = 0;

static gboolean reset_diag_copy_label(gpointer data) {
    (void)data;
    if (diag_copy_btn)
        gtk_button_set_label(GTK_BUTTON(diag_copy_btn), "Copy Diagnostics");
    diag_copy_reset_id = 0;
    return G_SOURCE_REMOVE;
}

static void on_diag_copy(GtkButton *b, gpointer d) {
    (void)b; (void)d;
    g_autofree gchar *text = build_diagnostics_text();
    GdkClipboard *cb = gdk_display_get_clipboard(gdk_display_get_default());
    gdk_clipboard_set_text(cb, text);
    if (diag_copy_btn) {
        gtk_button_set_label(GTK_BUTTON(diag_copy_btn), "Copied!");
        if (diag_copy_reset_id > 0) g_source_remove(diag_copy_reset_id);
        diag_copy_reset_id = g_timeout_add(2000, reset_diag_copy_label, NULL);
    }
}

static GtkWidget* build_diagnostics_section(void) {
    GtkWidget *page = gtk_box_new(GTK_ORIENTATION_VERTICAL, 8);
    gtk_widget_set_margin_start(page, 24);
    gtk_widget_set_margin_end(page, 24);
    gtk_widget_set_margin_top(page, 24);
    gtk_widget_set_margin_bottom(page, 24);

    GtkWidget *title = gtk_label_new("Diagnostics");
    gtk_widget_add_css_class(title, "title-1");
    gtk_label_set_xalign(GTK_LABEL(title), 0.0);
    gtk_box_append(GTK_BOX(page), title);

    GtkWidget *subtitle = gtk_label_new(
        "Full connectivity snapshot. Copy and share for troubleshooting.");
    gtk_widget_add_css_class(subtitle, "dim-label");
    gtk_label_set_xalign(GTK_LABEL(subtitle), 0.0);
    gtk_box_append(GTK_BOX(page), subtitle);

    g_autofree gchar *initial = build_diagnostics_text();
    GtkTextBuffer *buf = gtk_text_buffer_new(NULL);
    gtk_text_buffer_set_text(buf, initial, -1);

    diag_text_view = gtk_text_view_new_with_buffer(buf);
    gtk_text_view_set_editable(GTK_TEXT_VIEW(diag_text_view), FALSE);
    gtk_text_view_set_cursor_visible(GTK_TEXT_VIEW(diag_text_view), FALSE);
    gtk_text_view_set_wrap_mode(GTK_TEXT_VIEW(diag_text_view), GTK_WRAP_WORD_CHAR);
    gtk_text_view_set_monospace(GTK_TEXT_VIEW(diag_text_view), TRUE);
    gtk_widget_set_vexpand(diag_text_view, TRUE);

    GtkWidget *scrolled = gtk_scrolled_window_new();
    gtk_scrolled_window_set_child(GTK_SCROLLED_WINDOW(scrolled), diag_text_view);
    gtk_widget_set_vexpand(scrolled, TRUE);
    gtk_box_append(GTK_BOX(page), scrolled);

    GtkWidget *btn_row = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
    gtk_widget_set_margin_top(btn_row, 8);

    diag_copy_btn = gtk_button_new_with_label("Copy Diagnostics");
    g_signal_connect(diag_copy_btn, "clicked", G_CALLBACK(on_diag_copy), NULL);
    gtk_box_append(GTK_BOX(btn_row), diag_copy_btn);

    gtk_box_append(GTK_BOX(page), btn_row);
    return page;
}

static void refresh_diagnostics_content(void) {
    if (!diag_text_view) return;
    g_autofree gchar *text = build_diagnostics_text();
    GtkTextBuffer *buf = gtk_text_view_get_buffer(GTK_TEXT_VIEW(diag_text_view));
    gtk_text_buffer_set_text(buf, text, -1);
}

/* ══════════════════════════════════════════════════════════════════
 * Environment section
 *
 * Shows environment checks from the display model.
 * ══════════════════════════════════════════════════════════════════ */

static GtkWidget *env_checks_box = NULL;

extern void systemd_get_runtime_context(gchar **out_profile, gchar **out_state_dir, gchar **out_config_path);

static void populate_env_checks(GtkWidget *container) {
    /* Clear previous children */
    GtkWidget *child;
    while ((child = gtk_widget_get_first_child(container)) != NULL) {
        gtk_box_remove(GTK_BOX(container), child);
    }

    SystemdState *sys = state_get_systemd();
    g_autofree gchar *config_path = NULL;
    g_autofree gchar *state_dir = NULL;
    g_autofree gchar *profile = NULL;
    systemd_get_runtime_context(&profile, &state_dir, &config_path);

    EnvironmentCheckResult ecr;
    environment_check_build(sys, config_path, state_dir, &ecr);

    for (int i = 0; i < ecr.count; i++) {
        GtkWidget *row = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
        gtk_widget_set_margin_top(row, 4);

        const char *icon = ecr.rows[i].passed ? "\u2705" : "\u274C";
        GtkWidget *icon_label = gtk_label_new(icon);
        gtk_box_append(GTK_BOX(row), icon_label);

        g_autofree gchar *text = g_strdup_printf("%s: %s",
            ecr.rows[i].label,
            ecr.rows[i].detail ? ecr.rows[i].detail : "");
        GtkWidget *detail = gtk_label_new(text);
        gtk_label_set_wrap(GTK_LABEL(detail), TRUE);
        gtk_label_set_xalign(GTK_LABEL(detail), 0.0);
        gtk_widget_set_hexpand(detail, TRUE);
        gtk_box_append(GTK_BOX(row), detail);

        gtk_box_append(GTK_BOX(container), row);
    }
}

static GtkWidget* build_environment_section(void) {
    GtkWidget *scrolled = gtk_scrolled_window_new();
    gtk_scrolled_window_set_policy(GTK_SCROLLED_WINDOW(scrolled),
                                   GTK_POLICY_NEVER, GTK_POLICY_AUTOMATIC);

    GtkWidget *page = gtk_box_new(GTK_ORIENTATION_VERTICAL, 8);
    gtk_widget_set_margin_start(page, 24);
    gtk_widget_set_margin_end(page, 24);
    gtk_widget_set_margin_top(page, 24);
    gtk_widget_set_margin_bottom(page, 24);

    GtkWidget *title = gtk_label_new("Environment");
    gtk_widget_add_css_class(title, "title-1");
    gtk_label_set_xalign(GTK_LABEL(title), 0.0);
    gtk_box_append(GTK_BOX(page), title);

    GtkWidget *subtitle = gtk_label_new(
        "Prerequisites and runtime environment checks.");
    gtk_widget_add_css_class(subtitle, "dim-label");
    gtk_label_set_xalign(GTK_LABEL(subtitle), 0.0);
    gtk_box_append(GTK_BOX(page), subtitle);

    GtkWidget *sep = gtk_separator_new(GTK_ORIENTATION_HORIZONTAL);
    gtk_widget_set_margin_top(sep, 8);
    gtk_box_append(GTK_BOX(page), sep);

    env_checks_box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 4);
    gtk_widget_set_margin_top(env_checks_box, 8);
    populate_env_checks(env_checks_box);
    gtk_box_append(GTK_BOX(page), env_checks_box);

    gtk_scrolled_window_set_child(GTK_SCROLLED_WINDOW(scrolled), page);
    return scrolled;
}

static void refresh_environment_content(void) {
    if (!env_checks_box) return;
    populate_env_checks(env_checks_box);
}

/* ══════════════════════════════════════════════════════════════════
 * About section
 * ══════════════════════════════════════════════════════════════════ */

static GtkWidget* build_about_section(void) {
    GtkWidget *scrolled = gtk_scrolled_window_new();
    gtk_scrolled_window_set_policy(GTK_SCROLLED_WINDOW(scrolled),
                                   GTK_POLICY_NEVER, GTK_POLICY_AUTOMATIC);

    GtkWidget *page = gtk_box_new(GTK_ORIENTATION_VERTICAL, 12);
    gtk_widget_set_margin_start(page, 24);
    gtk_widget_set_margin_end(page, 24);
    gtk_widget_set_margin_top(page, 40);
    gtk_widget_set_margin_bottom(page, 24);
    gtk_widget_set_halign(page, GTK_ALIGN_CENTER);

    GtkWidget *title = gtk_label_new("OpenClaw");
    gtk_widget_add_css_class(title, "title-1");
    gtk_box_append(GTK_BOX(page), title);

    GtkWidget *subtitle = gtk_label_new("Linux Companion App");
    gtk_widget_add_css_class(subtitle, "title-3");
    gtk_box_append(GTK_BOX(page), subtitle);

    HealthState *health = state_get_health();
    const char *ver = (health && health->gateway_version) ? health->gateway_version : "Unknown";
    g_autofree gchar *ver_text = g_strdup_printf("Gateway Version: %s", ver);
    GtkWidget *version = gtk_label_new(ver_text);
    gtk_widget_add_css_class(version, "dim-label");
    gtk_widget_set_margin_top(version, 16);
    gtk_box_append(GTK_BOX(page), version);

    GtkWidget *docs_link = gtk_label_new(NULL);
    gtk_label_set_markup(GTK_LABEL(docs_link),
        "<a href=\"https://docs.openclaw.ai\">Documentation</a>");
    gtk_widget_set_margin_top(docs_link, 12);
    gtk_box_append(GTK_BOX(page), docs_link);

    GtkWidget *gh_link = gtk_label_new(NULL);
    gtk_label_set_markup(GTK_LABEL(gh_link),
        "<a href=\"https://github.com/openclaw/openclaw\">GitHub</a>");
    gtk_box_append(GTK_BOX(page), gh_link);

    GtkWidget *copyright = gtk_label_new("Copyright \u00A9 2025 OpenClaw Contributors");
    gtk_widget_add_css_class(copyright, "dim-label");
    gtk_widget_set_margin_top(copyright, 24);
    gtk_box_append(GTK_BOX(page), copyright);

    gtk_scrolled_window_set_child(GTK_SCROLLED_WINDOW(scrolled), page);
    return scrolled;
}

/* ══════════════════════════════════════════════════════════════════
 * Instances section (Tier B — local instance card)
 *
 * Shows the local machine instance card. No RPC needed; all data
 * is already available from state, health, systemd, and config.
 * ══════════════════════════════════════════════════════════════════ */

static GtkWidget *inst_hostname_label = NULL;
static GtkWidget *inst_platform_label = NULL;
static GtkWidget *inst_version_label = NULL;
static GtkWidget *inst_runtime_label = NULL;
static GtkWidget *inst_endpoint_label = NULL;
static GtkWidget *inst_unit_label = NULL;
static GtkWidget *inst_state_label = NULL;

static GtkWidget* inst_card_row(const char *heading, GtkWidget **out_value) {
    GtkWidget *row = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
    gtk_widget_set_margin_top(row, 2);

    GtkWidget *h = gtk_label_new(heading);
    gtk_widget_add_css_class(h, "dim-label");
    gtk_label_set_xalign(GTK_LABEL(h), 0.0);
    gtk_widget_set_size_request(h, 120, -1);
    gtk_box_append(GTK_BOX(row), h);

    GtkWidget *v = gtk_label_new("—");
    gtk_label_set_xalign(GTK_LABEL(v), 0.0);
    gtk_label_set_selectable(GTK_LABEL(v), TRUE);
    gtk_widget_set_hexpand(v, TRUE);
    gtk_box_append(GTK_BOX(row), v);

    *out_value = v;
    return row;
}

static GtkWidget* build_instances_section(void) {
    GtkWidget *scrolled = gtk_scrolled_window_new();
    gtk_scrolled_window_set_policy(GTK_SCROLLED_WINDOW(scrolled),
                                   GTK_POLICY_NEVER, GTK_POLICY_AUTOMATIC);

    GtkWidget *page = gtk_box_new(GTK_ORIENTATION_VERTICAL, 4);
    gtk_widget_set_margin_start(page, 24);
    gtk_widget_set_margin_end(page, 24);
    gtk_widget_set_margin_top(page, 24);
    gtk_widget_set_margin_bottom(page, 24);

    GtkWidget *title = gtk_label_new("Instances");
    gtk_widget_add_css_class(title, "title-1");
    gtk_label_set_xalign(GTK_LABEL(title), 0.0);
    gtk_box_append(GTK_BOX(page), title);

    GtkWidget *subtitle = gtk_label_new("Local gateway instance.");
    gtk_widget_add_css_class(subtitle, "dim-label");
    gtk_label_set_xalign(GTK_LABEL(subtitle), 0.0);
    gtk_box_append(GTK_BOX(page), subtitle);

    /* Local instance card */
    GtkWidget *card_frame = gtk_frame_new(NULL);
    gtk_widget_set_margin_top(card_frame, 12);

    GtkWidget *card = gtk_box_new(GTK_ORIENTATION_VERTICAL, 2);
    gtk_widget_set_margin_start(card, 16);
    gtk_widget_set_margin_end(card, 16);
    gtk_widget_set_margin_top(card, 12);
    gtk_widget_set_margin_bottom(card, 12);

    GtkWidget *card_title = gtk_label_new("Local Instance");
    gtk_widget_add_css_class(card_title, "heading");
    gtk_label_set_xalign(GTK_LABEL(card_title), 0.0);
    gtk_box_append(GTK_BOX(card), card_title);

    GtkWidget *sep = gtk_separator_new(GTK_ORIENTATION_HORIZONTAL);
    gtk_widget_set_margin_top(sep, 4);
    gtk_widget_set_margin_bottom(sep, 4);
    gtk_box_append(GTK_BOX(card), sep);

    gtk_box_append(GTK_BOX(card), inst_card_row("Hostname", &inst_hostname_label));
    gtk_box_append(GTK_BOX(card), inst_card_row("Platform", &inst_platform_label));
    gtk_box_append(GTK_BOX(card), inst_card_row("Version", &inst_version_label));
    gtk_box_append(GTK_BOX(card), inst_card_row("Runtime", &inst_runtime_label));
    gtk_box_append(GTK_BOX(card), inst_card_row("Endpoint", &inst_endpoint_label));
    gtk_box_append(GTK_BOX(card), inst_card_row("Unit", &inst_unit_label));
    gtk_box_append(GTK_BOX(card), inst_card_row("Service State", &inst_state_label));

    gtk_frame_set_child(GTK_FRAME(card_frame), card);
    gtk_box_append(GTK_BOX(page), card_frame);

    gtk_scrolled_window_set_child(GTK_SCROLLED_WINDOW(scrolled), page);
    return scrolled;
}

static void refresh_instances_content(void) {
    if (!inst_hostname_label) return;

    AppState current = state_get_current();
    RuntimeMode rm = state_get_runtime_mode();
    HealthState *health = state_get_health();
    SystemdState *sys = state_get_systemd();

    ReadinessInfo ri;
    readiness_evaluate(current, health, sys, &ri);

    DashboardDisplayModel dm;
    dashboard_display_model_build(current, rm, &ri, health, sys, &dm);

    g_autofree gchar *hostname = g_strdup(g_get_host_name());
    gtk_label_set_text(GTK_LABEL(inst_hostname_label), hostname ? hostname : "—");
    gtk_label_set_text(GTK_LABEL(inst_platform_label), "Linux");
    gtk_label_set_text(GTK_LABEL(inst_version_label),
        dm.gateway_version ? dm.gateway_version : "—");
    gtk_label_set_text(GTK_LABEL(inst_runtime_label),
        dm.runtime_label ? dm.runtime_label : "—");

    GatewayConfig *cfg = gateway_client_get_config();
    if (cfg) {
        g_autofree gchar *ep = g_strdup_printf("%s:%d", cfg->host ? cfg->host : "127.0.0.1", cfg->port);
        gtk_label_set_text(GTK_LABEL(inst_endpoint_label), ep);
    } else {
        gtk_label_set_text(GTK_LABEL(inst_endpoint_label), "—");
    }

    gtk_label_set_text(GTK_LABEL(inst_unit_label),
        dm.unit_name ? dm.unit_name : "—");

    if (dm.active_state && dm.sub_state) {
        g_autofree gchar *state_text = g_strdup_printf("%s (%s)", dm.active_state, dm.sub_state);
        gtk_label_set_text(GTK_LABEL(inst_state_label), state_text);
    } else {
        gtk_label_set_text(GTK_LABEL(inst_state_label),
            dm.active_state ? dm.active_state : "—");
    }
}

/* ══════════════════════════════════════════════════════════════════
 * Debug section (Tier B — reduced debug, conditional on need)
 *
 * Service state/PID, config folder reveal, journal command,
 * trigger health refresh, restart gateway, restart onboarding,
 * copy diagnostics dump.
 * ══════════════════════════════════════════════════════════════════ */

static GtkWidget *dbg_state_label = NULL;
static GtkWidget *dbg_unit_label = NULL;
static GtkWidget *dbg_journal_label = NULL;

static void on_dbg_refresh_health(GtkButton *b, gpointer d) {
    (void)b; (void)d;
    gateway_client_refresh();
}

static void on_dbg_restart_gw(GtkButton *b, gpointer d) {
    (void)b; (void)d;
    systemd_restart_gateway();
}

static void on_dbg_rerun_onboarding(GtkButton *b, gpointer d) {
    (void)b; (void)d;
    onboarding_show();
}

static void on_dbg_reveal_config(GtkButton *b, gpointer d) {
    (void)b; (void)d;
    GatewayConfig *cfg = gateway_client_get_config();
    if (cfg && cfg->config_path) {
        g_autofree gchar *dir = g_path_get_dirname(cfg->config_path);
        g_autofree gchar *uri = g_filename_to_uri(dir, NULL, NULL);
        if (uri) g_app_info_launch_default_for_uri(uri, NULL, NULL);
    }
}

static void on_dbg_copy_diagnostics(GtkButton *b, gpointer d) {
    (void)b; (void)d;
    g_autofree gchar *text = build_diagnostics_text();
    GdkClipboard *cb = gdk_display_get_clipboard(gdk_display_get_default());
    gdk_clipboard_set_text(cb, text);
}

static void on_dbg_copy_journal_cmd(GtkButton *b, gpointer d) {
    (void)b; (void)d;
    const gchar *unit = systemd_get_canonical_unit_name();
    g_autofree gchar *cmd = g_strdup_printf("journalctl --user -u %s -f",
        unit ? unit : "openclaw-gateway.service");
    GdkClipboard *cb = gdk_display_get_clipboard(gdk_display_get_default());
    gdk_clipboard_set_text(cb, cmd);
}

static GtkWidget* build_debug_section(void) {
    GtkWidget *scrolled = gtk_scrolled_window_new();
    gtk_scrolled_window_set_policy(GTK_SCROLLED_WINDOW(scrolled),
                                   GTK_POLICY_NEVER, GTK_POLICY_AUTOMATIC);

    GtkWidget *page = gtk_box_new(GTK_ORIENTATION_VERTICAL, 8);
    gtk_widget_set_margin_start(page, 24);
    gtk_widget_set_margin_end(page, 24);
    gtk_widget_set_margin_top(page, 24);
    gtk_widget_set_margin_bottom(page, 24);

    GtkWidget *title = gtk_label_new("Debug");
    gtk_widget_add_css_class(title, "title-1");
    gtk_label_set_xalign(GTK_LABEL(title), 0.0);
    gtk_box_append(GTK_BOX(page), title);

    GtkWidget *subtitle = gtk_label_new("Advanced debugging tools.");
    gtk_widget_add_css_class(subtitle, "dim-label");
    gtk_label_set_xalign(GTK_LABEL(subtitle), 0.0);
    gtk_box_append(GTK_BOX(page), subtitle);

    /* Service state */
    GtkWidget *state_heading = gtk_label_new("Gateway Service");
    gtk_widget_add_css_class(state_heading, "heading");
    gtk_label_set_xalign(GTK_LABEL(state_heading), 0.0);
    gtk_widget_set_margin_top(state_heading, 12);
    gtk_box_append(GTK_BOX(page), state_heading);

    gtk_box_append(GTK_BOX(page), inst_card_row("Unit", &dbg_unit_label));
    gtk_box_append(GTK_BOX(page), inst_card_row("State", &dbg_state_label));

    /* Journal command */
    GtkWidget *journal_heading = gtk_label_new("Journal");
    gtk_widget_add_css_class(journal_heading, "heading");
    gtk_label_set_xalign(GTK_LABEL(journal_heading), 0.0);
    gtk_widget_set_margin_top(journal_heading, 12);
    gtk_box_append(GTK_BOX(page), journal_heading);

    dbg_journal_label = gtk_label_new("—");
    gtk_widget_add_css_class(dbg_journal_label, "monospace");
    gtk_label_set_selectable(GTK_LABEL(dbg_journal_label), TRUE);
    gtk_label_set_xalign(GTK_LABEL(dbg_journal_label), 0.0);
    gtk_label_set_wrap(GTK_LABEL(dbg_journal_label), TRUE);
    gtk_box_append(GTK_BOX(page), dbg_journal_label);

    GtkWidget *copy_journal_btn = gtk_button_new_with_label("Copy Journal Command");
    gtk_widget_set_halign(copy_journal_btn, GTK_ALIGN_START);
    gtk_widget_set_margin_top(copy_journal_btn, 4);
    g_signal_connect(copy_journal_btn, "clicked", G_CALLBACK(on_dbg_copy_journal_cmd), NULL);
    gtk_box_append(GTK_BOX(page), copy_journal_btn);

    /* Actions */
    GtkWidget *actions_heading = gtk_label_new("Actions");
    gtk_widget_add_css_class(actions_heading, "heading");
    gtk_label_set_xalign(GTK_LABEL(actions_heading), 0.0);
    gtk_widget_set_margin_top(actions_heading, 12);
    gtk_box_append(GTK_BOX(page), actions_heading);

    GtkWidget *row1 = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
    gtk_widget_set_margin_top(row1, 4);

    GtkWidget *refresh_btn = gtk_button_new_with_label("Trigger Health Refresh");
    g_signal_connect(refresh_btn, "clicked", G_CALLBACK(on_dbg_refresh_health), NULL);
    gtk_box_append(GTK_BOX(row1), refresh_btn);

    GtkWidget *restart_btn = gtk_button_new_with_label("Restart Gateway");
    g_signal_connect(restart_btn, "clicked", G_CALLBACK(on_dbg_restart_gw), NULL);
    gtk_box_append(GTK_BOX(row1), restart_btn);
    gtk_box_append(GTK_BOX(page), row1);

    GtkWidget *row2 = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
    gtk_widget_set_margin_top(row2, 4);

    GtkWidget *reveal_btn = gtk_button_new_with_label("Reveal Config Folder");
    g_signal_connect(reveal_btn, "clicked", G_CALLBACK(on_dbg_reveal_config), NULL);
    gtk_box_append(GTK_BOX(row2), reveal_btn);

    GtkWidget *copy_diag_btn = gtk_button_new_with_label("Copy Diagnostics Dump");
    g_signal_connect(copy_diag_btn, "clicked", G_CALLBACK(on_dbg_copy_diagnostics), NULL);
    gtk_box_append(GTK_BOX(row2), copy_diag_btn);
    gtk_box_append(GTK_BOX(page), row2);

    GtkWidget *onboard_btn = gtk_button_new_with_label("Restart Onboarding");
    gtk_widget_set_halign(onboard_btn, GTK_ALIGN_START);
    gtk_widget_set_margin_top(onboard_btn, 4);
    g_signal_connect(onboard_btn, "clicked", G_CALLBACK(on_dbg_rerun_onboarding), NULL);
    gtk_box_append(GTK_BOX(page), onboard_btn);

    gtk_scrolled_window_set_child(GTK_SCROLLED_WINDOW(scrolled), page);
    return scrolled;
}

static void refresh_debug_content(void) {
    if (!dbg_state_label) return;

    SystemdState *sys = state_get_systemd();
    if (sys->active_state && sys->sub_state) {
        g_autofree gchar *state_text = g_strdup_printf("%s (%s)", sys->active_state, sys->sub_state);
        gtk_label_set_text(GTK_LABEL(dbg_state_label), state_text);
    } else {
        gtk_label_set_text(GTK_LABEL(dbg_state_label),
            sys->active_state ? sys->active_state : "—");
    }

    gtk_label_set_text(GTK_LABEL(dbg_unit_label),
        sys->unit_name ? sys->unit_name : "—");

    const gchar *unit = systemd_get_canonical_unit_name();
    g_autofree gchar *cmd = g_strdup_printf("journalctl --user -u %s -f",
        unit ? unit : "openclaw-gateway.service");
    gtk_label_set_text(GTK_LABEL(dbg_journal_label), cmd);
}

/* ══════════════════════════════════════════════════════════════════
 * Sessions section (Tier B — entry point)
 *
 * Header, short description, "Open in Dashboard" action.
 * Full session management lives in the dashboard web UI.
 * ══════════════════════════════════════════════════════════════════ */

static void on_open_dashboard_for_section(GtkButton *b, gpointer d) {
    (void)b; (void)d;
    GatewayConfig *cfg = gateway_client_get_config();
    if (!cfg) return;
    g_autofree gchar *url = gateway_config_dashboard_url(cfg);
    if (url) g_app_info_launch_default_for_uri(url, NULL, NULL);
}

static GtkWidget* build_sessions_section(void) {
    GtkWidget *scrolled = gtk_scrolled_window_new();
    gtk_scrolled_window_set_policy(GTK_SCROLLED_WINDOW(scrolled),
                                   GTK_POLICY_NEVER, GTK_POLICY_AUTOMATIC);

    GtkWidget *page = gtk_box_new(GTK_ORIENTATION_VERTICAL, 12);
    gtk_widget_set_margin_start(page, 24);
    gtk_widget_set_margin_end(page, 24);
    gtk_widget_set_margin_top(page, 24);
    gtk_widget_set_margin_bottom(page, 24);

    GtkWidget *title = gtk_label_new("Sessions");
    gtk_widget_add_css_class(title, "title-1");
    gtk_label_set_xalign(GTK_LABEL(title), 0.0);
    gtk_box_append(GTK_BOX(page), title);

    GtkWidget *desc = gtk_label_new(
        "Sessions represent active messaging conversations between "
        "users and the AI agent. Each channel connection maintains "
        "its own session with message history and context.");
    gtk_label_set_wrap(GTK_LABEL(desc), TRUE);
    gtk_label_set_xalign(GTK_LABEL(desc), 0.0);
    gtk_box_append(GTK_BOX(page), desc);

    GtkWidget *info = gtk_label_new(
        "View and manage sessions in the gateway dashboard.");
    gtk_widget_add_css_class(info, "dim-label");
    gtk_label_set_xalign(GTK_LABEL(info), 0.0);
    gtk_box_append(GTK_BOX(page), info);

    GtkWidget *btn = gtk_button_new_with_label("Open in Dashboard");
    gtk_widget_add_css_class(btn, "suggested-action");
    gtk_widget_set_halign(btn, GTK_ALIGN_START);
    gtk_widget_set_margin_top(btn, 8);
    g_signal_connect(btn, "clicked", G_CALLBACK(on_open_dashboard_for_section), NULL);
    gtk_box_append(GTK_BOX(page), btn);

    gtk_scrolled_window_set_child(GTK_SCROLLED_WINDOW(scrolled), page);
    return scrolled;
}

/* ══════════════════════════════════════════════════════════════════
 * Cron section (Tier B — entry point)
 *
 * Header, short description, "Open in Dashboard" action.
 * Full cron management lives in the dashboard web UI.
 * ══════════════════════════════════════════════════════════════════ */

static GtkWidget* build_cron_section(void) {
    GtkWidget *scrolled = gtk_scrolled_window_new();
    gtk_scrolled_window_set_policy(GTK_SCROLLED_WINDOW(scrolled),
                                   GTK_POLICY_NEVER, GTK_POLICY_AUTOMATIC);

    GtkWidget *page = gtk_box_new(GTK_ORIENTATION_VERTICAL, 12);
    gtk_widget_set_margin_start(page, 24);
    gtk_widget_set_margin_end(page, 24);
    gtk_widget_set_margin_top(page, 24);
    gtk_widget_set_margin_bottom(page, 24);

    GtkWidget *title = gtk_label_new("Cron");
    gtk_widget_add_css_class(title, "title-1");
    gtk_label_set_xalign(GTK_LABEL(title), 0.0);
    gtk_box_append(GTK_BOX(page), title);

    GtkWidget *desc = gtk_label_new(
        "Cron jobs allow the AI agent to perform scheduled tasks "
        "automatically. Configure recurring actions, periodic checks, "
        "and timed workflows.");
    gtk_label_set_wrap(GTK_LABEL(desc), TRUE);
    gtk_label_set_xalign(GTK_LABEL(desc), 0.0);
    gtk_box_append(GTK_BOX(page), desc);

    GtkWidget *info = gtk_label_new(
        "View and manage cron jobs in the gateway dashboard.");
    gtk_widget_add_css_class(info, "dim-label");
    gtk_label_set_xalign(GTK_LABEL(info), 0.0);
    gtk_box_append(GTK_BOX(page), info);

    GtkWidget *btn = gtk_button_new_with_label("Open in Dashboard");
    gtk_widget_add_css_class(btn, "suggested-action");
    gtk_widget_set_halign(btn, GTK_ALIGN_START);
    gtk_widget_set_margin_top(btn, 8);
    g_signal_connect(btn, "clicked", G_CALLBACK(on_open_dashboard_for_section), NULL);
    gtk_box_append(GTK_BOX(page), btn);

    gtk_scrolled_window_set_child(GTK_SCROLLED_WINDOW(scrolled), page);
    return scrolled;
}

/* ── Auto-refresh timer ── */

static gboolean on_refresh_tick(gpointer user_data) {
    (void)user_data;
    if (main_window) {
        refresh_dashboard_content();
        refresh_general_content();
        refresh_config_content();
        refresh_diagnostics_content();
        refresh_environment_content();
        refresh_instances_content();
        refresh_debug_content();
        return G_SOURCE_CONTINUE;
    }
    refresh_timer_id = 0;
    return G_SOURCE_REMOVE;
}

/* ── Window lifecycle ── */

static void on_window_destroy(GtkWindow *window, gpointer user_data) {
    (void)window;
    (void)user_data;

    if (refresh_timer_id > 0) {
        g_source_remove(refresh_timer_id);
        refresh_timer_id = 0;
    }

    main_window = NULL;
    content_stack = NULL;
    sidebar_list = NULL;

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

    gen_status_label = NULL;
    gen_runtime_label = NULL;
    gen_service_notice_label = NULL;
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

    cfg_status_label = NULL;
    cfg_path_label = NULL;
    cfg_modified_label = NULL;
    cfg_warning_label = NULL;
    cfg_issues_label = NULL;
    cfg_json_view = NULL;
    if (cfg_copy_reset_id > 0) {
        g_source_remove(cfg_copy_reset_id);
        cfg_copy_reset_id = 0;
    }
    cfg_copy_btn = NULL;

    if (diag_copy_reset_id > 0) {
        g_source_remove(diag_copy_reset_id);
        diag_copy_reset_id = 0;
    }
    diag_text_view = NULL;
    diag_copy_btn = NULL;

    env_checks_box = NULL;

    inst_hostname_label = NULL;
    inst_platform_label = NULL;
    inst_version_label = NULL;
    inst_runtime_label = NULL;
    inst_endpoint_label = NULL;
    inst_unit_label = NULL;
    inst_state_label = NULL;

    dbg_state_label = NULL;
    dbg_unit_label = NULL;
    dbg_journal_label = NULL;

    memset(section_pages, 0, sizeof(section_pages));
}

/* ── Public API ── */

void app_window_show(void) {
    if (main_window) {
        gtk_window_present(GTK_WINDOW(main_window));
        return;
    }

    GApplication *app = g_application_get_default();
    if (!app) return;

    main_window = adw_application_window_new(GTK_APPLICATION(app));
    gtk_window_set_title(GTK_WINDOW(main_window), "OpenClaw");
    gtk_window_set_default_size(GTK_WINDOW(main_window), 820, 600);

    /* Build split layout */
    AdwNavigationSplitView *split = ADW_NAVIGATION_SPLIT_VIEW(adw_navigation_split_view_new());

    /* Sidebar pane */
    GtkWidget *sidebar_content = build_sidebar();
    AdwNavigationPage *sidebar_page = adw_navigation_page_new(sidebar_content, "OpenClaw");
    adw_navigation_split_view_set_sidebar(split, sidebar_page);

    /* Content pane */
    GtkWidget *stack = build_content_stack();
    AdwNavigationPage *content_page = adw_navigation_page_new(stack, "Dashboard");
    adw_navigation_split_view_set_content(split, content_page);

    adw_application_window_set_content(ADW_APPLICATION_WINDOW(main_window), GTK_WIDGET(split));

    /* Select dashboard row by default */
    GtkListBoxRow *first = gtk_list_box_get_row_at_index(GTK_LIST_BOX(sidebar_list), 0);
    if (first) {
        gtk_list_box_select_row(GTK_LIST_BOX(sidebar_list), first);
    }

    g_signal_connect(main_window, "destroy", G_CALLBACK(on_window_destroy), NULL);

    /* Initial content fill for ALL sections + start auto-refresh */
    refresh_dashboard_content();
    refresh_general_content();
    refresh_config_content();
    refresh_diagnostics_content();
    refresh_environment_content();
    refresh_instances_content();
    refresh_debug_content();
    refresh_timer_id = g_timeout_add_seconds(1, on_refresh_tick, NULL);

    gtk_window_present(GTK_WINDOW(main_window));
}

void app_window_navigate_to(AppSection section) {
    if (section < 0 || section >= SECTION_COUNT) return;

    app_window_show();

    if (content_stack) {
        gtk_stack_set_visible_child_name(GTK_STACK(content_stack), section_meta[section].id);
    }
    if (sidebar_list) {
        GtkListBoxRow *row = gtk_list_box_get_row_at_index(GTK_LIST_BOX(sidebar_list), section);
        if (row) {
            gtk_list_box_select_row(GTK_LIST_BOX(sidebar_list), row);
        }
    }
}

gboolean app_window_is_visible(void) {
    return main_window != NULL;
}
