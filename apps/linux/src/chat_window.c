/*
 * chat_window.c
 *
 * Standalone chat window. Owns its own `ChatController` instance (see
 * chat_controller.{c,h}) and drives it directly: no singleton accessor,
 * no `SectionController` vtable indirection. The main settings window
 * neither builds nor embeds chat; this window neither builds nor
 * embeds settings.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "chat_window.h"

#include <adwaita.h>
#include <glib.h>

#include "chat_controller.h"
#include "test_seams.h"
#include "log.h"

/* ── Window-scoped state ── */

static GtkWidget      *s_window           = NULL;
static ChatController *s_chat_controller  = NULL;
static guint           s_refresh_timer_id = 0;
static gboolean        s_shutting_down    = FALSE;

/* ── Helpers ── */

static gboolean on_refresh_tick(gpointer user_data) {
    (void)user_data;
    if (s_chat_controller) {
        chat_controller_refresh(s_chat_controller);
    }
    return G_SOURCE_CONTINUE;
}

static void on_window_destroy(GtkWindow *window, gpointer user_data) {
    (void)window;
    (void)user_data;
    s_shutting_down = TRUE;

    if (s_refresh_timer_id != 0) {
        g_source_remove(s_refresh_timer_id);
        s_refresh_timer_id = 0;
    }
    if (s_chat_controller) {
        chat_controller_destroy(s_chat_controller);
        s_chat_controller = NULL;
    }

    s_window = NULL;
    s_shutting_down = FALSE;

    OC_LOG_INFO(OPENCLAW_LOG_CAT_TRAY, "chat window closed");
}

/* ── Public API ── */

void chat_window_show(void) {
    GApplication *app = g_application_get_default();
    ChatWindowShowAction action =
        chat_window_show_decide(app != NULL, s_window != NULL);

    switch (action) {
    case CHAT_WINDOW_ACTION_IGNORE_NO_APP:
        OC_LOG_WARN(OPENCLAW_LOG_CAT_TRAY,
                    "chat_window_show: no GApplication bound; ignoring");
        return;
    case CHAT_WINDOW_ACTION_PRESENT_EXISTING:
        gtk_window_present(GTK_WINDOW(s_window));
        return;
    case CHAT_WINDOW_ACTION_BUILD_AND_PRESENT:
        break;
    }

    /*
     * Instantiate the chat controller up front so a failure to acquire
     * the single-live-instance slot aborts the window build before we
     * allocate any Adwaita widgets.
     */
    s_chat_controller = chat_controller_new();
    if (!s_chat_controller) {
        OC_LOG_WARN(OPENCLAW_LOG_CAT_TRAY,
                    "chat_window_show: a ChatController is already live; "
                    "refusing to build a second chat window");
        return;
    }

    s_window = adw_application_window_new(GTK_APPLICATION(app));
    gtk_window_set_title(GTK_WINDOW(s_window), "OpenClaw Chat");
    gtk_window_set_default_size(GTK_WINDOW(s_window), 520, 760);

    GtkWidget *chat_root = chat_controller_build(s_chat_controller);
    if (!chat_root) {
        OC_LOG_WARN(OPENCLAW_LOG_CAT_TRAY,
                    "chat_window_show: chat controller returned no widget");
        gtk_window_destroy(GTK_WINDOW(s_window));
        s_window = NULL;
        chat_controller_destroy(s_chat_controller);
        s_chat_controller = NULL;
        return;
    }

    /* Toolbar view with headerbar (matches the main window's Adwaita chrome). */
    GtkWidget *toolbar_view = adw_toolbar_view_new();
    GtkWidget *header = adw_header_bar_new();
    adw_toolbar_view_add_top_bar(ADW_TOOLBAR_VIEW(toolbar_view), header);
    adw_toolbar_view_set_content(ADW_TOOLBAR_VIEW(toolbar_view), chat_root);
    adw_application_window_set_content(ADW_APPLICATION_WINDOW(s_window), toolbar_view);

    g_signal_connect(s_window, "destroy", G_CALLBACK(on_window_destroy), NULL);

    /* Initial fetch + periodic refresh, mirroring the main window cadence. */
    chat_controller_refresh(s_chat_controller);
    s_refresh_timer_id = g_timeout_add_seconds(1, on_refresh_tick, NULL);

    gtk_window_present(GTK_WINDOW(s_window));
    OC_LOG_INFO(OPENCLAW_LOG_CAT_TRAY, "chat window presented");
}

void chat_window_hide(void) {
    if (!s_window || s_shutting_down) return;
    gtk_window_close(GTK_WINDOW(s_window));
    /* on_window_destroy performs the actual teardown. */
}

gboolean chat_window_is_visible(void) {
    return s_window != NULL;
}
