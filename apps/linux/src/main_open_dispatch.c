/*
 * main_open_dispatch.c
 *
 * Dispatcher for `openclaw://` deep links. See main_open_dispatch.h.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "main_open_dispatch.h"

#include "deep_link.h"

DeepLinkDispatchKind deep_link_dispatcher_dispatch(const DeepLinkDispatcher *dispatcher,
                                                   const char *uri) {
    DeepLinkRoute route = {0};
    if (!deep_link_parse(uri, &route)) return DEEP_LINK_DISPATCH_NONE;

    DeepLinkDispatchKind kind = DEEP_LINK_DISPATCH_NONE;

    switch (route.kind) {
    case DEEP_LINK_ROUTE_DASHBOARD:
        if (dispatcher && dispatcher->show_section) {
            dispatcher->show_section(SECTION_DASHBOARD, dispatcher->user_data);
        }
        kind = DEEP_LINK_DISPATCH_DASHBOARD;
        break;

    case DEEP_LINK_ROUTE_CHAT:
        if (dispatcher && dispatcher->show_chat) {
            dispatcher->show_chat(dispatcher->user_data);
        }
        kind = DEEP_LINK_DISPATCH_CHAT;
        break;

    case DEEP_LINK_ROUTE_SETTINGS: {
        AppSection target = SECTION_GENERAL;
        if (route.section_id) {
            if (dispatcher && dispatcher->resolve_section_id) {
                gboolean resolved = dispatcher->resolve_section_id(
                    route.section_id, &target, dispatcher->user_data);
                if (!resolved) {
                    /* Hidden / unknown sections fall through without
                     * navigating — see deep_link_dispatcher_dispatch
                     * contract in main_open_dispatch.h. */
                    kind = DEEP_LINK_DISPATCH_NONE;
                    break;
                }
            } else {
                /* No resolver installed — be strict and ignore named
                 * sections rather than silently defaulting to General,
                 * which would make typos indistinguishable from the
                 * intentional root route. */
                kind = DEEP_LINK_DISPATCH_NONE;
                break;
            }
        }
        if (dispatcher && dispatcher->show_section) {
            dispatcher->show_section(target, dispatcher->user_data);
        }
        kind = DEEP_LINK_DISPATCH_SETTINGS;
        break;
    }

    case DEEP_LINK_ROUTE_ONBOARDING:
        if (dispatcher && dispatcher->rerun_onboarding) {
            dispatcher->rerun_onboarding(dispatcher->user_data);
        }
        kind = DEEP_LINK_DISPATCH_ONBOARDING;
        break;

    case DEEP_LINK_ROUTE_NONE:
    default:
        kind = DEEP_LINK_DISPATCH_NONE;
        break;
    }

    deep_link_route_clear(&route);
    return kind;
}
