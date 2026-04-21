/*
 * section_diagnostics.c
 *
 * Diagnostics section controller for the OpenClaw Linux Companion App.
 *
 * Owns the main-window diagnostics page UI, copy affordance, and refresh
 * path for the rendered diagnostics report text.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "section_diagnostics.h"

#include <adwaita.h>

#include "diagnostics.h"

static GtkWidget *diag_text_view = NULL;
static GtkWidget *diag_copy_btn = NULL;
static guint diag_copy_reset_id = 0;

static gboolean reset_diag_copy_label(gpointer data) {
    (void)data;

    if (diag_copy_btn) {
        gtk_button_set_label(GTK_BUTTON(diag_copy_btn), "Copy Diagnostics");
    }
    diag_copy_reset_id = 0;
    return G_SOURCE_REMOVE;
}

static void on_diag_copy(GtkButton *button, gpointer user_data) {
    (void)button;
    (void)user_data;

    g_autofree gchar *text = build_diagnostics_text();
    GdkClipboard *clipboard = gdk_display_get_clipboard(gdk_display_get_default());
    gdk_clipboard_set_text(clipboard, text);
    if (diag_copy_btn) {
        gtk_button_set_label(GTK_BUTTON(diag_copy_btn), "Copied!");
        if (diag_copy_reset_id > 0) {
            g_source_remove(diag_copy_reset_id);
        }
        diag_copy_reset_id = g_timeout_add(2000, reset_diag_copy_label, NULL);
    }
}

static GtkWidget* diagnostics_build(void) {
    GtkWidget *page = gtk_box_new(GTK_ORIENTATION_VERTICAL, 8);
    gtk_widget_set_margin_start(page, 24);
    gtk_widget_set_margin_end(page, 24);
    gtk_widget_set_margin_top(page, 24);
    gtk_widget_set_margin_bottom(page, 24);

    GtkWidget *title = gtk_label_new("Diagnostics");
    gtk_widget_add_css_class(title, "title-1");
    gtk_label_set_xalign(GTK_LABEL(title), 0.0);
    gtk_box_append(GTK_BOX(page), title);

    GtkWidget *subtitle = gtk_label_new("Full connectivity snapshot. Copy and share for troubleshooting.");
    gtk_widget_add_css_class(subtitle, "dim-label");
    gtk_label_set_xalign(GTK_LABEL(subtitle), 0.0);
    gtk_box_append(GTK_BOX(page), subtitle);

    g_autofree gchar *initial = build_diagnostics_text();
    GtkTextBuffer *buffer = gtk_text_buffer_new(NULL);
    gtk_text_buffer_set_text(buffer, initial, -1);

    diag_text_view = gtk_text_view_new_with_buffer(buffer);
    gtk_text_view_set_editable(GTK_TEXT_VIEW(diag_text_view), FALSE);
    gtk_text_view_set_cursor_visible(GTK_TEXT_VIEW(diag_text_view), FALSE);
    gtk_text_view_set_wrap_mode(GTK_TEXT_VIEW(diag_text_view), GTK_WRAP_WORD_CHAR);
    gtk_text_view_set_monospace(GTK_TEXT_VIEW(diag_text_view), TRUE);

    GtkWidget *scrolled = gtk_scrolled_window_new();
    gtk_scrolled_window_set_policy(GTK_SCROLLED_WINDOW(scrolled),
                                   GTK_POLICY_NEVER, GTK_POLICY_AUTOMATIC);
    gtk_scrolled_window_set_min_content_height(GTK_SCROLLED_WINDOW(scrolled), 360);
    gtk_scrolled_window_set_child(GTK_SCROLLED_WINDOW(scrolled), diag_text_view);
    gtk_widget_set_vexpand(scrolled, TRUE);
    gtk_box_append(GTK_BOX(page), scrolled);

    GtkWidget *btn_row = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
    gtk_widget_set_margin_top(btn_row, 8);

    diag_copy_btn = gtk_button_new_with_label("Copy Diagnostics");
    g_signal_connect(diag_copy_btn, "clicked", G_CALLBACK(on_diag_copy), NULL);
    gtk_box_append(GTK_BOX(btn_row), diag_copy_btn);

    gtk_box_append(GTK_BOX(page), btn_row);
    return page;
}

static void diagnostics_refresh(void) {
    if (!diag_text_view) {
        return;
    }
    if (!gtk_widget_get_realized(diag_text_view)) {
        return;
    }

    g_autofree gchar *text = build_diagnostics_text();
    GtkTextBuffer *buffer = gtk_text_view_get_buffer(GTK_TEXT_VIEW(diag_text_view));
    gtk_text_buffer_set_text(buffer, text, -1);
}

static void diagnostics_destroy(void) {
    if (diag_copy_reset_id > 0) {
        g_source_remove(diag_copy_reset_id);
        diag_copy_reset_id = 0;
    }
    diag_text_view = NULL;
    diag_copy_btn = NULL;
}

static void diagnostics_invalidate(void) {
}

static const SectionController diagnostics_controller = {
    .build = diagnostics_build,
    .refresh = diagnostics_refresh,
    .destroy = diagnostics_destroy,
    .invalidate = diagnostics_invalidate,
};

const SectionController* section_diagnostics_get(void) {
    return &diagnostics_controller;
}
