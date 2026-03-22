#include "systemd_helpers.h"
#include <string.h>

gboolean systemd_is_gateway_unit(const gchar *filename, const gchar *contents) {
    if (!contents) return FALSE;
    
    // Must be a gateway (explicit kind marker or legacy/default filename pattern)
    gboolean is_gateway = FALSE;
    if (strstr(contents, "OPENCLAW_SERVICE_KIND=gateway")) {
        is_gateway = TRUE;
    } else if (filename && ((g_str_has_prefix(filename, "openclaw-gateway.") || g_str_has_prefix(filename, "openclaw-gateway-")) ||
                            (g_str_has_prefix(filename, "clawdbot-gateway.") || g_str_has_prefix(filename, "clawdbot-gateway-")) ||
                            (g_str_has_prefix(filename, "moltbot-gateway.") || g_str_has_prefix(filename, "moltbot-gateway-")))) {
        // Fallback for older units or manual installs missing the KIND marker
        is_gateway = TRUE;
    }
    
    // If it has the new kind marker, that implies it's ours.
    // If it only has the general marker, it MUST match the gateway prefix to filter out node services.
    return is_gateway;
}

gchar* systemd_normalize_unit_override(const gchar *raw_unit) {
    if (!raw_unit) return NULL;
    gchar *trimmed = g_strstrip(g_strdup(raw_unit));
    if (strlen(trimmed) > 0) {
        if (g_str_has_suffix(trimmed, ".service")) {
            return trimmed;
        } else {
            gchar *res = g_strdup_printf("%s.service", trimmed);
            g_free(trimmed);
            return res;
        }
    }
    g_free(trimmed);
    return NULL;
}

gchar* systemd_normalize_profile(const gchar *raw_profile) {
    if (!raw_profile) return NULL;
    gchar *trimmed = g_strstrip(g_strdup(raw_profile));
    gchar *res = NULL;
    if (strlen(trimmed) == 0 || g_strcmp0(trimmed, "default") == 0) {
        res = g_strdup("openclaw-gateway.service");
    } else {
        res = g_strdup_printf("openclaw-gateway-%s.service", trimmed);
    }
    g_free(trimmed);
    return res;
}
