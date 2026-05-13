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

static gboolean check_key_is_valid(const char *key) {
    if (!key || key[0] == '\0') return FALSE;
    for (const char *p = key; *p; p++) {
        if (*p == ':' || *p == '\n' || *p == ' ' || *p == '\r') {
            return FALSE;
        }
    }
    return TRUE;
}

gchar* tray_protocol_format_check(const char *key, gboolean checked) {
    if (!check_key_is_valid(key)) return NULL;
    return g_strdup_printf("CHECK:%s:%d\n", key, checked ? 1 : 0);
}

gboolean tray_protocol_parse_check_action(const char *action,
                                          char **out_key,
                                          gboolean *out_value) {
    if (!action) return FALSE;

    /* Action body shape: "<KEY>_SET:<0|1>". The KEY token must end
     * with the literal "_SET" infix immediately before the colon, and
     * the trailing flag must be exactly one of '0' or '1' with no
     * extra characters. The host strips the `ACTION:` prefix before
     * reaching this parser. */
    const char *colon = strchr(action, ':');
    if (!colon) return FALSE;

    /* Reject extra colons. */
    if (strchr(colon + 1, ':') != NULL) return FALSE;

    /* Validate the flag suffix. */
    const char *flag = colon + 1;
    if (flag[0] == '\0' || flag[1] != '\0') return FALSE;
    if (flag[0] != '0' && flag[0] != '1') return FALSE;

    gsize head_len = (gsize)(colon - action);
    static const char suffix[] = "_SET";
    const gsize suffix_len = sizeof(suffix) - 1;
    if (head_len <= suffix_len) return FALSE;

    /* The head before the colon must end with `_SET`. */
    if (memcmp(action + head_len - suffix_len, suffix, suffix_len) != 0) {
        return FALSE;
    }

    /* The KEY token is the substring before `_SET`. Reject empty
     * keys, whitespace, and embedded newlines. */
    gsize key_len = head_len - suffix_len;
    if (key_len == 0) return FALSE;
    for (gsize i = 0; i < key_len; i++) {
        char c = action[i];
        if (c == ' ' || c == '\n' || c == '\r' || c == '\t') return FALSE;
    }

    if (out_key) *out_key = g_strndup(action, key_len);
    if (out_value) *out_value = (flag[0] == '1');
    return TRUE;
}
