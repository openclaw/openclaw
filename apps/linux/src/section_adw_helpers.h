/*
 * section_adw_helpers.h
 *
 * Shared libadwaita-backed row helpers for main-window sections.
 *
 * These helpers live in their own header so that the core section
 * controller contract (`section_controller.h`) can stay adwaita-free
 * and be included by headless registry tests that do not link
 * libadwaita. Sections that render AdwPreferencesPage content and
 * need consistent key/value rows should include this header instead
 * of duplicating row-building code locally.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#pragma once

#include <adwaita.h>
#include <gtk/gtk.h>

/* Build a libadwaita key/value info row for preference pages.
 *
 * Creates an AdwActionRow titled `heading` with a right-aligned,
 * selectable, wrapping GtkLabel suffix ("—" by default) that callers
 * update in-place via gtk_label_set_text(). The suffix label is
 * returned through `out_value` so refresh callbacks can rewrite it
 * without tearing down the row. */
static inline GtkWidget* section_adw_info_row(const char *heading, GtkWidget **out_value) {
    GtkWidget *row = adw_action_row_new();
    adw_preferences_row_set_title(ADW_PREFERENCES_ROW(row), heading);

    GtkWidget *value = gtk_label_new("\u2014");
    gtk_label_set_selectable(GTK_LABEL(value), TRUE);
    gtk_label_set_wrap(GTK_LABEL(value), TRUE);
    gtk_label_set_xalign(GTK_LABEL(value), 1.0);
    gtk_widget_set_hexpand(value, TRUE);
    gtk_widget_set_halign(value, GTK_ALIGN_END);
    adw_action_row_add_suffix(ADW_ACTION_ROW(row), value);

    if (out_value) {
        *out_value = value;
    }
    return row;
}
