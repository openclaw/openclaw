/*
 * diagnostics.h
 *
 * Diagnostics window and debug payload generation.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#pragma once

#include <glib.h>

void diagnostics_show_window(void);
gchar* build_diagnostics_text(void);
