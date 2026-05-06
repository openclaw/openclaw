/*
 * deep_link.c
 *
 * Pure-C parser for the Linux companion's `openclaw://` URL scheme.
 * See deep_link.h for the recognised routes.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "deep_link.h"

#include <string.h>

void deep_link_route_clear(DeepLinkRoute *route) {
    if (!route) return;
    g_clear_pointer(&route->section_id, g_free);
    route->kind = DEEP_LINK_ROUTE_NONE;
}

/* Validate that a section id is a reasonable lowercase token (letters,
 * digits, hyphens). We deliberately keep this conservative: the final
 * allowlist is the shell-section registry, but rejecting obviously
 * malformed tokens here avoids passing junk into the dispatcher. */
static gboolean section_id_looks_valid(const char *s) {
    if (!s || s[0] == '\0') return FALSE;
    for (const char *p = s; *p; p++) {
        unsigned char ch = (unsigned char)*p;
        gboolean ok = (ch >= 'a' && ch <= 'z')
                   || (ch >= '0' && ch <= '9')
                   || ch == '-';
        if (!ok) return FALSE;
    }
    return TRUE;
}

gboolean deep_link_parse(const char *uri, DeepLinkRoute *out_route) {
    if (out_route) memset(out_route, 0, sizeof(*out_route));
    if (!uri || !out_route) return FALSE;

    g_autoptr(GError) error = NULL;
    g_autoptr(GUri) parsed = g_uri_parse(uri, G_URI_FLAGS_NONE, &error);
    if (!parsed) return FALSE;

    const char *scheme = g_uri_get_scheme(parsed);
    if (!scheme || g_ascii_strcasecmp(scheme, "openclaw") != 0) return FALSE;

    const char *host = g_uri_get_host(parsed);
    if (!host || host[0] == '\0') return FALSE;

    g_autofree gchar *host_lower = g_ascii_strdown(host, -1);

    const char *path = g_uri_get_path(parsed);
    /* GUri yields "" (not NULL) for authority-only URIs. Treat NULL
     * defensively to the same effect. */
    const char *effective_path = path ? path : "";

    if (g_strcmp0(host_lower, "dashboard") == 0) {
        if (effective_path[0] != '\0' && g_strcmp0(effective_path, "/") != 0) return FALSE;
        out_route->kind = DEEP_LINK_ROUTE_DASHBOARD;
        return TRUE;
    }

    if (g_strcmp0(host_lower, "chat") == 0) {
        if (effective_path[0] != '\0' && g_strcmp0(effective_path, "/") != 0) return FALSE;
        out_route->kind = DEEP_LINK_ROUTE_CHAT;
        return TRUE;
    }

    if (g_strcmp0(host_lower, "onboarding") == 0) {
        if (effective_path[0] != '\0' && g_strcmp0(effective_path, "/") != 0) return FALSE;
        out_route->kind = DEEP_LINK_ROUTE_ONBOARDING;
        return TRUE;
    }

    if (g_strcmp0(host_lower, "settings") == 0) {
        if (effective_path[0] == '\0' || g_strcmp0(effective_path, "/") == 0) {
            out_route->kind = DEEP_LINK_ROUTE_SETTINGS;
            return TRUE;
        }
        /* Expect exactly one segment after the leading slash. */
        if (effective_path[0] != '/') return FALSE;
        const char *segment = effective_path + 1;
        if (strchr(segment, '/')) return FALSE;
        g_autofree gchar *lower = g_ascii_strdown(segment, -1);
        if (!section_id_looks_valid(lower)) return FALSE;

        out_route->kind = DEEP_LINK_ROUTE_SETTINGS;
        out_route->section_id = g_steal_pointer(&lower);
        return TRUE;
    }

    return FALSE;
}
