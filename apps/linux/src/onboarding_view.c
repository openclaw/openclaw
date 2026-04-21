/*
 * onboarding_view.c
 *
 * View/rendering layer for the OpenClaw Linux companion onboarding flow.
 *
 * Owns onboarding page widgets, page construction, page rebuild/reset,
 * and live content rendering. The controller/lifecycle decisions remain
 * in `onboarding.c`.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "onboarding_view.h"

#include <adwaita.h>
#include <string.h>

#include "gateway_client.h"
#include "gateway_config.h"
#include "readiness.h"
#include "runtime_paths.h"
#include "state.h"

static OnboardingViewCallbacks onboarding_view_callbacks = {0};
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
static GtkWidget *onboard_environment_checks_box = NULL;

static void on_next_clicked(GtkButton *button, gpointer user_data) {
    (void)button;

    GtkWidget *carousel = GTK_WIDGET(user_data);
    double n_pages = adw_carousel_get_n_pages(ADW_CAROUSEL(carousel));
    double pos = adw_carousel_get_position(ADW_CAROUSEL(carousel));
    if (pos + 1 < n_pages) {
        adw_carousel_scroll_to(ADW_CAROUSEL(carousel),
                               GTK_WIDGET(adw_carousel_get_nth_page(ADW_CAROUSEL(carousel), pos + 1)),
                               TRUE);
    }
}

static void on_back_clicked(GtkButton *button, gpointer user_data) {
    (void)button;

    GtkWidget *carousel = GTK_WIDGET(user_data);
    double pos = adw_carousel_get_position(ADW_CAROUSEL(carousel));
    if (pos >= 1.0) {
        adw_carousel_scroll_to(ADW_CAROUSEL(carousel),
                               GTK_WIDGET(adw_carousel_get_nth_page(ADW_CAROUSEL(carousel), pos - 1)),
                               TRUE);
    }
}

static void onboarding_render_environment_checks(GtkWidget *container) {
    if (!container || !GTK_IS_BOX(container)) {
        return;
    }

    GtkWidget *child = NULL;
    while ((child = gtk_widget_get_first_child(container)) != NULL) {
        gtk_box_remove(GTK_BOX(container), child);
    }

    SystemdState *sys = state_get_systemd();
    g_autofree gchar *config_path = NULL;
    g_autofree gchar *state_dir = NULL;
    g_autofree gchar *profile = NULL;
    systemd_get_runtime_context(&profile, &state_dir, &config_path);

    GatewayConfig *cfg = gateway_client_get_config();
    RuntimeEffectivePaths effective_paths = {0};
    runtime_effective_paths_resolve(cfg, profile, state_dir, config_path, &effective_paths);

    EnvironmentCheckResult result;
    environment_check_build(sys,
                            effective_paths.effective_config_path,
                            effective_paths.effective_state_dir,
                            &result);

    for (int i = 0; i < result.count; i++) {
        GtkWidget *row = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
        gtk_widget_set_margin_top(row, 4);

        const char *icon = result.rows[i].passed ? "✅" : "❌";
        GtkWidget *icon_label = gtk_label_new(icon);
        gtk_box_append(GTK_BOX(row), icon_label);

        g_autofree gchar *text = g_strdup_printf("%s: %s",
                                                 result.rows[i].label,
                                                 result.rows[i].detail ? result.rows[i].detail : "");
        GtkWidget *detail = gtk_label_new(text);
        gtk_label_set_wrap(GTK_LABEL(detail), TRUE);
        gtk_label_set_xalign(GTK_LABEL(detail), 0.0);
        gtk_widget_set_hexpand(detail, TRUE);
        gtk_box_append(GTK_BOX(row), detail);

        gtk_box_append(GTK_BOX(container), row);
    }

    environment_check_result_clear(&result);
    runtime_effective_paths_clear(&effective_paths);
}

static void onboarding_refresh_environment_content(void) {
    if (!onboard_environment_checks_box) {
        return;
    }

    onboarding_render_environment_checks(onboard_environment_checks_box);
}

static const char* stage_icon(OnboardingStageState state) {
    switch (state) {
    case ONBOARDING_STAGE_COMPLETE:
        return "✅";
    case ONBOARDING_STAGE_IN_PROGRESS:
        return "⏳";
    case ONBOARDING_STAGE_PENDING:
    default:
        return "○";
    }
}

static const char* stage_detail_for_config(OnboardingStageState state) {
    switch (state) {
    case ONBOARDING_STAGE_COMPLETE:
        return "Configuration validated";
    case ONBOARDING_STAGE_IN_PROGRESS:
        return "Resolving configuration issues";
    case ONBOARDING_STAGE_PENDING:
    default:
        return "Configuration not ready yet";
    }
}

static const char* stage_detail_for_service(OnboardingStageState state) {
    switch (state) {
    case ONBOARDING_STAGE_COMPLETE:
        return "Service installed and active";
    case ONBOARDING_STAGE_IN_PROGRESS:
        return "Service install or activation in progress";
    case ONBOARDING_STAGE_PENDING:
    default:
        return "Service setup pending";
    }
}

static const char* stage_detail_for_connection(OnboardingStageState state) {
    switch (state) {
    case ONBOARDING_STAGE_COMPLETE:
        return "Gateway connection established";
    case ONBOARDING_STAGE_IN_PROGRESS:
        return "Waiting for stable connection";
    case ONBOARDING_STAGE_PENDING:
    default:
        return "Connection not attempted yet";
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
    if (out_icon) {
        *out_icon = icon;
    }
    gtk_box_append(GTK_BOX(row), icon);

    GtkWidget *text_col = gtk_box_new(GTK_ORIENTATION_VERTICAL, 2);
    gtk_widget_set_hexpand(text_col, TRUE);

    GtkWidget *title = gtk_label_new(label);
    gtk_widget_add_css_class(title, "heading");
    gtk_label_set_xalign(GTK_LABEL(title), 0.0);
    gtk_box_append(GTK_BOX(text_col), title);

    GtkWidget *detail_label = gtk_label_new(detail);
    if (out_detail) {
        *out_detail = detail_label;
    }
    gtk_widget_add_css_class(detail_label, "dim-label");
    gtk_label_set_xalign(GTK_LABEL(detail_label), 0.0);
    gtk_label_set_wrap(GTK_LABEL(detail_label), TRUE);
    gtk_box_append(GTK_BOX(text_col), detail_label);

    gtk_box_append(GTK_BOX(row), text_col);
    return row;
}

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

    GtkWidget *subtitle = gtk_label_new("The Linux companion for your OpenClaw gateway.");
    gtk_widget_add_css_class(subtitle, "title-3");
    gtk_label_set_xalign(GTK_LABEL(subtitle), 0.5);
    gtk_box_append(GTK_BOX(page), subtitle);

    GtkWidget *security = gtk_label_new(
        "OpenClaw connects to an AI agent gateway that can trigger powerful actions on your system. The companion app helps you monitor, manage, and stay informed about your gateway's status.");
    gtk_label_set_wrap(GTK_LABEL(security), TRUE);
    gtk_label_set_xalign(GTK_LABEL(security), 0.0);
    gtk_widget_set_margin_top(security, 16);
    gtk_box_append(GTK_BOX(page), security);

    GtkWidget *btn_row = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
    gtk_widget_set_halign(btn_row, GTK_ALIGN_CENTER);
    gtk_widget_set_margin_top(btn_row, 24);

    GtkWidget *close_btn = gtk_button_new_with_label("Close");
    g_signal_connect(close_btn, "clicked", G_CALLBACK(onboarding_view_callbacks.close_clicked), NULL);
    gtk_box_append(GTK_BOX(btn_row), close_btn);

    GtkWidget *next_btn = gtk_button_new_with_label("Next");
    gtk_widget_add_css_class(next_btn, "suggested-action");
    g_signal_connect(next_btn, "clicked", G_CALLBACK(on_next_clicked), carousel);
    gtk_box_append(GTK_BOX(btn_row), next_btn);

    gtk_box_append(GTK_BOX(page), btn_row);
    return page;
}

static void onboarding_update_gateway_content(AppState current,
                                              const ReadinessInfo *readiness,
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
        gtk_label_set_text(GTK_LABEL(onboard_gateway_stage_config_icon), stage_icon(progress->configuration));
    }
    if (onboard_gateway_stage_config_detail) {
        gtk_label_set_text(GTK_LABEL(onboard_gateway_stage_config_detail),
                           stage_detail_for_config(progress->configuration));
    }
    if (onboard_gateway_stage_service_icon) {
        gtk_label_set_text(GTK_LABEL(onboard_gateway_stage_service_icon), stage_icon(progress->service_gateway));
    }
    if (onboard_gateway_stage_service_detail) {
        gtk_label_set_text(GTK_LABEL(onboard_gateway_stage_service_detail),
                           stage_detail_for_service(progress->service_gateway));
    }
    if (onboard_gateway_stage_connection_icon) {
        gtk_label_set_text(GTK_LABEL(onboard_gateway_stage_connection_icon), stage_icon(progress->connection));
    }
    if (onboard_gateway_stage_connection_detail) {
        gtk_label_set_text(GTK_LABEL(onboard_gateway_stage_connection_detail),
                           stage_detail_for_connection(progress->connection));
    }

    const gchar *next_action = gate->next_action ? gate->next_action : readiness->next_action;
    if (onboard_gateway_next_action_value) {
        gtk_label_set_text(GTK_LABEL(onboard_gateway_next_action_value), next_action ? next_action : "");
    }
    if (onboard_gateway_next_action_box) {
        gtk_widget_set_visible(onboard_gateway_next_action_box,
                               next_action != NULL && next_action[0] != '\0');
    }
}

static void onboarding_update_whats_next_content(const ReadinessInfo *readiness,
                                                 const ChatGateInfo *gate) {
    if (onboard_whats_next_guidance_label) {
        if (gate->ready) {
            gtk_label_set_text(GTK_LABEL(onboard_whats_next_guidance_label),
                               "Your gateway is running. Open the Dashboard to start interacting with your AI agent, or explore the companion app to monitor and manage your gateway.");
        } else {
            const gchar *guidance_text = gate->next_action ? gate->next_action : readiness->next_action;
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

void onboarding_view_refresh_live_content(void) {
    AppState current = state_get_current();
    ReadinessInfo readiness;
    readiness_evaluate(current, state_get_health(), state_get_systemd(), &readiness);
    const DesktopReadinessSnapshot *snapshot = state_get_readiness_snapshot();
    ChatGateInfo gate = {0};
    readiness_describe_chat_gate(snapshot, &gate);
    OnboardingStageProgress progress;
    readiness_build_onboarding_progress(current, state_get_health(), state_get_systemd(), &progress);

    onboarding_update_gateway_content(current, &readiness, &progress, &gate);
    onboarding_update_whats_next_content(&readiness, &gate);
    onboarding_refresh_environment_content();
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

    ReadinessInfo readiness;
    readiness_evaluate(current, health, sys, &readiness);

    OnboardingStageProgress progress;
    readiness_build_onboarding_progress(current, health, sys, &progress);

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

    const gchar *next_action = gate.next_action ? gate.next_action : readiness.next_action;
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
    g_signal_connect(close_btn, "clicked", G_CALLBACK(onboarding_view_callbacks.close_clicked), NULL);
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

    GtkWidget *checks_box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 0);
    onboard_environment_checks_box = checks_box;
    onboarding_render_environment_checks(checks_box);
    gtk_box_append(GTK_BOX(page), checks_box);

    GtkWidget *btn_row = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
    gtk_widget_set_halign(btn_row, GTK_ALIGN_CENTER);
    gtk_widget_set_margin_top(btn_row, 24);

    GtkWidget *back_btn = gtk_button_new_with_label("Back");
    g_signal_connect(back_btn, "clicked", G_CALLBACK(on_back_clicked), carousel);
    gtk_box_append(GTK_BOX(btn_row), back_btn);

    GtkWidget *close_btn = gtk_button_new_with_label("Close");
    g_signal_connect(close_btn, "clicked", G_CALLBACK(onboarding_view_callbacks.close_clicked), NULL);
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
    ReadinessInfo readiness;
    readiness_evaluate(current, state_get_health(), state_get_systemd(), &readiness);
    const DesktopReadinessSnapshot *snapshot = state_get_readiness_snapshot();
    ChatGateInfo gate = {0};
    readiness_describe_chat_gate(snapshot, &gate);

    const gchar *guidance_text = gate.next_action ? gate.next_action : readiness.next_action;
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
    g_signal_connect(dash_btn, "clicked", G_CALLBACK(onboarding_view_callbacks.open_dashboard_clicked), NULL);
    gtk_box_append(GTK_BOX(dash_row), dash_btn);
    gtk_widget_set_visible(dash_row, gate.ready);
    gtk_box_append(GTK_BOX(page), dash_row);
    onboard_whats_next_dashboard_button = dash_row;

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

    GtkWidget *finish_btn = gtk_button_new_with_label("Get Started");
    gtk_widget_add_css_class(finish_btn, "pill");
    gtk_widget_add_css_class(finish_btn, "suggested-action");
    g_signal_connect(finish_btn, "clicked", G_CALLBACK(onboarding_view_callbacks.finish_clicked), NULL);
    gtk_box_append(GTK_BOX(btn_row), finish_btn);

    gtk_box_append(GTK_BOX(page), btn_row);
    return page;
}

void onboarding_view_reset(void) {
    memset(&onboarding_view_callbacks, 0, sizeof(onboarding_view_callbacks));
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
    onboard_environment_checks_box = NULL;
}

void onboarding_view_build_pages(GtkWidget *carousel,
                                 OnboardingRoute route,
                                 const OnboardingViewCallbacks *callbacks) {
    onboarding_view_reset();
    if (callbacks) {
        onboarding_view_callbacks = *callbacks;
    }

    GtkWidget *welcome = build_welcome_page(carousel);
    adw_carousel_append(ADW_CAROUSEL(carousel), welcome);

    if (route == ONBOARDING_SHOW_FULL) {
        GtkWidget *gateway = build_gateway_page(carousel);
        adw_carousel_append(ADW_CAROUSEL(carousel), gateway);

        GtkWidget *environment = build_environment_page(carousel);
        adw_carousel_append(ADW_CAROUSEL(carousel), environment);
    }

    GtkWidget *whats_next = build_whats_next_page(carousel);
    adw_carousel_append(ADW_CAROUSEL(carousel), whats_next);

    onboarding_view_refresh_live_content();
}

void onboarding_view_rebuild_pages(GtkWidget *carousel,
                                   OnboardingRoute route,
                                   const OnboardingViewCallbacks *callbacks) {
    if (!carousel) {
        return;
    }

    guint page_count = (guint)adw_carousel_get_n_pages(ADW_CAROUSEL(carousel));
    guint current_pos = (guint)adw_carousel_get_position(ADW_CAROUSEL(carousel));

    while (page_count > 0) {
        GtkWidget *child = GTK_WIDGET(adw_carousel_get_nth_page(ADW_CAROUSEL(carousel), 0));
        if (!child) {
            break;
        }
        adw_carousel_remove(ADW_CAROUSEL(carousel), child);
        page_count--;
    }

    onboarding_view_build_pages(carousel, route, callbacks);

    guint new_count = (guint)adw_carousel_get_n_pages(ADW_CAROUSEL(carousel));
    if (new_count > 0) {
        guint clamped = current_pos < new_count ? current_pos : (new_count - 1);
        GtkWidget *target = GTK_WIDGET(adw_carousel_get_nth_page(ADW_CAROUSEL(carousel), clamped));
        if (target) {
            adw_carousel_scroll_to(ADW_CAROUSEL(carousel), target, FALSE);
        }
    }
}
