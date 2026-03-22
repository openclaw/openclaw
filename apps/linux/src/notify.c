/*
 * notify.c
 *
 * Desktop notification manager for the OpenClaw Linux Companion App.
 *
 * Responsible for emitting user-facing notifications during significant
 * operational state transitions (e.g., service starts, crashes).
 * Safely guards against sending notifications before the GTK application
 * is fully registered with the session bus.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include <gio/gio.h>
#include <glib.h>
#include <gtk/gtk.h>
#include "state.h"
#include "log.h"

void notify_init(void) {
    // Basic init, application holds notification scope
}

void notify_on_transition(AppState old_state, AppState new_state) {
    GApplication *app = g_application_get_default();

    OC_LOG_DEBUG(OPENCLAW_LOG_CAT_NOTIFY, "notify_on_transition entry old=%d new=%d app=%p registered=%d",
              old_state, new_state, (void *)app, app ? g_application_get_is_registered(app) : 0);
    
    // Safety guard: do not send notifications before app is registered
    if (!app || !g_application_get_is_registered(app)) {
        OC_LOG_DEBUG(OPENCLAW_LOG_CAT_NOTIFY, "notify_on_transition skip (not registered)");
        return;
    }

    gboolean should_notify = FALSE;
    const char *title = "OpenClaw Gateway";
    const char *body = "";
    
    // Started running
    if (old_state != STATE_RUNNING && old_state != STATE_RUNNING_WITH_WARNING && 
        (new_state == STATE_RUNNING || new_state == STATE_RUNNING_WITH_WARNING)) {
        should_notify = TRUE;
        body = "Gateway is now running.";
    }
    // Entered degraded
    else if (old_state != STATE_DEGRADED && new_state == STATE_DEGRADED) {
        should_notify = TRUE;
        body = "Gateway is degraded or unreachable.";
    }
    // Entered error
    else if (old_state != STATE_ERROR && new_state == STATE_ERROR) {
        should_notify = TRUE;
        body = "Gateway service failed.";
    }

    if (should_notify) {
        OC_LOG_DEBUG(OPENCLAW_LOG_CAT_NOTIFY, "notify_on_transition pre-send body='%s'", body);
        g_autoptr(GNotification) notification = g_notification_new(title);
        g_notification_set_body(notification, body);
        g_application_send_notification(app, "openclaw-status", notification);
        OC_LOG_DEBUG(OPENCLAW_LOG_CAT_NOTIFY, "notify_on_transition post-send");
    } else {
        OC_LOG_DEBUG(OPENCLAW_LOG_CAT_NOTIFY, "notify_on_transition no-send");
    }
}
