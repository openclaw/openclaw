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
 * Also registers as the `openclaw://` URL-scheme handler: URIs passed
 * from the desktop dispatcher are routed through the deep-link
 * dispatcher into the product coordinator / chat window without
 * duplicating navigation state.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include <gtk/gtk.h>
#include <adwaita.h>
#include <glib.h>

#include "chat_window.h"
#include "gateway_client.h"
#include "log.h"
#include "main_open_dispatch.h"
#include "product_coordinator.h"
#include "shell_sections.h"

void state_on_gateway_refresh_requested(void) {
    gateway_client_refresh();
}

static void deep_link_show_section(AppSection section, gpointer user_data) {
    (void)user_data;
    product_coordinator_request_show_section(section);
}

static void deep_link_show_chat(gpointer user_data) {
    (void)user_data;
    chat_window_show();
}

static void deep_link_rerun_onboarding(gpointer user_data) {
    (void)user_data;
    product_coordinator_request_rerun_onboarding();
}

static gboolean deep_link_resolve_section_id(const char *section_id,
                                             AppSection *out_section,
                                             gpointer user_data) {
    (void)user_data;
    return shell_sections_section_for_id(section_id, out_section);
}

static const DeepLinkDispatcher g_deep_link_dispatcher = {
    .show_section       = deep_link_show_section,
    .show_chat          = deep_link_show_chat,
    .rerun_onboarding   = deep_link_rerun_onboarding,
    .resolve_section_id = deep_link_resolve_section_id,
    .user_data          = NULL,
};

static void on_activate(GtkApplication *app, gpointer user_data) {
    (void)app;
    (void)user_data;

    product_coordinator_activate();
}

static void on_open(GApplication *app,
                    GFile **files,
                    gint n_files,
                    const gchar *hint,
                    gpointer user_data) {
    (void)hint;
    (void)user_data;

    /*
     * Deliver the primary `activate` signal before routing the URI so
     * that shell-coordinator state is fully bootstrapped when the
     * dispatcher asks to show a section. With single-instance
     * GApplication semantics this is a no-op on the primary (activate
     * already fired); it defensively covers the URL-first cold start.
     */
    g_application_activate(app);

    for (gint i = 0; i < n_files; i++) {
        if (!files[i]) continue;
        g_autofree gchar *uri = g_file_get_uri(files[i]);
        if (!uri) continue;

        DeepLinkDispatchKind kind =
            deep_link_dispatcher_dispatch(&g_deep_link_dispatcher, uri);
        if (kind == DEEP_LINK_DISPATCH_NONE) {
            OC_LOG_DEBUG(OPENCLAW_LOG_CAT_STATE, "ignored deep link uri=%s", uri);
        } else {
            OC_LOG_INFO(OPENCLAW_LOG_CAT_STATE,
                        "deep link dispatched uri=%s kind=%d",
                        uri, (int)kind);
        }
    }
}

int main(int argc, char **argv) {
    openclaw_log_init();

    g_autoptr(AdwApplication) app =
        adw_application_new("ai.openclaw.Companion", G_APPLICATION_HANDLES_OPEN);
    g_signal_connect(app, "activate", G_CALLBACK(on_activate), NULL);
    g_signal_connect(app, "open", G_CALLBACK(on_open), NULL);

    g_application_hold(G_APPLICATION(app));

    return g_application_run(G_APPLICATION(app), argc, argv);
}
