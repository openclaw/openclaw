#pragma once

#include <glib.h>

#include "app_window.h"
#include "section_controller.h"

typedef enum {
    SHELL_SECTION_GROUP_PARITY = 0,
    SHELL_SECTION_GROUP_EXTRAS = 1,
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
const ShellSectionMeta* shell_sections_meta(AppSection section);
const SectionController* shell_sections_controller(AppSection section);
gsize shell_sections_display_count(void);
const ShellSectionDisplayEntry* shell_sections_display_at(gsize index);
gboolean shell_sections_debug_pane_enabled(void);
