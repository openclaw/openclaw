/*
 * pairing_bootstrap_window.c
 *
 * Fallback window shown when the gateway returns PAIRING_REQUIRED during
 * the connect handshake. The operator must approve the Linux companion
 * from an already-paired admin UI before the transport can resume.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "pairing_bootstrap_window.h"
#include "gateway_ws.h"
#include "log.h"

#include <adwaita.h>
#include <glib.h>

/* ────────────────── pure helpers (tested headlessly) ────────────────── */

gchar* pairing_bootstrap_cli_command_for_request(const gchar *request_id) {
    if (request_id && request_id[0]) {
        return g_strdup_printf("openclaw devices pair approve %s", request_id);
    }
    /*
     * No requestId was carried on the PAIRING_REQUIRED detail (e.g. the
     * gateway rejected before assigning one, or the caller only has the
     * pairing_required flag). Point the operator at the discovery command
     * so they can look up the pending request on this machine.
     */
    return g_strdup("openclaw devices pair list");
}

/* ────────────────── singleton window state ────────────────── */

static GtkWindow *s_window = NULL;

/* Live labels inside the singleton so successive show() calls can update
 * request_id / device_id / detail without rebuilding the window. */
static GtkWidget *s_request_label = NULL;
static GtkWidget *s_device_label  = NULL;
static GtkWidget *s_detail_label  = NULL;
static GtkWidget *s_cli_label     = NULL;
static GtkWidget *s_copy_button   = NULL;

/*
 * Cached, authoritative state for the currently-visible bootstrap window.
 *
 * Each of these is set only when show() is called with a non-empty
 * value; NULL/empty inputs are ignored so the tray "Pairing…" re-present
 * path and any other caller that has lost the original metadata cannot
 * downgrade what the operator is looking at.
 *
 * All four strings are owned by this translation unit and freed on
 * window destroy. `s_current_cli` is recomputed from `s_current_request_id`
 * whenever the request id changes.
 */
static gchar *s_current_request_id = NULL;
static gchar *s_current_device_id  = NULL;
static gchar *s_current_detail     = NULL;
static gchar *s_current_cli        = NULL;

static void on_window_destroyed(gpointer data, GObject *where_the_object_was) {
    (void)data;
    if ((GObject *)s_window == where_the_object_was) {
        s_window = NULL;
        s_request_label = NULL;
        s_device_label  = NULL;
        s_detail_label  = NULL;
        s_cli_label     = NULL;
        s_copy_button   = NULL;
        g_clear_pointer(&s_current_request_id, g_free);
        g_clear_pointer(&s_current_device_id,  g_free);
        g_clear_pointer(&s_current_detail,     g_free);
        g_clear_pointer(&s_current_cli,        g_free);
    }
}

/*
 * Treat NULL and empty strings the same: a caller that has no data to
 * share must not overwrite cached state. Use at every update entry
 * point.
 */
static inline gboolean is_meaningful(const gchar *s) {
    return s != NULL && s[0] != '\0';
}

static void on_check_again_clicked(GtkButton *button, gpointer user_data) {
    (void)button;
    (void)user_data;
    OC_LOG_INFO(OPENCLAW_LOG_CAT_GATEWAY,
                "pairing bootstrap: operator requested reconnect check");
    gateway_ws_resume_after_pairing_approved();
    /* Keep the window open so the operator sees the status transition. */
}

static void on_dismiss_clicked(GtkButton *button, gpointer user_data) {
    (void)button;
    (void)user_data;
    if (s_window) {
        gtk_window_close(s_window);
    }
}

static void on_copy_cli_clicked(GtkButton *button, gpointer user_data) {
    (void)user_data;
    if (!s_current_cli || !s_current_cli[0]) return;
    GdkDisplay *display = gtk_widget_get_display(GTK_WIDGET(button));
    if (!display) return;
    GdkClipboard *cb = gdk_display_get_clipboard(display);
    if (!cb) return;
    gdk_clipboard_set_text(cb, s_current_cli);
    OC_LOG_INFO(OPENCLAW_LOG_CAT_GATEWAY,
                "pairing bootstrap: CLI command copied to clipboard");
}

/* ────────────────── view update helpers ────────────────── */

/*
 * Render helpers read exclusively from the cached `s_current_*` state.
 * The `show()` entry point is responsible for updating the cache before
 * calling these; the helpers themselves never accept user-supplied
 * strings, which eliminates the "NULL arg clobbers the visible state"
 * regression class at the view layer.
 */

static void render_request_label(void) {
    if (!s_request_label) return;
    if (is_meaningful(s_current_request_id)) {
        g_autofree gchar *escaped =
            g_markup_escape_text(s_current_request_id, -1);
        g_autofree gchar *markup = g_strdup_printf(
            "<small>Pending request: <tt>%s</tt></small>", escaped);
        gtk_label_set_markup(GTK_LABEL(s_request_label), markup);
    } else {
        gtk_label_set_markup(GTK_LABEL(s_request_label),
            "<small><i>No pending request id reported; run the discovery"
            " command below to look it up on this machine.</i></small>");
    }
    gtk_widget_set_visible(s_request_label, TRUE);
}

static void render_device_label(void) {
    if (!s_device_label) return;
    if (is_meaningful(s_current_device_id)) {
        /* Truncate to the first 16 hex chars for display; full ID is
         * selectable if the operator wants to copy it via keyboard. */
        g_autofree gchar *markup = g_strdup_printf(
            "<small>This machine: <tt>%.16s…</tt></small>", s_current_device_id);
        gtk_label_set_markup(GTK_LABEL(s_device_label), markup);
        gtk_widget_set_visible(s_device_label, TRUE);
    } else {
        gtk_widget_set_visible(s_device_label, FALSE);
    }
}

static void render_detail_label(void) {
    if (!s_detail_label) return;
    if (is_meaningful(s_current_detail)) {
        g_autofree gchar *escaped = g_markup_escape_text(s_current_detail, -1);
        g_autofree gchar *markup = g_strdup_printf(
            "<small><i>%s</i></small>", escaped);
        gtk_label_set_markup(GTK_LABEL(s_detail_label), markup);
        gtk_widget_set_visible(s_detail_label, TRUE);
    } else {
        gtk_widget_set_visible(s_detail_label, FALSE);
    }
}

static void render_cli_command(void) {
    g_clear_pointer(&s_current_cli, g_free);
    s_current_cli =
        pairing_bootstrap_cli_command_for_request(s_current_request_id);
    if (s_cli_label) {
        g_autofree gchar *escaped = g_markup_escape_text(s_current_cli, -1);
        g_autofree gchar *markup = g_strdup_printf("<tt>%s</tt>", escaped);
        gtk_label_set_markup(GTK_LABEL(s_cli_label), markup);
    }
    if (s_copy_button) {
        /* Copy is always meaningful — even the `pair list` fallback is
         * something the operator may want to paste into their terminal. */
        gtk_widget_set_sensitive(s_copy_button, s_current_cli != NULL);
    }
}

/*
 * Push all cached state to the visible labels. Called after any change
 * to `s_current_*`.
 */
static void rerender_all(void) {
    render_request_label();
    render_device_label();
    render_detail_label();
    render_cli_command();
}

/*
 * Update the cached fields, honoring the non-clobber contract (see
 * header). Returns TRUE when the request id changed, so callers know
 * to re-render the CLI command specifically.
 */
static gboolean ingest_update(const gchar *request_id,
                              const gchar *device_id,
                              const gchar *detail_message)
{
    gboolean request_changed = FALSE;
    if (is_meaningful(request_id) &&
        g_strcmp0(s_current_request_id, request_id) != 0)
    {
        g_free(s_current_request_id);
        s_current_request_id = g_strdup(request_id);
        request_changed = TRUE;
    }
    if (is_meaningful(device_id) &&
        g_strcmp0(s_current_device_id, device_id) != 0)
    {
        g_free(s_current_device_id);
        s_current_device_id = g_strdup(device_id);
    }
    if (is_meaningful(detail_message) &&
        g_strcmp0(s_current_detail, detail_message) != 0)
    {
        g_free(s_current_detail);
        s_current_detail = g_strdup(detail_message);
    }
    return request_changed;
}

/* ────────────────── window construction ────────────────── */

static GtkWindow* build_window(GtkWindow *parent)
{
    GtkWidget *win = adw_window_new();
    gtk_window_set_title(GTK_WINDOW(win), "Pairing required");
    gtk_window_set_default_size(GTK_WINDOW(win), 560, 420);
    gtk_window_set_modal(GTK_WINDOW(win), FALSE);
    gtk_window_set_hide_on_close(GTK_WINDOW(win), FALSE);
    if (parent) {
        gtk_window_set_transient_for(GTK_WINDOW(win), parent);
    }

    GtkWidget *header = adw_header_bar_new();
    GtkWidget *toolbar_view = adw_toolbar_view_new();
    adw_toolbar_view_add_top_bar(ADW_TOOLBAR_VIEW(toolbar_view), header);

    GtkWidget *content = gtk_box_new(GTK_ORIENTATION_VERTICAL, 12);
    gtk_widget_set_margin_start(content, 24);
    gtk_widget_set_margin_end(content, 24);
    gtk_widget_set_margin_top(content, 18);
    gtk_widget_set_margin_bottom(content, 18);

    /* ── Title ── */
    GtkWidget *title = gtk_label_new(NULL);
    gtk_label_set_markup(GTK_LABEL(title),
        "<b>This Linux machine is waiting for pairing approval</b>");
    gtk_label_set_xalign(GTK_LABEL(title), 0.0);
    gtk_label_set_wrap(GTK_LABEL(title), TRUE);
    gtk_box_append(GTK_BOX(content), title);

    /*
     * Explanation — Linux-first. Local CLI is the canonical fallback on this
     * OS; an already-paired operator UI (Control UI in a browser, macOS
     * companion, etc.) is mentioned only as an optional alternate approver
     * so we don't mislead operators who don't have another OS.
     */
    GtkWidget *explain = gtk_label_new(
        "Approve this pairing request to let the Linux companion connect "
        "to the gateway. On this machine, run the command below in a "
        "terminal to approve locally. Alternatively, if you already have "
        "another authorized operator surface paired with this gateway — "
        "such as the Control UI in a browser or the macOS companion — "
        "you can approve from there instead. Once approved, come back "
        "here and press “Check again”.");
    gtk_label_set_xalign(GTK_LABEL(explain), 0.0);
    gtk_label_set_wrap(GTK_LABEL(explain), TRUE);
    gtk_box_append(GTK_BOX(content), explain);

    /* ── Actionable request metadata ── */
    s_request_label = gtk_label_new(NULL);
    gtk_label_set_xalign(GTK_LABEL(s_request_label), 0.0);
    gtk_label_set_wrap(GTK_LABEL(s_request_label), TRUE);
    gtk_label_set_selectable(GTK_LABEL(s_request_label), TRUE);
    gtk_box_append(GTK_BOX(content), s_request_label);

    s_device_label = gtk_label_new(NULL);
    gtk_label_set_xalign(GTK_LABEL(s_device_label), 0.0);
    gtk_label_set_wrap(GTK_LABEL(s_device_label), TRUE);
    gtk_label_set_selectable(GTK_LABEL(s_device_label), TRUE);
    gtk_box_append(GTK_BOX(content), s_device_label);

    /* ── CLI fallback block ── */
    GtkWidget *cli_heading = gtk_label_new(NULL);
    gtk_label_set_markup(GTK_LABEL(cli_heading),
        "<b>Approve locally from this machine’s terminal</b>");
    gtk_label_set_xalign(GTK_LABEL(cli_heading), 0.0);
    gtk_widget_set_margin_top(cli_heading, 8);
    gtk_box_append(GTK_BOX(content), cli_heading);

    GtkWidget *cli_row = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
    gtk_widget_set_halign(cli_row, GTK_ALIGN_FILL);

    GtkWidget *cli_frame = gtk_frame_new(NULL);
    gtk_widget_set_hexpand(cli_frame, TRUE);
    s_cli_label = gtk_label_new(NULL);
    gtk_label_set_xalign(GTK_LABEL(s_cli_label), 0.0);
    gtk_label_set_selectable(GTK_LABEL(s_cli_label), TRUE);
    gtk_label_set_wrap(GTK_LABEL(s_cli_label), FALSE);
    gtk_widget_set_margin_start(s_cli_label, 10);
    gtk_widget_set_margin_end(s_cli_label, 10);
    gtk_widget_set_margin_top(s_cli_label, 6);
    gtk_widget_set_margin_bottom(s_cli_label, 6);
    gtk_frame_set_child(GTK_FRAME(cli_frame), s_cli_label);
    gtk_box_append(GTK_BOX(cli_row), cli_frame);

    s_copy_button = gtk_button_new_from_icon_name("edit-copy-symbolic");
    gtk_widget_set_tooltip_text(s_copy_button, "Copy command to clipboard");
    g_signal_connect(s_copy_button, "clicked", G_CALLBACK(on_copy_cli_clicked), NULL);
    gtk_box_append(GTK_BOX(cli_row), s_copy_button);

    gtk_box_append(GTK_BOX(content), cli_row);

    /* ── Free-form detail (last, so metadata stays above the fold) ── */
    s_detail_label = gtk_label_new(NULL);
    gtk_label_set_xalign(GTK_LABEL(s_detail_label), 0.0);
    gtk_label_set_wrap(GTK_LABEL(s_detail_label), TRUE);
    gtk_widget_set_margin_top(s_detail_label, 6);
    gtk_box_append(GTK_BOX(content), s_detail_label);

    /* ── Button row ── */
    GtkWidget *buttons = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
    gtk_widget_set_halign(buttons, GTK_ALIGN_END);
    gtk_widget_set_margin_top(buttons, 12);

    GtkWidget *dismiss = gtk_button_new_with_label("Dismiss");
    g_signal_connect(dismiss, "clicked", G_CALLBACK(on_dismiss_clicked), NULL);
    gtk_box_append(GTK_BOX(buttons), dismiss);

    GtkWidget *check = gtk_button_new_with_label("Check again");
    gtk_widget_add_css_class(check, "suggested-action");
    g_signal_connect(check, "clicked", G_CALLBACK(on_check_again_clicked), NULL);
    gtk_box_append(GTK_BOX(buttons), check);

    gtk_box_append(GTK_BOX(content), buttons);

    adw_toolbar_view_set_content(ADW_TOOLBAR_VIEW(toolbar_view), content);
    adw_window_set_content(ADW_WINDOW(win), toolbar_view);

    return GTK_WINDOW(win);
}

/* ────────────────── public API ────────────────── */

void pairing_bootstrap_window_show(GtkWindow   *parent,
                                   const gchar *request_id,
                                   const gchar *device_id,
                                   const gchar *detail_message)
{
    gboolean first_build = (s_window == NULL);

    if (first_build) {
        s_window = build_window(parent);
        g_object_weak_ref(G_OBJECT(s_window), on_window_destroyed, NULL);
    } else if (parent) {
        gtk_window_set_transient_for(s_window, parent);
    }

    /*
     * Update the cache non-destructively, then push everything to the
     * view. `ingest_update` silently ignores NULL/empty arguments, so
     * re-present paths that have lost the gateway metadata cannot
     * downgrade what the operator is currently looking at.
     */
    (void)ingest_update(request_id, device_id, detail_message);
    rerender_all();

    gtk_window_present(s_window);
}

void pairing_bootstrap_window_raise(void) {
    if (!s_window) return;
    /*
     * Pure present — no cache mutation, no re-render. The existing
     * labels and CLI command remain exactly as the operator last saw
     * them. Safe to call from any handler that just wants to pull the
     * window to the foreground.
     */
    gtk_window_present(s_window);
}

void pairing_bootstrap_window_hide(void) {
    if (s_window) {
        gtk_window_close(s_window);
    }
}

gboolean pairing_bootstrap_window_is_visible(void) {
    return s_window != NULL && gtk_widget_get_visible(GTK_WIDGET(s_window));
}

/* ────────────────── test-seam accessors ────────────────── */

const gchar* pairing_bootstrap_window_current_request_id(void) {
    return s_current_request_id;
}

const gchar* pairing_bootstrap_window_current_device_id(void) {
    return s_current_device_id;
}

const gchar* pairing_bootstrap_window_current_detail(void) {
    return s_current_detail;
}

const gchar* pairing_bootstrap_window_current_cli_command(void) {
    return s_current_cli;
}

void pairing_bootstrap_window_test_update_state(const gchar *request_id,
                                                const gchar *device_id,
                                                const gchar *detail_message)
{
    /*
     * Exercise the same ingest+render path the live show() uses, but
     * without touching s_window. `rerender_all()` is safe to call when
     * the label widgets are NULL: each render helper guards on its
     * widget pointer before touching GTK. The CLI command computation
     * goes through `pairing_bootstrap_cli_command_for_request()`, which
     * is pure, so `s_current_cli` ends up populated even with no
     * visible window.
     */
    (void)ingest_update(request_id, device_id, detail_message);
    rerender_all();
}

void pairing_bootstrap_window_test_clear_state(void) {
    g_clear_pointer(&s_current_request_id, g_free);
    g_clear_pointer(&s_current_device_id,  g_free);
    g_clear_pointer(&s_current_detail,     g_free);
    g_clear_pointer(&s_current_cli,        g_free);
}
