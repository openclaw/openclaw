#pragma once

#include "section_controller.h"

const SectionController* section_debug_get(void);
gboolean section_debug_test_has_action_label(const gchar *label);
gchar* section_debug_test_build_reveal_config_uri(void);
