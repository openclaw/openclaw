/*
 * tray_helper_protocol.c
 *
 * Pure-C parser/applier for the host→helper line shapes introduced in
 * Tranche D Full. See tray_helper_protocol.h.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "tray_helper_protocol.h"

#include <stdlib.h>
#include <string.h>

#include "tray_protocol.h"

TrayHelperMenuKey tray_helper_protocol_menu_key_from_string(const char *s) {
    if (!s) return TRAY_HELPER_MENU_KEY_UNKNOWN;
    if (g_strcmp0(s, "OPEN_DEBUG")          == 0) return TRAY_HELPER_MENU_KEY_OPEN_DEBUG;
    if (g_strcmp0(s, "EXEC_APPROVAL")       == 0) return TRAY_HELPER_MENU_KEY_EXEC_APPROVAL;
    if (g_strcmp0(s, "APPROVALS_PENDING")   == 0) return TRAY_HELPER_MENU_KEY_APPROVALS_PENDING;
    if (g_strcmp0(s, "RESET_REMOTE_TUNNEL") == 0) return TRAY_HELPER_MENU_KEY_RESET_REMOTE_TUNNEL;
    if (g_strcmp0(s, "RESTART_APP")         == 0) return TRAY_HELPER_MENU_KEY_RESTART_APP;
    return TRAY_HELPER_MENU_KEY_UNKNOWN;
}

gchar* tray_helper_protocol_format_approvals_label(guint count) {
    /* Tranche D Full keeps the label deterministic and language-stable.
     * Singular/plural variants are explicit so a translation pass can
     * later override them without restructuring the call site. */
    if (count == 0u) return g_strdup("Exec Approvals: 0 pending");
    if (count == 1u) return g_strdup("Exec Approvals: 1 pending");
    return g_strdup_printf("Exec Approvals: %u pending", count);
}

static gboolean apply_menu_visible(const TrayHelperProtocolHandlers *handlers,
                                    const char *body) {
    /* body shape: "<ACTION>:0|1" */
    if (!body) return FALSE;
    const char *colon = strchr(body, ':');
    if (!colon || colon == body) return FALSE;

    g_autofree gchar *action = g_strndup(body, (gsize)(colon - body));
    const char *flag = colon + 1;
    if (flag[0] == '\0' || flag[1] != '\0') return FALSE;
    if (flag[0] != '0' && flag[0] != '1') return FALSE;

    TrayHelperMenuKey key = tray_helper_protocol_menu_key_from_string(action);
    if (key == TRAY_HELPER_MENU_KEY_UNKNOWN) {
        /* Unknown keys are recognised by shape but silently dropped, per
         * spec ("Unknown keys are ignored"). Treat as not-applied. */
        return FALSE;
    }

    if (handlers && handlers->set_menu_visible) {
        handlers->set_menu_visible(key, flag[0] == '1', handlers->user_data);
    }
    return TRUE;
}

static gboolean apply_radio_exec_approval(const TrayHelperProtocolHandlers *handlers,
                                           const char *body) {
    /* body shape: "<mode>" — only deny/ask/allow are valid. */
    if (!tray_protocol_exec_approval_mode_is_valid(body)) return FALSE;
    if (handlers && handlers->set_radio_exec_approval) {
        handlers->set_radio_exec_approval(body, handlers->user_data);
    }
    return TRUE;
}

static gboolean apply_approvals(const TrayHelperProtocolHandlers *handlers,
                                 const char *body) {
    if (!body || body[0] == '\0') return FALSE;
    /* Reject negative numbers and anything that isn't pure digits. */
    for (const char *p = body; *p; p++) {
        if (*p < '0' || *p > '9') return FALSE;
    }
    char *endp = NULL;
    unsigned long parsed = strtoul(body, &endp, 10);
    if (!endp || *endp != '\0') return FALSE;
    if (parsed > G_MAXUINT) return FALSE;

    if (handlers && handlers->set_approvals_count) {
        handlers->set_approvals_count((guint)parsed, handlers->user_data);
    }
    return TRUE;
}

gboolean tray_helper_protocol_apply_line(const TrayHelperProtocolHandlers *handlers,
                                          const char *line) {
    if (!line) return FALSE;

    if (g_str_has_prefix(line, "MENU_VISIBLE:")) {
        return apply_menu_visible(handlers, line + sizeof("MENU_VISIBLE:") - 1);
    }
    if (g_str_has_prefix(line, "RADIO:EXEC_APPROVAL:")) {
        return apply_radio_exec_approval(handlers, line + sizeof("RADIO:EXEC_APPROVAL:") - 1);
    }
    if (g_str_has_prefix(line, "APPROVALS:")) {
        return apply_approvals(handlers, line + sizeof("APPROVALS:") - 1);
    }

    return FALSE;
}
