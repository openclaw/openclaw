/*
 * notify.h
 *
 * Public surface for the desktop notification manager.
 *
 * The companion fans out notifications through GApplication so the
 * helper TU never needs to link libnotify directly. All entry points
 * are safe to call before the app is registered with the session bus —
 * they no-op rather than crashing.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#ifndef OPENCLAW_LINUX_NOTIFY_H
#define OPENCLAW_LINUX_NOTIFY_H

#include <glib.h>

#include "state.h"

void notify_init(void);

/* Lifecycle/health-driven notifications dispatched from state.c. */
void notify_on_transition(AppState old_state, AppState new_state);
void notify_on_gateway_connection_transition(gboolean connected);

/*
 * Dispatch a manual "test" notification. Used by the Debug section
 * button and the tray "Send Test Notification" entry. Returns TRUE if
 * the notification was posted, FALSE if the GApplication has not yet
 * registered (caller is in pre-startup) — both outcomes are safe.
 */
gboolean notify_send_test_notification(void);

#endif /* OPENCLAW_LINUX_NOTIFY_H */
