/*
 * log.h
 *
 * Centralized, runtime-configurable logging layer for the Linux Companion App.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#ifndef OPENCLAW_LOG_H
#define OPENCLAW_LOG_H

#include <glib.h>

typedef enum {
    OPENCLAW_LOG_ERROR = 0,
    OPENCLAW_LOG_WARN,
    OPENCLAW_LOG_INFO,
    OPENCLAW_LOG_DEBUG,
    OPENCLAW_LOG_TRACE,
} OpenClawLogLevel;

typedef enum {
    OPENCLAW_LOG_CAT_SYSTEMD = 1 << 0,
    OPENCLAW_LOG_CAT_TRAY    = 1 << 1,
    OPENCLAW_LOG_CAT_STATE   = 1 << 2,
    OPENCLAW_LOG_CAT_NOTIFY  = 1 << 3,
    OPENCLAW_LOG_CAT_HEALTH  = 1 << 4,
    OPENCLAW_LOG_CAT_GATEWAY = 1 << 5,
    OPENCLAW_LOG_CAT_ALL     = OPENCLAW_LOG_CAT_SYSTEMD | OPENCLAW_LOG_CAT_TRAY | OPENCLAW_LOG_CAT_STATE | OPENCLAW_LOG_CAT_NOTIFY | OPENCLAW_LOG_CAT_HEALTH | OPENCLAW_LOG_CAT_GATEWAY
} OpenClawLogCategory;

void openclaw_log_init(void);
gboolean openclaw_log_enabled(OpenClawLogLevel level, guint category_mask);
void openclaw_log_write(OpenClawLogLevel level, guint category_mask, const char *file, int line, const char *func, const char *fmt, ...) G_GNUC_PRINTF(6, 7);

// NOTE: OC_LOG_ERROR routes through g_warning() intentionally to avoid process
// abort under G_DEBUG=fatal-criticals. ERROR is reserved for serious but
// recoverable conditions (e.g., helper spawn failure).
#define OC_LOG_ERROR(cat, fmt, ...) \
    do { if (openclaw_log_enabled(OPENCLAW_LOG_ERROR, (cat))) openclaw_log_write(OPENCLAW_LOG_ERROR, (cat), __FILE__, __LINE__, G_STRFUNC, (fmt), ##__VA_ARGS__); } while (0)

#define OC_LOG_WARN(cat, fmt, ...) \
    do { if (openclaw_log_enabled(OPENCLAW_LOG_WARN, (cat))) openclaw_log_write(OPENCLAW_LOG_WARN, (cat), __FILE__, __LINE__, G_STRFUNC, (fmt), ##__VA_ARGS__); } while (0)

#define OC_LOG_INFO(cat, fmt, ...) \
    do { if (openclaw_log_enabled(OPENCLAW_LOG_INFO, (cat))) openclaw_log_write(OPENCLAW_LOG_INFO, (cat), __FILE__, __LINE__, G_STRFUNC, (fmt), ##__VA_ARGS__); } while (0)

#define OC_LOG_DEBUG(cat, fmt, ...) \
    do { if (openclaw_log_enabled(OPENCLAW_LOG_DEBUG, (cat))) openclaw_log_write(OPENCLAW_LOG_DEBUG, (cat), __FILE__, __LINE__, G_STRFUNC, (fmt), ##__VA_ARGS__); } while (0)

#define OC_LOG_TRACE(cat, fmt, ...) \
    do { if (openclaw_log_enabled(OPENCLAW_LOG_TRACE, (cat))) openclaw_log_write(OPENCLAW_LOG_TRACE, (cat), __FILE__, __LINE__, G_STRFUNC, (fmt), ##__VA_ARGS__); } while (0)

#endif // OPENCLAW_LOG_H
