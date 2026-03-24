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
static gchar **cached_exec_start_argv = NULL;
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

static GPtrArray* systemd_get_user_unit_paths(const gchar *home_dir) {
    GPtrArray *paths = g_ptr_array_new_with_free_func(g_free);
    if (home_dir) {
        g_ptr_array_add(paths, g_build_filename(home_dir, ".config", "systemd", "user", NULL));
        g_ptr_array_add(paths, g_build_filename(home_dir, ".local", "share", "systemd", "user", NULL));
    }
    g_ptr_array_add(paths, g_strdup("/etc/systemd/user"));
    g_ptr_array_add(paths, g_strdup("/usr/lib/systemd/user"));
    g_ptr_array_add(paths, g_strdup("/lib/systemd/user"));
    return paths;
}

const gchar* systemd_get_canonical_unit_name(void) {
    if (cached_unit_name) return cached_unit_name;

    const gchar *home_dir = g_get_home_dir();

    GPtrArray *marked_units = g_ptr_array_new_with_free_func(g_free);
    GPtrArray *paths = systemd_get_user_unit_paths(home_dir);

    for (guint i = 0; i < paths->len; i++) {
        const gchar *path = g_ptr_array_index(paths, i);
        GDir *dir = g_dir_open(path, 0, NULL);
        if (!dir) continue;

        const gchar *filename;
        while ((filename = g_dir_read_name(dir)) != NULL) {
            if (!g_str_has_suffix(filename, ".service")) continue;

            g_autofree gchar *filepath = g_build_filename(path, filename, NULL);
            gchar *contents = NULL;
            if (g_file_get_contents(filepath, &contents, NULL, NULL)) {
                if (systemd_is_gateway_unit(filename, contents)) {
                    gboolean already_added = FALSE;
                    for (guint j = 0; j < marked_units->len; j++) {
                        if (g_strcmp0(filename, g_ptr_array_index(marked_units, j)) == 0) {
                            already_added = TRUE;
                            break;
                        }
                    }
                    if (!already_added) {
                        g_ptr_array_add(marked_units, g_strdup(filename));
                    }
                }
                g_free(contents);
            }
        }
        g_dir_close(dir);
    }
    g_ptr_array_free(paths, TRUE);

    gchar *env_override = NULL;
    const gchar *raw_unit = g_getenv("OPENCLAW_SYSTEMD_UNIT");
    const gchar *raw_profile = g_getenv("OPENCLAW_PROFILE");
    
    env_override = systemd_normalize_unit_override(raw_unit);
    
    if (!env_override && raw_profile) {
        env_override = systemd_normalize_profile(raw_profile);
    }
    
    if (env_override) {
        gboolean found = FALSE;
        for (guint i = 0; i < marked_units->len; i++) {
            if (g_strcmp0(env_override, (const gchar *)g_ptr_array_index(marked_units, i)) == 0) {
                found = TRUE;
                break;
            }
        }
        if (!found) {
            OC_LOG_WARN(OPENCLAW_LOG_CAT_SYSTEMD, "Environment requested unit '%s' but it was not discovered as a valid gateway.", env_override);
        }
        cached_unit_name = env_override;
        g_ptr_array_free(marked_units, TRUE);
        return cached_unit_name;
    }

    if (marked_units->len >= 1) {
        g_ptr_array_sort(marked_units, sort_marked_units);
        cached_unit_name = g_strdup(g_ptr_array_index(marked_units, 0));
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
    const gchar *unit_name = systemd_get_canonical_unit_name();
    
    g_autofree gchar *contents = NULL;
    g_autoptr(GError) error = NULL;
    gchar *unit_path = NULL;

    GPtrArray *paths = systemd_get_user_unit_paths(home_dir);
    for (guint i = 0; i < paths->len; i++) {
        gchar *test_path = g_build_filename(g_ptr_array_index(paths, i), unit_name, NULL);
        if (g_file_get_contents(test_path, &contents, NULL, &error)) {
            unit_path = test_path;
            break;
        }
        g_free(test_path);
        g_clear_error(&error);
    }
    g_ptr_array_free(paths, TRUE);

    if (!unit_path) {
        return;
    }
    
    gchar *unit_dir = g_path_get_dirname(unit_path);
    g_free(unit_path);

    gchar **lines = g_strsplit(contents, "\n", -1);
    gboolean in_service_section = FALSE;
    gchar *exec_start = NULL;
    gchar *working_directory = NULL;
    gchar **merged_env = g_new0(gchar*, 1);

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
                            merged_env = g_environ_setenv(merged_env, argv[j], eq + 1, TRUE);
                        }
                    }
                    g_strfreev(argv);
                }
            } else if (g_str_has_prefix(line, "EnvironmentFile=")) {
                gchar *env_val = line + 16;
                merged_env = systemd_parse_environment_file(env_val, home_dir, unit_dir, merged_env);
            }
        }
    }

    g_strfreev(lines);
    g_free(unit_dir);

    *exec_start_out = exec_start;
    *working_directory_out = working_directory;
    
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
    (void)user_data;

    // If unit files changed, re-evaluate our connection unconditionally
    if (g_strcmp0(signal_name, "UnitFilesChanged") == 0) {
        OC_LOG_DEBUG(OPENCLAW_LOG_CAT_SYSTEMD, "on_manager_signal signal=%s unit=%s proxy=%p",
                  signal_name, systemd_get_canonical_unit_name(), (void *)unit_proxy);
        systemd_refresh(); 
        return;
    }

    if (g_strcmp0(signal_name, "UnitNew") == 0 && parameters) {
        const gchar *unit_name = NULL;
        g_variant_get(parameters, "(&so)", &unit_name, NULL);
        if (unit_name) {
            const gchar *canonical = systemd_get_canonical_unit_name();
            if ((canonical && g_strcmp0(unit_name, canonical) == 0) || systemd_is_gateway_unit_name(unit_name)) {
                OC_LOG_DEBUG(OPENCLAW_LOG_CAT_SYSTEMD, "on_manager_signal signal=%s unit=%s proxy=%p",
                          signal_name, unit_name, (void *)unit_proxy);
                systemd_refresh();
            }
        }
    } else if (g_strcmp0(signal_name, "JobRemoved") == 0 && parameters) {
        guint32 job_id = 0;
        const gchar *job_path = NULL;
        const gchar *unit_name = NULL;
        const gchar *result = NULL;
        g_variant_get(parameters, "(u&o&s&s)", &job_id, &job_path, &unit_name, &result);
        if (unit_name) {
            const gchar *canonical = systemd_get_canonical_unit_name();
            if ((canonical && g_strcmp0(unit_name, canonical) == 0) || systemd_is_gateway_unit_name(unit_name)) {
                OC_LOG_DEBUG(OPENCLAW_LOG_CAT_SYSTEMD, "on_manager_signal signal=%s unit=%s result=%s proxy=%p",
                          signal_name, unit_name, result, (void *)unit_proxy);
                systemd_refresh();
            }
        }
    }
}

static void publish_systemd_state_with_cached_config(const gchar *active_state, const gchar *sub_state) {
    SystemdState sys_state = {0};
    sys_state.installed = TRUE;
    sys_state.unit_name = g_strdup(systemd_get_canonical_unit_name());

    if (active_state) {
        sys_state.active_state = g_strdup(active_state);
        sys_state.active = (g_strcmp0(active_state, "active") == 0);
        sys_state.activating = (g_strcmp0(active_state, "activating") == 0);
        sys_state.deactivating = (g_strcmp0(active_state, "deactivating") == 0);
        sys_state.failed = (g_strcmp0(active_state, "failed") == 0);
    }
    if (sub_state) {
        sys_state.sub_state = g_strdup(sub_state);
    }
    if (cached_exec_start_argv) {
        sys_state.exec_start_argv = g_strdupv(cached_exec_start_argv);
    }
    if (cached_working_directory) {
        sys_state.working_directory = g_strdup(cached_working_directory);
    }
    if (cached_environment) {
        sys_state.environment = g_strdupv(cached_environment);
    }

    state_update_systemd(&sys_state);

    g_free(sys_state.unit_name);
    g_free(sys_state.working_directory);
    g_free(sys_state.active_state);
    g_free(sys_state.sub_state);
    g_strfreev(sys_state.exec_start_argv);
    g_strfreev(sys_state.environment);
}

typedef struct {
    gchar *unit_name;
    gchar *unit_object_path;
} ServiceConfigContext;

static void service_config_context_free(ServiceConfigContext *ctx) {
    if (!ctx) return;
    g_free(ctx->unit_name);
    g_free(ctx->unit_object_path);
    g_free(ctx);
}

static gboolean service_config_context_is_current(const ServiceConfigContext *ctx) {
    if (!ctx) return FALSE;
    // Unit name must still match the canonical name
    if (g_strcmp0(ctx->unit_name, systemd_get_canonical_unit_name()) != 0)
        return FALSE;
    // The unit proxy must still exist and point to the same object path
    if (!unit_proxy) return FALSE;
    const gchar *current_path = g_dbus_proxy_get_object_path(unit_proxy);
    if (g_strcmp0(ctx->unit_object_path, current_path) != 0)
        return FALSE;
    return TRUE;
}

static void on_get_service_properties_ready(GObject *source_object, GAsyncResult *res, gpointer user_data) {
    ServiceConfigContext *ctx = (ServiceConfigContext *)user_data;
    g_autoptr(GError) error = NULL;
    g_autoptr(GVariant) result = g_dbus_connection_call_finish(G_DBUS_CONNECTION(source_object), res, &error);

    // Discard stale reply if the subscription/proxy has changed since we fired
    if (!service_config_context_is_current(ctx)) {
        OC_LOG_DEBUG(OPENCLAW_LOG_CAT_SYSTEMD,
                  "on_get_service_properties_ready stale-discard requested_name=%s requested_path=%s current_name=%s proxy=%p",
                  ctx ? ctx->unit_name : "(null)",
                  ctx ? ctx->unit_object_path : "(null)",
                  systemd_get_canonical_unit_name(),
                  (void *)unit_proxy);
        service_config_context_free(ctx);
        return;
    }
    service_config_context_free(ctx);

    gboolean config_loaded = FALSE;
    if (result) {
        // GetAll returns (a{sv})
        GVariant *props = g_variant_get_child_value(result, 0);
        if (props) {
            gchar **new_exec_argv = NULL;
            gchar *new_working_dir = NULL;
            gchar **new_env = NULL;

            if (systemd_parse_service_properties(props, g_get_home_dir(), &new_exec_argv, &new_working_dir, &new_env)) {
                g_strfreev(cached_exec_start_argv);
                cached_exec_start_argv = new_exec_argv;
                
                g_free(cached_working_directory);
                cached_working_directory = new_working_dir;
                
                g_strfreev(cached_environment);
                cached_environment = new_env;
                
                config_loaded = TRUE;
            } else {
                g_strfreev(new_exec_argv);
                g_free(new_working_dir);
                g_strfreev(new_env);
            }
            g_variant_unref(props);
        }
    }

    if (!config_loaded) {
        OC_LOG_DEBUG(OPENCLAW_LOG_CAT_SYSTEMD, "on_get_service_properties_ready D-Bus Service props unavailable, falling back to file parse");
        gchar *fallback_exec = NULL;
        extract_service_config_from_file(&fallback_exec, &cached_environment, &cached_working_directory);
        if (fallback_exec) {
            gint argcp;
            gchar **argvp = NULL;
            if (g_shell_parse_argv(fallback_exec, &argcp, &argvp, NULL)) {
                cached_exec_start_argv = argvp;
            }
            g_free(fallback_exec);
        }
    }

    // Stage 2: re-publish state now that service config is available.
    // unit_proxy is guaranteed non-NULL here by the staleness check above.
    g_autoptr(GVariant) active_state_v = g_dbus_proxy_get_cached_property(unit_proxy, "ActiveState");
    g_autoptr(GVariant) sub_state_v = g_dbus_proxy_get_cached_property(unit_proxy, "SubState");
    const gchar *as = active_state_v ? g_variant_get_string(active_state_v, NULL) : NULL;
    const gchar *ss = sub_state_v ? g_variant_get_string(sub_state_v, NULL) : NULL;
    publish_systemd_state_with_cached_config(as, ss);

    OC_LOG_DEBUG(OPENCLAW_LOG_CAT_SYSTEMD, "on_get_service_properties_ready exit config_loaded=%d proxy=%p",
              config_loaded, (void *)unit_proxy);
}

static void fetch_service_config_async(void) {
    if (!unit_proxy || !manager_proxy) return;

    const gchar *unit_path = g_dbus_proxy_get_object_path(unit_proxy);
    if (!unit_path) return;

    GDBusConnection *bus = g_dbus_proxy_get_connection(manager_proxy);
    if (!bus) return;

    ServiceConfigContext *ctx = g_new0(ServiceConfigContext, 1);
    ctx->unit_name = g_strdup(systemd_get_canonical_unit_name());
    ctx->unit_object_path = g_strdup(unit_path);

    OC_LOG_DEBUG(OPENCLAW_LOG_CAT_SYSTEMD, "fetch_service_config_async unit_path=%s unit_name=%s",
              unit_path, ctx->unit_name);

    // One-shot async GetAll against the Service interface (not the Unit interface)
    g_dbus_connection_call(
        bus,
        "org.freedesktop.systemd1",
        unit_path,
        "org.freedesktop.DBus.Properties",
        "GetAll",
        g_variant_new("(s)", "org.freedesktop.systemd1.Service"),
        G_VARIANT_TYPE("(a{sv})"),
        G_DBUS_CALL_FLAGS_NONE,
        -1, NULL,
        on_get_service_properties_ready,
        ctx);
}

static void fetch_unit_properties(void) {
    OC_LOG_TRACE(OPENCLAW_LOG_CAT_SYSTEMD, "fetch_unit_properties entry proxy=%p signal_id=%u", (void *)unit_proxy, properties_changed_signal_id);

    if (!unit_proxy) {
        OC_LOG_TRACE(OPENCLAW_LOG_CAT_SYSTEMD, "fetch_unit_properties skip proxy=%p", (void *)unit_proxy);
        return;
    }

    // Stage 1: Read runtime state from the Unit interface and publish immediately
    // with whatever service config is currently cached.
    g_autoptr(GVariant) active_state_v = g_dbus_proxy_get_cached_property(unit_proxy, "ActiveState");
    g_autoptr(GVariant) sub_state_v = g_dbus_proxy_get_cached_property(unit_proxy, "SubState");

    const gchar *as = active_state_v ? g_variant_get_string(active_state_v, NULL) : NULL;
    const gchar *ss = sub_state_v ? g_variant_get_string(sub_state_v, NULL) : NULL;

    publish_systemd_state_with_cached_config(as, ss);

    OC_LOG_TRACE(OPENCLAW_LOG_CAT_SYSTEMD, "fetch_unit_properties stage1 active_state=%s sub_state=%s proxy=%p",
              as ? as : "(null)", ss ? ss : "(null)", (void *)unit_proxy);

    // Stage 2: Async fetch of service config from the correct Service interface.
    // When the async callback fires, it will re-publish state with updated config.
    fetch_service_config_async();
}

static void systemd_init_proxy_helper(void) {
    if (manager_proxy) return;

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
}

void systemd_init(void) {
    systemd_init_proxy_helper();
    // Use async D-Bus properties instead of file parsing as primary source
    systemd_refresh();
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
        if (cached_exec_start_argv) {
            sys_state.exec_start_argv = g_strdupv(cached_exec_start_argv);
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
    if (!manager_proxy) {
        systemd_init_proxy_helper();
    }
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
