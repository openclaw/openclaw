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
#include "product_coordinator.h"

void state_on_gateway_refresh_requested(void) {
    gateway_client_refresh();
}

static void on_activate(GtkApplication *app, gpointer user_data) {
    (void)app;
    (void)user_data;

    product_coordinator_activate();
}

int main(int argc, char **argv) {
    openclaw_log_init();
    
    g_autoptr(AdwApplication) app = adw_application_new("ai.openclaw.Companion", G_APPLICATION_DEFAULT_FLAGS);
    g_signal_connect(app, "activate", G_CALLBACK(on_activate), NULL);

    g_application_hold(G_APPLICATION(app));

    return g_application_run(G_APPLICATION(app), argc, argv);
}
