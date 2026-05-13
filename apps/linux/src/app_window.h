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
    SECTION_CHAT,
    SECTION_AGENTS,
    SECTION_USAGE,
    SECTION_GENERAL,
    SECTION_CONFIG,
    SECTION_CHANNELS,
    SECTION_SKILLS,
    SECTION_WORKFLOWS,
    SECTION_CONTROL_ROOM,
    SECTION_ENVIRONMENT,
    SECTION_DIAGNOSTICS,
    SECTION_LOGS,
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
void app_window_refresh_snapshot(void);

/*
 * Pure helpers for the sidebar-row → AppSection tag encoding. The tag
 * must not collide with GObject's "no data" sentinel (NULL), so we
 * store `section + 1` and decode with `- 1`. Exposed so tests can
 * regress the "Dashboard (enum 0) stuck" bug without GTK.
 *
 *   encode(section)       returns a gpointer safe to stash via g_object_set_data
 *   decode(tag, &out)     returns TRUE on success, FALSE for NULL tags
 *                         or values outside the AppSection range.
 */
gpointer app_window_section_tag_encode(AppSection section);
gboolean app_window_section_tag_decode(gpointer tag, AppSection *out_section);
