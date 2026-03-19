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
#include <string.h>
#include "state.h"

static GDBusProxy *manager_proxy = NULL;
static GDBusProxy *unit_proxy = NULL;
static gchar *cached_exec_start = NULL;
static guint properties_changed_signal_id = 0;

static void fetch_unit_properties(void);
extern void systemd_refresh(void);

static gchar* extract_exec_start_from_file(void) {
    const gchar *home_dir = g_get_home_dir();
    if (!home_dir) return NULL;

    g_autofree gchar *unit_path = g_build_filename(home_dir, ".config", "systemd", "user", "openclaw-gateway.service", NULL);
    
    g_autoptr(GKeyFile) key_file = g_key_file_new();
    g_autoptr(GError) error = NULL;
    
    if (!g_key_file_load_from_file(key_file, unit_path, G_KEY_FILE_NONE, &error)) {
        // Normal if unit not installed yet
        return NULL;
    }
    
    gchar *exec_start = g_key_file_get_string(key_file, "Service", "ExecStart", &error);
    if (!exec_start) {
        g_warning("Could not find ExecStart in %s: %s", unit_path, error->message);
        return NULL;
    }
    
    return exec_start;
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

    state_update_systemd(&sys_state);

    g_free(sys_state.active_state);
    g_free(sys_state.sub_state);
    g_strfreev(sys_state.exec_start_argv);
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

    cached_exec_start = extract_exec_start_from_file();
}

void systemd_refresh(void) {
    if (!manager_proxy) return;

    g_autoptr(GError) error = NULL;
    
    // 1. Check if unit file exists/is installed at all
    g_autoptr(GVariant) file_state_res = g_dbus_proxy_call_sync(
        manager_proxy, "GetUnitFileState",
        g_variant_new("(s)", "openclaw-gateway.service"),
        G_DBUS_CALL_FLAGS_NONE, -1, NULL, &error);
        
    if (!file_state_res) {
        // Failed to get file state -> assume not installed
        SystemdState sys_state = {0};
        state_update_systemd(&sys_state);
        return;
    }
    
    // 2. Refresh ExecStart if we haven't got it yet (user might have just installed it)
    if (!cached_exec_start) {
        cached_exec_start = extract_exec_start_from_file();
    }

    // 3. Get runtime state
    g_autoptr(GVariant) res = g_dbus_proxy_call_sync(
        manager_proxy, "GetUnit",
        g_variant_new("(s)", "openclaw-gateway.service"),
        G_DBUS_CALL_FLAGS_NONE, -1, NULL, &error);

    if (!res) {
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
        
        state_update_systemd(&sys_state);
        g_free(sys_state.active_state);
        g_free(sys_state.sub_state);
        g_strfreev(sys_state.exec_start_argv);
        return;
    }

    const gchar *unit_path = NULL;
    g_variant_get(res, "(&o)", &unit_path);

    if (unit_path) {
        subscribe_to_unit(g_dbus_proxy_get_connection(manager_proxy), unit_path);
    }
}

void systemd_start_gateway(void) {
    if (!manager_proxy) return;
    g_dbus_proxy_call(
        manager_proxy, "StartUnit",
        g_variant_new("(ss)", "openclaw-gateway.service", "replace"),
        G_DBUS_CALL_FLAGS_NONE, -1, NULL, NULL, NULL); 
}

void systemd_stop_gateway(void) {
    if (!manager_proxy) return;
    g_dbus_proxy_call(
        manager_proxy, "StopUnit",
        g_variant_new("(ss)", "openclaw-gateway.service", "replace"),
        G_DBUS_CALL_FLAGS_NONE, -1, NULL, NULL, NULL);
}

void systemd_restart_gateway(void) {
    if (!manager_proxy) return;
    g_dbus_proxy_call(
        manager_proxy, "RestartUnit",
        g_variant_new("(ss)", "openclaw-gateway.service", "replace"),
        G_DBUS_CALL_FLAGS_NONE, -1, NULL, NULL, NULL);
}
