#pragma once

#include <glib.h>

#include "app_window.h"
#include "section_controller.h"

typedef enum {
    SHELL_SECTION_GROUP_PARITY = 0,
    SHELL_SECTION_GROUP_EXTRAS_OPERATIONAL = 1,
    SHELL_SECTION_GROUP_EXTRAS_DIAGNOSTIC = 2,
    SHELL_SECTION_GROUP_EXTRAS_DEBUG = 3,
} ShellSectionGroup;

typedef struct {
    const char *id;
    const char *title;
    const char *icon_name;
} ShellSectionMeta;

typedef struct {
    AppSection section;
    ShellSectionGroup group;
} ShellSectionDisplayEntry;

gboolean shell_sections_is_embedded(AppSection section);
gboolean shell_sections_is_visible(AppSection section);
const ShellSectionMeta* shell_sections_meta(AppSection section);

/*
 * Resolve a shell-section id string (e.g. "channels") to its
 * AppSection enum. Returns TRUE on a known, embedded, currently-visible
 * section and writes the match into *out_section; returns FALSE
 * otherwise (unknown id, not embedded, or gated out by the host's
 * visibility rules — notably SECTION_DEBUG hidden without
 * OPENCLAW_DEBUG_PANE). `out_section` may be NULL for a pure probe.
 */
gboolean shell_sections_section_for_id(const char *section_id,
                                       AppSection *out_section);
const char* shell_sections_group_heading(ShellSectionGroup group);
const SectionController* shell_sections_controller(AppSection section);
gsize shell_sections_display_count(void);
const ShellSectionDisplayEntry* shell_sections_display_at(gsize index);
gboolean shell_sections_debug_pane_enabled(void);
