/*
 * markdown_render.h
 * Description: Public declarations for markdown rendering helpers.
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#pragma once

#include <glib.h>

gchar* markdown_escape_pango(const gchar *text);
gchar* markdown_to_pango(const gchar *markdown);
