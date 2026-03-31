/*
 * app_window.h
 *
 * Main companion window for the OpenClaw Linux Companion App.
 *
 * Provides the primary product surface: a sidebar+content split layout
 * with section-based navigation. The window is tray-first by default —
 * it opens automatically only for first-run/recovery UX, or when the
 * user explicitly invokes "Open OpenClaw" from the tray.
 *
 * Container: AdwNavigationSplitView (libadwaita >= 1.4).
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#pragma once

#include <gtk/gtk.h>

typedef enum {
    SECTION_DASHBOARD,
    SECTION_GENERAL,
    SECTION_CONFIG,
    SECTION_ENVIRONMENT,
    SECTION_DIAGNOSTICS,
    SECTION_ABOUT,
    SECTION_INSTANCES,
    SECTION_DEBUG,
    SECTION_SESSIONS,
    SECTION_CRON,
    SECTION_COUNT,
} AppSection;

void app_window_show(void);
void app_window_navigate_to(AppSection section);
gboolean app_window_is_visible(void);

