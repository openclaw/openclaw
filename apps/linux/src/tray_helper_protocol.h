/*
 * tray_helper_protocol.h
 *
 * Pure-C parser/applier for the host→tray-helper line protocol that
 * runs inside `openclaw-tray-helper` (GTK3). The helper reads each
 * line from stdin, classifies it, and applies the resulting state
 * change to its menu widgets.
 *
 * To keep the GTK-bound widget code testable, the parser is split off
 * into this module. Instead of taking GTK widgets directly, it takes a
 * struct of callback function pointers — the helper installs real
 * callbacks that mutate widgets, and unit tests install capture
 * callbacks that record what was requested.
 *
 * The four protocol shapes handled here are:
 *
 *   MENU_VISIBLE:<ACTION>:0|1
 *   RADIO:EXEC_APPROVAL:<deny|ask|allow>
 *   APPROVALS:<n>
 *
 * Lines that do not match any of these prefixes are ignored — the
 * helper keeps its own handlers for `STATE:`, `RUNTIME:`, and
 * `SENSITIVE:` lines, which predate this module.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#ifndef OPENCLAW_LINUX_TRAY_HELPER_PROTOCOL_H
#define OPENCLAW_LINUX_TRAY_HELPER_PROTOCOL_H

#include <glib.h>

/* Stable identifiers for the menu items the helper can show/hide via
 * MENU_VISIBLE. Keeping them in a single enum lets the test harness
 * assert against named keys rather than free-form strings. */
typedef enum {
    TRAY_HELPER_MENU_KEY_UNKNOWN = 0,
    TRAY_HELPER_MENU_KEY_OPEN_DEBUG,
    TRAY_HELPER_MENU_KEY_EXEC_APPROVAL,
    TRAY_HELPER_MENU_KEY_APPROVALS_PENDING,
    TRAY_HELPER_MENU_KEY_RESET_REMOTE_TUNNEL,
    TRAY_HELPER_MENU_KEY_RESTART_APP,
} TrayHelperMenuKey;

typedef struct {
    /* Show/hide the named menu item. Helper owns the actual widget. */
    void (*set_menu_visible)(TrayHelperMenuKey key, gboolean visible, gpointer user_data);

    /* Select the radio item matching `mode` ("deny"/"ask"/"allow").
     * Helper is responsible for using its `updating_from_host` guard
     * so the resulting GtkRadioMenuItem::toggled does not re-emit an
     * ACTION line. */
    void (*set_radio_exec_approval)(const char *mode, gpointer user_data);

    /* Update the pending-approvals counter. Helper computes the
     * displayed label and visibility from the count. */
    void (*set_approvals_count)(guint count, gpointer user_data);

    gpointer user_data;
} TrayHelperProtocolHandlers;

/*
 * Convert an ASCII action key from a MENU_VISIBLE line into a
 * TrayHelperMenuKey. Returns TRAY_HELPER_MENU_KEY_UNKNOWN for any
 * unrecognised string (including NULL/empty), which the apply path
 * treats as "ignore".
 */
TrayHelperMenuKey tray_helper_protocol_menu_key_from_string(const char *s);

/*
 * Parse a single line and dispatch it through `handlers`. Returns
 * TRUE iff the line was recognised and a handler was invoked (or
 * would have been, had it been non-NULL); returns FALSE for any line
 * that does not match a Tranche D Full host→helper shape. The line
 * MUST be already chomped of any trailing newline.
 *
 * `handlers` may be NULL (the call still classifies the line and
 * returns the recognise/ignore decision); each handler pointer in
 * `handlers` may itself be NULL (that line is then silently dropped).
 */
gboolean tray_helper_protocol_apply_line(const TrayHelperProtocolHandlers *handlers,
                                          const char *line);

/*
 * Compute the label text that the helper renders next to the
 * pending-approvals item for a given count. Always returns a
 * newly-allocated string; caller frees with g_free(). Pluralisation
 * matches the Tranche D Full spec:
 *   0  → "Exec Approvals: 0 pending"
 *   1  → "Exec Approvals: 1 pending"
 *   >1 → "Exec Approvals: <n> pending"
 */
gchar* tray_helper_protocol_format_approvals_label(guint count);

#endif /* OPENCLAW_LINUX_TRAY_HELPER_PROTOCOL_H */
