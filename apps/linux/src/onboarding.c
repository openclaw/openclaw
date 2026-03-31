/*
 * onboarding.c
 *
 * State-aware onboarding flow for the OpenClaw Linux Companion App.
 *
 * Implements a guided first-run and recovery flow using AdwCarousel
 * for page navigation. The flow adapts to the detected gateway state:
 *   - Shortened when gateway is already healthy on first run
 *   - Full guidance when setup/install/config issues are detected
 *   - Re-openable from the app at any time
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include <gtk/gtk.h>
#include <adwaita.h>
#include <stdio.h>
#include <sys/stat.h>
#include <errno.h>
#include <string.h>
#include <glib/gstdio.h>

#include "onboarding.h"
#include "display_model.h"
#include "gateway_config.h"
#include "state.h"
#include "readiness.h"
#include "app_window.h"
#include "log.h"

/* ── Version marker persistence ── */

static gchar* get_marker_path(void) {
    const gchar *state_dir = g_get_user_state_dir(); /* XDG_STATE_HOME or ~/.local/state */
    return g_build_filename(state_dir, "openclaw-companion", "onboarding_version", NULL);
}

int onboarding_get_seen_version(void) {
    g_autofree gchar *path = get_marker_path();
    g_autofree gchar *contents = NULL;
    if (!g_file_get_contents(path, &contents, NULL, NULL)) {
        return 0;
    }
    g_strstrip(contents);
    gint64 v = g_ascii_strtoll(contents, NULL, 10);
    return (int)v;
}

static void write_seen_version(int version) {
    g_autofree gchar *path = get_marker_path();
    g_autofree gchar *dir = g_path_get_dirname(path);

    g_mkdir_with_parents(dir, 0755);

    g_autofree gchar *text = g_strdup_printf("%d\n", version);
    g_autoptr(GError) err = NULL;
    if (!g_file_set_contents(path, text, -1, &err)) {
        OC_LOG_WARN(OPENCLAW_LOG_CAT_STATE, "Failed to write onboarding marker: %s",
                    err->message);
    }
}

void onboarding_reset(void) {
    g_autofree gchar *path = get_marker_path();
    g_unlink(path);
}

/* ── Onboarding window ── */

static GtkWidget *onboard_window = NULL;

static void on_onboard_destroy(GtkWindow *window, gpointer data) {
    (void)window; (void)data;
    onboard_window = NULL;
}

static void on_finish_clicked(GtkButton *btn, gpointer data) {
    (void)btn; (void)data;
    write_seen_version(ONBOARDING_CURRENT_VERSION);
    if (onboard_window) {
        gtk_window_destroy(GTK_WINDOW(onboard_window));
    }
    app_window_show();
}

static void on_open_dashboard_clicked(GtkButton *btn, gpointer data) {
    (void)btn; (void)data;
    extern GatewayConfig* gateway_client_get_config(void); /* gateway_client.h */
    GatewayConfig *cfg = gateway_client_get_config();
    if (cfg) {
        g_autofree gchar *url = gateway_config_dashboard_url(cfg);
        if (url) {
            g_app_info_launch_default_for_uri(url, NULL, NULL);
        }
    }
}

/* ── Page builders ── */

static GtkWidget* build_welcome_page(void) {
    GtkWidget *page = gtk_box_new(GTK_ORIENTATION_VERTICAL, 16);
    gtk_widget_set_margin_start(page, 40);
    gtk_widget_set_margin_end(page, 40);
    gtk_widget_set_margin_top(page, 40);
    gtk_widget_set_margin_bottom(page, 40);
    gtk_widget_set_valign(page, GTK_ALIGN_CENTER);

    GtkWidget *title = gtk_label_new("Welcome to OpenClaw");
    gtk_widget_add_css_class(title, "title-1");
    gtk_box_append(GTK_BOX(page), title);

    GtkWidget *subtitle = gtk_label_new(
        "The Linux companion for your OpenClaw gateway.");
    gtk_widget_add_css_class(subtitle, "title-3");
    gtk_label_set_xalign(GTK_LABEL(subtitle), 0.5);
    gtk_box_append(GTK_BOX(page), subtitle);

    GtkWidget *security = gtk_label_new(
        "OpenClaw connects to an AI agent gateway that can trigger "
        "powerful actions on your system. The companion app helps you "
        "monitor, manage, and stay informed about your gateway's status.");
    gtk_label_set_wrap(GTK_LABEL(security), TRUE);
    gtk_label_set_xalign(GTK_LABEL(security), 0.0);
    gtk_widget_set_margin_top(security, 16);
    gtk_box_append(GTK_BOX(page), security);

    return page;
}

static GtkWidget* build_gateway_page(void) {
    GtkWidget *page = gtk_box_new(GTK_ORIENTATION_VERTICAL, 12);
    gtk_widget_set_margin_start(page, 40);
    gtk_widget_set_margin_end(page, 40);
    gtk_widget_set_margin_top(page, 40);
    gtk_widget_set_margin_bottom(page, 40);
    gtk_widget_set_valign(page, GTK_ALIGN_CENTER);

    GtkWidget *title = gtk_label_new("Gateway & Service");
    gtk_widget_add_css_class(title, "title-2");
    gtk_label_set_xalign(GTK_LABEL(title), 0.0);
    gtk_box_append(GTK_BOX(page), title);

    AppState current = state_get_current();
    RuntimeMode rm = state_get_runtime_mode();
    SystemdState *sys = state_get_systemd();
    HealthState *health = state_get_health();

    ReadinessInfo ri;
    readiness_evaluate(current, health, sys, &ri);

    /* State-aware content */
    if (current == STATE_RUNNING || current == STATE_RUNNING_WITH_WARNING) {
        if (rm == RUNTIME_HEALTHY_OUTSIDE_EXPECTED_SERVICE) {
            GtkWidget *status = gtk_label_new(
                "A healthy gateway was found at the configured endpoint, "
                "but it is not running via the expected systemd service.");
            gtk_label_set_wrap(GTK_LABEL(status), TRUE);
            gtk_label_set_xalign(GTK_LABEL(status), 0.0);
            gtk_widget_add_css_class(status, "accent");
            gtk_box_append(GTK_BOX(page), status);

            GtkWidget *detail = gtk_label_new(
                "This is normal if you run the gateway manually or via another "
                "service manager. The companion will monitor the endpoint and "
                "report its status, but service controls will target the "
                "expected systemd unit.");
            gtk_label_set_wrap(GTK_LABEL(detail), TRUE);
            gtk_label_set_xalign(GTK_LABEL(detail), 0.0);
            gtk_box_append(GTK_BOX(page), detail);
        } else {
            GtkWidget *status = gtk_label_new("Your gateway is running and healthy.");
            gtk_widget_add_css_class(status, "accent");
            gtk_label_set_xalign(GTK_LABEL(status), 0.0);
            gtk_box_append(GTK_BOX(page), status);
        }
    } else if (current == STATE_NEEDS_SETUP) {
        GtkWidget *msg = gtk_label_new(
            "No OpenClaw configuration was detected. Run the following "
            "command to initialize the OpenClaw environment:");
        gtk_label_set_wrap(GTK_LABEL(msg), TRUE);
        gtk_label_set_xalign(GTK_LABEL(msg), 0.0);
        gtk_box_append(GTK_BOX(page), msg);

        GtkWidget *cmd = gtk_label_new("openclaw setup");
        gtk_widget_add_css_class(cmd, "monospace");
        gtk_label_set_selectable(GTK_LABEL(cmd), TRUE);
        gtk_label_set_xalign(GTK_LABEL(cmd), 0.0);
        gtk_widget_set_margin_top(cmd, 8);
        gtk_box_append(GTK_BOX(page), cmd);
    } else if (current == STATE_NEEDS_GATEWAY_INSTALL) {
        GtkWidget *msg = gtk_label_new(
            "OpenClaw is configured, but no gateway service is installed. "
            "Run the following command:");
        gtk_label_set_wrap(GTK_LABEL(msg), TRUE);
        gtk_label_set_xalign(GTK_LABEL(msg), 0.0);
        gtk_box_append(GTK_BOX(page), msg);

        GtkWidget *cmd = gtk_label_new("openclaw gateway install");
        gtk_widget_add_css_class(cmd, "monospace");
        gtk_label_set_selectable(GTK_LABEL(cmd), TRUE);
        gtk_label_set_xalign(GTK_LABEL(cmd), 0.0);
        gtk_widget_set_margin_top(cmd, 8);
        gtk_box_append(GTK_BOX(page), cmd);
    } else {
        /* Generic: show readiness info */
        if (ri.classification) {
            g_autofree gchar *text = g_strdup_printf("Current status: %s", ri.classification);
            GtkWidget *status = gtk_label_new(text);
            gtk_label_set_xalign(GTK_LABEL(status), 0.0);
            gtk_box_append(GTK_BOX(page), status);
        }
        if (ri.missing) {
            GtkWidget *missing = gtk_label_new(ri.missing);
            gtk_label_set_wrap(GTK_LABEL(missing), TRUE);
            gtk_label_set_xalign(GTK_LABEL(missing), 0.0);
            gtk_box_append(GTK_BOX(page), missing);
        }
        if (ri.next_action) {
            GtkWidget *action = gtk_label_new(ri.next_action);
            gtk_widget_add_css_class(action, "accent");
            gtk_label_set_wrap(GTK_LABEL(action), TRUE);
            gtk_label_set_xalign(GTK_LABEL(action), 0.0);
            gtk_widget_set_margin_top(action, 8);
            gtk_box_append(GTK_BOX(page), action);
        }
    }

    /* Systemd context if available */
    if (sys && sys->unit_name) {
        g_autofree gchar *unit_text = g_strdup_printf("Service unit: %s", sys->unit_name);
        GtkWidget *unit = gtk_label_new(unit_text);
        gtk_widget_add_css_class(unit, "dim-label");
        gtk_label_set_xalign(GTK_LABEL(unit), 0.0);
        gtk_widget_set_margin_top(unit, 12);
        gtk_box_append(GTK_BOX(page), unit);
    }

    return page;
}

static GtkWidget* build_environment_page(void) {
    GtkWidget *page = gtk_box_new(GTK_ORIENTATION_VERTICAL, 12);
    gtk_widget_set_margin_start(page, 40);
    gtk_widget_set_margin_end(page, 40);
    gtk_widget_set_margin_top(page, 40);
    gtk_widget_set_margin_bottom(page, 40);
    gtk_widget_set_valign(page, GTK_ALIGN_CENTER);

    GtkWidget *title = gtk_label_new("Environment Check");
    gtk_widget_add_css_class(title, "title-2");
    gtk_label_set_xalign(GTK_LABEL(title), 0.0);
    gtk_box_append(GTK_BOX(page), title);

    /* Build environment checks */
    SystemdState *sys = state_get_systemd();
    gchar *config_path = NULL;
    gchar *state_dir = NULL;
    gchar *profile = NULL;
    extern void systemd_get_runtime_context(gchar **out_profile, gchar **out_state_dir, gchar **out_config_path);
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
            ecr.rows[i].label, ecr.rows[i].detail ? ecr.rows[i].detail : "");
        GtkWidget *detail = gtk_label_new(text);
        gtk_label_set_wrap(GTK_LABEL(detail), TRUE);
        gtk_label_set_xalign(GTK_LABEL(detail), 0.0);
        gtk_widget_set_hexpand(detail, TRUE);
        gtk_box_append(GTK_BOX(row), detail);

        gtk_box_append(GTK_BOX(page), row);
    }

    g_free(config_path);
    g_free(state_dir);
    g_free(profile);

    return page;
}

static GtkWidget* build_whats_next_page(void) {
    GtkWidget *page = gtk_box_new(GTK_ORIENTATION_VERTICAL, 16);
    gtk_widget_set_margin_start(page, 40);
    gtk_widget_set_margin_end(page, 40);
    gtk_widget_set_margin_top(page, 40);
    gtk_widget_set_margin_bottom(page, 40);
    gtk_widget_set_valign(page, GTK_ALIGN_CENTER);

    GtkWidget *title = gtk_label_new("What's Next");
    gtk_widget_add_css_class(title, "title-2");
    gtk_label_set_xalign(GTK_LABEL(title), 0.5);
    gtk_box_append(GTK_BOX(page), title);

    AppState current = state_get_current();
    ReadinessInfo ri;
    readiness_evaluate(current, state_get_health(), state_get_systemd(), &ri);

    if (current == STATE_RUNNING || current == STATE_RUNNING_WITH_WARNING) {
        GtkWidget *msg = gtk_label_new(
            "Your gateway is running. Open the Dashboard to start interacting "
            "with your AI agent, or explore the companion app to monitor and "
            "manage your gateway.");
        gtk_label_set_wrap(GTK_LABEL(msg), TRUE);
        gtk_label_set_xalign(GTK_LABEL(msg), 0.0);
        gtk_box_append(GTK_BOX(page), msg);

        GtkWidget *btn_row = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
        gtk_widget_set_halign(btn_row, GTK_ALIGN_CENTER);
        gtk_widget_set_margin_top(btn_row, 12);

        GtkWidget *dash_btn = gtk_button_new_with_label("Open Dashboard");
        gtk_widget_add_css_class(dash_btn, "suggested-action");
        g_signal_connect(dash_btn, "clicked", G_CALLBACK(on_open_dashboard_clicked), NULL);
        gtk_box_append(GTK_BOX(btn_row), dash_btn);

        gtk_box_append(GTK_BOX(page), btn_row);
    } else if (ri.next_action) {
        GtkWidget *guidance = gtk_label_new(ri.next_action);
        gtk_widget_add_css_class(guidance, "accent");
        gtk_label_set_wrap(GTK_LABEL(guidance), TRUE);
        gtk_label_set_xalign(GTK_LABEL(guidance), 0.0);
        gtk_box_append(GTK_BOX(page), guidance);
    }

    /* Documentation links */
    GtkWidget *links_label = gtk_label_new("Documentation:");
    gtk_widget_add_css_class(links_label, "dim-label");
    gtk_label_set_xalign(GTK_LABEL(links_label), 0.0);
    gtk_widget_set_margin_top(links_label, 20);
    gtk_box_append(GTK_BOX(page), links_label);

    GtkWidget *docs_link = gtk_label_new(NULL);
    gtk_label_set_markup(GTK_LABEL(docs_link),
        "<a href=\"https://docs.openclaw.ai\">docs.openclaw.ai</a>");
    gtk_label_set_xalign(GTK_LABEL(docs_link), 0.0);
    gtk_box_append(GTK_BOX(page), docs_link);

    /* Get Started button */
    GtkWidget *finish_btn = gtk_button_new_with_label("Get Started");
    gtk_widget_add_css_class(finish_btn, "pill");
    gtk_widget_add_css_class(finish_btn, "suggested-action");
    gtk_widget_set_halign(finish_btn, GTK_ALIGN_CENTER);
    gtk_widget_set_margin_top(finish_btn, 24);
    g_signal_connect(finish_btn, "clicked", G_CALLBACK(on_finish_clicked), NULL);
    gtk_box_append(GTK_BOX(page), finish_btn);

    return page;
}

/* ── Flow construction ── */

void onboarding_show(void) {
    if (onboard_window) {
        gtk_window_present(GTK_WINDOW(onboard_window));
        return;
    }

    GApplication *app = g_application_get_default();
    if (!app) return;

    AppState current = state_get_current();
    OnboardingRoute route = onboarding_routing_decide(
        current, onboarding_get_seen_version(), ONBOARDING_CURRENT_VERSION);

    onboard_window = adw_window_new();
    gtk_window_set_application(GTK_WINDOW(onboard_window), GTK_APPLICATION(app));
    gtk_window_set_title(GTK_WINDOW(onboard_window), "OpenClaw Setup");
    gtk_window_set_default_size(GTK_WINDOW(onboard_window), 560, 480);
    gtk_window_set_modal(GTK_WINDOW(onboard_window), TRUE);

    GtkWidget *carousel = adw_carousel_new();
    adw_carousel_set_allow_long_swipes(ADW_CAROUSEL(carousel), TRUE);

    /* Page 1: Welcome + Security (always shown) */
    GtkWidget *welcome = build_welcome_page();
    adw_carousel_append(ADW_CAROUSEL(carousel), welcome);

    if (route == ONBOARDING_SHOW_FULL) {
        /* Full flow: Gateway & Service + Environment Check */
        GtkWidget *gateway = build_gateway_page();
        adw_carousel_append(ADW_CAROUSEL(carousel), gateway);

        GtkWidget *env = build_environment_page();
        adw_carousel_append(ADW_CAROUSEL(carousel), env);
    }

    /* Final page: What's Next (always shown) */
    GtkWidget *whats_next = build_whats_next_page();
    adw_carousel_append(ADW_CAROUSEL(carousel), whats_next);

    /* Carousel indicator dots */
    GtkWidget *indicator_dots = adw_carousel_indicator_dots_new();
    adw_carousel_indicator_dots_set_carousel(ADW_CAROUSEL_INDICATOR_DOTS(indicator_dots),
                                              ADW_CAROUSEL(carousel));

    GtkWidget *vbox = gtk_box_new(GTK_ORIENTATION_VERTICAL, 0);
    gtk_widget_set_vexpand(carousel, TRUE);
    gtk_box_append(GTK_BOX(vbox), carousel);
    gtk_widget_set_margin_bottom(indicator_dots, 12);
    gtk_widget_set_halign(indicator_dots, GTK_ALIGN_CENTER);
    gtk_box_append(GTK_BOX(vbox), indicator_dots);

    adw_window_set_content(ADW_WINDOW(onboard_window), vbox);
    g_signal_connect(onboard_window, "destroy", G_CALLBACK(on_onboard_destroy), NULL);

    gtk_window_present(GTK_WINDOW(onboard_window));
}

void onboarding_check_and_show(void) {
    AppState current = state_get_current();
    OnboardingRoute route = onboarding_routing_decide(
        current, onboarding_get_seen_version(), ONBOARDING_CURRENT_VERSION);

    if (route == ONBOARDING_SKIP) {
        OC_LOG_DEBUG(OPENCLAW_LOG_CAT_STATE, "onboarding: skip (seen=%d current=%d)",
                     onboarding_get_seen_version(), ONBOARDING_CURRENT_VERSION);
        return;
    }

    OC_LOG_INFO(OPENCLAW_LOG_CAT_STATE, "onboarding: showing %s flow",
                route == ONBOARDING_SHOW_FULL ? "full" : "shortened");
    onboarding_show();
}
