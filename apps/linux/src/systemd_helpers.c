#include "systemd_helpers.h"
#include "log.h"
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

gchar** systemd_parse_single_env_file(const gchar *env_file, const gchar *home_dir, const gchar *unit_dir, gboolean is_optional, gchar **file_env) {
    gchar *expanded_h = NULL;
    const gchar *target_file = env_file;
    
    if (strstr(target_file, "%h")) {
        gchar **parts = g_strsplit(target_file, "%h", -1);
        expanded_h = g_strjoinv(home_dir, parts);
        g_strfreev(parts);
        target_file = expanded_h;
    }
    
    gchar *resolved_path = NULL;
    if (!g_path_is_absolute(target_file)) {
        if (unit_dir) {
            resolved_path = g_build_filename(unit_dir, target_file, NULL);
        } else {
            gchar *systemd_user_dir = g_build_filename(home_dir, ".config", "systemd", "user", NULL);
            resolved_path = g_build_filename(systemd_user_dir, target_file, NULL);
            g_free(systemd_user_dir);
        }
        target_file = resolved_path;
    }
    
    gchar *file_contents = NULL;
    if (g_file_get_contents(target_file, &file_contents, NULL, NULL)) {
        gchar **env_lines = g_strsplit(file_contents, "\n", -1);
        for (gint j = 0; env_lines[j] != NULL; j++) {
            gchar *env_line = g_strstrip(env_lines[j]);
            if (env_line[0] == '#' || env_line[0] == ';' || env_line[0] == '\0') continue;
            
            gchar *eq = strchr(env_line, '=');
            if (eq) {
                gchar *key = g_strndup(env_line, eq - env_line);
                gchar *val = g_strstrip(eq + 1);
                gsize val_len = strlen(val);
                if (val_len >= 2 && ((val[0] == '"' && val[val_len-1] == '"') ||
                                     (val[0] == '\'' && val[val_len-1] == '\''))) {
                    val[val_len-1] = '\0';
                    val++;
                }
                file_env = g_environ_setenv(file_env, key, val, TRUE);
                g_free(key);
            }
        }
        g_strfreev(env_lines);
        g_free(file_contents);
    } else if (!is_optional) {
        OC_LOG_WARN(OPENCLAW_LOG_CAT_SYSTEMD, "Failed to read EnvironmentFile: %s", target_file);
    }
    
    g_free(expanded_h);
    g_free(resolved_path);
    
    return file_env;
}

gchar** systemd_parse_environment_file(const gchar *env_val, const gchar *home_dir, const gchar *unit_dir, gchar **file_env) {
    gint argc = 0;
    gchar **argv = NULL;
    
    // Parse the line as a shell command to handle multiple files and quotes
    if (g_shell_parse_argv(env_val, &argc, &argv, NULL)) {
        for (gint k = 0; k < argc; k++) {
            gchar *env_file = argv[k];
            gboolean is_optional = FALSE;
            
            if (env_file[0] == '-') {
                is_optional = TRUE;
                env_file++;
            }
            
            if (env_file[0] == '\0') continue;
            
            file_env = systemd_parse_single_env_file(env_file, home_dir, unit_dir, is_optional, file_env);
        }
        g_strfreev(argv);
    }
    return file_env;
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
