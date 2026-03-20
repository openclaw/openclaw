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

static GDBusProxy *manager_proxy = NULL;
static GDBusProxy *unit_proxy = NULL;
static gchar *cached_exec_start = NULL;
static gchar **cached_environment = NULL;
static gchar *cached_unit_name = NULL;
static guint properties_changed_signal_id = 0;

static void fetch_unit_properties(void);
extern void systemd_refresh(void);

static gint sort_marked_units(gconstpointer a, gconstpointer b) {
    return g_strcmp0(*(const gchar **)a, *(const gchar **)b);
}

static const gchar* discover_canonical_unit_name(void) {
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
            if (strstr(contents, "OPENCLAW_SERVICE_MARKER=openclaw")) {
                g_ptr_array_add(marked_units, g_strdup(filename));
            }
            g_free(contents);
        }
    }
    g_dir_close(dir);

    if (marked_units->len == 1) {
        cached_unit_name = g_strdup(g_ptr_array_index(marked_units, 0));
    } else if (marked_units->len > 1) {
        gboolean found_default = FALSE;
        for (guint i = 0; i < marked_units->len; i++) {
            if (g_strcmp0((const gchar *)g_ptr_array_index(marked_units, i), "openclaw-gateway.service") == 0) {
                found_default = TRUE;
                break;
            }
        }
        if (found_default) {
            cached_unit_name = g_strdup("openclaw-gateway.service");
        } else {
            g_ptr_array_sort(marked_units, sort_marked_units);
            const gchar *selected = g_ptr_array_index(marked_units, 0);
            g_warning("Ambiguous OpenClaw systemd units found. Deterministically falling back to '%s'", selected);
            cached_unit_name = g_strdup(selected);
        }
    } else {
        cached_unit_name = g_strdup("openclaw-gateway.service");
    }

    g_ptr_array_free(marked_units, TRUE);
    return cached_unit_name;
}

static void extract_service_config_from_file(gchar **exec_start_out, gchar ***environment_out) {
    *exec_start_out = NULL;
    *environment_out = NULL;

    const gchar *home_dir = g_get_home_dir();
    if (!home_dir) return;

    const gchar *unit_name = discover_canonical_unit_name();
    g_autofree gchar *unit_path = g_build_filename(home_dir, ".config", "systemd", "user", unit_name, NULL);
    
    g_autofree gchar *contents = NULL;
    g_autoptr(GError) error = NULL;

    if (!g_file_get_contents(unit_path, &contents, NULL, &error)) {
        return;
    }

    gchar **lines = g_strsplit(contents, "\n", -1);
    gboolean in_service_section = FALSE;
    GPtrArray *env_array = g_ptr_array_new_with_free_func(g_free);
    gchar *exec_start = NULL;

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
            } else if (g_str_has_prefix(line, "Environment=")) {
                gchar *env_val = line + 12;
                gint argc = 0;
                gchar **argv = NULL;
                if (g_shell_parse_argv(env_val, &argc, &argv, NULL)) {
                    for (gint j = 0; j < argc; j++) {
                        g_ptr_array_add(env_array, g_strdup(argv[j]));
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
                                    gchar *merged = g_strdup_printf("%s=%s", g_strstrip(key), val);
                                    g_ptr_array_add(env_array, merged);
                                    g_free(key);
                                }
                            }
                            g_strfreev(env_lines);
                            g_free(file_contents);
                        } else if (!is_optional) {
                            g_warning("Failed to read EnvironmentFile: %s", env_file);
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
    
    if (env_array->len > 0) {
        g_ptr_array_add(env_array, NULL);
        *environment_out = (gchar **)g_ptr_array_free(env_array, FALSE);
    } else {
        g_ptr_array_free(env_array, TRUE);
        *environment_out = NULL;
    }
}

static void on_unit_properties_changed(GDBusProxy *proxy, GVariant *changed_properties, const gchar* const *invalidated_properties, gpointer user_data) {
    (void)proxy;
    (void)changed_properties;
    (void)invalidated_properties;
    (void)user_data;
    
    // We simply re-fetch the properties whenever they change
    fetch_unit_properties();
}

static void subscribe_to_unit(GDBusConnection *bus, const gchar *unit_path) {
    if (unit_proxy) {
        if (properties_changed_signal_id > 0) {
            g_signal_handler_disconnect(unit_proxy, properties_changed_signal_id);
            properties_changed_signal_id = 0;
        }
        g_object_unref(unit_proxy);
        unit_proxy = NULL;
    }

    g_autoptr(GError) error = NULL;
    unit_proxy = g_dbus_proxy_new_sync(
        bus, G_DBUS_PROXY_FLAGS_NONE, NULL,
        "org.freedesktop.systemd1",
        unit_path,
        "org.freedesktop.systemd1.Unit",
        NULL, &error);

    if (!unit_proxy) {
        g_warning("Failed to create Unit proxy: %s", error->message);
        return;
    }

    properties_changed_signal_id = g_signal_connect(unit_proxy, "g-properties-changed", G_CALLBACK(on_unit_properties_changed), NULL);
    
    fetch_unit_properties();
}

static void on_manager_signal(GDBusProxy *proxy, gchar *sender_name, gchar *signal_name, GVariant *parameters, gpointer user_data) {
    (void)proxy;
    (void)sender_name;
    (void)parameters;
    (void)user_data;

    // If unit files changed or a new unit appeared, re-evaluate our connection
    if (g_strcmp0(signal_name, "UnitNew") == 0 || g_strcmp0(signal_name, "UnitFilesChanged") == 0) {
        systemd_refresh(); 
    }
}

static void fetch_unit_properties(void) {
    if (!unit_proxy) return;

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

    if (cached_environment) {
        sys_state.environment = g_strdupv(cached_environment);
    }

    state_update_systemd(&sys_state);

    g_free(sys_state.active_state);
    g_free(sys_state.sub_state);
    g_strfreev(sys_state.exec_start_argv);
    g_strfreev(sys_state.environment);
}

void systemd_init(void) {
    g_autoptr(GError) error = NULL;
    g_autoptr(GDBusConnection) session_bus = g_bus_get_sync(G_BUS_TYPE_SESSION, NULL, &error);
    if (!session_bus) {
        g_warning("Failed to connect to session bus: %s", error->message);
        return;
    }

    manager_proxy = g_dbus_proxy_new_sync(
        session_bus, G_DBUS_PROXY_FLAGS_NONE, NULL,
        "org.freedesktop.systemd1",
        "/org/freedesktop/systemd1",
        "org.freedesktop.systemd1.Manager",
        NULL, &error);

    if (!manager_proxy) {
        g_warning("Failed to create systemd Manager proxy: %s", error->message);
        return;
    }
    
    g_signal_connect(manager_proxy, "g-signal", G_CALLBACK(on_manager_signal), NULL);
    
    // Systemd docs require us to call Subscribe before getting signals for non-running units
    g_dbus_proxy_call(manager_proxy, "Subscribe", NULL, G_DBUS_CALL_FLAGS_NONE, -1, NULL, NULL, NULL);

    extract_service_config_from_file(&cached_exec_start, &cached_environment);
}

static void on_get_unit_ready(GObject *source_object, GAsyncResult *res, gpointer user_data) {
    (void)user_data;
    g_autoptr(GError) error = NULL;
    g_autoptr(GVariant) result = g_dbus_proxy_call_finish(G_DBUS_PROXY(source_object), res, &error);

    // 3 (continued). Evaluate runtime state result
    if (!result) {
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

        if (cached_environment) {
            sys_state.environment = g_strdupv(cached_environment);
        }
        
        state_update_systemd(&sys_state);
        g_free(sys_state.active_state);
        g_free(sys_state.sub_state);
        g_strfreev(sys_state.exec_start_argv);
        g_strfreev(sys_state.environment);
        return;
    }

    // 3 (success). Extract unit path and subscribe to properties
    const gchar *unit_path = NULL;
    g_variant_get(result, "(&o)", &unit_path);

    if (unit_path) {
        subscribe_to_unit(g_dbus_proxy_get_connection(manager_proxy), unit_path);
    }
}

static void on_get_unit_file_state_ready(GObject *source_object, GAsyncResult *res, gpointer user_data) {
    (void)user_data;
    g_autoptr(GError) error = NULL;
    g_autoptr(GVariant) result = g_dbus_proxy_call_finish(G_DBUS_PROXY(source_object), res, &error);

    // 1. Refresh config unconditionally, so reconfigurations or deletions update the cache
    g_free(cached_exec_start);
    cached_exec_start = NULL;
    g_strfreev(cached_environment);
    cached_environment = NULL;
    extract_service_config_from_file(&cached_exec_start, &cached_environment);

    // 2. If GetUnitFileState fails, treat as not installed
    if (!result) {
        // Failed to get file state -> assume not installed
        SystemdState sys_state = {0};
        state_update_systemd(&sys_state);
        return;
    }

    // 3. Fetch runtime unit path asynchronously
    g_dbus_proxy_call(
        manager_proxy, "GetUnit",
        g_variant_new("(s)", discover_canonical_unit_name()),
        G_DBUS_CALL_FLAGS_NONE, -1, NULL,
        on_get_unit_ready, NULL);
}

void systemd_refresh(void) {
    if (!manager_proxy) return;

    g_free(cached_unit_name);
    cached_unit_name = NULL;
    const gchar *unit_name = discover_canonical_unit_name();

    // 1. Start async check if unit file exists/is installed at all
    g_dbus_proxy_call(
        manager_proxy, "GetUnitFileState",
        g_variant_new("(s)", unit_name),
        G_DBUS_CALL_FLAGS_NONE, -1, NULL,
        on_get_unit_file_state_ready, NULL);
}

void systemd_start_gateway(void) {
    if (!manager_proxy) return;
    g_dbus_proxy_call(
        manager_proxy, "StartUnit",
        g_variant_new("(ss)", discover_canonical_unit_name(), "replace"),
        G_DBUS_CALL_FLAGS_NONE, -1, NULL, NULL, NULL); 
}

void systemd_stop_gateway(void) {
    if (!manager_proxy) return;
    g_dbus_proxy_call(
        manager_proxy, "StopUnit",
        g_variant_new("(ss)", discover_canonical_unit_name(), "replace"),
        G_DBUS_CALL_FLAGS_NONE, -1, NULL, NULL, NULL);
}

void systemd_restart_gateway(void) {
    if (!manager_proxy) return;
    g_dbus_proxy_call(
        manager_proxy, "RestartUnit",
        g_variant_new("(ss)", discover_canonical_unit_name(), "replace"),
        G_DBUS_CALL_FLAGS_NONE, -1, NULL, NULL, NULL);
}
