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
#include "shell_sections.h"
#include "state.h"
#include "readiness.h"
#include "display_model.h"
#include "gateway_config.h"
#include "gateway_client.h"
#include "diagnostics.h"
#include "device_pair_prompter.h"
#include "gateway_ws.h"
#include "chat_window.h"
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
#include "section_agents.h"
#include "section_usage.h"
#include "section_logs.h"
#include "section_control_room.h"
#include "section_workflows.h"
#include "ui_model_utils.h"
#include "runtime_paths.h"
#include "log.h"
#include "product_state.h"
#include "product_coordinator.h"

/* ── Window state ── */

static GtkWidget *main_window = NULL;
static GtkWidget *content_stack = NULL;
static GtkWidget *sidebar_list = NULL;
static GtkWidget *shell_gateway_status_label = NULL;
static GtkWidget *shell_gateway_status_dot = NULL;
static GtkWidget *shell_service_status_label = NULL;
static GtkWidget *shell_service_status_dot = NULL;
static GtkWidget *shell_pairing_status_label = NULL;
static GtkWidget *shell_pairing_status_dot = NULL;
static GtkWidget *shell_pairing_status_button = NULL;
static guint refresh_timer_id = 0;
static AppSection active_section = SECTION_DASHBOARD;
static gboolean last_rpc_ready = FALSE;
static AppState last_app_state = STATE_NEEDS_SETUP;
static gboolean shell_seen_gateway_connected = FALSE;
static gboolean app_css_installed = FALSE;
static gboolean window_shutting_down = FALSE;

/* Section controllers keyed by AppSection (NULL for standalone/placeholder sections). */
static const SectionController *section_controllers[SECTION_COUNT] = {0};

/* ── Forward declarations ── */

static GtkWidget* build_placeholder_section(AppSection section);
static GtkWidget* build_about_section(void);
static void refresh_shell_status_footer(void);
static void ensure_app_css_loaded(void);
static void destroy_all_section_controllers(void);
static void on_sidebar_row_activated(GtkListBox *box, GtkListBoxRow *row, gpointer user_data);
static void on_window_destroy(GtkWindow *window, gpointer user_data);
static void on_shell_pairing_button_clicked(GtkButton *button, gpointer user_data);

/* ── Sidebar construction ── */

/*
 * Returns TRUE when a given AppSection should appear in the main settings
 * window. Sections whose UX lives in their own dedicated window (like
 * Chat, which ships as a standalone AdwApplicationWindow) are filtered
 * out here so the main window stays focused on management / diagnostics.
 */
static gboolean section_is_embedded_in_main_window(AppSection section) {
    return shell_sections_is_embedded(section);
}

/*
 * Pure section-tag encode/decode helpers live in
 * `app_window_section_tag.c` so a headless test can link them without
 * dragging the full GTK/Adwaita main-window TU. See that file for the
 * NULL-collision rationale (SECTION_DASHBOARD == 0).
 */

static GtkWidget* build_sidebar_row(AppSection section) {
    const ShellSectionMeta *meta = shell_sections_meta(section);

    GtkWidget *box = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 10);
    gtk_widget_set_margin_start(box, 8);
    gtk_widget_set_margin_end(box, 8);
    gtk_widget_set_margin_top(box, 6);
    gtk_widget_set_margin_bottom(box, 6);

    /*
     * Pin the logical section onto the row widget so activation handlers
     * do not have to rely on the list-box index (which shifts when we
     * filter out standalone-windowed sections like Chat).
     *
     * CRITICAL: store `section + 1`, never the raw enum. `SECTION_DASHBOARD`
     * is 0, and `g_object_set_data(..., GINT_TO_POINTER(0))` stores a
     * NULL pointer — indistinguishable from "no data set" when the row
     * activation handler tests `if (!tag) return`. The shift makes NULL
     * unambiguously mean "missing", and the activation / navigate paths
     * subtract 1 to recover the enum.
     */
    g_object_set_data(G_OBJECT(box), "oc_section",
                      app_window_section_tag_encode(section));

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
        if (!section_is_embedded_in_main_window((AppSection)i)) continue;
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

    /*
     * Pairing status row. Always present; actionability (and the
     * trailing "Open" button) is driven by `pairing_status_model_build`
     * which consults the same single-truth sources the macOS app and
     * Diagnostics tab read. Pairing is intentionally NOT in the tray
     * menu — this footer is the sole user-facing pairing surface.
     */
    GtkWidget *pairing_row = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 6);
    shell_pairing_status_dot = gtk_label_new("●");
    gtk_widget_add_css_class(shell_pairing_status_dot, "status-dot");
    gtk_box_append(GTK_BOX(pairing_row), shell_pairing_status_dot);
    shell_pairing_status_label = gtk_label_new("Pairing: not paired yet");
    gtk_label_set_xalign(GTK_LABEL(shell_pairing_status_label), 0.0);
    gtk_widget_set_hexpand(shell_pairing_status_label, TRUE);
    gtk_box_append(GTK_BOX(pairing_row), shell_pairing_status_label);
    shell_pairing_status_button = gtk_button_new_with_label("Open");
    gtk_widget_add_css_class(shell_pairing_status_button, "flat");
    gtk_widget_set_visible(shell_pairing_status_button, FALSE);
    g_signal_connect(shell_pairing_status_button, "clicked",
                     G_CALLBACK(on_shell_pairing_button_clicked), NULL);
    gtk_box_append(GTK_BOX(pairing_row), shell_pairing_status_button);
    gtk_box_append(GTK_BOX(footer), pairing_row);

    gtk_box_append(GTK_BOX(sidebar_shell), footer);
    return sidebar_shell;
}

static void clear_status_dot_classes(GtkWidget *dot) {
    if (!dot) return;
    gtk_widget_remove_css_class(dot, "connected");
    gtk_widget_remove_css_class(dot, "disconnected");
    gtk_widget_remove_css_class(dot, "connecting");
    gtk_widget_remove_css_class(dot, "service-inactive");
    gtk_widget_remove_css_class(dot, "warning");
    gtk_widget_remove_css_class(dot, "neutral");
}

static const char* pairing_dot_css_class(StatusColor color) {
    switch (color) {
    case STATUS_COLOR_GREEN:  return "connected";
    case STATUS_COLOR_ORANGE: return "warning";
    case STATUS_COLOR_RED:    return "disconnected";
    case STATUS_COLOR_GRAY:
    default:                  return "neutral";
    }
}

static void on_shell_pairing_button_clicked(GtkButton *button, gpointer user_data) {
    (void)button;
    (void)user_data;
    /*
     * Single-truth raise primitive shared with (previously) the tray
     * and with any other pairing affordance. Picks bootstrap window vs
     * approval dialog internally based on the same precedence the
     * footer `pairing_status_model_build` uses.
     */
    device_pair_prompter_raise();
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

    /*
     * Pairing status row. Reads the same two truth sources the
     * previous tray computation used — `gateway_ws_is_pairing_required`
     * (transport blocked on PAIRING_REQUIRED) and
     * `device_pair_prompter_pending_count` (local inbound-approval
     * queue) — plus the existing WS auth signal so a healthy paired
     * session can show a positive indicator.
     */
    if (shell_pairing_status_label && shell_pairing_status_dot) {
        gboolean pairing_required = gateway_ws_is_pairing_required();
        guint pending_approvals = device_pair_prompter_pending_count();
        gboolean auth_ok = (health && health->auth_ok);
        gboolean ws_connected = (health && health->ws_connected);

        PairingStatusModel pm;
        pairing_status_model_build(
            pairing_required, pending_approvals, auth_ok, ws_connected, &pm);

        clear_status_dot_classes(shell_pairing_status_dot);
        gtk_widget_add_css_class(shell_pairing_status_dot,
                                 pairing_dot_css_class(pm.color));
        gtk_label_set_text(GTK_LABEL(shell_pairing_status_label),
                           pm.label ? pm.label : "Pairing: unknown");
        if (shell_pairing_status_button) {
            gtk_widget_set_visible(shell_pairing_status_button, pm.actionable);
        }
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
        ".status-dot.warning { color: #e5a50a; }"
        ".status-dot.neutral { color: #77767b; }"
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

    for (int i = 0; i < SECTION_COUNT; i++) {
        section_controllers[i] = shell_sections_controller((AppSection)i);
    }

    for (int i = 0; i < SECTION_COUNT; i++) {
        if (!section_is_embedded_in_main_window((AppSection)i)) continue;
        GtkWidget *page;
        if (section_controllers[i]) {
            page = section_controllers[i]->build();
        } else if (i == SECTION_ABOUT) {
            page = build_about_section();
        } else {
            page = build_placeholder_section((AppSection)i);
        }
        gtk_stack_add_named(GTK_STACK(content_stack), page, shell_sections_meta((AppSection)i)->id);
    }

    return content_stack;
}

/* ── Sidebar row activation ── */

static void refresh_active_section(AppSection section) {
    if (section >= 0 && section < SECTION_COUNT && section_controllers[section]) {
        section_controllers[section]->refresh();
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

    /* Rows carry their logical AppSection as user data (see
     * build_sidebar_row); do not use the GtkListBoxRow index, which is
     * relative to visible rows and not to the AppSection enum.
     *
     * The tag is stored as `section + 1` so that SECTION_DASHBOARD (=0)
     * doesn't collide with GObject's "no data" sentinel (NULL). Decode
     * by subtracting 1 and reject the NULL case explicitly. */
    GtkWidget *row_child = gtk_list_box_row_get_child(row);
    gpointer tag = row_child
        ? g_object_get_data(G_OBJECT(row_child), "oc_section")
        : NULL;
    AppSection section;
    if (!app_window_section_tag_decode(tag, &section)) return;

    active_section = section;
    gtk_stack_set_visible_child_name(GTK_STACK(content_stack), shell_sections_meta(section)->id);
    refresh_active_section(active_section);
}

/* ── Placeholder section (Tier B / deferred) ── */

static GtkWidget* build_placeholder_section(AppSection section) {
    const ShellSectionMeta *meta = shell_sections_meta(section);

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

/* ── Auto-refresh timer ── */

static gboolean on_refresh_tick(gpointer user_data) {
    (void)user_data;

    /* During shutdown, controller refresh must stop before any widget teardown. */
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

        refresh_shell_status_footer();
        refresh_active_section(active_section);
        
        return G_SOURCE_CONTINUE;
    }
    refresh_timer_id = 0;
    return G_SOURCE_REMOVE;
}

/* ── Window lifecycle ── */

static void destroy_all_section_controllers(void) {
    for (int i = 0; i < SECTION_COUNT; i++) {
        if (section_controllers[i] && section_controllers[i]->destroy) {
            section_controllers[i]->destroy();
        }
    }
}

static void on_window_destroy(GtkWindow *window, gpointer user_data) {
    (void)window;
    (void)user_data;

    window_shutting_down = TRUE;

    if (refresh_timer_id > 0) {
        g_source_remove(refresh_timer_id);
        refresh_timer_id = 0;
    }

    destroy_all_section_controllers();

    main_window = NULL;
    content_stack = NULL;
    sidebar_list = NULL;
    shell_gateway_status_label = NULL;
    shell_gateway_status_dot = NULL;
    shell_service_status_label = NULL;
    shell_service_status_dot = NULL;
    shell_seen_gateway_connected = FALSE;
    shell_pairing_status_label = NULL;
    shell_pairing_status_dot = NULL;
    shell_pairing_status_button = NULL;
    memset(section_controllers, 0, sizeof(section_controllers));

    active_section = SECTION_DASHBOARD;
    last_rpc_ready = FALSE;
    last_app_state = STATE_NEEDS_SETUP;
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

    /*
     * Select dashboard row by default. `gtk_list_box_select_row` emits
     * `row-selected`, NOT `row-activated` — the activation handler won't
     * fire here, so we also explicitly set the visible child below.
     */
    GtkListBoxRow *first = gtk_list_box_get_row_at_index(GTK_LIST_BOX(sidebar_list), 0);
    if (first) {
        gtk_list_box_select_row(GTK_LIST_BOX(sidebar_list), first);
    }
    /*
     * Pin the initial visible child to the default section's id rather
     * than trusting insertion order. GtkStack picks "first child added"
     * by default, which is correct today but silently fragile — if the
     * embedded-section filter ever changes or Dashboard is reordered
     * in the enum, the default would drift.
     */
    if (content_stack) {
        const char *initial_id = shell_sections_meta(active_section)->id;
        if (gtk_stack_get_child_by_name(GTK_STACK(content_stack), initial_id)) {
            gtk_stack_set_visible_child_name(GTK_STACK(content_stack), initial_id);
        } else {
            OC_LOG_WARN(OPENCLAW_LOG_CAT_STATE,
                        "content stack missing child for default section id=%s",
                        initial_id ? initial_id : "(null)");
        }
    }

    g_signal_connect(main_window, "destroy", G_CALLBACK(on_window_destroy), NULL);

    /* Re-parent pairing dialogs (approval window + bootstrap window) to the
     * newly-created main window. Safe to call even if the prompter has not
     * been initialized; calls before init are no-ops. */
    device_pair_prompter_set_parent(GTK_WINDOW(main_window));

    /* Initial content fill for local/cheap sections + start auto-refresh */
    refresh_active_section(active_section);
    refresh_shell_status_footer();
    last_rpc_ready = gateway_rpc_is_ready();
    last_app_state = state_get_current();
    /* RPC-backed sections will fetch on first sidebar activation */
    refresh_timer_id = g_timeout_add_seconds(1, on_refresh_tick, NULL);

    gtk_window_present(GTK_WINDOW(main_window));
}

void app_window_navigate_to(AppSection section) {
    if (section < 0 || section >= SECTION_COUNT) return;

    /* Sections that live in their own window (Chat) must not drag the
     * main window open; route them to the dedicated surface instead. */
    if (!section_is_embedded_in_main_window(section)) {
        if (section == SECTION_CHAT) {
            chat_window_show();
        }
        return;
    }

    app_window_show();

    active_section = section;
    if (content_stack) {
        gtk_stack_set_visible_child_name(GTK_STACK(content_stack), shell_sections_meta(section)->id);
    }
    if (sidebar_list) {
        /* Walk rows to find the one whose stored section matches; the
         * index-based API is not reliable after filtering Chat out. */
        GtkListBoxRow *selected = NULL;
        for (int i = 0; ; i++) {
            GtkListBoxRow *row = gtk_list_box_get_row_at_index(GTK_LIST_BOX(sidebar_list), i);
            if (!row) break;
            GtkWidget *child = gtk_list_box_row_get_child(row);
            gpointer tag = child ? g_object_get_data(G_OBJECT(child), "oc_section") : NULL;
            AppSection row_section;
            if (app_window_section_tag_decode(tag, &row_section) && row_section == section) {
                selected = row;
                break;
            }
        }
        if (selected) gtk_list_box_select_row(GTK_LIST_BOX(sidebar_list), selected);
    }
    refresh_active_section(active_section);
}

void app_window_refresh_snapshot(void) {
    /* Explicit lifecycle invariant: snapshot refresh is invalid once shutdown begins. */
    if (window_shutting_down || !main_window) return;

    invalidate_all_rpc_sections();

    refresh_shell_status_footer();

    refresh_active_section(active_section);
}

gboolean app_window_is_visible(void) {
    return main_window != NULL;
}
