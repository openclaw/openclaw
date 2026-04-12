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
static GtkWidget *onboard_carousel = NULL;
static GtkWidget *onboard_indicator = NULL;
static OnboardingRoute onboard_current_route = ONBOARDING_SHOW_SHORTENED;

static GtkWidget *onboard_gateway_explanation_label = NULL;
static GtkWidget *onboard_gateway_stage_config_icon = NULL;
static GtkWidget *onboard_gateway_stage_config_detail = NULL;
static GtkWidget *onboard_gateway_stage_service_icon = NULL;
static GtkWidget *onboard_gateway_stage_service_detail = NULL;
static GtkWidget *onboard_gateway_stage_connection_icon = NULL;
static GtkWidget *onboard_gateway_stage_connection_detail = NULL;
static GtkWidget *onboard_gateway_next_action_box = NULL;
static GtkWidget *onboard_gateway_next_action_value = NULL;

static GtkWidget *onboard_whats_next_guidance_label = NULL;
static GtkWidget *onboard_whats_next_dashboard_button = NULL;

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

static void onboarding_refresh_live_content(void);
static GtkWidget* build_gateway_page(GtkWidget *carousel);
static GtkWidget* build_environment_page(GtkWidget *carousel);
static GtkWidget* build_whats_next_page(GtkWidget *carousel);

static void snapshot_free(OnboardingRenderSnapshot *snap) {
    g_free(snap->next_action);
    snap->next_action = NULL;
}

static void on_onboard_destroy(GtkWindow *window, gpointer user_data) {
    (void)window;
    (void)user_data;
    onboard_window = NULL;
    onboard_carousel = NULL;
    onboard_indicator = NULL;
    onboard_gateway_explanation_label = NULL;
    onboard_gateway_stage_config_icon = NULL;
    onboard_gateway_stage_config_detail = NULL;
    onboard_gateway_stage_service_icon = NULL;
    onboard_gateway_stage_service_detail = NULL;
    onboard_gateway_stage_connection_icon = NULL;
    onboard_gateway_stage_connection_detail = NULL;
    onboard_gateway_next_action_box = NULL;
    onboard_gateway_next_action_value = NULL;
    onboard_whats_next_guidance_label = NULL;
    onboard_whats_next_dashboard_button = NULL;
    onboard_has_render_snapshot = FALSE;
    snapshot_free(&onboard_last_snapshot);
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

static void on_next_clicked(GtkButton *btn, gpointer data) {
    (void)btn;
    GtkWidget *carousel = GTK_WIDGET(data);
    double n_pages = adw_carousel_get_n_pages(ADW_CAROUSEL(carousel));
    double pos = adw_carousel_get_position(ADW_CAROUSEL(carousel));
    if (pos + 1 < n_pages) {
        adw_carousel_scroll_to(ADW_CAROUSEL(carousel), GTK_WIDGET(adw_carousel_get_nth_page(ADW_CAROUSEL(carousel), pos + 1)), TRUE);
    }
}

static void on_back_clicked(GtkButton *btn, gpointer data) {
    (void)btn;
    GtkWidget *carousel = GTK_WIDGET(data);
    double pos = adw_carousel_get_position(ADW_CAROUSEL(carousel));
    if (pos >= 1.0) {
        adw_carousel_scroll_to(ADW_CAROUSEL(carousel), GTK_WIDGET(adw_carousel_get_nth_page(ADW_CAROUSEL(carousel), pos - 1)), TRUE);
    }
}

static void on_close_clicked(GtkButton *btn, gpointer data) {
    (void)btn; (void)data;
    if (onboard_window) {
        gtk_window_destroy(GTK_WINDOW(onboard_window));
    }
}

static const char* stage_icon(OnboardingStageState state) {
    switch (state) {
        case ONBOARDING_STAGE_COMPLETE: return "\u2705";
        case ONBOARDING_STAGE_IN_PROGRESS: return "\u23F3";
        case ONBOARDING_STAGE_PENDING:
        default: return "\u25CB";
    }
}

static const char* stage_detail_for_config(OnboardingStageState state) {
    switch (state) {
        case ONBOARDING_STAGE_COMPLETE: return "Configuration validated";
        case ONBOARDING_STAGE_IN_PROGRESS: return "Resolving configuration issues";
        case ONBOARDING_STAGE_PENDING:
        default: return "Configuration not ready yet";
    }
}

static const char* stage_detail_for_service(OnboardingStageState state) {
    switch (state) {
        case ONBOARDING_STAGE_COMPLETE: return "Service installed and active";
        case ONBOARDING_STAGE_IN_PROGRESS: return "Service install or activation in progress";
        case ONBOARDING_STAGE_PENDING:
        default: return "Service setup pending";
    }
}

static const char* stage_detail_for_connection(OnboardingStageState state) {
    switch (state) {
        case ONBOARDING_STAGE_COMPLETE: return "Gateway connection established";
        case ONBOARDING_STAGE_IN_PROGRESS: return "Waiting for stable connection";
        case ONBOARDING_STAGE_PENDING:
        default: return "Connection not attempted yet";
    }
}

static GtkWidget* build_stage_row(const char *label,
                                  OnboardingStageState state,
                                  const char *detail,
                                  GtkWidget **out_icon,
                                  GtkWidget **out_detail) {
    GtkWidget *row = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
    gtk_widget_set_margin_top(row, 2);

    GtkWidget *icon = gtk_label_new(stage_icon(state));
    if (out_icon) *out_icon = icon;
    gtk_box_append(GTK_BOX(row), icon);

    GtkWidget *text_col = gtk_box_new(GTK_ORIENTATION_VERTICAL, 2);
    gtk_widget_set_hexpand(text_col, TRUE);

    GtkWidget *title = gtk_label_new(label);
    gtk_widget_add_css_class(title, "heading");
    gtk_label_set_xalign(GTK_LABEL(title), 0.0);
    gtk_box_append(GTK_BOX(text_col), title);

    GtkWidget *detail_lbl = gtk_label_new(detail);
    if (out_detail) *out_detail = detail_lbl;
    gtk_widget_add_css_class(detail_lbl, "dim-label");
    gtk_label_set_xalign(GTK_LABEL(detail_lbl), 0.0);
    gtk_label_set_wrap(GTK_LABEL(detail_lbl), TRUE);
    gtk_box_append(GTK_BOX(text_col), detail_lbl);

    gtk_box_append(GTK_BOX(row), text_col);
    return row;
}

/* ── Page builders ── */

static GtkWidget* build_welcome_page(GtkWidget *carousel) {
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

    GtkWidget *btn_row = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
    gtk_widget_set_halign(btn_row, GTK_ALIGN_CENTER);
    gtk_widget_set_margin_top(btn_row, 24);

    GtkWidget *close_btn = gtk_button_new_with_label("Close");
    g_signal_connect(close_btn, "clicked", G_CALLBACK(on_close_clicked), NULL);
    gtk_box_append(GTK_BOX(btn_row), close_btn);

    GtkWidget *next_btn = gtk_button_new_with_label("Next");
    gtk_widget_add_css_class(next_btn, "suggested-action");
    g_signal_connect(next_btn, "clicked", G_CALLBACK(on_next_clicked), carousel);
    gtk_box_append(GTK_BOX(btn_row), next_btn);

    gtk_box_append(GTK_BOX(page), btn_row);

    return page;
}

static void onboarding_update_gateway_content(AppState current,
                                              const ReadinessInfo *ri,
                                              const OnboardingStageProgress *progress,
                                              const ChatGateInfo *gate) {
    if (onboard_gateway_explanation_label) {
        if (current == STATE_NEEDS_SETUP) {
            gtk_label_set_text(GTK_LABEL(onboard_gateway_explanation_label),
                               "OpenClaw is not bootstrapped yet. The companion app needs a local gateway service to function.");
        } else if (current == STATE_NEEDS_GATEWAY_INSTALL) {
            gtk_label_set_text(GTK_LABEL(onboard_gateway_explanation_label),
                               "A configuration exists, but the gateway service is not installed.");
        } else if (current == STATE_NEEDS_ONBOARDING) {
            gtk_label_set_text(GTK_LABEL(onboard_gateway_explanation_label),
                               "Local bootstrap is incomplete. The onboarding wizard needs to finish configuring the gateway.");
        } else if (!gate->ready) {
            gtk_label_set_text(GTK_LABEL(onboard_gateway_explanation_label),
                               "Gateway bootstrap is complete. Open Config -> Provider & Model Setup, configure a provider, reload models, and set a default model to unlock chat.");
        } else {
            gtk_label_set_text(GTK_LABEL(onboard_gateway_explanation_label),
                               "The gateway service is installed and configured.");
        }
    }

    if (onboard_gateway_stage_config_icon) {
        gtk_label_set_text(GTK_LABEL(onboard_gateway_stage_config_icon),
                           stage_icon(progress->configuration));
    }
    if (onboard_gateway_stage_config_detail) {
        gtk_label_set_text(GTK_LABEL(onboard_gateway_stage_config_detail),
                           stage_detail_for_config(progress->configuration));
    }

    if (onboard_gateway_stage_service_icon) {
        gtk_label_set_text(GTK_LABEL(onboard_gateway_stage_service_icon),
                           stage_icon(progress->service_gateway));
    }
    if (onboard_gateway_stage_service_detail) {
        gtk_label_set_text(GTK_LABEL(onboard_gateway_stage_service_detail),
                           stage_detail_for_service(progress->service_gateway));
    }

    if (onboard_gateway_stage_connection_icon) {
        gtk_label_set_text(GTK_LABEL(onboard_gateway_stage_connection_icon),
                           stage_icon(progress->connection));
    }
    if (onboard_gateway_stage_connection_detail) {
        gtk_label_set_text(GTK_LABEL(onboard_gateway_stage_connection_detail),
                           stage_detail_for_connection(progress->connection));
    }

    const gchar *next_action = gate->next_action ? gate->next_action : ri->next_action;
    if (onboard_gateway_next_action_value) {
        gtk_label_set_text(GTK_LABEL(onboard_gateway_next_action_value),
                           next_action ? next_action : "");
    }
    if (onboard_gateway_next_action_box) {
        gtk_widget_set_visible(onboard_gateway_next_action_box,
                               next_action != NULL && next_action[0] != '\0');
    }
}

static void onboarding_update_whats_next_content(const ReadinessInfo *ri,
                                                 const ChatGateInfo *gate) {
    if (onboard_whats_next_guidance_label) {
        if (gate->ready) {
            gtk_label_set_text(GTK_LABEL(onboard_whats_next_guidance_label),
                               "Your gateway is running. Open the Dashboard to start interacting with your AI agent, or explore the companion app to monitor and manage your gateway.");
        } else {
            const gchar *guidance_text = gate->next_action ? gate->next_action : ri->next_action;
            g_autofree gchar *guided = g_strdup_printf(
                "%s Then open Config -> Provider & Model Setup to finish provider/model readiness in-app.",
                guidance_text ? guidance_text : "");
            gtk_label_set_text(GTK_LABEL(onboard_whats_next_guidance_label), guided);
        }
    }
    if (onboard_whats_next_dashboard_button) {
        gtk_widget_set_visible(onboard_whats_next_dashboard_button, gate->ready);
    }
}

static void onboarding_refresh_live_content(void) {
    AppState current = state_get_current();
    ReadinessInfo ri;
    readiness_evaluate(current, state_get_health(), state_get_systemd(), &ri);
    const DesktopReadinessSnapshot *snapshot = state_get_readiness_snapshot();
    ChatGateInfo gate = {0};
    readiness_describe_chat_gate(snapshot, &gate);
    OnboardingStageProgress progress;
    readiness_build_onboarding_progress(current, state_get_health(), state_get_systemd(), &progress);

    onboarding_update_gateway_content(current, &ri, &progress, &gate);
    onboarding_update_whats_next_content(&ri, &gate);
}

static void onboarding_build_pages(OnboardingRoute route) {
    GtkWidget *welcome = build_welcome_page(onboard_carousel);
    adw_carousel_append(ADW_CAROUSEL(onboard_carousel), welcome);

    if (route == ONBOARDING_SHOW_FULL) {
        GtkWidget *gateway = build_gateway_page(onboard_carousel);
        adw_carousel_append(ADW_CAROUSEL(onboard_carousel), gateway);

        GtkWidget *env = build_environment_page(onboard_carousel);
        adw_carousel_append(ADW_CAROUSEL(onboard_carousel), env);
    }

    GtkWidget *whats_next = build_whats_next_page(onboard_carousel);
    adw_carousel_append(ADW_CAROUSEL(onboard_carousel), whats_next);

    onboard_current_route = route;
    onboarding_refresh_live_content();
}

static void onboarding_rebuild_pages(OnboardingRoute route) {
    if (!onboard_carousel) return;

    guint page_count = (guint)adw_carousel_get_n_pages(ADW_CAROUSEL(onboard_carousel));
    guint current_pos = (guint)adw_carousel_get_position(ADW_CAROUSEL(onboard_carousel));

    while (page_count > 0) {
        GtkWidget *child = GTK_WIDGET(adw_carousel_get_nth_page(ADW_CAROUSEL(onboard_carousel), 0));
        if (!child) break;
        adw_carousel_remove(ADW_CAROUSEL(onboard_carousel), child);
        page_count--;
    }

    onboard_gateway_explanation_label = NULL;
    onboard_gateway_stage_config_icon = NULL;
    onboard_gateway_stage_config_detail = NULL;
    onboard_gateway_stage_service_icon = NULL;
    onboard_gateway_stage_service_detail = NULL;
    onboard_gateway_stage_connection_icon = NULL;
    onboard_gateway_stage_connection_detail = NULL;
    onboard_gateway_next_action_box = NULL;
    onboard_gateway_next_action_value = NULL;
    onboard_whats_next_guidance_label = NULL;
    onboard_whats_next_dashboard_button = NULL;

    onboarding_build_pages(route);

    guint new_count = (guint)adw_carousel_get_n_pages(ADW_CAROUSEL(onboard_carousel));
    if (new_count > 0) {
        guint clamped = current_pos < new_count ? current_pos : (new_count - 1);
        GtkWidget *target = GTK_WIDGET(adw_carousel_get_nth_page(ADW_CAROUSEL(onboard_carousel), clamped));
        if (target) {
            adw_carousel_scroll_to(ADW_CAROUSEL(onboard_carousel), target, FALSE);
        }
    }
}

static GtkWidget* build_gateway_page(GtkWidget *carousel) {
    GtkWidget *page = gtk_box_new(GTK_ORIENTATION_VERTICAL, 12);
    gtk_widget_set_margin_start(page, 40);
    gtk_widget_set_margin_end(page, 40);
    gtk_widget_set_margin_top(page, 40);
    gtk_widget_set_margin_bottom(page, 40);
    gtk_widget_set_valign(page, GTK_ALIGN_CENTER);

    GtkWidget *title = gtk_label_new("Gateway Status");
    gtk_widget_add_css_class(title, "title-2");
    gtk_label_set_xalign(GTK_LABEL(title), 0.0);
    gtk_box_append(GTK_BOX(page), title);

    AppState current = state_get_current();
    SystemdState *sys = state_get_systemd();
    HealthState *health = state_get_health();
    const DesktopReadinessSnapshot *snapshot = state_get_readiness_snapshot();
    ChatGateInfo gate = {0};
    readiness_describe_chat_gate(snapshot, &gate);

    ReadinessInfo ri;
    readiness_evaluate(current, health, sys, &ri);

    OnboardingStageProgress progress;
    readiness_build_onboarding_progress(current, health, sys, &progress);

    /* State-aware guidance text */
    GtkWidget *explanation = gtk_label_new(NULL);
    if (current == STATE_NEEDS_SETUP) {
        gtk_label_set_text(GTK_LABEL(explanation),
            "OpenClaw is not bootstrapped yet. The companion app needs a local gateway service to function.");
    } else if (current == STATE_NEEDS_GATEWAY_INSTALL) {
        gtk_label_set_text(GTK_LABEL(explanation),
            "A configuration exists, but the gateway service is not installed.");
    } else if (current == STATE_NEEDS_ONBOARDING) {
        gtk_label_set_text(GTK_LABEL(explanation),
            "Local bootstrap is incomplete. The onboarding wizard needs to finish configuring the gateway.");
    } else if (!gate.ready) {
        gtk_label_set_text(GTK_LABEL(explanation),
            "Gateway bootstrap is complete. Open Config -> Provider & Model Setup, configure a provider, reload models, and set a default model to unlock chat.");
    } else {
        gtk_label_set_text(GTK_LABEL(explanation),
            "The gateway service is installed and configured.");
    }
    gtk_label_set_wrap(GTK_LABEL(explanation), TRUE);
    gtk_label_set_xalign(GTK_LABEL(explanation), 0.0);
    gtk_box_append(GTK_BOX(page), explanation);
    onboard_gateway_explanation_label = explanation;

    GtkWidget *stage_heading = gtk_label_new("Setup progress");
    gtk_widget_add_css_class(stage_heading, "heading");
    gtk_label_set_xalign(GTK_LABEL(stage_heading), 0.0);
    gtk_widget_set_margin_top(stage_heading, 12);
    gtk_box_append(GTK_BOX(page), stage_heading);

    GtkWidget *stages = gtk_box_new(GTK_ORIENTATION_VERTICAL, 4);
    gtk_widget_set_margin_top(stages, 4);
    gtk_box_append(GTK_BOX(stages),
                   build_stage_row("Configuration",
                                   progress.configuration,
                                   stage_detail_for_config(progress.configuration),
                                   &onboard_gateway_stage_config_icon,
                                   &onboard_gateway_stage_config_detail));
    gtk_box_append(GTK_BOX(stages),
                   build_stage_row("Service / Gateway",
                                   progress.service_gateway,
                                   stage_detail_for_service(progress.service_gateway),
                                   &onboard_gateway_stage_service_icon,
                                   &onboard_gateway_stage_service_detail));
    gtk_box_append(GTK_BOX(stages),
                   build_stage_row("Connection",
                                   progress.connection,
                                   stage_detail_for_connection(progress.connection),
                                   &onboard_gateway_stage_connection_icon,
                                   &onboard_gateway_stage_connection_detail));
    gtk_box_append(GTK_BOX(page), stages);

    const gchar *next_action = gate.next_action ? gate.next_action : ri.next_action;
    GtkWidget *action_box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 8);
    gtk_widget_set_margin_top(action_box, 16);
    gtk_widget_set_margin_bottom(action_box, 16);

    GtkWidget *action_label = gtk_label_new("Next step:");
    gtk_widget_add_css_class(action_label, "dim-label");
    gtk_label_set_xalign(GTK_LABEL(action_label), 0.0);
    gtk_box_append(GTK_BOX(action_box), action_label);

    GtkWidget *cmd_label = gtk_label_new(next_action ? next_action : "");
    gtk_widget_add_css_class(cmd_label, "accent");
    gtk_label_set_wrap(GTK_LABEL(cmd_label), TRUE);
    gtk_label_set_selectable(GTK_LABEL(cmd_label), TRUE);
    gtk_label_set_xalign(GTK_LABEL(cmd_label), 0.0);

    GtkWidget *frame = gtk_frame_new(NULL);
    gtk_widget_set_margin_top(frame, 4);
    gtk_frame_set_child(GTK_FRAME(frame), cmd_label);
    gtk_box_append(GTK_BOX(action_box), frame);

    gtk_widget_set_visible(action_box, next_action != NULL && next_action[0] != '\0');
    gtk_box_append(GTK_BOX(page), action_box);
    onboard_gateway_next_action_box = action_box;
    onboard_gateway_next_action_value = cmd_label;

    GtkWidget *btn_row = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
    gtk_widget_set_halign(btn_row, GTK_ALIGN_CENTER);
    gtk_widget_set_margin_top(btn_row, 24);

    GtkWidget *back_btn = gtk_button_new_with_label("Back");
    g_signal_connect(back_btn, "clicked", G_CALLBACK(on_back_clicked), carousel);
    gtk_box_append(GTK_BOX(btn_row), back_btn);

    GtkWidget *close_btn = gtk_button_new_with_label("Close");
    g_signal_connect(close_btn, "clicked", G_CALLBACK(on_close_clicked), NULL);
    gtk_box_append(GTK_BOX(btn_row), close_btn);

    GtkWidget *next_btn = gtk_button_new_with_label("Next");
    gtk_widget_add_css_class(next_btn, "suggested-action");
    g_signal_connect(next_btn, "clicked", G_CALLBACK(on_next_clicked), carousel);
    gtk_box_append(GTK_BOX(btn_row), next_btn);

    gtk_box_append(GTK_BOX(page), btn_row);

    return page;
}

static GtkWidget* build_environment_page(GtkWidget *carousel) {
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

    environment_check_result_clear(&ecr);

    g_free(config_path);
    g_free(state_dir);
    g_free(profile);

    GtkWidget *btn_row = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
    gtk_widget_set_halign(btn_row, GTK_ALIGN_CENTER);
    gtk_widget_set_margin_top(btn_row, 24);

    GtkWidget *back_btn = gtk_button_new_with_label("Back");
    g_signal_connect(back_btn, "clicked", G_CALLBACK(on_back_clicked), carousel);
    gtk_box_append(GTK_BOX(btn_row), back_btn);

    GtkWidget *close_btn = gtk_button_new_with_label("Close");
    g_signal_connect(close_btn, "clicked", G_CALLBACK(on_close_clicked), NULL);
    gtk_box_append(GTK_BOX(btn_row), close_btn);

    GtkWidget *next_btn = gtk_button_new_with_label("Next");
    gtk_widget_add_css_class(next_btn, "suggested-action");
    g_signal_connect(next_btn, "clicked", G_CALLBACK(on_next_clicked), carousel);
    gtk_box_append(GTK_BOX(btn_row), next_btn);

    gtk_box_append(GTK_BOX(page), btn_row);

    return page;
}

static GtkWidget* build_whats_next_page(GtkWidget *carousel) {
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
    const DesktopReadinessSnapshot *snapshot = state_get_readiness_snapshot();
    ChatGateInfo gate = {0};
    readiness_describe_chat_gate(snapshot, &gate);

    const gchar *guidance_text = gate.next_action ? gate.next_action : ri.next_action;
    g_autofree gchar *guided = gate.ready
        ? g_strdup("Your gateway is running. Open the Dashboard to start interacting with your AI agent, or explore the companion app to monitor and manage your gateway.")
        : g_strdup_printf("%s Then open Config -> Provider & Model Setup to finish provider/model readiness in-app.",
                          guidance_text ? guidance_text : "");
    GtkWidget *guidance = gtk_label_new(guided);
    gtk_widget_add_css_class(guidance, "accent");
    gtk_label_set_wrap(GTK_LABEL(guidance), TRUE);
    gtk_label_set_xalign(GTK_LABEL(guidance), 0.0);
    gtk_box_append(GTK_BOX(page), guidance);
    onboard_whats_next_guidance_label = guidance;

    GtkWidget *dash_row = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
    gtk_widget_set_halign(dash_row, GTK_ALIGN_CENTER);
    gtk_widget_set_margin_top(dash_row, 12);

    GtkWidget *dash_btn = gtk_button_new_with_label("Open Dashboard");
    gtk_widget_add_css_class(dash_btn, "suggested-action");
    g_signal_connect(dash_btn, "clicked", G_CALLBACK(on_open_dashboard_clicked), NULL);
    gtk_box_append(GTK_BOX(dash_row), dash_btn);
    gtk_widget_set_visible(dash_row, gate.ready);
    gtk_box_append(GTK_BOX(page), dash_row);
    onboard_whats_next_dashboard_button = dash_row;

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

    GtkWidget *btn_row = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
    gtk_widget_set_halign(btn_row, GTK_ALIGN_CENTER);
    gtk_widget_set_margin_top(btn_row, 24);

    GtkWidget *back_btn = gtk_button_new_with_label("Back");
    g_signal_connect(back_btn, "clicked", G_CALLBACK(on_back_clicked), carousel);
    gtk_box_append(GTK_BOX(btn_row), back_btn);

    /* Get Started button */
    GtkWidget *finish_btn = gtk_button_new_with_label("Get Started");
    gtk_widget_add_css_class(finish_btn, "pill");
    gtk_widget_add_css_class(finish_btn, "suggested-action");
    g_signal_connect(finish_btn, "clicked", G_CALLBACK(on_finish_clicked), NULL);
    gtk_box_append(GTK_BOX(btn_row), finish_btn);

    gtk_box_append(GTK_BOX(page), btn_row);

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

    onboard_carousel = adw_carousel_new();
    adw_carousel_set_allow_long_swipes(ADW_CAROUSEL(onboard_carousel), TRUE);
    onboarding_build_pages(route);

    /* Carousel indicator dots */
    onboard_indicator = adw_carousel_indicator_dots_new();
    adw_carousel_indicator_dots_set_carousel(ADW_CAROUSEL_INDICATOR_DOTS(onboard_indicator),
                                              ADW_CAROUSEL(onboard_carousel));

    GtkWidget *vbox = gtk_box_new(GTK_ORIENTATION_VERTICAL, 0);
    gtk_widget_set_vexpand(onboard_carousel, TRUE);
    gtk_box_append(GTK_BOX(vbox), onboard_carousel);
    gtk_widget_set_margin_bottom(onboard_indicator, 12);
    gtk_widget_set_halign(onboard_indicator, GTK_ALIGN_CENTER);
    gtk_box_append(GTK_BOX(vbox), onboard_indicator);

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
    extern void systemd_get_runtime_context(gchar **out_profile, gchar **out_state_dir, gchar **out_config_path);
    systemd_get_runtime_context(&profile, &state_dir, &config_path);

    gboolean config_file_exists = config_path && g_file_test(config_path, G_FILE_TEST_EXISTS);
    gboolean state_dir_exists = state_dir && g_file_test(state_dir, G_FILE_TEST_IS_DIR);

    ReadinessInfo ri;
    readiness_evaluate(current, health, sys, &ri);

    OnboardingStageProgress progress;
    readiness_build_onboarding_progress(current, health, sys, &progress);

    if (progress.operational_ready) {
        write_seen_version(ONBOARDING_CURRENT_VERSION);
        if (onboard_window) {
            gtk_window_destroy(GTK_WINDOW(onboard_window));
        }
        app_window_show();
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

    if (onboard_has_render_snapshot &&
        onboard_last_snapshot.state == new_snap.state &&
        onboard_last_snapshot.route == new_snap.route &&
        onboard_last_snapshot.stage_configuration == new_snap.stage_configuration &&
        onboard_last_snapshot.stage_service_gateway == new_snap.stage_service_gateway &&
        onboard_last_snapshot.stage_connection == new_snap.stage_connection &&
        onboard_last_snapshot.operational_ready == new_snap.operational_ready &&
        onboard_last_snapshot.config_valid == new_snap.config_valid &&
        onboard_last_snapshot.setup_detected == new_snap.setup_detected &&
        onboard_last_snapshot.sys_installed == new_snap.sys_installed &&
        onboard_last_snapshot.sys_active == new_snap.sys_active &&
        onboard_last_snapshot.config_file_exists == new_snap.config_file_exists &&
        onboard_last_snapshot.state_dir_exists == new_snap.state_dir_exists &&
        g_strcmp0(onboard_last_snapshot.next_action, new_snap.next_action) == 0) {
        
        snapshot_free(&new_snap);
        return; /* No material change, skip rebuild */
    }

    if (new_snap.route != onboard_current_route) {
        onboarding_rebuild_pages(new_snap.route);
    } else {
        onboarding_refresh_live_content();
    }

    snapshot_free(&onboard_last_snapshot);
    onboard_last_snapshot = new_snap;
    onboard_has_render_snapshot = TRUE;
    return;
}
