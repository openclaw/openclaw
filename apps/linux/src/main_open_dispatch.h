/*
 * main_open_dispatch.h
 *
 * Headless dispatch helper for `openclaw://` deep links. Extracted from
 * main.c so the `open`-signal wiring can be unit tested without GTK.
 *
 * The dispatcher is plumbed through a small host-supplied callback
 * table so production code can route to the real product coordinator
 * / chat window, and tests can install capture callbacks.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#ifndef OPENCLAW_LINUX_MAIN_OPEN_DISPATCH_H
#define OPENCLAW_LINUX_MAIN_OPEN_DISPATCH_H

#include <glib.h>

#include "app_window.h"

typedef enum {
    DEEP_LINK_DISPATCH_NONE = 0,      /* URI unrecognised; no host action taken */
    DEEP_LINK_DISPATCH_DASHBOARD,
    DEEP_LINK_DISPATCH_CHAT,
    DEEP_LINK_DISPATCH_SETTINGS,      /* resolved to section via the registry */
    DEEP_LINK_DISPATCH_ONBOARDING,
} DeepLinkDispatchKind;

typedef struct {
    /* Fires for ROUTE_DASHBOARD and ROUTE_SETTINGS (root or resolved
     * section). Host wires this to
     * `product_coordinator_request_show_section`. */
    void (*show_section)(AppSection section, gpointer user_data);

    /* Fires for ROUTE_CHAT. Host wires this to `chat_window_show`. */
    void (*show_chat)(gpointer user_data);

    /* Fires for ROUTE_ONBOARDING. Host wires this to
     * `product_coordinator_request_rerun_onboarding`. */
    void (*rerun_onboarding)(gpointer user_data);

    /* Resolve a section id to AppSection. Host typically delegates to
     * `shell_sections_section_for_id`. For a named settings route
     * (`openclaw://settings/<id>`), if this is NULL or returns FALSE
     * the dispatcher returns DEEP_LINK_DISPATCH_NONE without calling
     * `show_section`. Only the bare `openclaw://settings` root route
     * defaults to SECTION_GENERAL. */
    gboolean (*resolve_section_id)(const char *section_id,
                                   AppSection *out_section,
                                   gpointer user_data);

    gpointer user_data;
} DeepLinkDispatcher;

/*
 * Parse `uri` as a deep link and invoke the matching handler in
 * `dispatcher`. Returns the kind of dispatch that was performed;
 * DEEP_LINK_DISPATCH_NONE signals an ignored/unknown URI (no host
 * call was made).
 *
 * When `resolve_section_id` is provided but returns FALSE for a
 * named section (e.g. `openclaw://settings/debug` while the debug
 * pane is hidden), the dispatcher silently falls back to
 * DEEP_LINK_DISPATCH_NONE and does NOT invoke `show_section`, per
 * the tranche spec.
 */
DeepLinkDispatchKind deep_link_dispatcher_dispatch(const DeepLinkDispatcher *dispatcher,
                                                   const char *uri);

#endif /* OPENCLAW_LINUX_MAIN_OPEN_DISPATCH_H */
