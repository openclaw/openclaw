/*
 * format_utils.h
 * Description: Public declarations for Linux companion formatting helpers.
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#pragma once

#include <glib.h>

gchar* format_size_bytes(guint64 bytes);
gchar* format_money_usd(gdouble amount);
gchar* format_compact_count(guint64 n);
gchar* format_reset_time_ms(gint64 reset_at_ms, gint64 now_ms);
