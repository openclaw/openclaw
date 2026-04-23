/*
 * section_debug.c
 *
 * Debug section controller for the OpenClaw Linux Companion App.
 *
 * Owns the lightweight developer/debug page shown in the main window,
 * including refresh-trigger actions and diagnostic state presentation.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "section_debug.h"

#include <adwaita.h>

#include "gateway_client.h"
#include "product_coordinator.h"
#include "runtime_paths.h"
#include "state.h"

extern void systemd_restart_gateway(void);

static GtkWidget *dbg_state_label = NULL;
static GtkWidget *dbg_unit_label = NULL;
static GtkWidget *dbg_journal_label = NULL;

typedef struct {
    const gchar *label;
    GCallback callback;
} DebugActionSpec;

static void on_dbg_refresh_health(GtkButton *button, gpointer user_data) {
    (void)button;
    (void)user_data;
    gateway_client_refresh();
}

static void on_dbg_restart_gw(GtkButton *button, gpointer user_data) {
    (void)button;
    (void)user_data;
    systemd_restart_gateway();
}

static void on_dbg_rerun_onboarding(GtkButton *button, gpointer user_data) {
    (void)button;
    (void)user_data;
    product_coordinator_request_rerun_onboarding();
}

static void on_dbg_reveal_config(GtkButton *button, gpointer user_data) {
    (void)button;
    (void)user_data;

    g_autofree gchar *uri = section_debug_test_build_reveal_config_uri();
    if (uri) {
        g_app_info_launch_default_for_uri(uri, NULL, NULL);
    }
}

gchar* section_debug_test_build_reveal_config_uri(void) {
    g_autofree gchar *profile = NULL;
    g_autofree gchar *state_dir = NULL;
    g_autofree gchar *config_path = NULL;
    systemd_get_runtime_context(&profile, &state_dir, &config_path);

    GatewayConfig *cfg = gateway_client_get_config();
    RuntimeEffectivePaths effective_paths = {0};
    runtime_effective_paths_resolve(cfg, profile, state_dir, config_path, &effective_paths);

    gchar *uri = NULL;
    if (effective_paths.effective_config_path) {
        g_autofree gchar *dir = g_path_get_dirname(effective_paths.effective_config_path);
        uri = g_filename_to_uri(dir, NULL, NULL);
    }

    runtime_effective_paths_clear(&effective_paths);
    return uri;
}

static void on_dbg_copy_journal_cmd(GtkButton *button, gpointer user_data) {
    (void)button;
    (void)user_data;

    const gchar *unit = systemd_get_canonical_unit_name();
    g_autofree gchar *cmd = g_strdup_printf("journalctl --user -u %s -f",
                                            unit ? unit : "openclaw-gateway.service");
    GdkClipboard *clipboard = gdk_display_get_clipboard(gdk_display_get_default());
    gdk_clipboard_set_text(clipboard, cmd);
}

static const DebugActionSpec debug_row1_actions[] = {
    { "Trigger Health Refresh", G_CALLBACK(on_dbg_refresh_health) },
    { "Restart Gateway", G_CALLBACK(on_dbg_restart_gw) },
};

static const DebugActionSpec debug_row2_actions[] = {
    { "Reveal Config Folder", G_CALLBACK(on_dbg_reveal_config) },
};

static const DebugActionSpec debug_standalone_actions[] = {
    { "Restart Onboarding", G_CALLBACK(on_dbg_rerun_onboarding) },
};

static GtkWidget* debug_build_action_row(const DebugActionSpec *actions, gsize action_count) {
    GtkWidget *row = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
    gtk_widget_set_margin_top(row, 4);

    for (gsize i = 0; i < action_count; i++) {
        GtkWidget *button = gtk_button_new_with_label(actions[i].label);
        g_signal_connect(button, "clicked", actions[i].callback, NULL);
        gtk_box_append(GTK_BOX(row), button);
    }

    return row;
}

static GtkWidget* debug_build_action_button(const DebugActionSpec *action) {
    GtkWidget *button = gtk_button_new_with_label(action->label);
    gtk_widget_set_halign(button, GTK_ALIGN_START);
    gtk_widget_set_margin_top(button, 4);
    g_signal_connect(button, "clicked", action->callback, NULL);
    return button;
}

static gboolean debug_action_specs_contain(const DebugActionSpec *actions,
                                            gsize action_count,
                                            const gchar *label) {
    for (gsize i = 0; i < action_count; i++) {
        if (g_strcmp0(actions[i].label, label) == 0) {
            return TRUE;
        }
    }

    return FALSE;
}

static GtkWidget* debug_build(void) {
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

    GtkWidget *state_heading = gtk_label_new("Gateway Service");
    gtk_widget_add_css_class(state_heading, "heading");
    gtk_label_set_xalign(GTK_LABEL(state_heading), 0.0);
    gtk_widget_set_margin_top(state_heading, 12);
    gtk_box_append(GTK_BOX(page), state_heading);

    gtk_box_append(GTK_BOX(page), section_info_row("Unit", 120, &dbg_unit_label));
    gtk_box_append(GTK_BOX(page), section_info_row("State", 120, &dbg_state_label));

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

    GtkWidget *actions_heading = gtk_label_new("Actions");
    gtk_widget_add_css_class(actions_heading, "heading");
    gtk_label_set_xalign(GTK_LABEL(actions_heading), 0.0);
    gtk_widget_set_margin_top(actions_heading, 12);
    gtk_box_append(GTK_BOX(page), actions_heading);

    GtkWidget *row1 = debug_build_action_row(debug_row1_actions,
                                              G_N_ELEMENTS(debug_row1_actions));
    gtk_box_append(GTK_BOX(page), row1);

    GtkWidget *row2 = debug_build_action_row(debug_row2_actions,
                                              G_N_ELEMENTS(debug_row2_actions));
    gtk_box_append(GTK_BOX(page), row2);

    GtkWidget *onboard_btn = debug_build_action_button(&debug_standalone_actions[0]);
    gtk_box_append(GTK_BOX(page), onboard_btn);

    gtk_scrolled_window_set_child(GTK_SCROLLED_WINDOW(scrolled), page);
    return scrolled;
}

static void debug_refresh(void) {
    if (!dbg_state_label) {
        return;
    }

    SystemdState *sys = state_get_systemd();
    if (sys->active_state && sys->sub_state) {
        g_autofree gchar *state_text = g_strdup_printf("%s (%s)", sys->active_state, sys->sub_state);
        gtk_label_set_text(GTK_LABEL(dbg_state_label), state_text);
    } else {
        gtk_label_set_text(GTK_LABEL(dbg_state_label),
                           sys->active_state ? sys->active_state : "—");
    }

    gtk_label_set_text(GTK_LABEL(dbg_unit_label), sys->unit_name ? sys->unit_name : "—");

    const gchar *unit = systemd_get_canonical_unit_name();
    g_autofree gchar *cmd = g_strdup_printf("journalctl --user -u %s -f",
                                            unit ? unit : "openclaw-gateway.service");
    gtk_label_set_text(GTK_LABEL(dbg_journal_label), cmd);
}

static void debug_destroy(void) {
    dbg_state_label = NULL;
    dbg_unit_label = NULL;
    dbg_journal_label = NULL;
}

static void debug_invalidate(void) {
}

static const SectionController debug_controller = {
    .build = debug_build,
    .refresh = debug_refresh,
    .destroy = debug_destroy,
    .invalidate = debug_invalidate,
};

const SectionController* section_debug_get(void) {
    return &debug_controller;
}

gboolean section_debug_test_has_action_label(const gchar *label) {
    return debug_action_specs_contain(debug_row1_actions,
                                       G_N_ELEMENTS(debug_row1_actions),
                                       label)
        || debug_action_specs_contain(debug_row2_actions,
                                       G_N_ELEMENTS(debug_row2_actions),
                                       label)
        || debug_action_specs_contain(debug_standalone_actions,
                                       G_N_ELEMENTS(debug_standalone_actions),
                                       label);
}
