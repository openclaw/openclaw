#pragma once

#include <glib.h>

#include "app_window.h"
#include "section_controller.h"

typedef struct {
    const char *id;
    const char *title;
    const char *icon_name;
} ShellSectionMeta;

gboolean shell_sections_is_embedded(AppSection section);
const ShellSectionMeta* shell_sections_meta(AppSection section);
const SectionController* shell_sections_controller(AppSection section);
