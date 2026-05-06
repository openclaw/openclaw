/*
 * app_window_section_tag.c
 *
 * Pure encode/decode for sidebar row `AppSection` tags. Extracted from
 * app_window.c so the Dashboard-routing regression can be covered by a
 * headless unit test without pulling the entire main-window TU (GTK,
 * Adwaita, every integrated section controller).
 *
 * Store `section + 1` / read back via `- 1` so that SECTION_DASHBOARD
 * (enum 0) does not collide with GObject's "no data" sentinel (NULL)
 * returned by `g_object_get_data()` for un-keyed rows.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "app_window.h"

#include <glib.h>

gpointer app_window_section_tag_encode(AppSection section) {
    return GINT_TO_POINTER((gint)section + 1);
}

gboolean app_window_section_tag_decode(gpointer tag, AppSection *out_section) {
    if (!tag) return FALSE;
    gint raw = GPOINTER_TO_INT(tag) - 1;
    if (raw < 0 || raw >= SECTION_COUNT) return FALSE;
    if (out_section) *out_section = (AppSection)raw;
    return TRUE;
}
