/*
 * section_environment.c
 *
 * Environment section controller for the OpenClaw Linux Companion App.
 *
 * Owns the main-window environment checks page and renders the effective
 * runtime path and filesystem readiness status for the local companion.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "section_environment.h"

#include <adwaita.h>

#include "display_model.h"
#include "gateway_client.h"
#include "runtime_paths.h"
#include "state.h"

static GtkWidget *env_checks_box = NULL;

static void populate_env_checks(GtkWidget *container) {
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

static GtkWidget* environment_build(void) {
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

    GtkWidget *subtitle = gtk_label_new("Prerequisites and runtime environment checks.");
    gtk_widget_add_css_class(subtitle, "dim-label");
    gtk_label_set_xalign(GTK_LABEL(subtitle), 0.0);
    gtk_box_append(GTK_BOX(page), subtitle);

    GtkWidget *separator = gtk_separator_new(GTK_ORIENTATION_HORIZONTAL);
    gtk_widget_set_margin_top(separator, 8);
    gtk_box_append(GTK_BOX(page), separator);

    env_checks_box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 4);
    gtk_widget_set_margin_top(env_checks_box, 8);
    populate_env_checks(env_checks_box);
    gtk_box_append(GTK_BOX(page), env_checks_box);

    gtk_scrolled_window_set_child(GTK_SCROLLED_WINDOW(scrolled), page);
    return scrolled;
}

static void environment_refresh(void) {
    if (!env_checks_box) {
        return;
    }

    populate_env_checks(env_checks_box);
}

static void environment_destroy(void) {
    env_checks_box = NULL;
}

static void environment_invalidate(void) {
}

static const SectionController environment_controller = {
    .build = environment_build,
    .refresh = environment_refresh,
    .destroy = environment_destroy,
    .invalidate = environment_invalidate,
};

const SectionController* section_environment_get(void) {
    return &environment_controller;
}
