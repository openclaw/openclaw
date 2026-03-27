/*
 * systemd_helpers.c
 *
 * Helper functions for systemd integration in the OpenClaw Linux Companion App.
 *
 * Provides utilities for:
 * - Identifying OpenClaw gateway unit files by name and content
 * - Normalizing environment variable overrides and profile names
 * - Discovering systemd unit files across all standard search paths
 *
 * After the gateway client refactor, service-property parsing
 * (ExecStart, WorkingDirectory, Environment) is no longer needed.
 * The native gateway client reads config directly from
 * ~/.openclaw/openclaw.json.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "systemd_helpers.h"
#include <string.h>

gboolean systemd_is_gateway_unit_name(const gchar *unit_name) {
    if (!unit_name) return FALSE;
    return ((g_str_has_prefix(unit_name, "openclaw-gateway.") || g_str_has_prefix(unit_name, "openclaw-gateway-")) ||
            (g_str_has_prefix(unit_name, "clawdbot-gateway.") || g_str_has_prefix(unit_name, "clawdbot-gateway-")) ||
            (g_str_has_prefix(unit_name, "moltbot-gateway.") || g_str_has_prefix(unit_name, "moltbot-gateway-")));
}

gboolean systemd_is_gateway_unit(const gchar *filename, const gchar *contents) {
    if (!contents) return FALSE;
    
    // Must be a gateway (explicit kind marker or legacy/default filename pattern)
    if (strstr(contents, "OPENCLAW_SERVICE_KIND=gateway")) {
        return TRUE;
    }
    // Fallback for older units or manual installs missing the KIND marker
    return systemd_is_gateway_unit_name(filename);
}

gchar* systemd_normalize_unit_override(const gchar *raw_unit) {
    if (!raw_unit) return NULL;
    gchar *trimmed = g_strstrip(g_strdup(raw_unit));
    if (strlen(trimmed) > 0) {
        if (g_str_has_suffix(trimmed, ".service")) {
            return trimmed;
        } else {
            gchar *res = g_strdup_printf("%s.service", trimmed);
            g_free(trimmed);
            return res;
        }
    }
    g_free(trimmed);
    return NULL;
}

gchar* systemd_normalize_profile(const gchar *raw_profile) {
    if (!raw_profile) return NULL;
    gchar *trimmed = g_strstrip(g_strdup(raw_profile));
    gchar *res = NULL;
    if (strlen(trimmed) == 0 || g_ascii_strcasecmp(trimmed, "default") == 0) {
        res = g_strdup("openclaw-gateway.service");
    } else {
        res = g_strdup_printf("openclaw-gateway-%s.service", trimmed);
    }
    g_free(trimmed);
    return res;
}

GPtrArray* systemd_helpers_get_user_unit_paths(const gchar *home_dir) {
    GPtrArray *paths = g_ptr_array_new_with_free_func(g_free);
    if (home_dir) {
        g_ptr_array_add(paths, g_build_filename(home_dir, ".config", "systemd", "user", NULL));
        g_ptr_array_add(paths, g_build_filename(home_dir, ".local", "share", "systemd", "user", NULL));
    }
    g_ptr_array_add(paths, g_strdup("/etc/systemd/user"));
    g_ptr_array_add(paths, g_strdup("/etc/xdg/systemd/user"));
    g_ptr_array_add(paths, g_strdup("/usr/lib/systemd/user"));
    g_ptr_array_add(paths, g_strdup("/usr/local/lib/systemd/user"));
    g_ptr_array_add(paths, g_strdup("/usr/share/systemd/user"));
    g_ptr_array_add(paths, g_strdup("/lib/systemd/user"));
    return paths;
}

GPtrArray* systemd_helpers_get_system_unit_paths(void) {
    GPtrArray *paths = g_ptr_array_new_with_free_func(g_free);
    g_ptr_array_add(paths, g_strdup("/etc/systemd/system"));
    g_ptr_array_add(paths, g_strdup("/usr/lib/systemd/system"));
    g_ptr_array_add(paths, g_strdup("/usr/local/lib/systemd/system"));
    g_ptr_array_add(paths, g_strdup("/lib/systemd/system"));
    return paths;
}
