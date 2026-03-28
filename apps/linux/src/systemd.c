/*
 * systemd.c
 *
 * Systemd D-Bus integration for the OpenClaw Linux Companion App.
 *
 * Handles connecting to the org.freedesktop.systemd1 D-Bus interface
 * to securely fetch the true `ActiveState` and `SubState` of the
 * openclaw-gateway.service unit, explicitly checking file state first
 * to avoid false 'Not Installed' statuses for stopped services.
 *
 * After the gateway client refactor, systemd is used exclusively for:
 *   - Service lifecycle control (start/stop/restart via D-Bus)
 *   - Unit state subscription (active/inactive/failed)
 *   - Install/uninstall UX context
 * It is NOT a source of runtime gateway endpoint/config truth.
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
static gchar *cached_unit_name = NULL;
static guint properties_changed_signal_id = 0;

static void fetch_unit_properties(void);
extern void systemd_refresh(void);
static void clear_unit_subscription(const gchar *reason);

static gboolean check_system_scope_units(void) {
    GPtrArray *paths = systemd_helpers_get_system_unit_paths();
    gboolean found = FALSE;
    for (guint i = 0; i < paths->len; i++) {
        const gchar *path = g_ptr_array_index(paths, i);
        GDir *dir = g_dir_open(path, 0, NULL);
        if (!dir) continue;
        const gchar *filename;
        while ((filename = g_dir_read_name(dir)) != NULL) {
            if (g_str_has_suffix(filename, ".service")) {
                g_autofree gchar *filepath = g_build_filename(path, filename, NULL);
                gchar *contents = NULL;
                if (g_file_get_contents(filepath, &contents, NULL, NULL)) {
                    if (systemd_is_gateway_unit(filename, contents)) {
                        found = TRUE;
                        g_free(contents);
                        break;
                    }
                    g_free(contents);
                }
            }
        }
        g_dir_close(dir);
        if (found) break;
    }
    g_ptr_array_free(paths, TRUE);
    return found;
}

static gint sort_marked_units(gconstpointer a, gconstpointer b) {
    return g_strcmp0(*(const gchar **)a, *(const gchar **)b);
}

const gchar* systemd_get_canonical_unit_name(void) {
    if (cached_unit_name) return cached_unit_name;

    const gchar *home_dir = g_get_home_dir();

    GPtrArray *marked_units = g_ptr_array_new_with_free_func(g_free);
    GPtrArray *paths = systemd_helpers_get_user_unit_paths(home_dir);

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

    gboolean has_default = FALSE;
    for (guint i = 0; i < marked_units->len; i++) {
        if (g_strcmp0("openclaw-gateway.service", (const gchar *)g_ptr_array_index(marked_units, i)) == 0) {
            has_default = TRUE;
            break;
        }
    }

    if (has_default) {
        cached_unit_name = g_strdup("openclaw-gateway.service");
    } else if (marked_units->len >= 1) {
        g_ptr_array_sort(marked_units, sort_marked_units);
        cached_unit_name = g_strdup(g_ptr_array_index(marked_units, 0));
    } else {
        cached_unit_name = g_strdup("openclaw-gateway.service");
    }

    g_ptr_array_free(marked_units, TRUE);
    return cached_unit_name;
}

/*
 * Tri-state result for the D-Bus effective-env query.
 *
 * DBUS_ENV_OK:              D-Bus query succeeded; out params are authoritative.
 * DBUS_ENV_UNIT_NOT_LOADED: GetUnit failed — the unit is not loaded.
 *                           Expected when the gateway service is stopped.
 *                           Caller falls back to unit-file-text parsing;
 *                           this is the normal degraded path.
 * DBUS_ENV_QUERY_FAILED:    The unit appeared loaded but a subsequent D-Bus
 *                           step failed (proxy creation, property read, etc.).
 *                           Caller still falls back to unit-file-text parsing,
 *                           but this is an unexpected degradation that may mask
 *                           integration issues and should be investigated.
 */
typedef enum {
    DBUS_ENV_OK,
    DBUS_ENV_UNIT_NOT_LOADED,
    DBUS_ENV_QUERY_FAILED
} DbusEnvResult;

/*
 * Try to read the effective Environment property of the loaded unit via D-Bus.
 *
 * This is the PRIMARY path for runtime-context resolution. When the unit is
 * loaded, the Environment property reflects the merged result of the main
 * unit fragment, drop-in overrides, and EnvironmentFile= directives — i.e.
 * the actual environment the gateway process receives at runtime.
 *
 * Returns:
 *   DBUS_ENV_OK              — success; out_state_dir/out_config_path are set.
 *   DBUS_ENV_UNIT_NOT_LOADED — expected fallback; unit is not loaded.
 *   DBUS_ENV_QUERY_FAILED    — degraded fallback; D-Bus query failed after
 *                              the unit appeared loaded.
 *
 * On any non-OK result the caller falls back to unit-file-text parsing,
 * which is a DEGRADED APPROXIMATION: it reads only the base unit file and
 * may miss drop-ins, EnvironmentFile=, and layered overrides.
 *
 * Scope: only OPENCLAW_STATE_DIR and OPENCLAW_CONFIG_PATH are extracted.
 * No ExecStart parsing, no CLI argument reconstruction, no other properties.
 */
static DbusEnvResult systemd_try_dbus_effective_env(const gchar *unit,
                                                    gchar **out_state_dir,
                                                    gchar **out_config_path) {
    if (!manager_proxy) return DBUS_ENV_QUERY_FAILED;

    /* GetUnit returns the object path for a loaded unit; fails if not loaded */
    g_autoptr(GError) error = NULL;
    g_autoptr(GVariant) get_unit_result = g_dbus_proxy_call_sync(
        manager_proxy, "GetUnit",
        g_variant_new("(s)", unit),
        G_DBUS_CALL_FLAGS_NONE, 2000, NULL, &error);

    if (!get_unit_result) {
        OC_LOG_DEBUG(OPENCLAW_LOG_CAT_SYSTEMD,
                     "GetUnit failed for '%s' (unit not loaded, expected fallback): %s",
                     unit, error->message);
        return DBUS_ENV_UNIT_NOT_LOADED;
    }

    const gchar *unit_path = NULL;
    g_variant_get(get_unit_result, "(&o)", &unit_path);
    if (!unit_path) return DBUS_ENV_QUERY_FAILED;

    /* Create a proxy on the Service interface to read the Environment property */
    g_autoptr(GDBusProxy) svc_proxy = g_dbus_proxy_new_sync(
        g_dbus_proxy_get_connection(manager_proxy),
        G_DBUS_PROXY_FLAGS_NONE, NULL,
        "org.freedesktop.systemd1",
        unit_path,
        "org.freedesktop.systemd1.Service",
        NULL, &error);

    if (!svc_proxy) {
        OC_LOG_WARN(OPENCLAW_LOG_CAT_SYSTEMD,
                    "Degraded fallback: Service proxy creation failed for loaded unit '%s': %s",
                    unit_path, error->message);
        return DBUS_ENV_QUERY_FAILED;
    }

    g_autoptr(GVariant) env_v = g_dbus_proxy_get_cached_property(svc_proxy, "Environment");
    if (!env_v || !g_variant_is_of_type(env_v, G_VARIANT_TYPE_STRING_ARRAY)) {
        OC_LOG_WARN(OPENCLAW_LOG_CAT_SYSTEMD,
                    "Degraded fallback: Environment property unavailable or wrong type "
                    "for loaded unit '%s'", unit);
        return DBUS_ENV_QUERY_FAILED;
    }

    const gchar **env_strv = g_variant_get_strv(env_v, NULL);
    if (!env_strv) return DBUS_ENV_QUERY_FAILED;

    if (out_state_dir) {
        *out_state_dir = systemd_helpers_extract_env_from_strv(env_strv, "OPENCLAW_STATE_DIR");
    }
    if (out_config_path) {
        *out_config_path = systemd_helpers_extract_env_from_strv(env_strv, "OPENCLAW_CONFIG_PATH");
    }

    g_free(env_strv);

    OC_LOG_DEBUG(OPENCLAW_LOG_CAT_SYSTEMD,
                 "Effective env from D-Bus (authoritative): state_dir=%s config_path=%s",
                 (out_state_dir && *out_state_dir) ? *out_state_dir : "(null)",
                 (out_config_path && *out_config_path) ? *out_config_path : "(null)");
    return DBUS_ENV_OK;
}

void systemd_get_runtime_context(gchar **out_profile, gchar **out_state_dir, gchar **out_config_path) {
    if (out_profile) *out_profile = NULL;
    if (out_state_dir) *out_state_dir = NULL;
    if (out_config_path) *out_config_path = NULL;

    const gchar *unit = systemd_get_canonical_unit_name();
    if (!unit) return;

    /* Profile label derived from unit name (informational only, not used for path derivation) */
    if (out_profile) {
        if (g_str_has_prefix(unit, "openclaw-gateway-") && g_str_has_suffix(unit, ".service")) {
            *out_profile = g_strndup(unit + 17, strlen(unit) - 17 - 8);
        } else if (g_strcmp0(unit, "openclaw-gateway.service") == 0) {
            *out_profile = g_strdup("default");
        }
    }

    /*
     * Runtime-context resolution contract:
     *
     * PRIMARY PATH — D-Bus effective environment query.
     *   When the gateway unit is loaded, we read its Environment property
     *   via org.freedesktop.systemd1.Service. This is the authoritative
     *   source because it reflects the merged result of the main unit
     *   fragment, drop-in overrides, and EnvironmentFile= directives.
     *
     * FALLBACK PATH — unit-file-text parsing (DEGRADED APPROXIMATION).
     *   Used when the primary path is unavailable. Reads only the base
     *   unit file and extracts Environment= lines directly. This is NOT
     *   equivalent to the primary path: it may miss drop-ins,
     *   EnvironmentFile= directives, and layered overrides.
     *
     *   Two sub-cases trigger the fallback:
     *     (a) Unit not loaded (expected): the service is stopped/unloaded,
     *         so there is no loaded state to query. The base file is the
     *         best available approximation.
     *     (b) D-Bus query failed (degraded): the unit appeared loaded but
     *         a proxy/property step failed. This may mask integration
     *         issues and should be investigated.
     *
     * HTTP/WebSocket remain the sole runtime truth for gateway reachability.
     * Systemd involvement here is strictly limited to obtaining the
     * effective runtime context (config path and state dir) for initial
     * config resolution.
     */
    DbusEnvResult dbus_result = systemd_try_dbus_effective_env(unit, out_state_dir, out_config_path);
    if (dbus_result == DBUS_ENV_OK) {
        return;
    }

    if (dbus_result == DBUS_ENV_UNIT_NOT_LOADED) {
        OC_LOG_DEBUG(OPENCLAW_LOG_CAT_SYSTEMD,
                     "Unit '%s' is not loaded; using unit-file-text fallback "
                     "(expected for stopped services)", unit);
    } else {
        OC_LOG_WARN(OPENCLAW_LOG_CAT_SYSTEMD,
                    "D-Bus effective-env query failed for '%s'; using degraded "
                    "unit-file-text fallback (may miss drop-ins and EnvironmentFile= "
                    "overrides — investigate if the unit should be queryable)", unit);
    }

    const gchar *home_override = g_getenv("OPENCLAW_HOME");
    const gchar *home_dir = (home_override && home_override[0] != '\0') ? home_override : g_get_home_dir();
    g_autofree gchar *unit_file_path = systemd_helpers_find_unit_file(unit, home_dir);
    if (!unit_file_path) return;

    gchar *contents = NULL;
    if (!g_file_get_contents(unit_file_path, &contents, NULL, NULL)) return;

    if (out_state_dir) {
        *out_state_dir = systemd_helpers_parse_unit_env(contents, "OPENCLAW_STATE_DIR");
    }
    if (out_config_path) {
        *out_config_path = systemd_helpers_parse_unit_env(contents, "OPENCLAW_CONFIG_PATH");
    }

    g_free(contents);
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

static void publish_systemd_state(const gchar *active_state, const gchar *sub_state) {
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

    state_update_systemd(&sys_state);

    g_free(sys_state.unit_name);
    g_free(sys_state.active_state);
    g_free(sys_state.sub_state);
}

static void fetch_unit_properties(void) {
    OC_LOG_TRACE(OPENCLAW_LOG_CAT_SYSTEMD, "fetch_unit_properties entry proxy=%p signal_id=%u", (void *)unit_proxy, properties_changed_signal_id);

    if (!unit_proxy) {
        OC_LOG_TRACE(OPENCLAW_LOG_CAT_SYSTEMD, "fetch_unit_properties skip proxy=%p", (void *)unit_proxy);
        return;
    }

    g_autoptr(GVariant) active_state_v = g_dbus_proxy_get_cached_property(unit_proxy, "ActiveState");
    g_autoptr(GVariant) sub_state_v = g_dbus_proxy_get_cached_property(unit_proxy, "SubState");

    const gchar *as = active_state_v ? g_variant_get_string(active_state_v, NULL) : NULL;
    const gchar *ss = sub_state_v ? g_variant_get_string(sub_state_v, NULL) : NULL;

    publish_systemd_state(as, ss);

    OC_LOG_TRACE(OPENCLAW_LOG_CAT_SYSTEMD, "fetch_unit_properties active_state=%s sub_state=%s proxy=%p",
              as ? as : "(null)", ss ? ss : "(null)", (void *)unit_proxy);
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
        sys_state.unit_name = g_strdup(systemd_get_canonical_unit_name());

        state_update_systemd(&sys_state);
        g_free(sys_state.unit_name);
        g_free(sys_state.active_state);
        g_free(sys_state.sub_state);
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
