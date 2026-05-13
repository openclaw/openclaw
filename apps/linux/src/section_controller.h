/*
 * section_controller.h
 *
 * Section controller interface for the OpenClaw Linux Companion App.
 *
 * Each RPC-backed management section (Channels, Skills, Sessions, Cron,
 * Instances) implements this interface. The app_window owns the lifecycle
 * and delegates build/refresh/destroy to the controller.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#pragma once

#include <gtk/gtk.h>
#include <glib.h>

/* Default per-section TTL for RPC freshness (30 seconds) */
#define SECTION_FRESH_INTERVAL_US (30 * G_USEC_PER_SEC)

typedef struct {
    /* Build the widget tree for this section. Called once at window init. */
    GtkWidget* (*build)(void);

    /* Refresh data. Called on section activation and periodic tick.
     * Implementations should respect TTL freshness and skip if not stale. */
    void (*refresh)(void);

    /* Cleanup all owned state on window destroy. Must NULL widget refs. */
    void (*destroy)(void);

    /* Mark cached data stale so next refresh forces a re-fetch.
     * Called after a successful mutation to trigger immediate refresh. */
    void (*invalidate)(void);
} SectionController;

static inline gboolean section_controller_has_required_callbacks(const SectionController *controller) {
    return controller
        && controller->build
        && controller->refresh
        && controller->destroy
        && controller->invalidate;
}

static inline GtkWidget* section_controller_build_safe(const SectionController *controller) {
    return (controller && controller->build) ? controller->build() : NULL;
}

static inline void section_controller_refresh_safe(const SectionController *controller) {
    if (controller && controller->refresh) {
        controller->refresh();
    }
}

static inline void section_controller_destroy_safe(const SectionController *controller) {
    if (controller && controller->destroy) {
        controller->destroy();
    }
}

static inline void section_controller_invalidate_safe(const SectionController *controller) {
    if (controller && controller->invalidate) {
        controller->invalidate();
    }
}

/* ── Shared freshness helpers ────────────────────────────────────── */

static inline gboolean section_is_stale(gint64 *last_fetch_us) {
    gint64 now = g_get_monotonic_time();
    return (now - *last_fetch_us) >= SECTION_FRESH_INTERVAL_US;
}

static inline void section_mark_fresh(gint64 *last_fetch_us) {
    *last_fetch_us = g_get_monotonic_time();
}

static inline void section_mark_stale(gint64 *last_fetch_us) {
    *last_fetch_us = 0;
}

/* ── Shared UI helpers ───────────────────────────────────────────── */

/* Remove all children from a GtkBox. */
static inline void section_box_clear(GtkWidget *box) {
    GtkWidget *child;
    while ((child = gtk_widget_get_first_child(box)) != NULL) {
        gtk_box_remove(GTK_BOX(box), child);
    }
}

/* Build a key→value info row with a fixed-width dim label on the left. */
static inline GtkWidget* section_info_row(const char *heading, int label_width,
                                           GtkWidget **out_value) {
    GtkWidget *row = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
    gtk_widget_set_margin_top(row, 2);

    GtkWidget *h = gtk_label_new(heading);
    gtk_widget_add_css_class(h, "dim-label");
    gtk_label_set_xalign(GTK_LABEL(h), 0.0);
    gtk_widget_set_size_request(h, label_width, -1);
    gtk_box_append(GTK_BOX(row), h);

    GtkWidget *v = gtk_label_new("\u2014");
    gtk_label_set_xalign(GTK_LABEL(v), 0.0);
    gtk_label_set_selectable(GTK_LABEL(v), TRUE);
    gtk_widget_set_hexpand(v, TRUE);
    gtk_box_append(GTK_BOX(row), v);

    *out_value = v;
    return row;
}
