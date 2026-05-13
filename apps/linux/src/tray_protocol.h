/*
 * tray_protocol.h
 *
 * Pure-C / GLib formatter + parser for the line protocol shared between
 * the OpenClaw Linux companion (host) and its private tray helper
 * (`openclaw-tray-helper`).
 *
 * The host writes formatted lines to the helper's stdin and reads
 * `ACTION:` / `STATE:` lines back from the helper's stdout. Tranche D
 * Full extends that protocol with three additional host→helper line
 * shapes:
 *
 *   MENU_VISIBLE:<ACTION>:0|1     — show/hide a tray menu item
 *   RADIO:EXEC_APPROVAL:<mode>    — select the active radio item
 *   APPROVALS:<n>                 — pending exec-approval count badge
 *
 * And one new helper→host action body:
 *
 *   EXEC_APPROVAL_SET:<deny|ask|allow>
 *
 * This module owns *only* string formatting and parsing. It deliberately
 * has no GTK dependency, so both the host and the helper (and the unit
 * tests) can link it cheaply.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#ifndef OPENCLAW_LINUX_TRAY_PROTOCOL_H
#define OPENCLAW_LINUX_TRAY_PROTOCOL_H

#include <glib.h>

/*
 * Format a MENU_VISIBLE line for transmission to the tray helper. The
 * trailing "\n" is included so the result can be passed straight to
 * `send_line_to_helper` without further concatenation.
 *
 * Returns NULL when `action` is NULL or empty. The caller frees with
 * g_free().
 */
gchar* tray_protocol_format_menu_visible(const char *action, gboolean visible);

/*
 * Format a RADIO:EXEC_APPROVAL line. `mode` must be one of the canonical
 * lower-case strings: "deny", "ask", "allow". For any other input the
 * function returns NULL.
 */
gchar* tray_protocol_format_radio_exec_approval(const char *mode);

/*
 * Format an APPROVALS:<count> line. Always succeeds for any guint.
 * Caller frees with g_free().
 */
gchar* tray_protocol_format_approvals(guint count);

/*
 * Parse the body of an `EXEC_APPROVAL_SET:<mode>` action line (i.e. the
 * substring AFTER `ACTION:`). On success, writes a newly-allocated copy
 * of the mode token into `*out_mode` and returns TRUE. On any malformed
 * input (NULL, missing prefix, missing/invalid mode token, trailing
 * junk) returns FALSE and leaves `*out_mode` untouched. `out_mode` may
 * be NULL — then the function is a pure validity probe.
 */
gboolean tray_protocol_parse_exec_approval_action(const char *action, char **out_mode);

/*
 * Lightweight check on a mode token (no allocation). TRUE iff `mode` is
 * exactly one of "deny", "ask", "allow". NULL returns FALSE.
 */
gboolean tray_protocol_exec_approval_mode_is_valid(const char *mode);

/*
 * Format a CHECK line for a binary toggle menu item. Tranche E adds
 * two such items: HEARTBEATS and BROWSER_CONTROL.
 *
 *   CHECK:<KEY>:0|1\n
 *
 * `key` must be a non-empty bare token without colons, spaces, or
 * newlines. Returns NULL for any malformed key. Caller frees with
 * g_free().
 */
gchar* tray_protocol_format_check(const char *key, gboolean checked);

/*
 * Parse the body of a `<KEY>_SET:0|1` action line (i.e. the substring
 * AFTER `ACTION:`). On success writes a newly-allocated copy of the
 * KEY token (without the trailing `_SET:<flag>`) into `*out_key` and
 * the parsed boolean into `*out_value`. Either out-pointer may be
 * NULL — the function still returns the validity verdict.
 *
 * Rejects any input with extra colons, whitespace, non-binary flags,
 * empty keys, missing `_SET` infix, or trailing characters.
 */
gboolean tray_protocol_parse_check_action(const char *action,
                                          char **out_key,
                                          gboolean *out_value);

#endif /* OPENCLAW_LINUX_TRAY_PROTOCOL_H */
