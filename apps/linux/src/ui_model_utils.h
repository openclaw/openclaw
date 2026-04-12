/*
 * ui_model_utils.h
 *
 * Shared widget/model lifecycle helpers for GTK drop-downs and
 * Adwaita combo rows.
 */

#pragma once

#include <gtk/gtk.h>
#include <adwaita.h>

gboolean ui_dropdown_replace_model(GtkWidget *dropdown,
                                   gpointer *model_slot,
                                   GListModel *new_model,
                                   guint selected,
                                   gboolean sensitive);

void ui_dropdown_detach_model(GtkWidget *dropdown, gpointer *model_slot);

gboolean ui_combo_row_replace_model(GtkWidget *combo_row,
                                    gpointer *model_slot,
                                    GListModel *new_model,
                                    guint selected);

void ui_combo_row_detach_model(GtkWidget *combo_row, gpointer *model_slot);
