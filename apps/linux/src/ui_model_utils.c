/*
 * ui_model_utils.c
 *
 * Shared widget/model lifecycle helpers for GTK drop-downs and
 * Adwaita combo rows.
 */

#include "ui_model_utils.h"

gboolean ui_dropdown_replace_model(GtkWidget *dropdown,
                                   gpointer *model_slot,
                                   GListModel *new_model,
                                   guint selected,
                                   gboolean sensitive)
{
    if (!model_slot || !new_model) return FALSE;

    if (dropdown && GTK_IS_DROP_DOWN(dropdown)) {
        gtk_drop_down_set_model(GTK_DROP_DOWN(dropdown), new_model);
        gtk_drop_down_set_selected(GTK_DROP_DOWN(dropdown), selected);
        gtk_widget_set_sensitive(dropdown, sensitive);
    }

    if (*model_slot && G_IS_OBJECT(*model_slot)) {
        g_object_unref(*model_slot);
    }
    *model_slot = new_model;
    return TRUE;
}

void ui_dropdown_detach_model(GtkWidget *dropdown, gpointer *model_slot) {
    if (dropdown && GTK_IS_DROP_DOWN(dropdown)) {
        gtk_drop_down_set_model(GTK_DROP_DOWN(dropdown), NULL);
    }

    if (model_slot && *model_slot && G_IS_OBJECT(*model_slot)) {
        g_object_unref(*model_slot);
        *model_slot = NULL;
    }
}

gboolean ui_combo_row_replace_model(GtkWidget *combo_row,
                                    gpointer *model_slot,
                                    GListModel *new_model,
                                    guint selected)
{
    if (!model_slot || !new_model) return FALSE;

    if (combo_row && ADW_IS_COMBO_ROW(combo_row)) {
        adw_combo_row_set_model(ADW_COMBO_ROW(combo_row), new_model);
        adw_combo_row_set_selected(ADW_COMBO_ROW(combo_row), selected);
    }

    if (*model_slot && G_IS_OBJECT(*model_slot)) {
        g_object_unref(*model_slot);
    }
    *model_slot = new_model;
    return TRUE;
}

void ui_combo_row_detach_model(GtkWidget *combo_row, gpointer *model_slot) {
    if (combo_row && ADW_IS_COMBO_ROW(combo_row)) {
        adw_combo_row_set_model(ADW_COMBO_ROW(combo_row), NULL);
    }

    if (model_slot && *model_slot && G_IS_OBJECT(*model_slot)) {
        g_object_unref(*model_slot);
        *model_slot = NULL;
    }
}
