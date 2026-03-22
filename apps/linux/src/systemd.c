/*
 * systemd.c
 *
 * Systemd D-Bus integration for the OpenClaw Linux Companion App.
 *
 * Handles connecting to the org.freedesktop.systemd1 D-Bus interface
 * to securely fetch the true `ActiveState` and `SubState` of the 
 * openclaw-gateway.service unit, explicitly checking file state first
 * to avoid false 'Not Installed' statuses for stopped services.
 * Extracts the `ExecStart` parameter from the user unit file to ensure
 * a deterministic path for CLI commands.
 * Now operates in an event-driven mode via signal subscriptions.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include <gio/gio.h>
#include <glib.h>
#include <glib/gstdio.h>
#include <string.h>
#include "state.h"
#include "log.h"

#include "systemd_helpers.h"

static GDBusProxy *manager_proxy = NULL;
static GDBusProxy *unit_proxy = NULL;
static gchar *cached_exec_start = NULL;
static gchar *cached_working_directory = NULL;
static gchar **cached_environment = NULL;
static gchar *cached_unit_name = NULL;
static guint properties_changed_signal_id = 0;

static void fetch_unit_properties(void);
extern void systemd_refresh(void);
static void clear_unit_subscription(const gchar *reason);

static gboolean check_system_scope_units(void) {
    const gchar *paths[] = {"/etc/systemd/system", "/usr/lib/systemd/system", "/lib/systemd/system"};
    for (size_t i = 0; i < G_N_ELEMENTS(paths); i++) {
        GDir *dir = g_dir_open(paths[i], 0, NULL);
        if (!dir) continue;
        const gchar *filename;
        while ((filename = g_dir_read_name(dir)) != NULL) {
            if (g_str_has_suffix(filename, ".service")) {
                g_autofree gchar *filepath = g_build_filename(paths[i], filename, NULL);
                gchar *contents = NULL;
                if (g_file_get_contents(filepath, &contents, NULL, NULL)) {
                    if (systemd_is_gateway_unit(filename, contents)) {
                        g_free(contents);
                        g_dir_close(dir);
                        return TRUE;
                    }
                    g_free(contents);
                }
            }
        }
        g_dir_close(dir);
    }
    return FALSE;
}

static gint sort_marked_units(gconstpointer a, gconstpointer b) {
    return g_strcmp0(*(const gchar **)a, *(const gchar **)b);
}

const gchar* systemd_get_canonical_unit_name(void) {
    if (cached_unit_name) return cached_unit_name;

    const gchar *home_dir = g_get_home_dir();
    if (!home_dir) {
        cached_unit_name = g_strdup("openclaw-gateway.service");
        return cached_unit_name;
    }

    g_autofree gchar *systemd_user_dir = g_build_filename(home_dir, ".config", "systemd", "user", NULL);
    
    GDir *dir = g_dir_open(systemd_user_dir, 0, NULL);
    if (!dir) {
        cached_unit_name = g_strdup("openclaw-gateway.service");
        return cached_unit_name;
    }

    const gchar *filename;
    GPtrArray *marked_units = g_ptr_array_new_with_free_func(g_free);

    while ((filename = g_dir_read_name(dir)) != NULL) {
        if (!g_str_has_suffix(filename, ".service")) continue;

        g_autofree gchar *filepath = g_build_filename(systemd_user_dir, filename, NULL);
        gchar *contents = NULL;
        if (g_file_get_contents(filepath, &contents, NULL, NULL)) {
            if (systemd_is_gateway_unit(filename, contents)) {
                g_ptr_array_add(marked_units, g_strdup(filename));
            }
            g_free(contents);
        }
    }
    g_dir_close(dir);

    if (marked_units->len == 1) {
        cached_unit_name = g_strdup(g_ptr_array_index(marked_units, 0));
    } else if (marked_units->len > 1) {
        /*
         * v1 multi-unit selection rule precedence:
         * 1. OPENCLAW_SYSTEMD_UNIT (explicit absolute unit name)
         * 2. OPENCLAW_PROFILE (derived as openclaw-gateway-<profile>.service)
         * 3. Prefer a candidate that is active.
         * 4. Otherwise, prefer a candidate that is enabled.
         * 5. Otherwise, deterministically select the first lexical candidate.
         */
        gchar *env_override = NULL;
        const gchar *raw_unit = g_getenv("OPENCLAW_SYSTEMD_UNIT");
        const gchar *raw_profile = g_getenv("OPENCLAW_PROFILE");
        
        env_override = systemd_normalize_unit_override(raw_unit);
        
        if (!env_override && raw_profile) {
            env_override = systemd_normalize_profile(raw_profile);
        }
        
        if (env_override) {
            for (guint i = 0; i < marked_units->len; i++) {
                if (g_strcmp0(env_override, (const gchar *)g_ptr_array_index(marked_units, i)) == 0) {
                    cached_unit_name = g_strdup(env_override);
                    g_free(env_override);
                    g_ptr_array_free(marked_units, TRUE);
                    return cached_unit_name;
                }
            }
            OC_LOG_WARN(OPENCLAW_LOG_CAT_SYSTEMD, "Environment requested unit '%s' but it was not discovered as a valid gateway; falling back to discovery.", env_override);
            g_free(env_override);
        }
        
        const gchar *best_candidate = NULL;
        gboolean best_is_active = FALSE;
        gboolean best_is_enabled = FALSE;
        
        // Sort lexically first so tie-breaking is deterministic
        g_ptr_array_sort(marked_units, sort_marked_units);
        
        for (guint i = 0; i < marked_units->len; i++) {
            const gchar *candidate = g_ptr_array_index(marked_units, i);
            gboolean active = FALSE, enabled = FALSE;
            
            // Inline get_unit_preference_score
            if (manager_proxy) {
                g_autoptr(GError) err1 = NULL;
                g_autoptr(GVariant) fs_res = g_dbus_proxy_call_sync(manager_proxy, "GetUnitFileState", 
                                                                    g_variant_new("(s)", candidate), 
                                                                    G_DBUS_CALL_FLAGS_NONE, -1, NULL, &err1);
                if (fs_res) {
                    const gchar *state_str = NULL;
                    g_variant_get(fs_res, "(&s)", &state_str);
                    if (g_strcmp0(state_str, "enabled") == 0) enabled = TRUE;
                }
                
                g_autoptr(GError) err2 = NULL;
                g_autoptr(GVariant) u_res = g_dbus_proxy_call_sync(manager_proxy, "GetUnit",
                                                                   g_variant_new("(s)", candidate),
                                                                   G_DBUS_CALL_FLAGS_NONE, -1, NULL, &err2);
                if (u_res) {
                    const gchar *path = NULL;
                    g_variant_get(u_res, "(&o)", &path);
                    if (path) {
                        g_autoptr(GDBusProxy) uproxy = g_dbus_proxy_new_sync(g_dbus_proxy_get_connection(manager_proxy), G_DBUS_PROXY_FLAGS_NONE, NULL, "org.freedesktop.systemd1", path, "org.freedesktop.systemd1.Unit", NULL, NULL);
                        if (uproxy) {
                            g_autoptr(GVariant) as_var = g_dbus_proxy_get_cached_property(uproxy, "ActiveState");
                            if (as_var) {
                                if (g_strcmp0(g_variant_get_string(as_var, NULL), "active") == 0) active = TRUE;
                            }
                        }
                    }
                }
            }
            
            if (!best_candidate) {
                best_candidate = candidate;
                best_is_active = active;
                best_is_enabled = enabled;
            } else if (active && !best_is_active) {
                best_candidate = candidate;
                best_is_active = active;
                best_is_enabled = enabled;
            } else if (!best_is_active && enabled && !best_is_enabled) {
                best_candidate = candidate;
                best_is_active = active;
                best_is_enabled = enabled;
            }
        }
        
        if (!best_is_active && !best_is_enabled) {
            OC_LOG_WARN(OPENCLAW_LOG_CAT_SYSTEMD, "Multiple OpenClaw systemd units found but none are active or enabled. "
                      "Deterministically selecting '%s' via lexical fallback.", best_candidate);
        }
        
        cached_unit_name = g_strdup(best_candidate);
    } else {
        cached_unit_name = g_strdup("openclaw-gateway.service");
    }

    g_ptr_array_free(marked_units, TRUE);
    return cached_unit_name;
}

static void extract_service_config_from_file(gchar **exec_start_out, gchar ***environment_out, gchar **working_directory_out) {
    *exec_start_out = NULL;
    *environment_out = NULL;
    *working_directory_out = NULL;

    const gchar *home_dir = g_get_home_dir();
    if (!home_dir) return;

    g_autofree gchar *unit_path = g_build_filename(home_dir, ".config", "systemd", "user", systemd_get_canonical_unit_name(), NULL);
    
    g_autofree gchar *contents = NULL;
    g_autoptr(GError) error = NULL;

    if (!g_file_get_contents(unit_path, &contents, NULL, &error)) {
        return;
    }

    gchar **lines = g_strsplit(contents, "\n", -1);
    gboolean in_service_section = FALSE;
    gchar *exec_start = NULL;
    gchar *working_directory = NULL;
    gchar **inline_env = g_new0(gchar*, 1);
    gchar **file_env = g_new0(gchar*, 1);

    for (gint i = 0; lines[i] != NULL; i++) {
        gchar *line = g_strstrip(lines[i]);
        if (line[0] == '#' || line[0] == ';') continue;
        
        if (g_str_has_prefix(line, "[")) {
            if (g_strcmp0(line, "[Service]") == 0) {
                in_service_section = TRUE;
            } else {
                in_service_section = FALSE;
            }
            continue;
        }

        if (in_service_section) {
            if (g_str_has_prefix(line, "ExecStart=")) {
                g_free(exec_start);
                exec_start = g_strdup(line + 10);
            } else if (g_str_has_prefix(line, "WorkingDirectory=")) {
                g_free(working_directory);
                gchar *wd_raw = g_strstrip(g_strdup(line + 17));
                gsize len = strlen(wd_raw);
                // Unquote WorkingDirectory= to respect actual filesystem paths that contain spaces
                if (len >= 2 && ((wd_raw[0] == '"' && wd_raw[len-1] == '"') || 
                                 (wd_raw[0] == '\'' && wd_raw[len-1] == '\''))) {
                    wd_raw[len-1] = '\0';
                    working_directory = g_strdup(wd_raw + 1);
                    g_free(wd_raw);
                } else {
                    working_directory = wd_raw;
                }
            } else if (g_str_has_prefix(line, "Environment=")) {
                gchar *env_val = line + 12;
                gint argc = 0;
                gchar **argv = NULL;
                if (g_shell_parse_argv(env_val, &argc, &argv, NULL)) {
                    for (gint j = 0; j < argc; j++) {
                        gchar *eq = strchr(argv[j], '=');
                        if (eq) {
                            *eq = '\0';
                            inline_env = g_environ_setenv(inline_env, argv[j], eq + 1, TRUE);
                        }
                    }
                    g_strfreev(argv);
                }
            } else if (g_str_has_prefix(line, "EnvironmentFile=")) {
                gchar *env_val = line + 16;
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
                        
                        gchar *expanded_h = NULL;
                        if (strstr(env_file, "%h")) {
                            gchar **parts = g_strsplit(env_file, "%h", -1);
                            expanded_h = g_strjoinv(home_dir, parts);
                            g_strfreev(parts);
                            env_file = expanded_h;
                        }
                        
                        gchar *resolved_path = NULL;
                        if (!g_path_is_absolute(env_file)) {
                            gchar *systemd_user_dir = g_build_filename(home_dir, ".config", "systemd", "user", NULL);
                            resolved_path = g_build_filename(systemd_user_dir, env_file, NULL);
                            g_free(systemd_user_dir);
                            env_file = resolved_path;
                        }
                        
                        gchar *file_contents = NULL;
                        if (g_file_get_contents(env_file, &file_contents, NULL, NULL)) {
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
                            OC_LOG_WARN(OPENCLAW_LOG_CAT_SYSTEMD, "Failed to read EnvironmentFile: %s", env_file);
                        }
                        
                        g_free(expanded_h);
                        g_free(resolved_path);
                    }
                    g_strfreev(argv);
                }
            }
        }
    }

    g_strfreev(lines);

    *exec_start_out = exec_start;
    *working_directory_out = working_directory;
    
    // Merge: file_env overrides inline_env
    gchar **merged_env = inline_env;
    for (gint i = 0; file_env && file_env[i]; i++) {
        gchar *eq = strchr(file_env[i], '=');
        if (eq) {
            *eq = '\0';
            merged_env = g_environ_setenv(merged_env, file_env[i], eq + 1, TRUE);
            *eq = '=';
        }
    }
    
    g_strfreev(file_env);
    
    if (g_strv_length(merged_env) > 0) {
        *environment_out = merged_env;
    } else {
        g_strfreev(merged_env);
        *environment_out = NULL;
    }
}

static void clear_unit_subscription(const gchar *reason) {
    OC_LOG_DEBUG(OPENCLAW_LOG_CAT_SYSTEMD, "clear-start reason=%s proxy=%p signal_id=%u unit=%s",
              reason, (void *)unit_proxy, properties_changed_signal_id,
              systemd_get_canonical_unit_name());

    if (unit_proxy && properties_changed_signal_id > 0) {
        g_signal_handler_disconnect(unit_proxy, properties_changed_signal_id);
    }
    properties_changed_signal_id = 0;

    if (unit_proxy) {
        g_object_unref(unit_proxy);
        unit_proxy = NULL;
    }

    OC_LOG_DEBUG(OPENCLAW_LOG_CAT_SYSTEMD, "clear-done reason=%s proxy=%p signal_id=%u", reason, (void *)unit_proxy, properties_changed_signal_id);
}

static void on_unit_properties_changed(GDBusProxy *proxy, GVariant *changed_properties, const gchar* const *invalidated_properties, gpointer user_data) {
    (void)changed_properties;
    (void)invalidated_properties;
    (void)user_data;
    
    OC_LOG_TRACE(OPENCLAW_LOG_CAT_SYSTEMD, "on_unit_properties_changed entry proxy=%p signal_id=%u", (void *)proxy, properties_changed_signal_id);

    // We simply re-fetch the properties whenever they change
    fetch_unit_properties();
}

static void subscribe_to_unit(GDBusConnection *bus, const gchar *unit_path) {
    GDBusProxy *old_proxy = unit_proxy;
    OC_LOG_DEBUG(OPENCLAW_LOG_CAT_SYSTEMD, "subscribe-enter old_proxy=%p unit_path=%s", (void *)old_proxy, unit_path);

    clear_unit_subscription("re-subscribe");

    g_autoptr(GError) error = NULL;
    unit_proxy = g_dbus_proxy_new_sync(
        bus, G_DBUS_PROXY_FLAGS_NONE, NULL,
        "org.freedesktop.systemd1",
        unit_path,
        "org.freedesktop.systemd1.Unit",
        NULL, &error);

    if (!unit_proxy) {
        OC_LOG_WARN(OPENCLAW_LOG_CAT_SYSTEMD, "Failed to create Unit proxy: %s", error->message);
        OC_LOG_DEBUG(OPENCLAW_LOG_CAT_SYSTEMD, "subscribe-failed unit_path=%s error=%s",
                  unit_path, error->message);
        return;
    }

    properties_changed_signal_id = g_signal_connect(unit_proxy, "g-properties-changed", G_CALLBACK(on_unit_properties_changed), NULL);

    OC_LOG_DEBUG(OPENCLAW_LOG_CAT_SYSTEMD, "subscribe-acquired new_proxy=%p signal_id=%u unit_path=%s", (void *)unit_proxy, properties_changed_signal_id, unit_path);
    
    fetch_unit_properties();

    OC_LOG_DEBUG(OPENCLAW_LOG_CAT_SYSTEMD, "subscribe-exit owned_proxy=%p unit_path=%s", (void *)unit_proxy, unit_path);
}

static void on_manager_signal(GDBusProxy *proxy, gchar *sender_name, gchar *signal_name, GVariant *parameters, gpointer user_data) {
    (void)proxy;
    (void)sender_name;
    (void)parameters;
    (void)user_data;

    // If unit files changed or a new unit appeared, re-evaluate our connection
    if (g_strcmp0(signal_name, "UnitNew") == 0 || g_strcmp0(signal_name, "UnitFilesChanged") == 0) {
        OC_LOG_DEBUG(OPENCLAW_LOG_CAT_SYSTEMD, "on_manager_signal signal=%s unit=%s proxy=%p",
                  signal_name, systemd_get_canonical_unit_name(), (void *)unit_proxy);
        systemd_refresh(); 
    }
}

static void fetch_unit_properties(void) {
    OC_LOG_TRACE(OPENCLAW_LOG_CAT_SYSTEMD, "fetch_unit_properties entry proxy=%p signal_id=%u", (void *)unit_proxy, properties_changed_signal_id);

    if (!unit_proxy) {
        OC_LOG_TRACE(OPENCLAW_LOG_CAT_SYSTEMD, "fetch_unit_properties skip proxy=%p", (void *)unit_proxy);
        return;
    }

    g_autoptr(GVariant) active_state_v = g_dbus_proxy_get_cached_property(unit_proxy, "ActiveState");
    g_autoptr(GVariant) sub_state_v = g_dbus_proxy_get_cached_property(unit_proxy, "SubState");

    SystemdState sys_state = {0};
    sys_state.installed = TRUE;

    if (active_state_v) {
        const gchar *as = g_variant_get_string(active_state_v, NULL);
        sys_state.active_state = g_strdup(as);
        
        sys_state.active = (g_strcmp0(as, "active") == 0);
        sys_state.activating = (g_strcmp0(as, "activating") == 0);
        sys_state.deactivating = (g_strcmp0(as, "deactivating") == 0);
        sys_state.failed = (g_strcmp0(as, "failed") == 0);
    }

    if (sub_state_v) {
        const gchar *ss = g_variant_get_string(sub_state_v, NULL);
        sys_state.sub_state = g_strdup(ss);
    }

    if (cached_exec_start) {
        gint argcp;
        gchar **argvp = NULL;
        if (g_shell_parse_argv(cached_exec_start, &argcp, &argvp, NULL)) {
            sys_state.exec_start_argv = argvp;
        }
    }

    if (cached_working_directory) {
        sys_state.working_directory = g_strdup(cached_working_directory);
    }

    if (cached_environment) {
        sys_state.environment = g_strdupv(cached_environment);
    }
    
    sys_state.unit_name = g_strdup(systemd_get_canonical_unit_name());

    state_update_systemd(&sys_state);

    OC_LOG_TRACE(OPENCLAW_LOG_CAT_SYSTEMD, "fetch_unit_properties exit active_state=%s sub_state=%s proxy=%p",
              sys_state.active_state ? sys_state.active_state : "(null)",
              sys_state.sub_state ? sys_state.sub_state : "(null)",
              (void *)unit_proxy);

    g_free(sys_state.unit_name);
    g_free(sys_state.working_directory);
    g_free(sys_state.active_state);
    g_free(sys_state.sub_state);
    g_strfreev(sys_state.exec_start_argv);
    g_strfreev(sys_state.environment);
}

void systemd_init(void) {
    g_autoptr(GError) error = NULL;
    g_autoptr(GDBusConnection) session_bus = g_bus_get_sync(G_BUS_TYPE_SESSION, NULL, &error);
    if (!session_bus) {
        OC_LOG_WARN(OPENCLAW_LOG_CAT_SYSTEMD, "Failed to connect to session bus: %s", error->message);
        SystemdState sys_state = {0};
        sys_state.systemd_unavailable = TRUE;
        state_update_systemd(&sys_state);
        return;
    }

    manager_proxy = g_dbus_proxy_new_sync(
        session_bus, G_DBUS_PROXY_FLAGS_NONE, NULL,
        "org.freedesktop.systemd1",
        "/org/freedesktop/systemd1",
        "org.freedesktop.systemd1.Manager",
        NULL, &error);

    if (!manager_proxy) {
        OC_LOG_WARN(OPENCLAW_LOG_CAT_SYSTEMD, "Failed to create systemd Manager proxy: %s", error->message);
        SystemdState sys_state = {0};
        sys_state.systemd_unavailable = TRUE;
        state_update_systemd(&sys_state);
        return;
    }
    
    g_signal_connect(manager_proxy, "g-signal", G_CALLBACK(on_manager_signal), NULL);
    
    // Systemd docs require us to call Subscribe before getting signals for non-running units
    g_dbus_proxy_call(manager_proxy, "Subscribe", NULL, G_DBUS_CALL_FLAGS_NONE, -1, NULL, NULL, NULL);

    extract_service_config_from_file(&cached_exec_start, &cached_environment, &cached_working_directory);
}

static void on_get_unit_ready(GObject *source_object, GAsyncResult *res, gpointer user_data) {
    gchar *requested_unit_name = (gchar *)user_data;
    g_autoptr(GError) error = NULL;
    g_autoptr(GVariant) result = g_dbus_proxy_call_finish(G_DBUS_PROXY(source_object), res, &error);

    OC_LOG_DEBUG(OPENCLAW_LOG_CAT_SYSTEMD, "on_get_unit_ready entry requested=%s current=%s proxy=%p",
              requested_unit_name ? requested_unit_name : "(null)",
              systemd_get_canonical_unit_name(),
              (void *)unit_proxy);

    // If the canonical unit has changed since we requested this unit, discard the stale reply
    if (requested_unit_name) {
        if (g_strcmp0(requested_unit_name, systemd_get_canonical_unit_name()) != 0) {
            OC_LOG_DEBUG(OPENCLAW_LOG_CAT_SYSTEMD, "on_get_unit_ready stale-discard requested=%s current=%s",
                      requested_unit_name, systemd_get_canonical_unit_name());
            g_free(requested_unit_name);
            return;
        }
        g_free(requested_unit_name);
    }

    // 3 (continued). Evaluate runtime state result
    if (!result) {
        OC_LOG_DEBUG(OPENCLAW_LOG_CAT_SYSTEMD, "on_get_unit_ready !result proxy=%p error=%s",
                  (void *)unit_proxy, error ? error->message : "(null)");
        // Drop the previous unit subscription when retargeting to an unloaded unit
        clear_unit_subscription("unit-unloaded");

        // Unit is installed but completely stopped/inactive/unloaded
        SystemdState sys_state = {0};
        sys_state.installed = TRUE;
        sys_state.active_state = g_strdup("inactive");
        sys_state.sub_state = g_strdup("dead");
        
        // Try to parse argv from the cached ExecStart string
        if (cached_exec_start) {
            gint argcp;
            gchar **argvp = NULL;
            if (g_shell_parse_argv(cached_exec_start, &argcp, &argvp, NULL)) {
                sys_state.exec_start_argv = argvp;
            }
        }

        if (cached_working_directory) {
            sys_state.working_directory = g_strdup(cached_working_directory);
        }

        if (cached_environment) {
            sys_state.environment = g_strdupv(cached_environment);
        }
        
        sys_state.unit_name = g_strdup(systemd_get_canonical_unit_name());
        
        state_update_systemd(&sys_state);
        g_free(sys_state.unit_name);
        g_free(sys_state.working_directory);
        g_free(sys_state.active_state);
        g_free(sys_state.sub_state);
        g_strfreev(sys_state.exec_start_argv);
        g_strfreev(sys_state.environment);
        return;
    }

    // 3 (success). Extract unit path and subscribe to properties
    const gchar *unit_path = NULL;
    g_variant_get(result, "(&o)", &unit_path);

    OC_LOG_DEBUG(OPENCLAW_LOG_CAT_SYSTEMD, "on_get_unit_ready success unit_path=%s proxy=%p",
              unit_path ? unit_path : "(null)", (void *)unit_proxy);

    if (unit_path) {
        subscribe_to_unit(g_dbus_proxy_get_connection(manager_proxy), unit_path);
    }
}

static void on_get_unit_file_state_ready(GObject *source_object, GAsyncResult *res, gpointer user_data) {
    gchar *requested_unit_name = (gchar *)user_data;
    g_autoptr(GError) error = NULL;
    g_autoptr(GVariant) result = g_dbus_proxy_call_finish(G_DBUS_PROXY(source_object), res, &error);

    OC_LOG_DEBUG(OPENCLAW_LOG_CAT_SYSTEMD, "on_get_unit_file_state_ready entry requested=%s current=%s proxy=%p",
              requested_unit_name ? requested_unit_name : "(null)",
              systemd_get_canonical_unit_name(),
              (void *)unit_proxy);

    // If the canonical unit has changed since we requested this unit, discard the stale reply
    if (requested_unit_name) {
        if (g_strcmp0(requested_unit_name, systemd_get_canonical_unit_name()) != 0) {
            OC_LOG_DEBUG(OPENCLAW_LOG_CAT_SYSTEMD, "on_get_unit_file_state_ready stale-discard requested=%s current=%s",
                      requested_unit_name, systemd_get_canonical_unit_name());
            g_free(requested_unit_name);
            return;
        }
        g_free(requested_unit_name);
    }

    // 1. Refresh config unconditionally, so reconfigurations or deletions update the cache
    g_free(cached_exec_start);
    cached_exec_start = NULL;
    g_free(cached_working_directory);
    cached_working_directory = NULL;
    g_strfreev(cached_environment);
    cached_environment = NULL;
    extract_service_config_from_file(&cached_exec_start, &cached_environment, &cached_working_directory);

    gboolean is_installed = FALSE;
    if (result) {
        const gchar *state_str = NULL;
        g_variant_get(result, "(&s)", &state_str);
        if (g_strcmp0(state_str, "not-found") != 0) {
            is_installed = TRUE;
        }
    }

    // 2. If GetUnitFileState fails or state is "not-found", treat as not installed
    if (!is_installed) {
        OC_LOG_DEBUG(OPENCLAW_LOG_CAT_SYSTEMD, "on_get_unit_file_state_ready !is_installed proxy=%p",
                  (void *)unit_proxy);
        // Drop the previous unit subscription if the selected unit is no longer installed
        clear_unit_subscription("unit-not-installed");

        // Failed to get file state or unit not found -> assume not installed
        SystemdState sys_state = {0};
        if (check_system_scope_units()) {
            sys_state.system_installed_unsupported = TRUE;
        }
        sys_state.unit_name = g_strdup(systemd_get_canonical_unit_name());
        state_update_systemd(&sys_state);
        g_free(sys_state.unit_name);
        return;
    }

    OC_LOG_DEBUG(OPENCLAW_LOG_CAT_SYSTEMD, "on_get_unit_file_state_ready is_installed proxy=%p",
              (void *)unit_proxy);

    // 3. Fetch runtime unit path asynchronously
    const gchar *current_unit = systemd_get_canonical_unit_name();
    g_dbus_proxy_call(
        manager_proxy, "GetUnit",
        g_variant_new("(s)", current_unit),
        G_DBUS_CALL_FLAGS_NONE, -1, NULL,
        on_get_unit_ready, g_strdup(current_unit));
}

void systemd_refresh(void) {
    if (!manager_proxy) return;

    g_free(cached_unit_name);
    cached_unit_name = NULL;

    const gchar *unit_name = systemd_get_canonical_unit_name();
    OC_LOG_TRACE(OPENCLAW_LOG_CAT_SYSTEMD, "systemd_refresh entry proxy=%p signal_id=%u unit=%s",
              (void *)unit_proxy, properties_changed_signal_id, unit_name ? unit_name : "(null)");

    if (!unit_name) return;

    // 1. Start async check if unit file exists/is installed at all
    g_dbus_proxy_call(
        manager_proxy, "GetUnitFileState",
        g_variant_new("(s)", unit_name),
        G_DBUS_CALL_FLAGS_NONE, -1, NULL,
        on_get_unit_file_state_ready, g_strdup(unit_name));
}

static void on_manager_unit_action_finished(GObject *source_object, GAsyncResult *res, gpointer user_data) {
    const gchar *method = (const gchar *)user_data;
    g_autoptr(GError) error = NULL;
    g_autoptr(GVariant) result = g_dbus_proxy_call_finish(G_DBUS_PROXY(source_object), res, &error);

    if (result) {
        const gchar *job_path = NULL;
        g_variant_get(result, "(&o)", &job_path);
        OC_LOG_INFO(OPENCLAW_LOG_CAT_SYSTEMD, "on_manager_unit_action_finished success method=%s job=%s manager=%p unit=%s",
                  method, job_path ? job_path : "(null)",
                  (void *)manager_proxy, systemd_get_canonical_unit_name());
    } else {
        OC_LOG_WARN(OPENCLAW_LOG_CAT_SYSTEMD, "on_manager_unit_action_finished error method=%s manager=%p unit=%s error=%s",
                  method, (void *)manager_proxy, systemd_get_canonical_unit_name(), error ? error->message : "(null)");
    }
}

void systemd_start_gateway(void) {
    if (!manager_proxy) return;
    OC_LOG_DEBUG(OPENCLAW_LOG_CAT_SYSTEMD, "systemd_start_gateway pre-call manager=%p unit=%s",
              (void *)manager_proxy, systemd_get_canonical_unit_name());
    g_dbus_proxy_call(
        manager_proxy, "StartUnit",
        g_variant_new("(ss)", systemd_get_canonical_unit_name(), "replace"),
        G_DBUS_CALL_FLAGS_NONE, -1, NULL,
        on_manager_unit_action_finished, (gpointer)"StartUnit");
}

void systemd_stop_gateway(void) {
    if (!manager_proxy) return;
    OC_LOG_DEBUG(OPENCLAW_LOG_CAT_SYSTEMD, "systemd_stop_gateway pre-call manager=%p unit=%s",
              (void *)manager_proxy, systemd_get_canonical_unit_name());
    g_dbus_proxy_call(
        manager_proxy, "StopUnit",
        g_variant_new("(ss)", systemd_get_canonical_unit_name(), "replace"),
        G_DBUS_CALL_FLAGS_NONE, -1, NULL,
        on_manager_unit_action_finished, (gpointer)"StopUnit");
}

void systemd_restart_gateway(void) {
    if (!manager_proxy) return;
    OC_LOG_DEBUG(OPENCLAW_LOG_CAT_SYSTEMD, "systemd_restart_gateway pre-call manager=%p unit=%s",
              (void *)manager_proxy, systemd_get_canonical_unit_name());
    g_dbus_proxy_call(
        manager_proxy, "RestartUnit",
        g_variant_new("(ss)", systemd_get_canonical_unit_name(), "replace"),
        G_DBUS_CALL_FLAGS_NONE, -1, NULL,
        on_manager_unit_action_finished, (gpointer)"RestartUnit");
}
