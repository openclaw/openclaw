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
#include "runtime_reveal.h"
#include "state.h"
#include "gateway_config.h"
#include "connection_mode_resolver.h"
#include "remote_endpoint.h"
#include "remote_tunnel.h"
#include "product_state.h"

extern void systemd_restart_gateway(void);

static void debug_refresh_remote_mode(void);
static void on_remote_state_changed(gpointer user_data);

static GtkWidget *dbg_state_label = NULL;
static GtkWidget *dbg_unit_label = NULL;
static GtkWidget *dbg_journal_label = NULL;

/* Remote-mode diagnostics */
static GtkWidget *dbg_remote_mode_label = NULL;
static GtkWidget *dbg_remote_source_label = NULL;
static GtkWidget *dbg_remote_transport_label = NULL;
static GtkWidget *dbg_remote_endpoint_label = NULL;
static GtkWidget *dbg_remote_tunnel_label = NULL;
static GtkWidget *dbg_remote_tunnel_detail_label = NULL;
static guint      dbg_endpoint_sub = 0;
static guint      dbg_tunnel_sub   = 0;

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
    return runtime_reveal_build_config_dir_uri();
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

    GtkWidget *remote_heading = gtk_label_new("Remote Mode");
    gtk_widget_add_css_class(remote_heading, "heading");
    gtk_label_set_xalign(GTK_LABEL(remote_heading), 0.0);
    gtk_widget_set_margin_top(remote_heading, 12);
    gtk_box_append(GTK_BOX(page), remote_heading);

    gtk_box_append(GTK_BOX(page),
        section_info_row("Effective mode", 140, &dbg_remote_mode_label));
    gtk_box_append(GTK_BOX(page),
        section_info_row("Mode source", 140, &dbg_remote_source_label));
    gtk_box_append(GTK_BOX(page),
        section_info_row("Transport", 140, &dbg_remote_transport_label));
    gtk_box_append(GTK_BOX(page),
        section_info_row("Endpoint state", 140, &dbg_remote_endpoint_label));
    gtk_box_append(GTK_BOX(page),
        section_info_row("Tunnel state", 140, &dbg_remote_tunnel_label));
    gtk_box_append(GTK_BOX(page),
        section_info_row("Tunnel detail", 140, &dbg_remote_tunnel_detail_label));

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

    /* Live updates for the Remote Mode group. */
    if (!dbg_endpoint_sub) {
        dbg_endpoint_sub = remote_endpoint_subscribe(on_remote_state_changed, NULL);
    }
    if (!dbg_tunnel_sub) {
        dbg_tunnel_sub = remote_tunnel_subscribe(on_remote_state_changed, NULL);
    }

    return scrolled;
}

static const gchar* effective_mode_text(ProductConnectionMode m) {
    switch (m) {
    case PRODUCT_CONNECTION_MODE_LOCAL:  return "local";
    case PRODUCT_CONNECTION_MODE_REMOTE: return "remote";
    default:                             return "unspecified";
    }
}

static const gchar* effective_mode_source_text(EffectiveModeSource s) {
    switch (s) {
    case EFFECTIVE_MODE_SRC_CONFIG_MODE:       return "config gateway.mode";
    case EFFECTIVE_MODE_SRC_CONFIG_REMOTE_URL: return "config gateway.remote.url";
    case EFFECTIVE_MODE_SRC_PRODUCT_STATE:     return "product state";
    case EFFECTIVE_MODE_SRC_ONBOARDING:        return "onboarding fallback";
    default:                                   return "—";
    }
}

static void debug_refresh_remote_mode(void) {
    if (!dbg_remote_mode_label) return;

    GatewayConfig *config = gateway_client_get_config();
    const gchar *cfg_mode = config ? config->mode : NULL;
    gboolean has_remote_url = config && config->remote_url != NULL;
    ProductConnectionMode persisted = product_state_get_connection_mode();
    gboolean onboarded = product_state_get_onboarding_seen_version() > 0;

    EffectiveConnectionMode em = connection_mode_resolve(
        cfg_mode, has_remote_url, persisted, onboarded);

    gtk_label_set_text(GTK_LABEL(dbg_remote_mode_label),
                       effective_mode_text(em.mode));
    gtk_label_set_text(GTK_LABEL(dbg_remote_source_label),
                       effective_mode_source_text(em.source));

    const gchar *transport_text = "—";
    if (em.mode == PRODUCT_CONNECTION_MODE_REMOTE && config && config->remote_present) {
        transport_text = (config->remote_transport == REMOTE_TRANSPORT_DIRECT)
            ? "direct (ws[s])"
            : "ssh local-forward";
    }
    gtk_label_set_text(GTK_LABEL(dbg_remote_transport_label), transport_text);

    const RemoteEndpointSnapshot *ep = remote_endpoint_get();
    if (ep) {
        if (ep->kind == REMOTE_ENDPOINT_READY) {
            g_autofree gchar *line = g_strdup_printf(
                "ready %s://%s:%d",
                ep->tls ? "wss" : "ws",
                ep->host ? ep->host : "?",
                ep->port);
            gtk_label_set_text(GTK_LABEL(dbg_remote_endpoint_label), line);
        } else {
            g_autofree gchar *line = g_strdup_printf(
                "%s%s%s",
                remote_endpoint_state_to_string(ep->kind),
                ep->detail ? " — " : "",
                ep->detail ? ep->detail : "");
            gtk_label_set_text(GTK_LABEL(dbg_remote_endpoint_label), line);
        }
    } else {
        gtk_label_set_text(GTK_LABEL(dbg_remote_endpoint_label), "—");
    }

    const RemoteTunnelState *ts = remote_tunnel_get_state();
    if (ts) {
        g_autofree gchar *line = g_strdup_printf(
            "%s pid=%d local_port=%d restarts=%d",
            remote_tunnel_state_to_string(ts->kind),
            ts->pid, ts->local_port, ts->restart_count);
        gtk_label_set_text(GTK_LABEL(dbg_remote_tunnel_label), line);
        gtk_label_set_text(GTK_LABEL(dbg_remote_tunnel_detail_label),
                           (ts->last_error && ts->last_error[0]) ? ts->last_error : "—");
    } else {
        gtk_label_set_text(GTK_LABEL(dbg_remote_tunnel_label), "—");
        gtk_label_set_text(GTK_LABEL(dbg_remote_tunnel_detail_label), "—");
    }
}

static void on_remote_state_changed(gpointer user_data) {
    (void)user_data;
    debug_refresh_remote_mode();
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

    debug_refresh_remote_mode();
}

static void debug_destroy(void) {
    if (dbg_endpoint_sub) {
        remote_endpoint_unsubscribe(dbg_endpoint_sub);
        dbg_endpoint_sub = 0;
    }
    if (dbg_tunnel_sub) {
        remote_tunnel_unsubscribe(dbg_tunnel_sub);
        dbg_tunnel_sub = 0;
    }
    dbg_state_label = NULL;
    dbg_unit_label = NULL;
    dbg_journal_label = NULL;
    dbg_remote_mode_label = NULL;
    dbg_remote_source_label = NULL;
    dbg_remote_transport_label = NULL;
    dbg_remote_endpoint_label = NULL;
    dbg_remote_tunnel_label = NULL;
    dbg_remote_tunnel_detail_label = NULL;
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
