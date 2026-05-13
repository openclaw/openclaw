/*
 * deep_link.h
 *
 * Pure-C / GLib parser for the Linux companion's `openclaw://` URL
 * scheme. Keeps navigation URL handling isolated from GTK so it can be
 * unit tested headlessly.
 *
 * Recognised routes in this tranche (navigation-only — macOS-style
 * agent/gateway deep links are intentionally NOT handled here):
 *
 *   openclaw://dashboard
 *   openclaw://chat
 *   openclaw://settings                 → General section
 *   openclaw://settings/<section-id>    → named shell section
 *   openclaw://onboarding               → re-run onboarding
 *
 * Section id validation is left to the caller (the main-window shell
 * registry); this parser preserves the raw id string.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#ifndef OPENCLAW_LINUX_DEEP_LINK_H
#define OPENCLAW_LINUX_DEEP_LINK_H

#include <glib.h>

typedef enum {
    DEEP_LINK_ROUTE_NONE = 0,
    DEEP_LINK_ROUTE_DASHBOARD,
    DEEP_LINK_ROUTE_CHAT,
    DEEP_LINK_ROUTE_SETTINGS,
    DEEP_LINK_ROUTE_ONBOARDING,
} DeepLinkRouteKind;

typedef struct {
    DeepLinkRouteKind kind;
    /*
     * Optional shell-section id for DEEP_LINK_ROUTE_SETTINGS when a
     * path segment was supplied (e.g. `openclaw://settings/channels`).
     * NULL for the bare `openclaw://settings` route and for every other
     * kind. Owned by the route; free with `deep_link_route_clear`.
     */
    gchar *section_id;
} DeepLinkRoute;

/*
 * Parse `uri` into a deep-link route. Returns TRUE on a recognised
 * shape and writes the result to `*out_route`; returns FALSE and
 * leaves `*out_route` zero-initialised otherwise.
 *
 * Scheme/host matching is case-insensitive per RFC 3986. Query
 * strings and fragments are ignored. Unknown hosts (including
 * macOS-specific `agent` / `gateway`) return FALSE. Extra path
 * segments beyond the single optional `<section-id>` on `settings`
 * are rejected.
 */
gboolean deep_link_parse(const char *uri, DeepLinkRoute *out_route);

/* Release any heap-owned fields inside `*route` (currently section_id). */
void deep_link_route_clear(DeepLinkRoute *route);

#endif /* OPENCLAW_LINUX_DEEP_LINK_H */
