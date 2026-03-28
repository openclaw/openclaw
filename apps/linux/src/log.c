/*
 * log.c
 *
 * Implementation of the runtime-configurable logging layer.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "log.h"
#include <stdarg.h>
#include <string.h>

static OpenClawLogLevel current_level = OPENCLAW_LOG_WARN; // Default to WARN (quiet execution)
static guint current_categories = OPENCLAW_LOG_CAT_ALL;

static gboolean has_multiple_bits(guint mask) {
    return mask && (mask & (mask - 1));
}

void openclaw_log_init(void) {
    // Default to a quiet execution (ERROR and WARN)
    current_level = OPENCLAW_LOG_WARN;

    const gchar *env_level = g_getenv("OPENCLAW_LINUX_LOG");
    if (env_level) {
        if (g_ascii_strcasecmp(env_level, "trace") == 0) {
            current_level = OPENCLAW_LOG_TRACE;
        } else if (g_ascii_strcasecmp(env_level, "debug") == 0) {
            current_level = OPENCLAW_LOG_DEBUG;
        } else if (g_ascii_strcasecmp(env_level, "info") == 0) {
            current_level = OPENCLAW_LOG_INFO;
        } else if (g_ascii_strcasecmp(env_level, "warn") == 0) {
            current_level = OPENCLAW_LOG_WARN;
        } else if (g_ascii_strcasecmp(env_level, "error") == 0) {
            current_level = OPENCLAW_LOG_ERROR;
        }
    }

    const gchar *env_cats = g_getenv("OPENCLAW_LINUX_LOG_CATEGORIES");
    if (env_cats && *env_cats != '\0') {
        current_categories = 0;
        gchar **cats = g_strsplit(env_cats, ",", -1);
        for (gint i = 0; cats[i] != NULL; i++) {
            gchar *cat = g_strstrip(cats[i]);
            if (g_ascii_strcasecmp(cat, "systemd") == 0) {
                current_categories |= OPENCLAW_LOG_CAT_SYSTEMD;
            } else if (g_ascii_strcasecmp(cat, "tray") == 0) {
                current_categories |= OPENCLAW_LOG_CAT_TRAY;
            } else if (g_ascii_strcasecmp(cat, "state") == 0) {
                current_categories |= OPENCLAW_LOG_CAT_STATE;
            } else if (g_ascii_strcasecmp(cat, "notify") == 0) {
                current_categories |= OPENCLAW_LOG_CAT_NOTIFY;
            } else if (g_ascii_strcasecmp(cat, "health") == 0) {
                current_categories |= OPENCLAW_LOG_CAT_HEALTH;
            } else if (g_ascii_strcasecmp(cat, "gateway") == 0) {
                current_categories |= OPENCLAW_LOG_CAT_GATEWAY;
            }
        }
        g_strfreev(cats);
        // If they provided a totally bogus string, fall back to ALL
        if (current_categories == 0) {
            current_categories = OPENCLAW_LOG_CAT_ALL;
        }
    } else {
        // If OPENCLAW_LINUX_LOG_CATEGORIES is unset, all categories are enabled subject to the selected level.
        current_categories = OPENCLAW_LOG_CAT_ALL;
    }
}

gboolean openclaw_log_enabled(OpenClawLogLevel level, guint category_mask) {
    if (level > current_level) {
        return FALSE;
    }
    if ((category_mask & current_categories) == 0) {
        return FALSE;
    }
    return TRUE;
}

void openclaw_log_write(OpenClawLogLevel level, guint category_mask, const char *file, int line, const char *func, const char *fmt, ...) {

    const char *level_str = "UNKNOWN";
    switch (level) {
        case OPENCLAW_LOG_ERROR: level_str = "ERROR"; break;
        case OPENCLAW_LOG_WARN:  level_str = "WARN "; break;
        case OPENCLAW_LOG_INFO:  level_str = "INFO "; break;
        case OPENCLAW_LOG_DEBUG: level_str = "DEBUG"; break;
        case OPENCLAW_LOG_TRACE: level_str = "TRACE"; break;
    }

    const char *cat_str = "UNKN";
    // Defensive: handle multiple category bits by showing MULTI
    if (has_multiple_bits(category_mask)) {
        cat_str = "MULTI";
    } else if (category_mask & OPENCLAW_LOG_CAT_SYSTEMD) {
        cat_str = "SYSD";
    } else if (category_mask & OPENCLAW_LOG_CAT_TRAY) {
        cat_str = "TRAY";
    } else if (category_mask & OPENCLAW_LOG_CAT_STATE) {
        cat_str = "STAT";
    } else if (category_mask & OPENCLAW_LOG_CAT_NOTIFY) {
        cat_str = "NOTI";
    } else if (category_mask & OPENCLAW_LOG_CAT_HEALTH) {
        cat_str = "HLTH";
    } else if (category_mask & OPENCLAW_LOG_CAT_GATEWAY) {
        cat_str = "GATE";
    }

    // Extract filename from path for terser logging
    const char *short_file = strrchr(file, '/');
    if (short_file) short_file++;
    else short_file = file;

    g_autofree gchar *msg = NULL;
    va_list args;
    va_start(args, fmt);
    msg = g_strdup_vprintf(fmt, args);
    va_end(args);

    switch (level) {
        case OPENCLAW_LOG_ERROR:
            // Route ERROR through g_warning() for safety - avoids process abort under G_DEBUG=fatal-criticals
            // ERROR is reserved for serious but recoverable conditions (e.g., helper spawn failure)
            g_warning("[OC:%s][%s] %s:%d %s() %s", level_str, cat_str, short_file, line, func, msg);
            break;
        case OPENCLAW_LOG_WARN:
            // WARN is for recoverable issues that don't prevent normal operation
            g_warning("[OC:%s][%s] %s:%d %s() %s", level_str, cat_str, short_file, line, func, msg);
            break;
        case OPENCLAW_LOG_INFO:
        case OPENCLAW_LOG_DEBUG:
        case OPENCLAW_LOG_TRACE:
        default:
            g_message("[OC:%s][%s] %s:%d %s() %s", level_str, cat_str, short_file, line, func, msg);
            break;
    }
}
