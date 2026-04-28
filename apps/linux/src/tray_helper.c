/*
 * tray_helper.c
 *
 * Private GTK3 tray helper daemon.
 *
 * Encapsulates Ayatana AppIndicator and GTK3 menu presentation. Operates as an
 * internal helper to prevent runtime GType collisions with the main GTK4 app.
 * Handles IPC commands to render state and gate user actions.
 *
 * ── GNOME Tray Host-Behavior Contract ──
 *
 * Under Ayatana AppIndicator on Ubuntu GNOME (SNI protocol):
 *
 *  - Left-click:  Host-controlled. GNOME Shell (via ubuntu-appindicators
 *                 extension) opens the indicator menu. The app does NOT
 *                 control or override this behavior and MUST NOT attempt to.
 *
 *  - Right-click: Host-controlled. Same as left-click on GNOME; opens the
 *                 indicator menu. On KDE/XFCE the host may present a
 *                 separate context menu, but the app does not differentiate.
 *
 *  - Middle-click: App-controlled via app_indicator_set_secondary_activate_target.
 *                  This helper maps middle-click to "Open OpenClaw" (line 187).
 *                  Note: GNOME Shell ignores middle-click (host limitation);
 *                  this only fires on KDE/XFCE/other hosts that support it.
 *
 * Summary: the app owns only the menu contents and the middle-click target.
 * All click-to-menu routing is host behavior. Do not add left/right click
 * differentiation — it is unsupported and will silently fail on GNOME.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include <gtk/gtk.h>
#include <libayatana-appindicator/app-indicator.h>
#include <stdio.h>
#include <string.h>
#include <gio/gio.h>

#include "tray_helper_protocol.h"

static AppIndicator *indicator = NULL;

/* Tray helpers must not echo an ACTION line back to the host while
 * applying a host-driven RADIO update — otherwise the host would see
 * its own broadcast bounce back as a user click. The radio item
 * activate handler short-circuits when this guard is TRUE. */
static gboolean updating_from_host = FALSE;

/* Status context (disabled labels) */
static GtkWidget *status_item = NULL;
static GtkWidget *runtime_item = NULL;

/* Exec Approvals submenu (Tranche D Full).
 * Default selected mode is "ask" until the host sends RADIO. */
static GtkWidget *exec_approval_parent_item = NULL;
static GtkWidget *exec_approval_deny_item   = NULL;
static GtkWidget *exec_approval_ask_item    = NULL;
static GtkWidget *exec_approval_allow_item  = NULL;

/* Pending exec approvals indicator (insensitive label).
 * Hidden when count == 0. */
static GtkWidget *approvals_pending_item = NULL;

/* Operational items that the host can show/hide via MENU_VISIBLE. */
static GtkWidget *reset_remote_tunnel_item = NULL;
static GtkWidget *restart_app_item = NULL;

/* Navigation actions */
static GtkWidget *open_main_item = NULL;
static GtkWidget *open_dashboard_item = NULL;
static GtkWidget *open_chat_item = NULL;

/* Expected service actions */
static GtkWidget *start_item = NULL;
static GtkWidget *stop_item = NULL;
static GtkWidget *restart_item = NULL;
static GtkWidget *refresh_item = NULL;

/* App navigation */
static GtkWidget *settings_item = NULL;
static GtkWidget *diagnostics_item = NULL;
static GtkWidget *logs_item = NULL;
static GtkWidget *debug_item = NULL;

/* Operational/debug parity items (Tranche D Core).
 * All flat — no submenus, no checks, no radios. Each one emits a fixed
 * ACTION:<NAME> line that the host process routes through the shared
 * debug-action registry (`oc_debug_action_from_tray_string`). */
static GtkWidget *restart_onboarding_item = NULL;
static GtkWidget *reveal_config_item = NULL;
static GtkWidget *reveal_state_item = NULL;
static GtkWidget *copy_journal_item = NULL;
static GtkWidget *send_test_notification_item = NULL;

static void send_action(const char *action) {
    g_print("ACTION:%s\n", action);
    fflush(stdout);
}

static void on_open_main(GtkMenuItem *item, gpointer data) { (void)item; (void)data; send_action("OPEN_MAIN"); }
static void on_open_dashboard(GtkMenuItem *item, gpointer data) { (void)item; (void)data; send_action("OPEN_DASHBOARD"); }
static void on_open_chat(GtkMenuItem *item, gpointer data) { (void)item; (void)data; send_action("OPEN_CHAT"); }
static void on_start_clicked(GtkMenuItem *item, gpointer data) { (void)item; (void)data; send_action("START"); }
static void on_stop_clicked(GtkMenuItem *item, gpointer data) { (void)item; (void)data; send_action("STOP"); }
static void on_restart_clicked(GtkMenuItem *item, gpointer data) { (void)item; (void)data; send_action("RESTART"); }
static void on_refresh_clicked(GtkMenuItem *item, gpointer data) { (void)item; (void)data; send_action("REFRESH"); }
static void on_settings_clicked(GtkMenuItem *item, gpointer data) { (void)item; (void)data; send_action("OPEN_SETTINGS"); }
static void on_diagnostics_clicked(GtkMenuItem *item, gpointer data) { (void)item; (void)data; send_action("OPEN_DIAGNOSTICS"); }
static void on_logs_clicked(GtkMenuItem *item, gpointer data) { (void)item; (void)data; send_action("OPEN_LOGS"); }
static void on_debug_clicked(GtkMenuItem *item, gpointer data) { (void)item; (void)data; send_action("OPEN_DEBUG"); }
static void on_restart_onboarding_clicked(GtkMenuItem *item, gpointer data) { (void)item; (void)data; send_action("RESTART_ONBOARDING"); }
static void on_reveal_config_clicked(GtkMenuItem *item, gpointer data) { (void)item; (void)data; send_action("REVEAL_CONFIG_FOLDER"); }
static void on_reveal_state_clicked(GtkMenuItem *item, gpointer data) { (void)item; (void)data; send_action("REVEAL_STATE_FOLDER"); }
static void on_copy_journal_clicked(GtkMenuItem *item, gpointer data) { (void)item; (void)data; send_action("COPY_JOURNAL_COMMAND"); }
static void on_send_test_notification_clicked(GtkMenuItem *item, gpointer data) { (void)item; (void)data; send_action("SEND_TEST_NOTIFICATION"); }
static void on_reset_remote_tunnel_clicked(GtkMenuItem *item, gpointer data) { (void)item; (void)data; send_action("RESET_REMOTE_TUNNEL"); }
static void on_restart_app_clicked(GtkMenuItem *item, gpointer data) { (void)item; (void)data; send_action("RESTART_APP"); }

/*
 * Radio activate handler (Exec Approvals submenu).
 *
 * Each radio item carries its mode token in `g_object_set_data(item,
 * "exec-approval-mode", "deny|ask|allow")` so a single callback can
 * service all three. Suppresses re-emission while applying a host
 * RADIO update via the `updating_from_host` guard.
 */
static void on_exec_approval_radio_activate(GtkRadioMenuItem *item, gpointer data) {
    (void)data;
    if (updating_from_host) return;
    if (!gtk_check_menu_item_get_active(GTK_CHECK_MENU_ITEM(item))) return;

    const char *mode = g_object_get_data(G_OBJECT(item), "exec-approval-mode");
    if (!mode) return;

    g_autofree gchar *line = g_strdup_printf("EXEC_APPROVAL_SET:%s", mode);
    send_action(line);
}

static void on_quit_clicked(GtkMenuItem *item, gpointer data) { 
    (void)item; (void)data;
    send_action("QUIT"); 
    gtk_main_quit();
}

/* ── tray_helper_protocol callback adapters ─────────────────────
 *
 * The pure parser in tray_helper_protocol.c is GTK-free; these thin
 * adapters translate its callback contract into widget mutations.
 */

static GtkWidget* widget_for_menu_key(TrayHelperMenuKey key) {
    switch (key) {
    case TRAY_HELPER_MENU_KEY_OPEN_DEBUG:          return debug_item;
    case TRAY_HELPER_MENU_KEY_EXEC_APPROVAL:       return exec_approval_parent_item;
    case TRAY_HELPER_MENU_KEY_APPROVALS_PENDING:   return approvals_pending_item;
    case TRAY_HELPER_MENU_KEY_RESET_REMOTE_TUNNEL: return reset_remote_tunnel_item;
    case TRAY_HELPER_MENU_KEY_RESTART_APP:         return restart_app_item;
    case TRAY_HELPER_MENU_KEY_UNKNOWN:
    default:                                       return NULL;
    }
}

static void helper_set_menu_visible(TrayHelperMenuKey key, gboolean visible, gpointer ud) {
    (void)ud;
    GtkWidget *w = widget_for_menu_key(key);
    if (!w) return;
    /* Both the visible flag and the "no-show-all" flag must agree —
     * otherwise a future gtk_widget_show_all() on the menu would un-hide
     * everything we just hid. */
    gtk_widget_set_no_show_all(w, !visible);
    if (visible) gtk_widget_show(w);
    else         gtk_widget_hide(w);
}

static void helper_set_radio_exec_approval(const char *mode, gpointer ud) {
    (void)ud;
    GtkWidget *target = NULL;
    if      (g_strcmp0(mode, "deny")  == 0) target = exec_approval_deny_item;
    else if (g_strcmp0(mode, "ask")   == 0) target = exec_approval_ask_item;
    else if (g_strcmp0(mode, "allow") == 0) target = exec_approval_allow_item;
    if (!target) return;

    /* Set the active item under the host-update guard so the activate
     * handler does not echo an EXEC_APPROVAL_SET back out. */
    updating_from_host = TRUE;
    gtk_check_menu_item_set_active(GTK_CHECK_MENU_ITEM(target), TRUE);
    updating_from_host = FALSE;
}

static void helper_set_approvals_count(guint count, gpointer ud) {
    (void)ud;
    if (!approvals_pending_item) return;

    g_autofree gchar *label = tray_helper_protocol_format_approvals_label(count);
    gtk_menu_item_set_label(GTK_MENU_ITEM(approvals_pending_item), label);

    /* The pending-approvals label is also gated by an explicit
     * MENU_VISIBLE:APPROVALS_PENDING line from the host (so the host
     * controls visibility based on its own readiness signals). The
     * spec, however, also says "If n == 0: hide pending approvals
     * item" purely from the count. Apply that policy here as a
     * defensive default — if the host disagrees, its later
     * MENU_VISIBLE will overwrite this state. */
    gboolean visible = (count > 0);
    gtk_widget_set_no_show_all(approvals_pending_item, !visible);
    if (visible) gtk_widget_show(approvals_pending_item);
    else         gtk_widget_hide(approvals_pending_item);
}

static const TrayHelperProtocolHandlers helper_protocol_handlers = {
    .set_menu_visible        = helper_set_menu_visible,
    .set_radio_exec_approval = helper_set_radio_exec_approval,
    .set_approvals_count     = helper_set_approvals_count,
    .user_data               = NULL,
};

static gboolean handle_stdin(GIOChannel *source, GIOCondition condition, gpointer data) {
    (void)data;
    gchar *line = NULL;
    GError *error = NULL;

    if (condition & (G_IO_HUP | G_IO_ERR)) {
        gtk_main_quit();
        return G_SOURCE_REMOVE;
    }

    GIOStatus status = g_io_channel_read_line(source, &line, NULL, NULL, &error);
    if (status == G_IO_STATUS_NORMAL && line) {
        g_strchomp(line);
        if (g_str_has_prefix(line, "STATE:")) {
            const char *state_str = line + 6;
            if (status_item) {
                gtk_menu_item_set_label(GTK_MENU_ITEM(status_item), state_str);
            }
        } else if (g_str_has_prefix(line, "RUNTIME:")) {
            const char *runtime_str = line + 8;
            if (runtime_item) {
                gtk_menu_item_set_label(GTK_MENU_ITEM(runtime_item), runtime_str);
            }
        } else if (g_str_has_prefix(line, "SENSITIVE:")) {
            gchar **parts = g_strsplit(line, ":", 3);
            if (g_strv_length(parts) == 3) {
                const gchar *action = parts[1];
                gboolean is_sensitive = (g_strcmp0(parts[2], "1") == 0);
                
                if (g_strcmp0(action, "START") == 0 && start_item) {
                    gtk_widget_set_sensitive(start_item, is_sensitive);
                } else if (g_strcmp0(action, "STOP") == 0 && stop_item) {
                    gtk_widget_set_sensitive(stop_item, is_sensitive);
                } else if (g_strcmp0(action, "RESTART") == 0 && restart_item) {
                    gtk_widget_set_sensitive(restart_item, is_sensitive);
                } else if (g_strcmp0(action, "OPEN_DASHBOARD") == 0 && open_dashboard_item) {
                    gtk_widget_set_sensitive(open_dashboard_item, is_sensitive);
                } else if (g_strcmp0(action, "OPEN_CHAT") == 0 && open_chat_item) {
                    gtk_widget_set_sensitive(open_chat_item, is_sensitive);
                }
            }
            g_strfreev(parts);
        } else {
            /* Tranche D Full host→helper extensions: MENU_VISIBLE,
             * RADIO:EXEC_APPROVAL, APPROVALS. The pure parser handles
             * recognition + dispatch; lines it doesn't recognise are
             * silently dropped. */
            (void)tray_helper_protocol_apply_line(&helper_protocol_handlers, line);
        }
        g_free(line);
    } else if (status == G_IO_STATUS_EOF) {
        g_clear_error(&error);
        gtk_main_quit();
        return G_SOURCE_REMOVE;
    } else {
        g_clear_error(&error);
    }
    
    return G_SOURCE_CONTINUE;
}

int main(int argc, char **argv) {
    gtk_init(&argc, &argv);

    indicator = app_indicator_new("openclaw-companion",
                                  "openclaw-icon",
                                  APP_INDICATOR_CATEGORY_APPLICATION_STATUS);
    
    app_indicator_set_status(indicator, APP_INDICATOR_STATUS_ACTIVE);
    app_indicator_set_icon_theme_path(indicator, "/usr/share/icons"); 

    GtkWidget *menu = gtk_menu_new();

    /* ── Status context (disabled) ── */
    status_item = gtk_menu_item_new_with_label("Unknown");
    gtk_widget_set_sensitive(status_item, FALSE);
    gtk_menu_shell_append(GTK_MENU_SHELL(menu), status_item);

    runtime_item = gtk_menu_item_new_with_label("No Runtime Detected");
    gtk_widget_set_sensitive(runtime_item, FALSE);
    gtk_menu_shell_append(GTK_MENU_SHELL(menu), runtime_item);

    gtk_menu_shell_append(GTK_MENU_SHELL(menu), gtk_separator_menu_item_new());

    /* ── Navigation actions ── */
    open_main_item = gtk_menu_item_new_with_label("Open OpenClaw");
    g_signal_connect(open_main_item, "activate", G_CALLBACK(on_open_main), NULL);
    gtk_menu_shell_append(GTK_MENU_SHELL(menu), open_main_item);

    open_dashboard_item = gtk_menu_item_new_with_label("Open Dashboard");
    g_signal_connect(open_dashboard_item, "activate", G_CALLBACK(on_open_dashboard), NULL);
    gtk_widget_set_sensitive(open_dashboard_item, FALSE);
    gtk_menu_shell_append(GTK_MENU_SHELL(menu), open_dashboard_item);

    /* Chat lives in its own standalone window; see chat_window.{c,h}. */
    open_chat_item = gtk_menu_item_new_with_label("Open Chat");
    g_signal_connect(open_chat_item, "activate", G_CALLBACK(on_open_chat), NULL);
    gtk_widget_set_sensitive(open_chat_item, FALSE);
    gtk_menu_shell_append(GTK_MENU_SHELL(menu), open_chat_item);

    /*
     * Intentionally no pairing entry here. Pairing status and its
     * actionable affordances live in the main app window footer (see
     * `refresh_shell_status_footer()` in src/app_window.c). The
     * bootstrap/approval surfaces are raised directly by the pair
     * prompter when pairing is required or pending; the tray does not
     * duplicate that state.
     */

    gtk_menu_shell_append(GTK_MENU_SHELL(menu), gtk_separator_menu_item_new());

    /* ── Expected service actions ── */
    start_item = gtk_menu_item_new_with_label("Start Gateway");
    g_signal_connect(start_item, "activate", G_CALLBACK(on_start_clicked), NULL);
    gtk_widget_set_sensitive(start_item, FALSE);
    gtk_menu_shell_append(GTK_MENU_SHELL(menu), start_item);

    stop_item = gtk_menu_item_new_with_label("Stop Gateway");
    g_signal_connect(stop_item, "activate", G_CALLBACK(on_stop_clicked), NULL);
    gtk_widget_set_sensitive(stop_item, FALSE);
    gtk_menu_shell_append(GTK_MENU_SHELL(menu), stop_item);

    restart_item = gtk_menu_item_new_with_label("Restart Gateway");
    g_signal_connect(restart_item, "activate", G_CALLBACK(on_restart_clicked), NULL);
    gtk_widget_set_sensitive(restart_item, FALSE);
    gtk_menu_shell_append(GTK_MENU_SHELL(menu), restart_item);

    refresh_item = gtk_menu_item_new_with_label("Refresh Status");
    g_signal_connect(refresh_item, "activate", G_CALLBACK(on_refresh_clicked), NULL);
    gtk_menu_shell_append(GTK_MENU_SHELL(menu), refresh_item);

    gtk_menu_shell_append(GTK_MENU_SHELL(menu), gtk_separator_menu_item_new());

    /* ── App navigation ── */
    settings_item = gtk_menu_item_new_with_label("Settings");
    g_signal_connect(settings_item, "activate", G_CALLBACK(on_settings_clicked), NULL);
    gtk_menu_shell_append(GTK_MENU_SHELL(menu), settings_item);

    diagnostics_item = gtk_menu_item_new_with_label("Diagnostics");
    g_signal_connect(diagnostics_item, "activate", G_CALLBACK(on_diagnostics_clicked), NULL);
    gtk_menu_shell_append(GTK_MENU_SHELL(menu), diagnostics_item);

    logs_item = gtk_menu_item_new_with_label("Logs");
    g_signal_connect(logs_item, "activate", G_CALLBACK(on_logs_clicked), NULL);
    gtk_menu_shell_append(GTK_MENU_SHELL(menu), logs_item);

    debug_item = gtk_menu_item_new_with_label("Debug");
    g_signal_connect(debug_item, "activate", G_CALLBACK(on_debug_clicked), NULL);
    /* Hidden until the host sends MENU_VISIBLE:OPEN_DEBUG:1. SECTION_DEBUG
     * is gated by OPENCLAW_DEBUG_PANE on the host side. */
    gtk_widget_set_no_show_all(debug_item, TRUE);
    gtk_menu_shell_append(GTK_MENU_SHELL(menu), debug_item);

    gtk_menu_shell_append(GTK_MENU_SHELL(menu), gtk_separator_menu_item_new());

    /* ── Operational / debug parity actions (flat) ── */
    restart_onboarding_item = gtk_menu_item_new_with_label("Restart Onboarding");
    g_signal_connect(restart_onboarding_item, "activate", G_CALLBACK(on_restart_onboarding_clicked), NULL);
    gtk_menu_shell_append(GTK_MENU_SHELL(menu), restart_onboarding_item);

    reveal_config_item = gtk_menu_item_new_with_label("Reveal Config Folder");
    g_signal_connect(reveal_config_item, "activate", G_CALLBACK(on_reveal_config_clicked), NULL);
    gtk_menu_shell_append(GTK_MENU_SHELL(menu), reveal_config_item);

    reveal_state_item = gtk_menu_item_new_with_label("Reveal State Folder");
    g_signal_connect(reveal_state_item, "activate", G_CALLBACK(on_reveal_state_clicked), NULL);
    gtk_menu_shell_append(GTK_MENU_SHELL(menu), reveal_state_item);

    copy_journal_item = gtk_menu_item_new_with_label("Copy Journal Command");
    g_signal_connect(copy_journal_item, "activate", G_CALLBACK(on_copy_journal_clicked), NULL);
    gtk_menu_shell_append(GTK_MENU_SHELL(menu), copy_journal_item);

    send_test_notification_item = gtk_menu_item_new_with_label("Send Test Notification");
    g_signal_connect(send_test_notification_item, "activate", G_CALLBACK(on_send_test_notification_clicked), NULL);
    gtk_menu_shell_append(GTK_MENU_SHELL(menu), send_test_notification_item);

    /* ── Reset Remote Tunnel (initially hidden — host emits
     *    MENU_VISIBLE:RESET_REMOTE_TUNNEL:1 only when applicable) ── */
    reset_remote_tunnel_item = gtk_menu_item_new_with_label("Reset Remote Tunnel");
    g_signal_connect(reset_remote_tunnel_item, "activate", G_CALLBACK(on_reset_remote_tunnel_clicked), NULL);
    gtk_widget_set_no_show_all(reset_remote_tunnel_item, TRUE);
    gtk_menu_shell_append(GTK_MENU_SHELL(menu), reset_remote_tunnel_item);

    /* ── Restart App (visible by default; host can toggle via
     *    MENU_VISIBLE:RESTART_APP) ── */
    restart_app_item = gtk_menu_item_new_with_label("Restart App");
    g_signal_connect(restart_app_item, "activate", G_CALLBACK(on_restart_app_clicked), NULL);
    gtk_menu_shell_append(GTK_MENU_SHELL(menu), restart_app_item);

    gtk_menu_shell_append(GTK_MENU_SHELL(menu), gtk_separator_menu_item_new());

    /* ── Exec Approvals (Tranche D Full) ──
     *
     * Pending-counter item (insensitive, hidden until the host sends
     * APPROVALS:n with n > 0) followed by a radio submenu for the
     * quick-mode default. The host owns the source of truth: it emits
     * RADIO:EXEC_APPROVAL:<mode> on every refresh, which selects the
     * matching radio item under the `updating_from_host` guard so no
     * EXEC_APPROVAL_SET is echoed back.
     */
    approvals_pending_item = gtk_menu_item_new_with_label("Exec Approvals: 0 pending");
    gtk_widget_set_sensitive(approvals_pending_item, FALSE);
    gtk_widget_set_no_show_all(approvals_pending_item, TRUE);
    gtk_menu_shell_append(GTK_MENU_SHELL(menu), approvals_pending_item);

    exec_approval_parent_item = gtk_menu_item_new_with_label("Exec Approvals");
    gtk_widget_set_no_show_all(exec_approval_parent_item, TRUE);
    GtkWidget *exec_approval_submenu = gtk_menu_new();
    gtk_menu_item_set_submenu(GTK_MENU_ITEM(exec_approval_parent_item), exec_approval_submenu);
    gtk_menu_shell_append(GTK_MENU_SHELL(menu), exec_approval_parent_item);

    /* Three radio items in a single GtkRadioMenuItem group. The "ask"
     * default is selected before any host message arrives so the
     * widget always has a selected state. */
    exec_approval_deny_item = gtk_radio_menu_item_new_with_label(NULL, "Deny");
    g_object_set_data(G_OBJECT(exec_approval_deny_item), "exec-approval-mode", "deny");
    g_signal_connect(exec_approval_deny_item, "activate",
                     G_CALLBACK(on_exec_approval_radio_activate), NULL);
    gtk_menu_shell_append(GTK_MENU_SHELL(exec_approval_submenu), exec_approval_deny_item);

    GSList *radio_group = gtk_radio_menu_item_get_group(GTK_RADIO_MENU_ITEM(exec_approval_deny_item));
    exec_approval_ask_item = gtk_radio_menu_item_new_with_label(radio_group, "Ask");
    g_object_set_data(G_OBJECT(exec_approval_ask_item), "exec-approval-mode", "ask");
    g_signal_connect(exec_approval_ask_item, "activate",
                     G_CALLBACK(on_exec_approval_radio_activate), NULL);
    gtk_menu_shell_append(GTK_MENU_SHELL(exec_approval_submenu), exec_approval_ask_item);

    radio_group = gtk_radio_menu_item_get_group(GTK_RADIO_MENU_ITEM(exec_approval_ask_item));
    exec_approval_allow_item = gtk_radio_menu_item_new_with_label(radio_group, "Allow");
    g_object_set_data(G_OBJECT(exec_approval_allow_item), "exec-approval-mode", "allow");
    g_signal_connect(exec_approval_allow_item, "activate",
                     G_CALLBACK(on_exec_approval_radio_activate), NULL);
    gtk_menu_shell_append(GTK_MENU_SHELL(exec_approval_submenu), exec_approval_allow_item);

    /* Default selection = ask. The submenu always stays initialised
     * regardless of host readiness. */
    updating_from_host = TRUE;
    gtk_check_menu_item_set_active(GTK_CHECK_MENU_ITEM(exec_approval_ask_item), TRUE);
    updating_from_host = FALSE;

    gtk_menu_shell_append(GTK_MENU_SHELL(menu), gtk_separator_menu_item_new());

    /* ── Quit ── */
    GtkWidget *quit_item = gtk_menu_item_new_with_label("Quit");
    g_signal_connect(quit_item, "activate", G_CALLBACK(on_quit_clicked), NULL);
    gtk_menu_shell_append(GTK_MENU_SHELL(menu), quit_item);

    gtk_widget_show_all(menu);
    app_indicator_set_menu(indicator, GTK_MENU(menu));

    /* Middle-click → Open OpenClaw (KDE/XFCE) */
    app_indicator_set_secondary_activate_target(indicator, open_main_item);

    GIOChannel *stdin_ch = g_io_channel_unix_new(fileno(stdin));
    g_io_add_watch(stdin_ch, G_IO_IN | G_IO_HUP | G_IO_ERR, handle_stdin, NULL);
    g_io_channel_unref(stdin_ch);

    gtk_main();
    return 0;
}
