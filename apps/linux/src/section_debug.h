#pragma once

#include "section_controller.h"

const SectionController* section_debug_get(void);
gboolean section_debug_test_has_action_label(const gchar *label);
