/*
 * exec_approval_tray_model.c
 *
 * Implementation of the OcExecQuickMode <-> wire token mapping used by
 * the tray protocol surface. See exec_approval_tray_model.h.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "exec_approval_tray_model.h"

const char* exec_approval_tray_mode_to_string(OcExecQuickMode mode) {
    switch (mode) {
    case OC_EXEC_QUICK_MODE_DENY:  return "deny";
    case OC_EXEC_QUICK_MODE_ASK:   return "ask";
    case OC_EXEC_QUICK_MODE_ALLOW: return "allow";
    default:                       return NULL;
    }
}

gboolean exec_approval_tray_mode_from_string(const char *s, OcExecQuickMode *out) {
    if (!s) return FALSE;

    OcExecQuickMode mode;
    if      (g_strcmp0(s, "deny")  == 0) mode = OC_EXEC_QUICK_MODE_DENY;
    else if (g_strcmp0(s, "ask")   == 0) mode = OC_EXEC_QUICK_MODE_ASK;
    else if (g_strcmp0(s, "allow") == 0) mode = OC_EXEC_QUICK_MODE_ALLOW;
    else return FALSE;

    if (out) *out = mode;
    return TRUE;
}
