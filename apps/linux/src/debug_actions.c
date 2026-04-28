/*
 * debug_actions.c
 *
 * Implementation of the shared debug-action registry. Side effects that
 * intrinsically need GTK (clipboard writes, URI launches that must go
 * through GAppInfo) are routed through hook seams installed at startup.
 *
 * Cross-module dependencies are imported via forward declarations so
 * the registry's translation unit does not transitively pull GTK in;
 * tests can link this file alongside their own stubs and remain
 * headless.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "debug_actions.h"

#include <glib.h>
#include <string.h>

#include "app_restart.h"
#include "notify.h"
#include "runtime_reveal.h"

/* ── Forward declarations of cross-module entry points ──────────────
 *
 * Defined in:
 *   gateway_client.c          → gateway_client_refresh
 *   systemd.c                 → systemd_restart_gateway
 *   state.c                   → systemd_get_canonical_unit_name
 *   product_coordinator.c     → product_coordinator_request_rerun_onboarding
 *   debug_actions_show_section() — thin wrapper installed by the host
 *     application (see oc_debug_actions_set_show_section); tests can
 *     install their own capture wrapper. We deliberately avoid
 *     including app_window.h here so the registry stays GTK-free.
 */
extern void gateway_client_refresh(void);
extern void systemd_restart_gateway(void);
extern const gchar* systemd_get_canonical_unit_name(void);
extern void product_coordinator_request_rerun_onboarding(void);

/* ── Registry table ─────────────────────────────────────────────── */

static const OcDebugActionSpec g_debug_actions[] = {
    [OC_DEBUG_ACTION_TRIGGER_HEALTH_REFRESH] = {
        .id                 = OC_DEBUG_ACTION_TRIGGER_HEALTH_REFRESH,
        .tray_action_string = "TRIGGER_HEALTH_REFRESH",
        .tray_menu_label    = NULL,                       /* not surfaced in tray (REFRESH covers it) */
        .debug_page_label   = "Trigger Health Refresh",
    },
    [OC_DEBUG_ACTION_RESTART_GATEWAY] = {
        .id                 = OC_DEBUG_ACTION_RESTART_GATEWAY,
        .tray_action_string = NULL,                       /* tray's RESTART legacy action covers it */
        .tray_menu_label    = NULL,
        .debug_page_label   = "Restart Gateway",
    },
    [OC_DEBUG_ACTION_RESTART_ONBOARDING] = {
        .id                 = OC_DEBUG_ACTION_RESTART_ONBOARDING,
        .tray_action_string = "RESTART_ONBOARDING",
        .tray_menu_label    = "Restart Onboarding",
        .debug_page_label   = "Restart Onboarding",
    },
    [OC_DEBUG_ACTION_REVEAL_CONFIG_FOLDER] = {
        .id                 = OC_DEBUG_ACTION_REVEAL_CONFIG_FOLDER,
        .tray_action_string = "REVEAL_CONFIG_FOLDER",
        .tray_menu_label    = "Reveal Config Folder",
        .debug_page_label   = "Reveal Config Folder",
    },
    [OC_DEBUG_ACTION_REVEAL_STATE_FOLDER] = {
        .id                 = OC_DEBUG_ACTION_REVEAL_STATE_FOLDER,
        .tray_action_string = "REVEAL_STATE_FOLDER",
        .tray_menu_label    = "Reveal State Folder",
        .debug_page_label   = "Reveal State Folder",
    },
    [OC_DEBUG_ACTION_COPY_JOURNAL_COMMAND] = {
        .id                 = OC_DEBUG_ACTION_COPY_JOURNAL_COMMAND,
        .tray_action_string = "COPY_JOURNAL_COMMAND",
        .tray_menu_label    = "Copy Journal Command",
        .debug_page_label   = "Copy Journal Command",
    },
    [OC_DEBUG_ACTION_SEND_TEST_NOTIFICATION] = {
        .id                 = OC_DEBUG_ACTION_SEND_TEST_NOTIFICATION,
        .tray_action_string = "SEND_TEST_NOTIFICATION",
        .tray_menu_label    = "Send Test Notification",
        .debug_page_label   = "Send Test Notification",
    },
    [OC_DEBUG_ACTION_OPEN_LOGS] = {
        .id                 = OC_DEBUG_ACTION_OPEN_LOGS,
        .tray_action_string = "OPEN_LOGS",
        .tray_menu_label    = "Open Logs",
        .debug_page_label   = NULL,                       /* navigates away from Debug */
    },
    [OC_DEBUG_ACTION_OPEN_DEBUG] = {
        .id                 = OC_DEBUG_ACTION_OPEN_DEBUG,
        .tray_action_string = "OPEN_DEBUG",
        .tray_menu_label    = "Open Debug",
        .debug_page_label   = NULL,                       /* you are already here */
    },
    [OC_DEBUG_ACTION_RESET_REMOTE_TUNNEL] = {
        .id                 = OC_DEBUG_ACTION_RESET_REMOTE_TUNNEL,
        .tray_action_string = "RESET_REMOTE_TUNNEL",
        .tray_menu_label    = "Reset Remote Tunnel",
        .debug_page_label   = NULL,                       /* tray-only until a reset API lands */
    },
    [OC_DEBUG_ACTION_RESTART_APP] = {
        .id                 = OC_DEBUG_ACTION_RESTART_APP,
        .tray_action_string = "RESTART_APP",
        .tray_menu_label    = "Restart App",
        .debug_page_label   = "Restart App",
    },
};

G_STATIC_ASSERT(G_N_ELEMENTS(g_debug_actions) == OC_DEBUG_ACTION_COUNT);

/* ── Hook seams ────────────────────────────────────────────────── */

typedef struct {
    OcDebugUriLauncherFn     uri_launcher;
    gpointer                 uri_launcher_data;
    OcDebugClipboardWriterFn clipboard_writer;
    gpointer                 clipboard_writer_data;
} OcDebugHooks;

static OcDebugHooks g_hooks = {0};

void oc_debug_actions_set_uri_launcher(OcDebugUriLauncherFn fn, gpointer user_data) {
    g_hooks.uri_launcher = fn;
    g_hooks.uri_launcher_data = user_data;
}

void oc_debug_actions_set_clipboard_writer(OcDebugClipboardWriterFn fn, gpointer user_data) {
    g_hooks.clipboard_writer = fn;
    g_hooks.clipboard_writer_data = user_data;
}

/* ── Show-section hook (Open Logs / Open Debug) ───────────────────
 *
 * The registry must not import app_window.h (it would pull GTK in),
 * so the host installs a thin show-section adapter here. Default is
 * a no-op so headless tests do not crash if a dispatch fires before
 * the host hook has been installed.
 */
static OcDebugShowSectionFn g_show_section_fn = NULL;
static gpointer             g_show_section_data = NULL;

void oc_debug_actions_set_show_section_handler(OcDebugShowSectionFn fn, gpointer user_data) {
    g_show_section_fn = fn;
    g_show_section_data = user_data;
}

/* ── Test capture state ─────────────────────────────────────────── */

static gchar               *g_test_last_uri = NULL;
static gchar               *g_test_last_clipboard = NULL;
static gboolean             g_test_section_requested = FALSE;
static OcDebugSectionTarget g_test_last_section_target = OC_DEBUG_SECTION_TARGET_LOGS;

static void capture_uri(const char *uri) {
    g_free(g_test_last_uri);
    g_test_last_uri = uri ? g_strdup(uri) : NULL;
}

static void capture_clipboard(const char *text) {
    g_free(g_test_last_clipboard);
    g_test_last_clipboard = text ? g_strdup(text) : NULL;
}

const char* oc_debug_actions_test_last_uri(void) {
    return g_test_last_uri;
}

const char* oc_debug_actions_test_last_clipboard_text(void) {
    return g_test_last_clipboard;
}

OcDebugSectionTarget oc_debug_actions_test_last_section_target(void) {
    return g_test_last_section_target;
}

gboolean oc_debug_actions_test_section_was_requested(void) {
    return g_test_section_requested;
}

void oc_debug_actions_test_reset(void) {
    g_clear_pointer(&g_test_last_uri, g_free);
    g_clear_pointer(&g_test_last_clipboard, g_free);
    g_test_section_requested = FALSE;
    g_test_last_section_target = OC_DEBUG_SECTION_TARGET_LOGS;
    g_hooks.uri_launcher = NULL;
    g_hooks.uri_launcher_data = NULL;
    g_hooks.clipboard_writer = NULL;
    g_hooks.clipboard_writer_data = NULL;
    g_show_section_fn = NULL;
    g_show_section_data = NULL;
}

static void show_section(OcDebugSectionTarget target) {
    g_test_section_requested = TRUE;
    g_test_last_section_target = target;
    if (g_show_section_fn) {
        g_show_section_fn(target, g_show_section_data);
    }
}

/* ── Internal helpers ─────────────────────────────────────────── */

static void launch_uri(const char *uri) {
    if (!uri || !uri[0]) return;
    capture_uri(uri);
    if (g_hooks.uri_launcher) {
        g_hooks.uri_launcher(uri, g_hooks.uri_launcher_data);
    }
}

static void write_clipboard(const char *text) {
    if (!text) return;
    capture_clipboard(text);
    if (g_hooks.clipboard_writer) {
        g_hooks.clipboard_writer(text, g_hooks.clipboard_writer_data);
    }
}

/* ── Public API ──────────────────────────────────────────────── */

const OcDebugActionSpec* oc_debug_action_get(OcDebugAction id) {
    if ((guint)id >= (guint)OC_DEBUG_ACTION_COUNT) return NULL;
    return &g_debug_actions[id];
}

guint oc_debug_action_count(void) {
    return (guint)OC_DEBUG_ACTION_COUNT;
}

gboolean oc_debug_action_from_tray_string(const char *s, OcDebugAction *out) {
    if (!s) return FALSE;
    for (guint i = 0; i < (guint)OC_DEBUG_ACTION_COUNT; i++) {
        const char *ts = g_debug_actions[i].tray_action_string;
        if (ts && strcmp(ts, s) == 0) {
            if (out) *out = (OcDebugAction)i;
            return TRUE;
        }
    }
    return FALSE;
}

gboolean oc_debug_action_dispatch(OcDebugAction id) {
    if ((guint)id >= (guint)OC_DEBUG_ACTION_COUNT) return FALSE;

    switch (id) {
    case OC_DEBUG_ACTION_TRIGGER_HEALTH_REFRESH:
        gateway_client_refresh();
        return TRUE;

    case OC_DEBUG_ACTION_RESTART_GATEWAY:
        systemd_restart_gateway();
        return TRUE;

    case OC_DEBUG_ACTION_RESTART_ONBOARDING:
        product_coordinator_request_rerun_onboarding();
        return TRUE;

    case OC_DEBUG_ACTION_REVEAL_CONFIG_FOLDER: {
        g_autofree gchar *uri = runtime_reveal_build_config_dir_uri();
        launch_uri(uri);
        return TRUE;
    }

    case OC_DEBUG_ACTION_REVEAL_STATE_FOLDER: {
        g_autofree gchar *uri = runtime_reveal_build_state_dir_uri();
        launch_uri(uri);
        return TRUE;
    }

    case OC_DEBUG_ACTION_COPY_JOURNAL_COMMAND: {
        const gchar *unit = systemd_get_canonical_unit_name();
        g_autofree gchar *cmd = g_strdup_printf("journalctl --user -u %s -f",
                                                unit ? unit : "openclaw-gateway.service");
        write_clipboard(cmd);
        return TRUE;
    }

    case OC_DEBUG_ACTION_SEND_TEST_NOTIFICATION:
        (void)notify_send_test_notification();
        return TRUE;

    case OC_DEBUG_ACTION_OPEN_LOGS:
        show_section(OC_DEBUG_SECTION_TARGET_LOGS);
        return TRUE;

    case OC_DEBUG_ACTION_OPEN_DEBUG:
        show_section(OC_DEBUG_SECTION_TARGET_DEBUG);
        return TRUE;

    case OC_DEBUG_ACTION_RESET_REMOTE_TUNNEL:
        /*
         * TODO: wire to a real reset API once one exists. The closest
         * existing primitives are `remote_tunnel_stop()` plus a
         * coordinator-driven re-apply, but synthesising that here would
         * duplicate the connection-mode coordinator's apply path. The
         * tray surfaces this action only when MENU_VISIBLE is set to 1,
         * and the host emits MENU_VISIBLE:RESET_REMOTE_TUNNEL:0 until
         * a public reset entrypoint lands — so reaching this dispatch
         * indicates a stale helper or test harness.
         */
        return FALSE;

    case OC_DEBUG_ACTION_RESTART_APP:
        return app_restart_request();

    case OC_DEBUG_ACTION_COUNT:
    default:
        return FALSE;
    }
}
