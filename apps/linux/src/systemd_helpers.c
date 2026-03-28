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

gchar* systemd_helpers_find_unit_file(const gchar *unit_name, const gchar *home_dir) {
    if (!unit_name) return NULL;

    GPtrArray *paths = systemd_helpers_get_user_unit_paths(home_dir);
    gchar *result = NULL;

    for (guint i = 0; i < paths->len && !result; i++) {
        gchar *candidate = g_build_filename(
            (const gchar *)g_ptr_array_index(paths, i), unit_name, NULL);
        if (g_file_test(candidate, G_FILE_TEST_EXISTS)) {
            result = candidate;
        } else {
            g_free(candidate);
        }
    }

    g_ptr_array_free(paths, TRUE);
    return result;
}

gchar* systemd_helpers_parse_unit_env(const gchar *unit_contents, const gchar *key) {
    if (!unit_contents || !key || key[0] == '\0') return NULL;

    gchar *search_key = g_strdup_printf("%s=", key);
    gsize search_key_len = strlen(search_key);
    gchar **lines = g_strsplit(unit_contents, "\n", -1);
    gchar *result = NULL;

    for (gint i = 0; lines[i] && !result; i++) {
        gchar *line = g_strstrip(g_strdup(lines[i]));

        if (!g_str_has_prefix(line, "Environment=")) {
            g_free(line);
            continue;
        }

        /*
         * The installer emits one Environment= per line, in one of these forms:
         *   Environment=KEY=VALUE
         *   Environment="KEY=VALUE"
         * (see src/daemon/systemd-unit.ts:renderEnvLines)
         *
         * We strip the Environment= prefix, then an optional leading/trailing
         * double-quote, then search for KEY= within the assignment body.
         */
        const gchar *body = line + 12; /* strlen("Environment=") */

        /* Strip optional surrounding quotes, tracking whether they were present */
        gchar *unquoted;
        gsize body_len = strlen(body);
        gboolean was_quoted = (body_len >= 2 && body[0] == '"' && body[body_len - 1] == '"');
        if (was_quoted) {
            unquoted = g_strndup(body + 1, body_len - 2);
        } else {
            unquoted = g_strdup(body);
        }

        /* Find KEY= within the (possibly multi-assignment) body */
        const gchar *pos = strstr(unquoted, search_key);
        if (pos) {
            /* Ensure KEY= is at start of body or preceded by a space (multi-val) */
            if (pos == unquoted || *(pos - 1) == ' ') {
                const gchar *val_start = pos + search_key_len;
                const gchar *val_end = val_start;
                if (was_quoted) {
                    /* Outer-quoted single-assignment: consume to end-of-string */
                    val_end = val_start + strlen(val_start);
                } else {
                    /* Unquoted (possibly multi-assignment): stop at space */
                    while (*val_end && *val_end != ' ' && *val_end != '"') {
                        val_end++;
                    }
                }
                if (val_end > val_start) {
                    result = g_strndup(val_start, val_end - val_start);
                }
            }
        }

        g_free(unquoted);
        g_free(line);
    }

    g_strfreev(lines);
    g_free(search_key);
    return result;
}

gchar* systemd_helpers_extract_env_from_strv(const gchar * const *env_array, const gchar *key) {
    if (!env_array || !key || key[0] == '\0') return NULL;

    g_autofree gchar *prefix = g_strdup_printf("%s=", key);
    gsize prefix_len = strlen(prefix);

    for (gsize i = 0; env_array[i] != NULL; i++) {
        if (g_str_has_prefix(env_array[i], prefix)) {
            const gchar *val = env_array[i] + prefix_len;
            if (val[0] != '\0') {
                return g_strdup(val);
            }
        }
    }
    return NULL;
}
