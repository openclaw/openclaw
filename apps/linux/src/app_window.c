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
#include "gateway_rpc.h"
#include "gateway_data.h"
#include "gateway_mutations.h"
#include "json_access.h"
#include "config_setup_transform.h"
#include "section_channels.h"
#include "section_skills.h"
#include "section_sessions.h"
#include "section_cron.h"
#include "section_instances.h"
#include "section_chat.h"
#include "section_agents.h"
#include "section_usage.h"
#include "section_logs.h"
#include "section_control_room.h"
#include "section_workflows.h"
#include "ui_model_utils.h"
#include "log.h"

/* ── Section metadata ── */

typedef struct {
    const char *id;
    const char *title;
    const char *icon_name;
} SectionMeta;

static const SectionMeta section_meta[SECTION_COUNT] = {
    [SECTION_DASHBOARD]    = { "dashboard",    "Dashboard",    "computer-symbolic" },
    [SECTION_CHAT]         = { "chat",         "Chat",         "chat-bubbles-symbolic" },
    [SECTION_AGENTS]       = { "agents",       "Agents",       "avatar-default-symbolic" },
    [SECTION_USAGE]        = { "usage",        "Usage",        "view-statistics-symbolic" },
    [SECTION_GENERAL]      = { "general",      "General",      "preferences-system-symbolic" },
    [SECTION_CONFIG]       = { "config",       "Config",       "document-properties-symbolic" },
    [SECTION_CHANNELS]     = { "channels",     "Channels",     "mail-send-symbolic" },
    [SECTION_SKILLS]       = { "skills",       "Skills",       "applications-science-symbolic" },
    [SECTION_WORKFLOWS]    = { "workflows",    "Workflows",    "view-list-bullet-symbolic" },
    [SECTION_CONTROL_ROOM] = { "control-room", "Control Room", "applications-system-symbolic" },
    [SECTION_ENVIRONMENT]  = { "environment",  "Environment",  "system-run-symbolic" },
    [SECTION_DIAGNOSTICS]  = { "diagnostics",  "Diagnostics",  "utilities-system-monitor-symbolic" },
    [SECTION_LOGS]         = { "logs",         "Logs",         "text-x-log-symbolic" },
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
static GtkWidget *shell_gateway_status_label = NULL;
static GtkWidget *shell_gateway_status_dot = NULL;
static GtkWidget *shell_service_status_label = NULL;
static GtkWidget *shell_service_status_dot = NULL;
static guint refresh_timer_id = 0;
static AppSection active_section = SECTION_DASHBOARD;
static gboolean last_rpc_ready = FALSE;
static AppState last_app_state = STATE_NEEDS_SETUP;
static gboolean shell_seen_gateway_connected = FALSE;
static gboolean app_css_installed = FALSE;
static gboolean window_shutting_down = FALSE;

/* Section content widgets that need updating */
static GtkWidget *section_pages[SECTION_COUNT] = {0};

/* Section controllers for RPC-backed sections (NULL for local-only sections) */
static const SectionController *section_controllers[SECTION_COUNT] = {0};

/* ── Forward declarations ── */

static GtkWidget* build_placeholder_section(AppSection section);
static GtkWidget* build_dashboard_section(void);
static GtkWidget* build_general_section(void);
static GtkWidget* build_config_section(void);
static GtkWidget* build_diagnostics_section(void);
static GtkWidget* build_environment_section(void);
static GtkWidget* build_about_section(void);
static GtkWidget* build_debug_section(void);
static void refresh_dashboard_content(void);
static void refresh_general_content(void);
static void refresh_config_content(void);
static void refresh_diagnostics_content(void);
static void refresh_environment_content(void);
static void refresh_debug_content(void);
static void refresh_shell_status_footer(void);
static void ensure_app_css_loaded(void);
static void on_sidebar_row_activated(GtkListBox *box, GtkListBoxRow *row, gpointer user_data);
static void on_window_destroy(GtkWindow *window, gpointer user_data);

/* Integrated (non-controller) surfaces are lifecycle-sensitive: refresh helpers
 * must treat widget pointers as ephemeral and no-op during shutdown/teardown. */
static inline gboolean app_window_can_refresh_integrated(void) {
    return !window_shutting_down && main_window != NULL;
}

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
    GtkWidget *sidebar_shell = gtk_box_new(GTK_ORIENTATION_VERTICAL, 0);

    GtkWidget *scrolled = gtk_scrolled_window_new();
    gtk_scrolled_window_set_policy(GTK_SCROLLED_WINDOW(scrolled),
                                   GTK_POLICY_NEVER, GTK_POLICY_AUTOMATIC);
    gtk_widget_set_size_request(scrolled, 200, -1);
    gtk_widget_set_vexpand(scrolled, TRUE);

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
    gtk_box_append(GTK_BOX(sidebar_shell), scrolled);

    GtkWidget *footer_sep = gtk_separator_new(GTK_ORIENTATION_HORIZONTAL);
    gtk_box_append(GTK_BOX(sidebar_shell), footer_sep);

    GtkWidget *footer = gtk_box_new(GTK_ORIENTATION_VERTICAL, 4);
    gtk_widget_set_margin_start(footer, 10);
    gtk_widget_set_margin_end(footer, 10);
    gtk_widget_set_margin_top(footer, 8);
    gtk_widget_set_margin_bottom(footer, 8);

    GtkWidget *gateway_row = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 6);
    shell_gateway_status_dot = gtk_label_new("●");
    gtk_widget_add_css_class(shell_gateway_status_dot, "status-dot");
    gtk_box_append(GTK_BOX(gateway_row), shell_gateway_status_dot);
    shell_gateway_status_label = gtk_label_new("Gateway: Connecting");
    gtk_label_set_xalign(GTK_LABEL(shell_gateway_status_label), 0.0);
    gtk_widget_set_hexpand(shell_gateway_status_label, TRUE);
    gtk_box_append(GTK_BOX(gateway_row), shell_gateway_status_label);
    gtk_box_append(GTK_BOX(footer), gateway_row);

    GtkWidget *service_row = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 6);
    shell_service_status_dot = gtk_label_new("●");
    gtk_widget_add_css_class(shell_service_status_dot, "status-dot");
    gtk_box_append(GTK_BOX(service_row), shell_service_status_dot);
    shell_service_status_label = gtk_label_new("Service: Inactive");
    gtk_label_set_xalign(GTK_LABEL(shell_service_status_label), 0.0);
    gtk_widget_set_hexpand(shell_service_status_label, TRUE);
    gtk_box_append(GTK_BOX(service_row), shell_service_status_label);
    gtk_box_append(GTK_BOX(footer), service_row);

    gtk_box_append(GTK_BOX(sidebar_shell), footer);
    return sidebar_shell;
}

static void clear_status_dot_classes(GtkWidget *dot) {
    if (!dot) return;
    gtk_widget_remove_css_class(dot, "connected");
    gtk_widget_remove_css_class(dot, "disconnected");
    gtk_widget_remove_css_class(dot, "connecting");
    gtk_widget_remove_css_class(dot, "service-inactive");
}

static void refresh_shell_status_footer(void) {
    if (!shell_gateway_status_label || !shell_gateway_status_dot ||
        !shell_service_status_label || !shell_service_status_dot) {
        return;
    }

    SystemdState *sys = state_get_systemd();
    HealthState *health = state_get_health();

    gboolean service_active = (sys && sys->active);
    gboolean gateway_connected = (health && health->http_ok && health->ws_connected);
    if (gateway_connected) {
        shell_seen_gateway_connected = TRUE;
    }

    const char *gateway_label = "Gateway: Connecting";

    clear_status_dot_classes(shell_gateway_status_dot);
    clear_status_dot_classes(shell_service_status_dot);

    if (!service_active) {
        gateway_label = "Gateway: Service inactive";
        gtk_widget_add_css_class(shell_gateway_status_dot, "service-inactive");
    } else if (gateway_connected) {
        gateway_label = "Gateway: Connected";
        gtk_widget_add_css_class(shell_gateway_status_dot, "connected");
    } else if (shell_seen_gateway_connected) {
        gateway_label = "Gateway: Disconnected";
        gtk_widget_add_css_class(shell_gateway_status_dot, "disconnected");
    } else {
        gateway_label = "Gateway: Connecting";
        gtk_widget_add_css_class(shell_gateway_status_dot, "connecting");
    }

    gtk_label_set_text(GTK_LABEL(shell_gateway_status_label), gateway_label);

    if (service_active) {
        gtk_widget_add_css_class(shell_service_status_dot, "connected");
        gtk_label_set_text(GTK_LABEL(shell_service_status_label), "Service: Active");
    } else {
        gtk_widget_add_css_class(shell_service_status_dot, "service-inactive");
        gtk_label_set_text(GTK_LABEL(shell_service_status_label), "Service: Inactive");
    }
}

static void ensure_app_css_loaded(void) {
    if (app_css_installed) return;

    const char *css =
        ".status-dot {"
        "  font-size: 12px;"
        "  font-weight: 700;"
        "}"
        ".status-dot.connected { color: #33d17a; }"
        ".status-dot.disconnected { color: #e01b24; }"
        ".status-dot.service-inactive { color: #77767b; }"
        ".status-dot.connecting {"
        "  color: #e5a50a;"
        "  animation: openclaw-pulse 1.1s ease-in-out infinite;"
        "}"
        "@keyframes openclaw-pulse {"
        "  0% { opacity: 0.35; }"
        "  50% { opacity: 1; }"
        "  100% { opacity: 0.35; }"
        "}";

    GtkCssProvider *provider = gtk_css_provider_new();
    gtk_css_provider_load_from_string(provider, css);

    GdkDisplay *display = gdk_display_get_default();
    if (display) {
        gtk_style_context_add_provider_for_display(
            display,
            GTK_STYLE_PROVIDER(provider),
            GTK_STYLE_PROVIDER_PRIORITY_APPLICATION);
        app_css_installed = TRUE;
    }

    g_object_unref(provider);
}

/* ── Content stack ── */

static GtkWidget* build_content_stack(void) {
    content_stack = gtk_stack_new();
    gtk_stack_set_transition_type(GTK_STACK(content_stack), GTK_STACK_TRANSITION_TYPE_CROSSFADE);
    gtk_stack_set_transition_duration(GTK_STACK(content_stack), 150);

    /* Register section controllers for RPC-backed sections */
    section_controllers[SECTION_CHAT]      = section_chat_get();
    section_controllers[SECTION_AGENTS]    = section_agents_get();
    section_controllers[SECTION_USAGE]     = section_usage_get();
    section_controllers[SECTION_CHANNELS]  = section_channels_get();
    section_controllers[SECTION_SKILLS]    = section_skills_get();
    section_controllers[SECTION_WORKFLOWS] = section_workflows_get();
    section_controllers[SECTION_CONTROL_ROOM] = section_control_room_get();
    section_controllers[SECTION_LOGS]      = section_logs_get();
    section_controllers[SECTION_SESSIONS]  = section_sessions_get();
    section_controllers[SECTION_CRON]      = section_cron_get();
    section_controllers[SECTION_INSTANCES] = section_instances_get();

    for (int i = 0; i < SECTION_COUNT; i++) {
        GtkWidget *page;
        if (section_controllers[i]) {
            page = section_controllers[i]->build();
        } else if (i == SECTION_DASHBOARD) {
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
        } else if (i == SECTION_DEBUG) {
            page = build_debug_section();
        } else {
            page = build_placeholder_section((AppSection)i);
        }
        section_pages[i] = page;
        gtk_stack_add_named(GTK_STACK(content_stack), page, section_meta[i].id);
    }

    return content_stack;
}

/* ── Sidebar row activation ── */

static void refresh_active_rpc_section(AppSection section) {
    if (section >= 0 && section < SECTION_COUNT && section_controllers[section]) {
        section_controllers[section]->refresh();
    }
}

static void refresh_active_integrated_section(AppSection section) {
    switch (section) {
    case SECTION_DASHBOARD:
        refresh_dashboard_content();
        break;
    case SECTION_GENERAL:
        refresh_general_content();
        break;
    case SECTION_CONFIG:
        refresh_config_content();
        break;
    case SECTION_DIAGNOSTICS:
        refresh_diagnostics_content();
        break;
    case SECTION_ENVIRONMENT:
        refresh_environment_content();
        break;
    case SECTION_INSTANCES:
        section_instances_refresh_local();
        break;
    case SECTION_DEBUG:
        refresh_debug_content();
        break;
    default:
        break;
    }
}

static void invalidate_all_rpc_sections(void) {
    for (int i = 0; i < SECTION_COUNT; i++) {
        if (section_controllers[i] && section_controllers[i]->invalidate) {
            section_controllers[i]->invalidate();
        }
    }
}

static void on_sidebar_row_activated(GtkListBox *box, GtkListBoxRow *row, gpointer user_data) {
    (void)box;
    (void)user_data;

    int idx = gtk_list_box_row_get_index(row);
    if (idx >= 0 && idx < SECTION_COUNT) {
        active_section = (AppSection)idx;
        gtk_stack_set_visible_child_name(GTK_STACK(content_stack), section_meta[idx].id);
        refresh_active_integrated_section(active_section);
        refresh_active_rpc_section(active_section);
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
    if (!app_window_can_refresh_integrated()) return;

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
    if (!app_window_can_refresh_integrated()) return;
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

    RuntimePathStatus general_paths = {0};
    runtime_path_status_build(config_path, state_dir, NULL, &general_paths);

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
    gtk_label_set_text(GTK_LABEL(gen_profile_label),
        profile_display);

    runtime_path_status_clear(&general_paths);

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
static GtkWidget *cfg_validation_label = NULL;
static GtkWidget *cfg_copy_btn = NULL;
static GtkWidget *cfg_reload_btn = NULL;
static GtkWidget *cfg_save_btn = NULL;
static GtkWidget *cfg_setup_summary_label = NULL;
static GtkWidget *cfg_setup_status_label = NULL;
static GtkWidget *cfg_provider_id_entry = NULL;
static GtkWidget *cfg_provider_base_url_entry = NULL;
static GtkWidget *cfg_reload_models_btn = NULL;
static GtkWidget *cfg_model_dropdown = NULL;
static GtkStringList *cfg_model_dropdown_model = NULL;
static GtkWidget *cfg_apply_provider_btn = NULL;
static GtkWidget *cfg_apply_model_btn = NULL;
static guint cfg_copy_reset_id = 0;
static gboolean cfg_programmatic_change = FALSE;
static gboolean cfg_editor_dirty = FALSE;
static gboolean cfg_editor_valid = TRUE;
static gboolean cfg_request_in_flight = FALSE;
static gboolean cfg_initial_load_requested = FALSE;
static gchar *cfg_baseline_text = NULL;
static gchar *cfg_baseline_hash = NULL;
static guint cfg_generation = 1;
static gboolean cfg_models_request_in_flight = FALSE;
static GPtrArray *cfg_models_cache = NULL;

typedef struct {
    gchar *id;
    gchar *label;
} ConfigModelChoice;

typedef struct {
    guint generation;
} ConfigRequestContext;

static gchar* cfg_editor_get_text(void);
static void cfg_request_reload(void);
static void cfg_refresh_setup_surface(void);
static void on_cfg_save_done(const GatewayRpcResponse *response, gpointer user_data);

static ConfigRequestContext* cfg_request_context_new(void) {
    ConfigRequestContext *ctx = g_new0(ConfigRequestContext, 1);
    ctx->generation = cfg_generation;
    return ctx;
}

static gboolean cfg_request_context_is_stale(const ConfigRequestContext *ctx) {
    return !ctx || ctx->generation != cfg_generation;
}

static void cfg_request_context_free(gpointer data) {
    g_free(data);
}

static void cfg_model_choice_free(ConfigModelChoice *choice) {
    if (!choice) return;
    g_free(choice->id);
    g_free(choice->label);
    g_free(choice);
}

static void cfg_attach_model_dropdown_model(GtkStringList *new_model,
                                            guint selected,
                                            gboolean enabled) {
    if (!new_model) return;
    ui_dropdown_replace_model(cfg_model_dropdown,
                              (gpointer *)&cfg_model_dropdown_model,
                              G_LIST_MODEL(new_model),
                              selected,
                              enabled);
}

static void cfg_set_model_dropdown_placeholder(const gchar *label,
                                               gboolean enabled) {
    GtkStringList *new_model = gtk_string_list_new(NULL);
    gtk_string_list_append(new_model, label && label[0] != '\0' ? label : "No models loaded");
    cfg_attach_model_dropdown_model(new_model, 0, enabled);
}

static gchar* cfg_extract_default_model_id(JsonObject *root_obj) {
    if (!root_obj || !json_object_has_member(root_obj, "agents")) return NULL;
    JsonNode *agents_node = json_object_get_member(root_obj, "agents");
    if (!agents_node || !JSON_NODE_HOLDS_OBJECT(agents_node)) return NULL;
    JsonObject *agents_obj = json_node_get_object(agents_node);

    JsonObject *defaults_obj = NULL;
    if (json_object_has_member(agents_obj, "defaults")) {
        JsonNode *defaults_node = json_object_get_member(agents_obj, "defaults");
        if (defaults_node && JSON_NODE_HOLDS_OBJECT(defaults_node)) {
            defaults_obj = json_node_get_object(defaults_node);
        }
    }
    if (!defaults_obj && json_object_has_member(agents_obj, "default")) {
        JsonNode *defaults_node = json_object_get_member(agents_obj, "default");
        if (defaults_node && JSON_NODE_HOLDS_OBJECT(defaults_node)) {
            defaults_obj = json_node_get_object(defaults_node);
        }
    }
    if (!defaults_obj || !json_object_has_member(defaults_obj, "model")) return NULL;

    JsonNode *model_node = json_object_get_member(defaults_obj, "model");
    if (model_node && JSON_NODE_HOLDS_VALUE(model_node) &&
        json_node_get_value_type(model_node) == G_TYPE_STRING) {
        const gchar *model = json_node_get_string(model_node);
        return (model && model[0] != '\0') ? g_strdup(model) : NULL;
    }
    if (model_node && JSON_NODE_HOLDS_OBJECT(model_node)) {
        JsonObject *model_obj = json_node_get_object(model_node);
        const gchar *primary = oc_json_string_member(model_obj, "primary");
        return (primary && primary[0] != '\0') ? g_strdup(primary) : NULL;
    }

    return NULL;
}

static gboolean cfg_set_editor_text_programmatically(const gchar *text) {
    if (!cfg_json_view) return FALSE;
    GtkTextBuffer *buf = gtk_text_view_get_buffer(GTK_TEXT_VIEW(cfg_json_view));
    cfg_programmatic_change = TRUE;
    gtk_text_buffer_set_text(buf, text ? text : "{}", -1);
    cfg_programmatic_change = FALSE;
    return TRUE;
}

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
    g_autofree gchar *contents = cfg_editor_get_text();
    if (!contents) return;

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

static gchar* cfg_editor_get_text(void) {
    if (!cfg_json_view) return g_strdup("");
    GtkTextBuffer *buf = gtk_text_view_get_buffer(GTK_TEXT_VIEW(cfg_json_view));
    GtkTextIter start;
    GtkTextIter end;
    gtk_text_buffer_get_bounds(buf, &start, &end);
    return gtk_text_buffer_get_text(buf, &start, &end, FALSE);
}

static void cfg_refresh_buttons(void) {
    if (cfg_reload_btn) {
        gtk_widget_set_sensitive(cfg_reload_btn, !cfg_request_in_flight);
    }
    if (cfg_save_btn) {
        gtk_widget_set_sensitive(cfg_save_btn,
            !cfg_request_in_flight && cfg_editor_dirty && cfg_editor_valid);
    }
    if (cfg_reload_models_btn) {
        gtk_widget_set_sensitive(cfg_reload_models_btn,
                                 !cfg_request_in_flight && !cfg_models_request_in_flight);
    }
    if (cfg_apply_provider_btn) {
        gtk_widget_set_sensitive(cfg_apply_provider_btn,
                                 !cfg_request_in_flight && cfg_editor_valid);
    }
    if (cfg_apply_model_btn) {
        gboolean has_models = cfg_models_cache && cfg_models_cache->len > 0;
        gtk_widget_set_sensitive(cfg_apply_model_btn,
                                 !cfg_request_in_flight && has_models && cfg_editor_valid);
    }
}

static gboolean cfg_validate_and_track(const gchar *text) {
    g_autoptr(JsonParser) parser = json_parser_new();
    g_autoptr(GError) err = NULL;
    gboolean valid = json_parser_load_from_data(parser, text ? text : "", -1, &err);

    if (valid) {
        JsonNode *root = json_parser_get_root(parser);
        valid = (root && JSON_NODE_HOLDS_OBJECT(root));
        if (!valid && cfg_validation_label) {
            gtk_label_set_text(GTK_LABEL(cfg_validation_label), "Validation: root value must be a JSON object");
        }
    } else if (cfg_validation_label) {
        g_autofree gchar *msg = g_strdup_printf("Validation: %s",
            err && err->message ? err->message : "invalid JSON");
        gtk_label_set_text(GTK_LABEL(cfg_validation_label), msg);
    }

    if (valid && cfg_validation_label) {
        gtk_label_set_text(GTK_LABEL(cfg_validation_label), "Validation: JSON is valid");
    }

    cfg_editor_valid = valid;
    cfg_editor_dirty = (g_strcmp0(text ? text : "", cfg_baseline_text ? cfg_baseline_text : "") != 0);
    cfg_refresh_buttons();
    return valid;
}

static void cfg_request_save_text(const gchar *text) {
    if (cfg_request_in_flight) return;
    if (!cfg_validate_and_track(text)) return;
    if (!cfg_editor_dirty) {
        if (cfg_setup_status_label) {
            gtk_label_set_text(GTK_LABEL(cfg_setup_status_label), "No config changes to save.");
        }
        return;
    }

    cfg_request_in_flight = TRUE;
    cfg_refresh_buttons();
    ConfigRequestContext *ctx = cfg_request_context_new();
    g_autofree gchar *rid = mutation_config_set(text, cfg_baseline_hash, on_cfg_save_done, ctx);
    if (!rid) {
        cfg_request_context_free(ctx);
        cfg_request_in_flight = FALSE;
        if (cfg_validation_label) {
            gtk_label_set_text(GTK_LABEL(cfg_validation_label), "Failed to request config.set");
        }
        if (cfg_setup_status_label) {
            gtk_label_set_text(GTK_LABEL(cfg_setup_status_label), "Provider/model save request failed.");
        }
        cfg_refresh_buttons();
    }
}

static void cfg_rebuild_models_dropdown(const gchar *default_model_id) {
    GtkStringList *new_model = gtk_string_list_new(NULL);
    guint selected = 0;
    for (guint i = 0; cfg_models_cache && i < cfg_models_cache->len; i++) {
        ConfigModelChoice *choice = g_ptr_array_index(cfg_models_cache, i);
        gtk_string_list_append(new_model, choice->label ? choice->label : choice->id);
        if (default_model_id && choice->id && g_strcmp0(choice->id, default_model_id) == 0) {
            selected = i;
        }
    }
    if (cfg_models_cache && cfg_models_cache->len > 0) {
        cfg_attach_model_dropdown_model(new_model, selected, TRUE);
    } else {
        cfg_attach_model_dropdown_model(new_model, 0, FALSE);
    }
}

static void cfg_refresh_setup_surface(void) {
    g_autofree gchar *text = cfg_editor_get_text();
    g_autoptr(JsonParser) parser = json_parser_new();
    g_autoptr(GError) err = NULL;

    const gchar *provider_id = NULL;
    const gchar *provider_base_url = NULL;
    g_autofree gchar *default_model_id = NULL;

    if (json_parser_load_from_data(parser, text ? text : "", -1, &err)) {
        JsonNode *root = json_parser_get_root(parser);
        if (root && JSON_NODE_HOLDS_OBJECT(root)) {
            JsonObject *root_obj = json_node_get_object(root);
            default_model_id = cfg_extract_default_model_id(root_obj);

            if (json_object_has_member(root_obj, "models")) {
                JsonNode *models_node = json_object_get_member(root_obj, "models");
                if (models_node && JSON_NODE_HOLDS_OBJECT(models_node)) {
                    JsonObject *models_obj = json_node_get_object(models_node);
                    if (json_object_has_member(models_obj, "providers")) {
                        JsonNode *providers_node = json_object_get_member(models_obj, "providers");
                        if (providers_node && JSON_NODE_HOLDS_OBJECT(providers_node)) {
                            JsonObject *providers_obj = json_node_get_object(providers_node);
                            GList *members = json_object_get_members(providers_obj);
                            if (members) {
                                provider_id = members->data;
                                JsonNode *provider_node = json_object_get_member(providers_obj, provider_id);
                                if (provider_node && JSON_NODE_HOLDS_OBJECT(provider_node)) {
                                    JsonObject *provider_obj = json_node_get_object(provider_node);
                                    provider_base_url = oc_json_string_member(provider_obj, "baseUrl");
                                }
                            }
                            g_list_free(members);
                        }
                    }
                }
            }
        }
    }

    if (cfg_provider_id_entry) {
        gtk_editable_set_text(GTK_EDITABLE(cfg_provider_id_entry), provider_id ? provider_id : "");
    }
    if (cfg_provider_base_url_entry) {
        gtk_editable_set_text(GTK_EDITABLE(cfg_provider_base_url_entry), provider_base_url ? provider_base_url : "");
    }
    const DesktopReadinessSnapshot *snap = state_get_readiness_snapshot();
    ChatGateInfo gate = {0};
    readiness_describe_chat_gate(snap, &gate);
    if (cfg_setup_summary_label) {
        g_autofree gchar *summary = g_strdup_printf(
            "Provider: %s | Default model: %s | Catalog: %s | Selected: %s | Agents: %s | Chat: %s (%s)",
            provider_id && provider_id[0] != '\0' ? provider_id : "missing",
            default_model_id ? default_model_id : "missing",
            snap && snap->model_catalog_available ? "ready" : "missing",
            snap && snap->selected_model_resolved ? "resolved" : "unresolved",
            snap && snap->agents_available ? "ready" : "missing",
            gate.ready ? "ready" : "blocked",
            readiness_chat_block_reason_to_string(gate.reason));
        gtk_label_set_text(GTK_LABEL(cfg_setup_summary_label), summary);
    }

    if (cfg_setup_status_label) {
        if (gate.ready) {
            gtk_label_set_text(GTK_LABEL(cfg_setup_status_label), "Chat is ready.");
        } else {
            g_autofree gchar *status = g_strdup_printf("Blocked (%s). %s",
                                                       readiness_chat_block_reason_to_string(gate.reason),
                                                       gate.next_action ? gate.next_action : "Resolve provider/model readiness.");
            gtk_label_set_text(GTK_LABEL(cfg_setup_status_label), status);
        }
    }

    if (cfg_models_cache && cfg_models_cache->len > 0) {
        cfg_rebuild_models_dropdown(default_model_id);
    } else {
        cfg_set_model_dropdown_placeholder("Load models to pick default", FALSE);
    }
    cfg_refresh_buttons();
}

static void on_cfg_models_list_done(const GatewayRpcResponse *response, gpointer user_data) {
    ConfigRequestContext *ctx = (ConfigRequestContext *)user_data;
    if (cfg_request_context_is_stale(ctx)) {
        cfg_request_context_free(ctx);
        return;
    }
    cfg_request_context_free(ctx);

    cfg_models_request_in_flight = FALSE;
    if (cfg_models_cache) g_ptr_array_unref(cfg_models_cache);
    cfg_models_cache = g_ptr_array_new_with_free_func((GDestroyNotify)cfg_model_choice_free);

    if (!response || !response->ok || !response->payload || !JSON_NODE_HOLDS_OBJECT(response->payload)) {
        if (cfg_setup_status_label) {
            gtk_label_set_text(GTK_LABEL(cfg_setup_status_label), "Failed to reload models from gateway.");
        }
        cfg_set_model_dropdown_placeholder("Model list unavailable", FALSE);
        cfg_refresh_buttons();
        return;
    }

    JsonObject *obj = json_node_get_object(response->payload);
    JsonNode *models_node = json_object_get_member(obj, "models");
    if (models_node && JSON_NODE_HOLDS_ARRAY(models_node)) {
        JsonArray *arr = json_node_get_array(models_node);
        for (guint i = 0; i < json_array_get_length(arr); i++) {
            JsonNode *n = json_array_get_element(arr, i);
            if (!n || !JSON_NODE_HOLDS_OBJECT(n)) continue;
            JsonObject *mo = json_node_get_object(n);
            const gchar *id = oc_json_string_member(mo, "id");
            if (!id || id[0] == '\0') continue;
            const gchar *name = oc_json_string_member(mo, "name");
            const gchar *provider = oc_json_string_member(mo, "provider");
            ConfigModelChoice *choice = g_new0(ConfigModelChoice, 1);
            choice->id = g_strdup(id);
            choice->label = g_strdup_printf("%s (%s)", name ? name : id, provider ? provider : "provider");
            g_ptr_array_add(cfg_models_cache, choice);
        }
    }

    if (active_section == SECTION_CONFIG) {
        cfg_refresh_setup_surface();
    }
    if (cfg_setup_status_label) {
        g_autofree gchar *msg = g_strdup_printf("Loaded %u model(s) from gateway.", cfg_models_cache->len);
        gtk_label_set_text(GTK_LABEL(cfg_setup_status_label), msg);
    }
}

static void on_cfg_reload_models(GtkButton *button, gpointer user_data) {
    (void)button;
    (void)user_data;
    if (cfg_models_request_in_flight) return;

    cfg_models_request_in_flight = TRUE;
    cfg_refresh_buttons();
    ConfigRequestContext *ctx = cfg_request_context_new();
    g_autofree gchar *rid = gateway_rpc_request("models.list", NULL, 0, on_cfg_models_list_done, ctx);
    if (!rid) {
        cfg_request_context_free(ctx);
        cfg_models_request_in_flight = FALSE;
        if (cfg_setup_status_label) {
            gtk_label_set_text(GTK_LABEL(cfg_setup_status_label), "Failed to request models.list.");
        }
        cfg_refresh_buttons();
        gateway_client_request_dependency_refresh();
        return;
    }

    gateway_client_invalidate_dependencies(TRUE, FALSE);
    gateway_client_request_dependency_refresh();
}

static void on_cfg_apply_provider(GtkButton *button, gpointer user_data) {
    (void)button;
    (void)user_data;
    g_autofree gchar *provider_id = g_strdup(
        gtk_editable_get_text(GTK_EDITABLE(cfg_provider_id_entry)));
    g_autofree gchar *base_url = g_strdup(
        gtk_editable_get_text(GTK_EDITABLE(cfg_provider_base_url_entry)));

    if (!provider_id || provider_id[0] == '\0') {
        if (cfg_setup_status_label) {
            gtk_label_set_text(GTK_LABEL(cfg_setup_status_label), "Provider id is required.");
        }
        return;
    }

    if (!cfg_editor_valid) {
        if (cfg_setup_status_label) {
            gtk_label_set_text(GTK_LABEL(cfg_setup_status_label), "Fix config JSON before applying provider.");
        }
        return;
    }

    g_autofree gchar *text = cfg_editor_get_text();
    g_autoptr(GError) err = NULL;
    g_autofree gchar *updated = config_setup_apply_provider(text, provider_id, base_url, &err);
    if (!updated) {
        if (cfg_setup_status_label) {
            gtk_label_set_text(GTK_LABEL(cfg_setup_status_label),
                               err && err->message ? err->message : "Failed to apply provider config shape.");
        }
        return;
    }

    cfg_set_editor_text_programmatically(updated);
    cfg_validate_and_track(updated);
    if (cfg_setup_status_label) {
        gtk_label_set_text(GTK_LABEL(cfg_setup_status_label), "Provider block updated. Saving…");
    }
    cfg_request_save_text(updated);
}

static void on_cfg_apply_default_model(GtkButton *button, gpointer user_data) {
    (void)button;
    (void)user_data;
    guint idx = cfg_model_dropdown ? gtk_drop_down_get_selected(GTK_DROP_DOWN(cfg_model_dropdown)) : GTK_INVALID_LIST_POSITION;
    if (!cfg_models_cache || idx == GTK_INVALID_LIST_POSITION || idx >= cfg_models_cache->len) {
        if (cfg_setup_status_label) {
            gtk_label_set_text(GTK_LABEL(cfg_setup_status_label), "Select a model from the loaded catalog.");
        }
        return;
    }

    ConfigModelChoice *choice = g_ptr_array_index(cfg_models_cache, idx);
    if (!choice || !choice->id) return;

    if (!cfg_editor_valid) {
        if (cfg_setup_status_label) {
            gtk_label_set_text(GTK_LABEL(cfg_setup_status_label), "Fix config JSON before applying default model.");
        }
        return;
    }

    g_autofree gchar *provider_id = g_strdup(
        gtk_editable_get_text(GTK_EDITABLE(cfg_provider_id_entry)));
    g_autofree gchar *text = cfg_editor_get_text();
    g_autoptr(GError) err = NULL;
    g_autofree gchar *updated = config_setup_apply_default_model(text,
                                                                 provider_id,
                                                                 choice->id,
                                                                 &err);
    if (!updated) {
        if (cfg_setup_status_label) {
            gtk_label_set_text(GTK_LABEL(cfg_setup_status_label),
                               err && err->message ? err->message : "Failed to apply default model config shape.");
        }
        return;
    }

    cfg_set_editor_text_programmatically(updated);
    cfg_validate_and_track(updated);
    if (cfg_setup_status_label) {
        gtk_label_set_text(GTK_LABEL(cfg_setup_status_label), "Default model updated. Saving…");
    }
    cfg_request_save_text(updated);
}

static void on_cfg_buffer_changed(GtkTextBuffer *buffer, gpointer user_data) {
    (void)buffer;
    (void)user_data;
    if (cfg_programmatic_change) return;
    g_autofree gchar *text = cfg_editor_get_text();
    cfg_validate_and_track(text);
    if (active_section == SECTION_CONFIG) {
        cfg_refresh_setup_surface();
    }
}

static void on_cfg_get_done(const GatewayRpcResponse *response, gpointer user_data) {
    ConfigRequestContext *ctx = (ConfigRequestContext *)user_data;
    if (cfg_request_context_is_stale(ctx)) {
        cfg_request_context_free(ctx);
        return;
    }
    cfg_request_context_free(ctx);

    cfg_request_in_flight = FALSE;

    if (!response || !response->ok) {
        if (cfg_validation_label) {
            g_autofree gchar *msg = g_strdup_printf("Load failed: %s",
                response && response->error_msg ? response->error_msg : "unknown error");
            gtk_label_set_text(GTK_LABEL(cfg_validation_label), msg);
        }
        cfg_refresh_buttons();
        return;
    }

    GatewayConfigSnapshot *snapshot = gateway_data_parse_config_get(response->payload);
    if (!snapshot || !snapshot->config) {
        if (cfg_validation_label) {
            gtk_label_set_text(GTK_LABEL(cfg_validation_label), "Load failed: invalid config response");
        }
        gateway_config_snapshot_free(snapshot);
        cfg_refresh_buttons();
        return;
    }

    JsonNode *node = json_node_new(JSON_NODE_OBJECT);
    json_node_set_object(node, snapshot->config);
    g_autofree gchar *pretty = json_to_string(node, TRUE);
    json_node_unref(node);

    g_free(cfg_baseline_text);
    cfg_baseline_text = g_strdup(pretty ? pretty : "{}");
    g_free(cfg_baseline_hash);
    cfg_baseline_hash = g_strdup(snapshot->hash);

    if (cfg_json_view) {
        GtkTextBuffer *buf = gtk_text_view_get_buffer(GTK_TEXT_VIEW(cfg_json_view));
        cfg_programmatic_change = TRUE;
        gtk_text_buffer_set_text(buf, cfg_baseline_text, -1);
        cfg_programmatic_change = FALSE;
    }

    cfg_editor_dirty = FALSE;
    cfg_validate_and_track(cfg_baseline_text);
    if (active_section == SECTION_CONFIG) {
        cfg_refresh_setup_surface();
    }
    cfg_refresh_buttons();
    gateway_config_snapshot_free(snapshot);
}

static void cfg_request_reload(void) {
    if (cfg_request_in_flight) return;
    cfg_request_in_flight = TRUE;
    cfg_refresh_buttons();
    ConfigRequestContext *ctx = cfg_request_context_new();
    g_autofree gchar *rid = mutation_config_get(NULL, on_cfg_get_done, ctx);
    if (!rid) {
        cfg_request_context_free(ctx);
        cfg_request_in_flight = FALSE;
        if (cfg_validation_label) {
            gtk_label_set_text(GTK_LABEL(cfg_validation_label), "Failed to request config.get");
        }
        cfg_refresh_buttons();
    }
}

static void on_cfg_reload(GtkButton *b, gpointer d) {
    (void)b;
    (void)d;
    cfg_request_reload();
}

static void on_cfg_save_done(const GatewayRpcResponse *response, gpointer user_data) {
    ConfigRequestContext *ctx = (ConfigRequestContext *)user_data;
    if (cfg_request_context_is_stale(ctx)) {
        cfg_request_context_free(ctx);
        return;
    }
    cfg_request_context_free(ctx);

    cfg_request_in_flight = FALSE;
    if (!response || !response->ok) {
        if (cfg_validation_label) {
            g_autofree gchar *msg = g_strdup_printf("Save failed: %s",
                response && response->error_msg ? response->error_msg : "unknown error");
            gtk_label_set_text(GTK_LABEL(cfg_validation_label), msg);
        }
        cfg_refresh_buttons();
        return;
    }

    if (cfg_validation_label) {
        gtk_label_set_text(GTK_LABEL(cfg_validation_label), "Save successful. Reloading baseline…");
    }
    if (cfg_setup_status_label) {
        gtk_label_set_text(GTK_LABEL(cfg_setup_status_label), "Saved provider/model config. Reloading baseline…");
    }
    gateway_client_invalidate_dependencies(TRUE, TRUE);
    gateway_client_refresh();
    gateway_client_request_dependency_refresh();
    cfg_request_reload();
}

static void on_cfg_save(GtkButton *b, gpointer d) {
    (void)b;
    (void)d;
    if (cfg_request_in_flight) return;

    g_autofree gchar *text = cfg_editor_get_text();
    cfg_request_save_text(text);
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

    GtkWidget *setup_sep = gtk_separator_new(GTK_ORIENTATION_HORIZONTAL);
    gtk_widget_set_margin_top(setup_sep, 8);
    gtk_box_append(GTK_BOX(page), setup_sep);

    GtkWidget *setup_heading = gtk_label_new("Provider & Model Setup");
    gtk_widget_add_css_class(setup_heading, "heading");
    gtk_label_set_xalign(GTK_LABEL(setup_heading), 0.0);
    gtk_widget_set_margin_top(setup_heading, 8);
    gtk_box_append(GTK_BOX(page), setup_heading);

    cfg_setup_summary_label = gtk_label_new("Provider: missing | Default model: missing");
    gtk_widget_add_css_class(cfg_setup_summary_label, "dim-label");
    gtk_label_set_xalign(GTK_LABEL(cfg_setup_summary_label), 0.0);
    gtk_box_append(GTK_BOX(page), cfg_setup_summary_label);

    cfg_setup_status_label = gtk_label_new("Use this section to complete provider/model setup for chat readiness.");
    gtk_widget_add_css_class(cfg_setup_status_label, "dim-label");
    gtk_label_set_xalign(GTK_LABEL(cfg_setup_status_label), 0.0);
    gtk_label_set_wrap(GTK_LABEL(cfg_setup_status_label), TRUE);
    gtk_box_append(GTK_BOX(page), cfg_setup_status_label);

    GtkWidget *provider_row = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
    cfg_provider_id_entry = gtk_entry_new();
    gtk_entry_set_placeholder_text(GTK_ENTRY(cfg_provider_id_entry), "Provider id (e.g. openai, ollama)");
    gtk_widget_set_size_request(cfg_provider_id_entry, 220, -1);
    gtk_box_append(GTK_BOX(provider_row), cfg_provider_id_entry);

    cfg_provider_base_url_entry = gtk_entry_new();
    gtk_entry_set_placeholder_text(GTK_ENTRY(cfg_provider_base_url_entry), "Provider baseUrl (optional)");
    gtk_widget_set_hexpand(cfg_provider_base_url_entry, TRUE);
    gtk_box_append(GTK_BOX(provider_row), cfg_provider_base_url_entry);

    cfg_apply_provider_btn = gtk_button_new_with_label("Configure Provider");
    g_signal_connect(cfg_apply_provider_btn, "clicked", G_CALLBACK(on_cfg_apply_provider), NULL);
    gtk_box_append(GTK_BOX(provider_row), cfg_apply_provider_btn);
    gtk_box_append(GTK_BOX(page), provider_row);

    GtkWidget *model_row = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
    cfg_reload_models_btn = gtk_button_new_with_label("Reload Models");
    g_signal_connect(cfg_reload_models_btn, "clicked", G_CALLBACK(on_cfg_reload_models), NULL);
    gtk_box_append(GTK_BOX(model_row), cfg_reload_models_btn);

    cfg_model_dropdown_model = NULL;
    cfg_model_dropdown = gtk_drop_down_new(NULL, NULL);
    gtk_widget_set_hexpand(cfg_model_dropdown, TRUE);
    gtk_box_append(GTK_BOX(model_row), cfg_model_dropdown);

    cfg_apply_model_btn = gtk_button_new_with_label("Set Default Model");
    gtk_widget_add_css_class(cfg_apply_model_btn, "suggested-action");
    g_signal_connect(cfg_apply_model_btn, "clicked", G_CALLBACK(on_cfg_apply_default_model), NULL);
    gtk_box_append(GTK_BOX(model_row), cfg_apply_model_btn);
    gtk_box_append(GTK_BOX(page), model_row);

    cfg_set_model_dropdown_placeholder("Load models to pick default", FALSE);

    /* 5. Raw JSON read-only view */
    GtkWidget *json_heading = gtk_label_new("Raw Config");
    gtk_widget_add_css_class(json_heading, "heading");
    gtk_label_set_xalign(GTK_LABEL(json_heading), 0.0);
    gtk_widget_set_margin_top(json_heading, 12);
    gtk_box_append(GTK_BOX(page), json_heading);

    GtkTextBuffer *json_buf = gtk_text_buffer_new(NULL);
    cfg_json_view = gtk_text_view_new_with_buffer(json_buf);
    gtk_text_view_set_editable(GTK_TEXT_VIEW(cfg_json_view), TRUE);
    gtk_text_view_set_cursor_visible(GTK_TEXT_VIEW(cfg_json_view), TRUE);
    gtk_text_view_set_wrap_mode(GTK_TEXT_VIEW(cfg_json_view), GTK_WRAP_WORD_CHAR);
    gtk_text_view_set_monospace(GTK_TEXT_VIEW(cfg_json_view), TRUE);
    gtk_widget_set_vexpand(cfg_json_view, TRUE);
    g_signal_connect(json_buf, "changed", G_CALLBACK(on_cfg_buffer_changed), NULL);

    GtkWidget *json_scrolled = gtk_scrolled_window_new();
    gtk_scrolled_window_set_child(GTK_SCROLLED_WINDOW(json_scrolled), cfg_json_view);
    gtk_widget_set_vexpand(json_scrolled, TRUE);
    gtk_scrolled_window_set_min_content_height(GTK_SCROLLED_WINDOW(json_scrolled), 200);
    gtk_box_append(GTK_BOX(page), json_scrolled);

    cfg_validation_label = gtk_label_new("Validation: loading config…");
    gtk_widget_add_css_class(cfg_validation_label, "dim-label");
    gtk_label_set_xalign(GTK_LABEL(cfg_validation_label), 0.0);
    gtk_widget_set_margin_top(cfg_validation_label, 6);
    gtk_box_append(GTK_BOX(page), cfg_validation_label);

    /* 6. Reload / save / copy actions */
    GtkWidget *copy_row = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
    gtk_widget_set_margin_top(copy_row, 6);

    cfg_reload_btn = gtk_button_new_with_label("Reload");
    g_signal_connect(cfg_reload_btn, "clicked", G_CALLBACK(on_cfg_reload), NULL);
    gtk_box_append(GTK_BOX(copy_row), cfg_reload_btn);

    cfg_save_btn = gtk_button_new_with_label("Save");
    gtk_widget_add_css_class(cfg_save_btn, "suggested-action");
    g_signal_connect(cfg_save_btn, "clicked", G_CALLBACK(on_cfg_save), NULL);
    gtk_box_append(GTK_BOX(copy_row), cfg_save_btn);

    cfg_copy_btn = gtk_button_new_with_label("Copy Config JSON");
    g_signal_connect(cfg_copy_btn, "clicked", G_CALLBACK(on_cfg_copy_json), NULL);
    gtk_box_append(GTK_BOX(copy_row), cfg_copy_btn);

    gtk_box_append(GTK_BOX(page), copy_row);

    cfg_refresh_buttons();

    return page;
}

static void refresh_config_content(void) {
    if (!app_window_can_refresh_integrated()) return;
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
    g_autofree gchar *cfg_path_display = NULL;
    if (cm.config_path && cm.config_path[0] != '\0') {
        if (g_utf8_validate(cm.config_path, -1, NULL)) {
            cfg_path_display = g_strdup(cm.config_path);
        } else {
            cfg_path_display = g_filename_display_name(cm.config_path);
        }
    }
    gtk_label_set_text(GTK_LABEL(cfg_path_label), cfg_path_display ? cfg_path_display : "—");
    g_autofree gchar *mod_text = cfg_get_modified_text(path);
    g_autofree gchar *mod_label = g_strdup_printf("Last modified: %s", mod_text);
    gtk_label_set_text(GTK_LABEL(cfg_modified_label), mod_label);

    if (!cfg_initial_load_requested && gateway_rpc_is_ready()) {
        cfg_initial_load_requested = TRUE;
        cfg_request_reload();
    }

    if (active_section == SECTION_CONFIG) {
        cfg_refresh_setup_surface();
    }

    cfg_refresh_buttons();
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
    if (!app_window_can_refresh_integrated()) return;
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

    GatewayConfig *cfg = gateway_client_get_config();

    GatewayConfigContext ctx = {0};
    ctx.explicit_config_path = config_path;
    ctx.effective_state_dir = state_dir;
    ctx.profile = profile;

    g_autofree gchar *resolved_config_path = gateway_config_resolve_path(&ctx);

    const gchar *effective_config_path = NULL;
    if (cfg && cfg->config_path && cfg->config_path[0] != '\0') {
        effective_config_path = cfg->config_path;
    } else if (resolved_config_path && resolved_config_path[0] != '\0') {
        effective_config_path = resolved_config_path;
    } else if (config_path && config_path[0] != '\0') {
        effective_config_path = config_path;
    }

    EnvironmentCheckResult ecr;
    environment_check_build(sys,
                            effective_config_path,
                            state_dir,
                            &ecr);

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

    environment_check_result_clear(&ecr);
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
    if (!app_window_can_refresh_integrated()) return;
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

    gtk_box_append(GTK_BOX(page), gen_info_row("Unit", &dbg_unit_label));
    gtk_box_append(GTK_BOX(page), gen_info_row("State", &dbg_state_label));

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
    if (!app_window_can_refresh_integrated()) return;
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
/* ── Auto-refresh timer ── */

static gboolean on_refresh_tick(gpointer user_data) {
    (void)user_data;

    /* During shutdown, integrated refresh must stop before any widget teardown. */
    if (window_shutting_down) {
        refresh_timer_id = 0;
        return G_SOURCE_REMOVE;
    }

    if (main_window) {
        gboolean rpc_ready = gateway_rpc_is_ready();
        AppState app_state = state_get_current();
        if (rpc_ready != last_rpc_ready || app_state != last_app_state) {
            invalidate_all_rpc_sections();
            last_rpc_ready = rpc_ready;
            last_app_state = app_state;
        }

        refresh_active_integrated_section(active_section);
        refresh_shell_status_footer();
        /* RPC-backed sections refresh on activation + TTL, not every tick */
        refresh_active_rpc_section(active_section);
        
        return G_SOURCE_CONTINUE;
    }
    refresh_timer_id = 0;
    return G_SOURCE_REMOVE;
}

/* ── Window lifecycle ── */

static void on_window_destroy(GtkWindow *window, gpointer user_data) {
    (void)window;
    (void)user_data;

    window_shutting_down = TRUE;

    if (refresh_timer_id > 0) {
        g_source_remove(refresh_timer_id);
        refresh_timer_id = 0;
    }

    /* Destroy section-owned async/list resources before clearing global widgets. */
    for (int i = 0; i < SECTION_COUNT; i++) {
        if (section_controllers[i]) {
            section_controllers[i]->destroy();
        }
    }

    main_window = NULL;
    content_stack = NULL;
    sidebar_list = NULL;
    shell_gateway_status_label = NULL;
    shell_gateway_status_dot = NULL;
    shell_service_status_label = NULL;
    shell_service_status_dot = NULL;
    shell_seen_gateway_connected = FALSE;

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
    cfg_validation_label = NULL;
    cfg_setup_summary_label = NULL;
    cfg_setup_status_label = NULL;
    cfg_provider_id_entry = NULL;
    cfg_provider_base_url_entry = NULL;
    cfg_reload_models_btn = NULL;
    ui_dropdown_detach_model(cfg_model_dropdown, (gpointer *)&cfg_model_dropdown_model);
    cfg_model_dropdown = NULL;
    cfg_apply_provider_btn = NULL;
    cfg_apply_model_btn = NULL;
    if (cfg_copy_reset_id > 0) {
        g_source_remove(cfg_copy_reset_id);
        cfg_copy_reset_id = 0;
    }
    cfg_copy_btn = NULL;
    cfg_reload_btn = NULL;
    cfg_save_btn = NULL;
    cfg_programmatic_change = FALSE;
    cfg_editor_dirty = FALSE;
    cfg_editor_valid = TRUE;
    cfg_request_in_flight = FALSE;
    cfg_initial_load_requested = FALSE;
    cfg_models_request_in_flight = FALSE;
    cfg_generation++;
    if (cfg_models_cache) g_ptr_array_unref(cfg_models_cache);
    cfg_models_cache = NULL;
    g_clear_pointer(&cfg_baseline_text, g_free);
    g_clear_pointer(&cfg_baseline_hash, g_free);

    if (diag_copy_reset_id > 0) {
        g_source_remove(diag_copy_reset_id);
        diag_copy_reset_id = 0;
    }
    diag_text_view = NULL;
    diag_copy_btn = NULL;

    env_checks_box = NULL;

    dbg_state_label = NULL;
    dbg_unit_label = NULL;
    dbg_journal_label = NULL;

    active_section = SECTION_DASHBOARD;
    last_rpc_ready = FALSE;
    last_app_state = STATE_NEEDS_SETUP;
    memset(section_pages, 0, sizeof(section_pages));
}

/* ── Public API ── */

void app_window_show(void) {
    if (main_window) {
        gtk_window_present(GTK_WINDOW(main_window));
        return;
    }

    window_shutting_down = FALSE;

    GApplication *app = g_application_get_default();
    if (!app) return;

    ensure_app_css_loaded();

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
    
    /* Keep the headerbar but remove the custom close button */
    GtkWidget *header_bar = adw_header_bar_new();
    
    GtkWidget *content_vbox = gtk_box_new(GTK_ORIENTATION_VERTICAL, 0);
    gtk_box_append(GTK_BOX(content_vbox), header_bar);
    gtk_widget_set_vexpand(stack, TRUE);
    gtk_box_append(GTK_BOX(content_vbox), stack);
    
    AdwNavigationPage *content_page = adw_navigation_page_new(content_vbox, "Dashboard");
    
    adw_navigation_split_view_set_content(split, content_page);

    adw_application_window_set_content(ADW_APPLICATION_WINDOW(main_window), GTK_WIDGET(split));

    /* Select dashboard row by default */
    GtkListBoxRow *first = gtk_list_box_get_row_at_index(GTK_LIST_BOX(sidebar_list), 0);
    if (first) {
        gtk_list_box_select_row(GTK_LIST_BOX(sidebar_list), first);
    }

    g_signal_connect(main_window, "destroy", G_CALLBACK(on_window_destroy), NULL);

    /* Initial content fill for local/cheap sections + start auto-refresh */
    refresh_active_integrated_section(active_section);
    refresh_shell_status_footer();
    last_rpc_ready = gateway_rpc_is_ready();
    last_app_state = state_get_current();
    /* RPC-backed sections will fetch on first sidebar activation */
    refresh_timer_id = g_timeout_add_seconds(1, on_refresh_tick, NULL);

    gtk_window_present(GTK_WINDOW(main_window));
}

void app_window_navigate_to(AppSection section) {
    if (section < 0 || section >= SECTION_COUNT) return;

    app_window_show();

    active_section = section;
    if (content_stack) {
        gtk_stack_set_visible_child_name(GTK_STACK(content_stack), section_meta[section].id);
    }
    if (sidebar_list) {
        GtkListBoxRow *row = gtk_list_box_get_row_at_index(GTK_LIST_BOX(sidebar_list), section);
        if (row) {
            gtk_list_box_select_row(GTK_LIST_BOX(sidebar_list), row);
        }
    }
    refresh_active_integrated_section(active_section);
    refresh_active_rpc_section(active_section);
}

void app_window_refresh_snapshot(void) {
    /* Explicit lifecycle invariant: snapshot refresh is invalid once shutdown begins. */
    if (window_shutting_down || !main_window) return;

    invalidate_all_rpc_sections();

    refresh_active_integrated_section(active_section);
    refresh_shell_status_footer();

    refresh_active_rpc_section(active_section);
}

gboolean app_window_is_visible(void) {
    return main_window != NULL;
}
