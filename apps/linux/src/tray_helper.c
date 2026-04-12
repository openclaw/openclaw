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

static AppIndicator *indicator = NULL;

/* Status context (disabled labels) */
static GtkWidget *status_item = NULL;
static GtkWidget *runtime_item = NULL;

/* Navigation actions */
static GtkWidget *open_main_item = NULL;
static GtkWidget *open_dashboard_item = NULL;

/* Expected service actions */
static GtkWidget *start_item = NULL;
static GtkWidget *stop_item = NULL;
static GtkWidget *restart_item = NULL;
static GtkWidget *refresh_item = NULL;

/* App navigation */
static GtkWidget *settings_item = NULL;
static GtkWidget *diagnostics_item = NULL;

static void send_action(const char *action) {
    g_print("ACTION:%s\n", action);
    fflush(stdout);
}

static void on_open_main(GtkMenuItem *item, gpointer data) { (void)item; (void)data; send_action("OPEN_MAIN"); }
static void on_open_dashboard(GtkMenuItem *item, gpointer data) { (void)item; (void)data; send_action("OPEN_DASHBOARD"); }
static void on_start_clicked(GtkMenuItem *item, gpointer data) { (void)item; (void)data; send_action("START"); }
static void on_stop_clicked(GtkMenuItem *item, gpointer data) { (void)item; (void)data; send_action("STOP"); }
static void on_restart_clicked(GtkMenuItem *item, gpointer data) { (void)item; (void)data; send_action("RESTART"); }
static void on_refresh_clicked(GtkMenuItem *item, gpointer data) { (void)item; (void)data; send_action("REFRESH"); }
static void on_settings_clicked(GtkMenuItem *item, gpointer data) { (void)item; (void)data; send_action("OPEN_SETTINGS"); }
static void on_diagnostics_clicked(GtkMenuItem *item, gpointer data) { (void)item; (void)data; send_action("OPEN_DIAGNOSTICS"); }
static void on_quit_clicked(GtkMenuItem *item, gpointer data) { 
    (void)item; (void)data;
    send_action("QUIT"); 
    gtk_main_quit();
}

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
                }
            }
            g_strfreev(parts);
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
