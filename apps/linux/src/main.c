/*
 * main.c
 *
 * Application entry point for the OpenClaw Linux Companion App.
 *
 * Bootstraps the GTK4/Libadwaita application loop, defers initialization
 * logic until the app is fully registered via the `on_activate` signal,
 * and orchestrates the distinct timers for the 3-lane asynchronous polling
 * (Systemd events, Primary Status polling, Secondary Probe polling).
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include <gtk/gtk.h>
#include <adwaita.h>
#include <glib.h>

extern void tray_init(void);
extern void systemd_init(void);
extern void systemd_refresh(void);
extern void health_init(void);
extern void health_probe_gateway(void);
extern void health_run_deep_probe(void);
extern void state_init(void);
extern void notify_init(void);

static gboolean on_status_poll(gpointer user_data) {
    (void)user_data;
    health_probe_gateway();
    return G_SOURCE_CONTINUE;
}

static gboolean on_probe_poll(gpointer user_data) {
    (void)user_data;
    health_run_deep_probe();
    return G_SOURCE_CONTINUE;
}

static void on_activate(GtkApplication *app, gpointer user_data) {
    (void)app;
    (void)user_data;
    
    // Ensure we only initialize once if activate is called multiple times
    static gboolean initialized = FALSE;
    if (initialized) return;
    initialized = TRUE;

    // The app has 3 distinct asynchronous runtime lanes:
    // Lane 1: Real-time systemd D-Bus event subscription lane.
    // Lane 2: Periodic async primary status lane (gateway status --json) for operational health.
    // Lane 3: Periodic async secondary deep probe lane (gateway probe) for diagnostics.

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

    // 5. Initialize health subsystem
    health_init();

    // 6. Start the disjoint lane timers
    // Lane 2: Primary JSON Status (every 5 seconds)
    g_timeout_add_seconds(5, on_status_poll, NULL);
    
    // Lane 3: Secondary Deep Probe (every 60 seconds)
    g_timeout_add_seconds(60, on_probe_poll, NULL);
}

int main(int argc, char **argv) {
    g_autoptr(AdwApplication) app = adw_application_new("ai.openclaw.Companion", G_APPLICATION_DEFAULT_FLAGS);
    g_signal_connect(app, "activate", G_CALLBACK(on_activate), NULL);

    g_application_hold(G_APPLICATION(app));

    return g_application_run(G_APPLICATION(app), argc, argv);
}
