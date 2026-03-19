/*
 * tray_helper.c
 *
 * Private GTK3 tray helper daemon.
 *
 * Encapsulates Ayatana AppIndicator and GTK3 menu presentation. Operates as an
 * internal helper to prevent runtime GType collisions with the main GTK4 app.
 * Handles IPC commands to render state and gate user actions.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include <gtk/gtk.h>
#include <libayatana-appindicator/app-indicator.h>
#include <stdio.h>
#include <string.h>
#include <gio/gio.h>

static AppIndicator *indicator = NULL;
static GtkWidget *status_item = NULL;
static GtkWidget *start_item = NULL;
static GtkWidget *stop_item = NULL;
static GtkWidget *restart_item = NULL;

static void send_action(const char *action) {
    g_print("ACTION:%s\n", action);
    fflush(stdout);
}

static void on_start_clicked(GtkMenuItem *item, gpointer data) { (void)item; (void)data; send_action("START"); }
static void on_stop_clicked(GtkMenuItem *item, gpointer data) { (void)item; (void)data; send_action("STOP"); }
static void on_restart_clicked(GtkMenuItem *item, gpointer data) { (void)item; (void)data; send_action("RESTART"); }
static void on_refresh_clicked(GtkMenuItem *item, gpointer data) { (void)item; (void)data; send_action("REFRESH"); }
static void on_diagnostics_clicked(GtkMenuItem *item, gpointer data) { (void)item; (void)data; send_action("DIAGNOSTICS"); }
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
                gchar *label = g_strdup_printf("Status: %s", state_str);
                gtk_menu_item_set_label(GTK_MENU_ITEM(status_item), label);
                g_free(label);
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
                }
            }
            g_strfreev(parts);
        }
        g_free(line);
    } else if (status == G_IO_STATUS_EOF) {
        gtk_main_quit();
        return G_SOURCE_REMOVE;
    }
    
    return G_SOURCE_CONTINUE;
}

int main(int argc, char **argv) {
    gtk_init(&argc, &argv);

    indicator = app_indicator_new("openclaw-companion",
                                  "openclaw-icon", // fallback/placeholder
                                  APP_INDICATOR_CATEGORY_APPLICATION_STATUS);
    
    app_indicator_set_status(indicator, APP_INDICATOR_STATUS_ACTIVE);
    app_indicator_set_icon_theme_path(indicator, "/usr/share/icons"); 

    GtkWidget *menu = gtk_menu_new();

    status_item = gtk_menu_item_new_with_label("Status: Unknown");
    gtk_widget_set_sensitive(status_item, FALSE); 
    gtk_menu_shell_append(GTK_MENU_SHELL(menu), status_item);
    
    gtk_menu_shell_append(GTK_MENU_SHELL(menu), gtk_separator_menu_item_new());

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

    GtkWidget *refresh_item = gtk_menu_item_new_with_label("Refresh Status");
    g_signal_connect(refresh_item, "activate", G_CALLBACK(on_refresh_clicked), NULL);
    gtk_menu_shell_append(GTK_MENU_SHELL(menu), refresh_item);

    gtk_menu_shell_append(GTK_MENU_SHELL(menu), gtk_separator_menu_item_new());

    GtkWidget *diag_item = gtk_menu_item_new_with_label("Diagnostics / Settings");
    g_signal_connect(diag_item, "activate", G_CALLBACK(on_diagnostics_clicked), NULL);
    gtk_menu_shell_append(GTK_MENU_SHELL(menu), diag_item);

    gtk_menu_shell_append(GTK_MENU_SHELL(menu), gtk_separator_menu_item_new());

    GtkWidget *quit_item = gtk_menu_item_new_with_label("Quit");
    g_signal_connect(quit_item, "activate", G_CALLBACK(on_quit_clicked), NULL);
    gtk_menu_shell_append(GTK_MENU_SHELL(menu), quit_item);

    gtk_widget_show_all(menu);
    app_indicator_set_menu(indicator, GTK_MENU(menu));

    GIOChannel *stdin_ch = g_io_channel_unix_new(fileno(stdin));
    g_io_add_watch(stdin_ch, G_IO_IN | G_IO_HUP | G_IO_ERR, handle_stdin, NULL);
    g_io_channel_unref(stdin_ch);

    gtk_main();
    return 0;
}
