/*
 * format_utils.c
 * Description: Shared formatting utilities for Linux companion UI strings.
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "format_utils.h"

#include <math.h>

static gchar* format_with_suffix(gdouble value, const gchar *suffix, gint decimals) {
    if (decimals <= 0) {
        return g_strdup_printf("%.0f%s", value, suffix);
    }
    return g_strdup_printf("%.*f%s", decimals, value, suffix);
}

gchar* format_size_bytes(guint64 bytes) {
    if (bytes < 1024ULL) {
        return g_strdup_printf("%" G_GUINT64_FORMAT " B", bytes);
    }

    gdouble kb = (gdouble)bytes / 1024.0;
    if (kb < 1024.0) {
        return format_with_suffix(kb, " KB", kb >= 10.0 ? 0 : 1);
    }

    gdouble mb = kb / 1024.0;
    if (mb < 1024.0) {
        return format_with_suffix(mb, " MB", mb >= 10.0 ? 0 : 1);
    }

    gdouble gb = mb / 1024.0;
    return format_with_suffix(gb, " GB", gb >= 10.0 ? 0 : 1);
}

gchar* format_money_usd(gdouble amount) {
    if (amount >= 100.0) {
        return g_strdup_printf("%.2f", amount);
    }
    if (amount >= 1.0) {
        return g_strdup_printf("%.3f", amount);
    }
    return g_strdup_printf("%.4f", amount);
}

gchar* format_compact_count(guint64 n) {
    if (n >= 1000000ULL) {
        return g_strdup_printf("%.1fM", (gdouble)n / 1000000.0);
    }
    if (n >= 10000ULL) {
        return g_strdup_printf("%.0fk", (gdouble)n / 1000.0);
    }
    if (n >= 1000ULL) {
        return g_strdup_printf("%.1fk", (gdouble)n / 1000.0);
    }
    return g_strdup_printf("%" G_GUINT64_FORMAT, n);
}

gchar* format_reset_time_ms(gint64 reset_at_ms, gint64 now_ms) {
    if (reset_at_ms <= now_ms) {
        return g_strdup("reset due");
    }

    gint64 delta_sec = (reset_at_ms - now_ms) / 1000;
    gint64 hours = delta_sec / 3600;
    gint64 mins = (delta_sec % 3600) / 60;

    if (hours > 0) {
        return g_strdup_printf("resets in %" G_GINT64_FORMAT "h %" G_GINT64_FORMAT "m", hours, mins);
    }
    if (mins > 0) {
        return g_strdup_printf("resets in %" G_GINT64_FORMAT "m", mins);
    }
    return g_strdup("resets in <1m");
}
