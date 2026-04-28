/*
 * tray_protocol.c
 *
 * Implementation of the pure-C tray helper line protocol formatter and
 * parser. See tray_protocol.h for the protocol grammar.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "tray_protocol.h"

#include <string.h>

gboolean tray_protocol_exec_approval_mode_is_valid(const char *mode) {
    if (!mode) return FALSE;
    return g_strcmp0(mode, "deny")  == 0
        || g_strcmp0(mode, "ask")   == 0
        || g_strcmp0(mode, "allow") == 0;
}

gchar* tray_protocol_format_menu_visible(const char *action, gboolean visible) {
    if (!action || action[0] == '\0') return NULL;
    return g_strdup_printf("MENU_VISIBLE:%s:%d\n", action, visible ? 1 : 0);
}

gchar* tray_protocol_format_radio_exec_approval(const char *mode) {
    if (!tray_protocol_exec_approval_mode_is_valid(mode)) return NULL;
    return g_strdup_printf("RADIO:EXEC_APPROVAL:%s\n", mode);
}

gchar* tray_protocol_format_approvals(guint count) {
    return g_strdup_printf("APPROVALS:%u\n", count);
}

gboolean tray_protocol_parse_exec_approval_action(const char *action, char **out_mode) {
    if (!action) return FALSE;

    /* Action body shape: "EXEC_APPROVAL_SET:<mode>" with no trailing
     * whitespace or extra colons. The host strips the `ACTION:` prefix
     * before reaching this parser, so the body must start with the
     * verb. */
    static const char prefix[] = "EXEC_APPROVAL_SET:";
    const gsize prefix_len = sizeof(prefix) - 1;

    if (strncmp(action, prefix, prefix_len) != 0) return FALSE;

    const char *mode = action + prefix_len;
    if (mode[0] == '\0') return FALSE;
    if (strchr(mode, ':') != NULL) return FALSE;          /* extra fields */
    if (strchr(mode, '\n') != NULL) return FALSE;
    if (strchr(mode, ' ') != NULL) return FALSE;

    if (!tray_protocol_exec_approval_mode_is_valid(mode)) return FALSE;

    if (out_mode) *out_mode = g_strdup(mode);
    return TRUE;
}
