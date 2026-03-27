/*
 * main.c
 *
 * Application entry point for the OpenClaw Linux Companion App.
 *
 * Bootstraps the GTK4/Libadwaita application loop, defers initialization
 * logic until the app is fully registered via the `on_activate` signal,
 * and orchestrates the two runtime lanes:
 *   Lane 1: Systemd D-Bus event subscription (service lifecycle context)
 *   Lane 2: Native gateway client (HTTP health + WebSocket connectivity)
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include <gtk/gtk.h>
#include <adwaita.h>
#include <glib.h>

#include "log.h"
#include "gateway_client.h"

extern void tray_init(void);
extern void systemd_init(void);
extern void systemd_refresh(void);
extern void state_init(void);
extern void notify_init(void);

void state_on_gateway_refresh_requested(void) {
    gateway_client_refresh();
}

static void on_activate(GtkApplication *app, gpointer user_data) {
    (void)app;
    (void)user_data;
    
    // Ensure we only initialize once if activate is called multiple times
    static gboolean initialized = FALSE;
    if (initialized) return;
    initialized = TRUE;

    // The app has 2 distinct asynchronous runtime lanes:
    // Lane 1: Real-time systemd D-Bus event subscription (service lifecycle context)
    // Lane 2: Native gateway client (HTTP health polling + persistent WebSocket)

    // Startup Sequence:
    // 1. Initialize app state and notifications
    state_init();
    notify_init();
    
    // 2. Initialize tray first so the UI helper exists to receive early state broadcasts
    tray_init();
    
    // 3. Initialize systemd D-Bus lane (which may immediately publish 'User Systemd Unavailable')
    systemd_init();
    
    // 4. Perform the initial systemd state fetch so we don't start with a blank UI
    systemd_refresh();

    // 5. Initialize native gateway client (HTTP health polling + WebSocket)
    // The gateway client manages its own internal timers for health polling
    // and WebSocket reconnection with exponential backoff.
    gateway_client_init();
}

int main(int argc, char **argv) {
    openclaw_log_init();
    
    g_autoptr(AdwApplication) app = adw_application_new("ai.openclaw.Companion", G_APPLICATION_DEFAULT_FLAGS);
    g_signal_connect(app, "activate", G_CALLBACK(on_activate), NULL);

    g_application_hold(G_APPLICATION(app));

    return g_application_run(G_APPLICATION(app), argc, argv);
}
