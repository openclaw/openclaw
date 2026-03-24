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

gboolean systemd_parse_service_properties(GVariant *props, const gchar *home_dir, gchar ***exec_start_argv_out, gchar **working_directory_out, gchar ***environment_out) {
    if (!props || !exec_start_argv_out || !working_directory_out || !environment_out) {
        return FALSE;
    }

    *exec_start_argv_out = NULL;
    *working_directory_out = NULL;
    *environment_out = NULL;

    GVariant *exec_start_v = g_variant_lookup_value(props, "ExecStart", NULL);
    GVariant *working_dir_v = g_variant_lookup_value(props, "WorkingDirectory", G_VARIANT_TYPE_STRING);
    GVariant *env_v = g_variant_lookup_value(props, "Environment", NULL);
    GVariant *env_files_v = g_variant_lookup_value(props, "EnvironmentFiles", NULL);

    gboolean parse_success = FALSE;

    if (exec_start_v) {
        const gchar *type_string = g_variant_get_type_string(exec_start_v);
        GVariantIter *iter = NULL;
        
        // Handle both observed systemd signatures
        if (g_strcmp0(type_string, "a(sasbttuii)") == 0) {
            g_variant_get(exec_start_v, "a(sasbttuii)", &iter);
            gchar *path;
            gchar **argv;
            gboolean ignore_errors;
            guint64 start_time, stop_time;
            guint32 pid;
            gint32 code, status;

            if (g_variant_iter_next(iter, "(s^asbttuii)", &path, &argv, &ignore_errors, &start_time, &stop_time, &pid, &code, &status)) {
                if (argv && g_strv_length(argv) > 0) {
                    *exec_start_argv_out = argv;
                    parse_success = TRUE;
                } else {
                    g_strfreev(argv);
                }
                g_free(path);
            }
            g_variant_iter_free(iter);
        } else if (g_strcmp0(type_string, "a(sasbttttuii)") == 0) {
            g_variant_get(exec_start_v, "a(sasbttttuii)", &iter);
            gchar *path;
            gchar **argv;
            gboolean ignore_errors;
            guint64 start_time, stop_time, exec_time, something_else; // The extra 'tt' fields
            guint32 pid;
            gint32 code, status;

            if (g_variant_iter_next(iter, "(s^asbttttuii)", &path, &argv, &ignore_errors, &start_time, &stop_time, &exec_time, &something_else, &pid, &code, &status)) {
                if (argv && g_strv_length(argv) > 0) {
                    *exec_start_argv_out = argv;
                    parse_success = TRUE;
                } else {
                    g_strfreev(argv);
                }
                g_free(path);
            }
            g_variant_iter_free(iter);
        } else {
            OC_LOG_WARN(OPENCLAW_LOG_CAT_SYSTEMD, "Unexpected ExecStart GVariant signature: %s", type_string);
        }
        g_variant_unref(exec_start_v);
    }

    if (!parse_success) {
        // Required field failed, clean up any partial state
        if (working_dir_v) g_variant_unref(working_dir_v);
        if (env_v) g_variant_unref(env_v);
        if (env_files_v) g_variant_unref(env_files_v);
        return FALSE;
    }

    if (working_dir_v) {
        const gchar *raw_wd = g_variant_get_string(working_dir_v, NULL);
        if (raw_wd && raw_wd[0] != '\0') {
            const gchar *clean_wd = raw_wd;
            // Systemd uses prefixes like '!' and '-' to modify working directory behavior.
            // We conservatively strip these observed syntactic modifiers to get the real absolute path.
            while (*clean_wd == '!' || *clean_wd == '-') {
                clean_wd++;
            }
            
            if (clean_wd[0] == '/') {
                *working_directory_out = g_strdup(clean_wd);
            } else if (clean_wd[0] != '\0') {
                // Not an absolute path after stripping, invalid format
                parse_success = FALSE;
            }
        }
        g_variant_unref(working_dir_v);
    }

    if (!parse_success) {
        g_strfreev(*exec_start_argv_out);
        *exec_start_argv_out = NULL;
        if (env_v) g_variant_unref(env_v);
        if (env_files_v) g_variant_unref(env_files_v);
        return FALSE;
    }

    gchar **merged_env = g_new0(gchar*, 1);

    if (env_v) {
        const gchar **env_array = g_variant_get_strv(env_v, NULL);
        if (env_array) {
            for (gsize i = 0; env_array[i] != NULL; i++) {
                gchar *eq = strchr(env_array[i], '=');
                if (eq) {
                    g_autofree gchar *key = g_strndup(env_array[i], eq - env_array[i]);
                    merged_env = g_environ_setenv(merged_env, key, eq + 1, TRUE);
                }
            }
            g_free(env_array);
        }
        g_variant_unref(env_v);
    }

    if (env_files_v) {
        // Signature: a(sb) - array of (path, optional boolean)
        if (g_strcmp0(g_variant_get_type_string(env_files_v), "a(sb)") == 0) {
            GVariantIter *iter;
            g_variant_get(env_files_v, "a(sb)", &iter);
            gchar *path;
            gboolean optional;

            while (g_variant_iter_next(iter, "(sb)", &path, &optional)) {
                merged_env = systemd_parse_single_env_file(path, home_dir, NULL, optional, merged_env);
                g_free(path);
            }
            g_variant_iter_free(iter);
        }
        g_variant_unref(env_files_v);
    }

    if (g_strv_length(merged_env) > 0) {
        *environment_out = merged_env;
    } else {
        g_strfreev(merged_env);
    }

    return TRUE;
}
