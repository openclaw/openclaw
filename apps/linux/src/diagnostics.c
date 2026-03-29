/*
 * diagnostics.c
 *
 * Diagnostics window and debug payload generation.
 *
 * Provides a plain-text Adwaita window detailing the gateway client
 * connectivity state: systemd service context and native HTTP/WebSocket
 * health. Exposes a canonical formatter to ensure the displayed text
 * and the copied clipboard payload are always identical.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include <gtk/gtk.h>
#include <adwaita.h>
#include "state.h"
#include "readiness.h"

static GtkWidget *diag_window = NULL;
static GtkWidget *copy_btn = NULL;
static guint copy_timeout_id = 0;
static guint auto_refresh_timeout_id = 0;
static GtkWidget *text_view = NULL;

static gchar* format_age(gint64 timestamp_us) {
    if (timestamp_us == 0) {
        return g_strdup("Never");
    }
    gint64 now = g_get_real_time();
    gint64 diff_sec = (now - timestamp_us) / 1000000;
    
    if (diff_sec < 5) return g_strdup("Just now");
    if (diff_sec < 60) return g_strdup_printf("%ld seconds ago", diff_sec);
    if (diff_sec < 3600) return g_strdup_printf("%ld minutes ago", diff_sec / 60);
    return g_strdup_printf("%ld hours ago", diff_sec / 3600);
}

static gchar* build_diagnostics_text(void) {
    AppState current = state_get_current();
    SystemdState *sys = state_get_systemd();
    HealthState *health = state_get_health();

    ReadinessInfo ri;
    readiness_evaluate(current, health, sys, &ri);

    g_autofree gchar *health_age = format_age(health->last_updated);

    GString *out = g_string_new(NULL);

    /* Readiness summary */
    g_string_append_printf(out, "=== Readiness ===\n");
    g_string_append_printf(out, "Status: %s\n", ri.classification ? ri.classification : "Unknown");
    if (ri.missing) {
        g_string_append_printf(out, "Detail: %s\n", ri.missing);
    }
    if (ri.next_action) {
        g_string_append_printf(out, "Next:   %s\n", ri.next_action);
    }

    /* Systemd service context */
    g_string_append_printf(out, "\n=== Systemd Service ===\n");
    g_string_append_printf(out, "Unit: %s\n", sys->unit_name ? sys->unit_name : "N/A");
    g_string_append_printf(out, "ActiveState: %s\n", sys->active_state ? sys->active_state : "Unknown");
    g_string_append_printf(out, "SubState: %s\n", sys->sub_state ? sys->sub_state : "Unknown");

    /* Gateway connectivity */
    g_string_append_printf(out, "\n=== Gateway Connectivity ===\n");
    g_string_append_printf(out, "Source: Native HTTP + WebSocket\n");
    g_string_append_printf(out, "Last updated: %s\n", health_age);
    g_string_append_printf(out, "Endpoint: %s:%d\n",
        health->endpoint_host ? health->endpoint_host : "127.0.0.1",
        health->endpoint_port);
    const char *http_probe_str;
    switch (health->http_probe_result) {
    case HTTP_PROBE_OK:                      http_probe_str = "OK"; break;
    case HTTP_PROBE_CONNECT_REFUSED:         http_probe_str = "Connect Refused"; break;
    case HTTP_PROBE_CONNECT_TIMEOUT:         http_probe_str = "Connect Timeout"; break;
    case HTTP_PROBE_TIMED_OUT_AFTER_CONNECT: http_probe_str = "Timed Out After Connect"; break;
    case HTTP_PROBE_INVALID_RESPONSE:        http_probe_str = "Invalid Response"; break;
    default:                                 http_probe_str = "Unreachable"; break;
    }
    g_string_append_printf(out, "HTTP Health: %s\n", http_probe_str);
    g_string_append_printf(out, "WebSocket: %s\n", health->ws_connected ? "Connected" : "Disconnected");
    g_string_append_printf(out, "RPC OK: %s\n", health->rpc_ok ? "Yes" : "No");
    g_string_append_printf(out, "Auth OK: %s\n", health->auth_ok ? "Yes" : "No");
    g_string_append_printf(out, "Auth Source: %s\n", health->auth_source ? health->auth_source : "N/A");
    g_string_append_printf(out, "Gateway Version: %s\n", health->gateway_version ? health->gateway_version : "N/A");

    /* Configuration */
    g_string_append_printf(out, "\n=== Configuration ===\n");
    g_string_append_printf(out, "Config Valid: %s\n", health->config_valid ? "Yes" : "No");
    g_string_append_printf(out, "Setup Detected: %s\n", health->setup_detected ? "Yes" : "No");
    g_string_append_printf(out, "Config Issues: %d\n", health->config_issues_count);
    g_string_append_printf(out, "Last Error: %s\n", health->last_error ? health->last_error : "None");

    return g_string_free(out, FALSE);
}

static gboolean refresh_diagnostics_view(gpointer user_data) {
    (void)user_data;
    if (diag_window && text_view) {
        gchar *info_text = build_diagnostics_text();
        GtkTextBuffer *buffer = gtk_text_view_get_buffer(GTK_TEXT_VIEW(text_view));
        gtk_text_buffer_set_text(buffer, info_text, -1);
        g_free(info_text);
        return G_SOURCE_CONTINUE;
    }
    return G_SOURCE_REMOVE;
}

static gboolean reset_copy_button(gpointer user_data) {
    (void)user_data;
    if (copy_btn) {
        gtk_button_set_label(GTK_BUTTON(copy_btn), "Copy Diagnostics");
    }
    copy_timeout_id = 0;
    return G_SOURCE_REMOVE;
}

static void on_copy_clicked(GtkButton *btn, gpointer user_data) {
    (void)btn;
    (void)user_data;
    
    gchar *payload = build_diagnostics_text();
    GdkClipboard *clipboard = gdk_display_get_clipboard(gdk_display_get_default());
    gdk_clipboard_set_text(clipboard, payload);
    g_free(payload);

    if (copy_btn) {
        gtk_button_set_label(GTK_BUTTON(copy_btn), "Copied!");
        
        if (copy_timeout_id > 0) {
            g_source_remove(copy_timeout_id);
        }
        copy_timeout_id = g_timeout_add(2000, reset_copy_button, NULL);
    }
}

static void on_close_clicked(GtkButton *btn, gpointer user_data) {
    (void)btn;
    (void)user_data;
    if (diag_window) {
        gtk_window_destroy(GTK_WINDOW(diag_window));
    }
}

static void on_diag_window_close(GtkWindow *window, gpointer user_data) {
    (void)window;
    (void)user_data;
    if (copy_timeout_id > 0) {
        g_source_remove(copy_timeout_id);
        copy_timeout_id = 0;
    }
    if (auto_refresh_timeout_id > 0) {
        g_source_remove(auto_refresh_timeout_id);
        auto_refresh_timeout_id = 0;
    }
    copy_btn = NULL;
    text_view = NULL;
    diag_window = NULL;
}

void diagnostics_show_window(void) {
    if (diag_window) {
        gtk_window_present(GTK_WINDOW(diag_window));
        return;
    }

    GApplication *app = g_application_get_default();
    
    diag_window = adw_window_new();
    gtk_window_set_application(GTK_WINDOW(diag_window), GTK_APPLICATION(app));
    gtk_window_set_title(GTK_WINDOW(diag_window), "OpenClaw Diagnostics");
    gtk_window_set_default_size(GTK_WINDOW(diag_window), 550, 550);

    GtkWidget *vbox = gtk_box_new(GTK_ORIENTATION_VERTICAL, 10);
    gtk_widget_set_margin_start(vbox, 20);
    gtk_widget_set_margin_end(vbox, 20);
    gtk_widget_set_margin_top(vbox, 20);
    gtk_widget_set_margin_bottom(vbox, 20);
    adw_window_set_content(ADW_WINDOW(diag_window), vbox);

    gchar *info_text = build_diagnostics_text();
    
    GtkTextBuffer *buffer = gtk_text_buffer_new(NULL);
    gtk_text_buffer_set_text(buffer, info_text, -1);
    g_free(info_text);

    text_view = gtk_text_view_new_with_buffer(buffer);
    gtk_text_view_set_editable(GTK_TEXT_VIEW(text_view), FALSE);
    gtk_text_view_set_cursor_visible(GTK_TEXT_VIEW(text_view), FALSE);
    gtk_text_view_set_wrap_mode(GTK_TEXT_VIEW(text_view), GTK_WRAP_WORD_CHAR);
    gtk_text_view_set_monospace(GTK_TEXT_VIEW(text_view), TRUE);
    gtk_widget_set_vexpand(text_view, TRUE);

    GtkWidget *scrolled_window = gtk_scrolled_window_new();
    gtk_scrolled_window_set_child(GTK_SCROLLED_WINDOW(scrolled_window), text_view);
    gtk_widget_set_vexpand(scrolled_window, TRUE);
    gtk_box_append(GTK_BOX(vbox), scrolled_window);

    GtkWidget *action_row = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 10);
    gtk_widget_set_halign(action_row, GTK_ALIGN_END);
    gtk_widget_set_margin_top(action_row, 10);

    copy_btn = gtk_button_new_with_label("Copy Diagnostics");
    g_signal_connect(copy_btn, "clicked", G_CALLBACK(on_copy_clicked), NULL);
    
    GtkWidget *close_btn = gtk_button_new_with_label("Close");
    g_signal_connect(close_btn, "clicked", G_CALLBACK(on_close_clicked), NULL);

    gtk_box_append(GTK_BOX(action_row), copy_btn);
    gtk_box_append(GTK_BOX(action_row), close_btn);
    gtk_box_append(GTK_BOX(vbox), action_row);

    g_signal_connect(diag_window, "destroy", G_CALLBACK(on_diag_window_close), NULL);

    // Refresh diagnostics text every 1 second while window is open.
    // Note: This auto-refresh updates ONLY the displayed text from already-held 
    // in-memory state. It does NOT trigger additional CLI work. Lane timers 
    // and lane subprocesses remain completely separate.
    auto_refresh_timeout_id = g_timeout_add_seconds(1, refresh_diagnostics_view, NULL);

    gtk_window_present(GTK_WINDOW(diag_window));
}
