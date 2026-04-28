/*
 * debug_actions.h
 *
 * Shared debug-action registry for the OpenClaw Linux Companion App.
 *
 * Single source of truth for the set of operational/debug affordances
 * surfaced by the tray helper menu and the in-app Debug section
 * (`section_debug.c`). Prior to this registry, the tray dispatched via
 * an ad-hoc if/else ladder while `section_debug.c` declared its own
 * `DebugActionSpec` tables — and any new action exposed in both
 * surfaces had to be wired twice with no compile-time guarantee they
 * stayed in sync.
 *
 * Each registered `OcDebugAction` carries:
 *
 *   - a `tray_action_string` used by the tray helper protocol
 *     (the `ACTION:<NAME>` line emitted on stdout); NULL when the
 *     action is intentionally not surfaced in the tray.
 *   - a `tray_menu_label` used by the helper to label the menu item;
 *     NULL when the action is not in the tray.
 *   - a `debug_page_label` used by the Debug section to label the
 *     button; NULL when the action is intentionally not surfaced in
 *     the Debug section.
 *
 * The dispatcher is pure C / GLib + GIO: it never imports GTK. Side
 * effects that genuinely need GTK or GDK (clipboard writes, URI
 * launches that should funnel through the desktop default handler)
 * are routed through hook seams installed once at startup. Tests can
 * install capture hooks instead and assert what was requested without
 * a display.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#ifndef OPENCLAW_LINUX_DEBUG_ACTIONS_H
#define OPENCLAW_LINUX_DEBUG_ACTIONS_H

#include <glib.h>

typedef enum {
    OC_DEBUG_ACTION_TRIGGER_HEALTH_REFRESH = 0,
    OC_DEBUG_ACTION_RESTART_GATEWAY,
    OC_DEBUG_ACTION_RESTART_ONBOARDING,
    OC_DEBUG_ACTION_REVEAL_CONFIG_FOLDER,
    OC_DEBUG_ACTION_REVEAL_STATE_FOLDER,
    OC_DEBUG_ACTION_COPY_JOURNAL_COMMAND,
    OC_DEBUG_ACTION_SEND_TEST_NOTIFICATION,
    OC_DEBUG_ACTION_OPEN_LOGS,
    OC_DEBUG_ACTION_OPEN_DEBUG,
    OC_DEBUG_ACTION_RESET_REMOTE_TUNNEL,
    OC_DEBUG_ACTION_RESTART_APP,
    OC_DEBUG_ACTION_COUNT,
} OcDebugAction;

typedef struct {
    OcDebugAction id;
    const char   *tray_action_string;
    const char   *tray_menu_label;
    const char   *debug_page_label;
} OcDebugActionSpec;

/* Returns the spec for `id`, or NULL when `id` is out of range. */
const OcDebugActionSpec* oc_debug_action_get(OcDebugAction id);

/* Number of entries in the registry (excludes the COUNT sentinel). */
guint oc_debug_action_count(void);

/*
 * Look up an action by its tray action string (case-sensitive). Returns
 * TRUE when matched and writes the id into `*out`; returns FALSE for
 * unknown / NULL input. Safe to pass NULL for `out` (then it is purely
 * a "do we recognize this string" probe).
 */
gboolean oc_debug_action_from_tray_string(const char *s, OcDebugAction *out);

/*
 * Dispatch the registered side effect for `id`. Returns TRUE when the
 * action was recognized and executed (even if the underlying side
 * effect was a no-op, e.g. a reveal action whose URI could not be
 * resolved), and FALSE for unknown ids.
 */
gboolean oc_debug_action_dispatch(OcDebugAction id);

/* ── Production hook seams ─────────────────────────────────────────
 *
 * The registry is pure C and intentionally does not pull GTK/GDK in.
 * Surfaces that need GTK to materialize (clipboard, URI launch) are
 * routed through these hooks. Production installs real hooks once at
 * startup; tests install capture hooks (or rely on the default no-op
 * behavior).
 */

typedef void (*OcDebugUriLauncherFn)(const char *uri, gpointer user_data);
typedef void (*OcDebugClipboardWriterFn)(const char *text, gpointer user_data);

void oc_debug_actions_set_uri_launcher(OcDebugUriLauncherFn fn, gpointer user_data);
void oc_debug_actions_set_clipboard_writer(OcDebugClipboardWriterFn fn, gpointer user_data);

/*
 * The Open Logs / Open Debug actions navigate the main app window to
 * a specific section. The registry must not import app_window.h (it
 * would pull GTK in transitively), so the host installs a small
 * adapter via this hook. Tests can install a capture hook instead.
 */
typedef enum {
    OC_DEBUG_SECTION_TARGET_LOGS = 0,
    OC_DEBUG_SECTION_TARGET_DEBUG = 1,
} OcDebugSectionTarget;

typedef void (*OcDebugShowSectionFn)(OcDebugSectionTarget target, gpointer user_data);

void oc_debug_actions_set_show_section_handler(OcDebugShowSectionFn fn, gpointer user_data);

OcDebugSectionTarget oc_debug_actions_test_last_section_target(void);
gboolean             oc_debug_actions_test_section_was_requested(void);

/* ── Test seams ──────────────────────────────────────────────────── */

/*
 * Returns the most-recent URI that was requested via the URI hook (or
 * NULL if none). Pointer remains valid until the next dispatch or
 * `oc_debug_actions_test_reset()`.
 */
const char* oc_debug_actions_test_last_uri(void);

/*
 * Returns the most-recent clipboard text that was requested via the
 * clipboard hook. Same lifetime contract as `..._test_last_uri()`.
 */
const char* oc_debug_actions_test_last_clipboard_text(void);

/*
 * Clears captured test state and uninstalls currently registered hooks.
 * Intended for unit tests only; production code must not call this after
 * installing runtime hooks.
 */
void oc_debug_actions_test_reset(void);

#endif /* OPENCLAW_LINUX_DEBUG_ACTIONS_H */
