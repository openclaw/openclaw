/*
 * section_sessions.c
 *
 * Sessions section controller for the OpenClaw Linux Companion App.
 *
 * Complete native session management: list with detail cards, token
 * usage, thinking/verbose levels, and Reset/Compact/Delete mutation
 * actions. RPC fetch via sessions.list.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "section_sessions.h"
#include "gateway_rpc.h"
#include "gateway_data.h"
#include "gateway_mutations.h"
#include "gateway_config.h"
#include "gateway_client.h"
#include <adwaita.h>

/* ── State ───────────────────────────────────────────────────────── */

static GtkWidget *sessions_list_box = NULL;
static GtkWidget *sessions_status_label = NULL;
static GatewaySessionsData *sessions_data_cache = NULL;
static gboolean sessions_fetch_in_flight = FALSE;
static gint64 sessions_last_fetch_us = 0;

/* Forward declarations */
static void sessions_rebuild_list(void);
static void sessions_force_refresh(void);

/* ── Dashboard handoff ───────────────────────────────────────────── */

extern GatewayConfig* gateway_client_get_config(void);

static void on_open_dashboard(GtkButton *b, gpointer d) {
    (void)b; (void)d;
    GatewayConfig *cfg = gateway_client_get_config();
    if (!cfg) return;
    g_autofree gchar *url = gateway_config_dashboard_url(cfg);
    if (url) g_app_info_launch_default_for_uri(url, NULL, NULL);
}

/* ── Mutation callbacks ──────────────────────────────────────────── */

static void on_mutation_done(const GatewayRpcResponse *response, gpointer user_data) {
    (void)user_data;
    if (!sessions_status_label) return;

    if (!response->ok) {
        g_autofree gchar *msg = g_strdup_printf("Error: %s",
            response->error_msg ? response->error_msg : "unknown");
        gtk_label_set_text(GTK_LABEL(sessions_status_label), msg);
    }

    sessions_force_refresh();
}

/* ── Action handlers ─────────────────────────────────────────────── */

static void on_session_reset(GtkButton *btn, gpointer user_data) {
    (void)user_data;
    const gchar *key = (const gchar *)g_object_get_data(G_OBJECT(btn), "session-key");
    if (!key) return;

    gtk_widget_set_sensitive(GTK_WIDGET(btn), FALSE);
    if (sessions_status_label)
        gtk_label_set_text(GTK_LABEL(sessions_status_label), "Resetting\u2026");

    g_autofree gchar *req = mutation_sessions_reset(key, on_mutation_done, NULL);
    if (!req) {
        gtk_widget_set_sensitive(GTK_WIDGET(btn), TRUE);
        if (sessions_status_label)
            gtk_label_set_text(GTK_LABEL(sessions_status_label), "Failed to send request");
    }
}

static void on_session_compact(GtkButton *btn, gpointer user_data) {
    (void)user_data;
    const gchar *key = (const gchar *)g_object_get_data(G_OBJECT(btn), "session-key");
    if (!key) return;

    gtk_widget_set_sensitive(GTK_WIDGET(btn), FALSE);
    if (sessions_status_label)
        gtk_label_set_text(GTK_LABEL(sessions_status_label), "Compacting\u2026");

    g_autofree gchar *req = mutation_sessions_compact(key, on_mutation_done, NULL);
    if (!req) {
        gtk_widget_set_sensitive(GTK_WIDGET(btn), TRUE);
        if (sessions_status_label)
            gtk_label_set_text(GTK_LABEL(sessions_status_label), "Failed to send request");
    }
}

static void on_thinking_changed(GObject *gobject, GParamSpec *pspec, gpointer user_data) {
    (void)pspec; (void)user_data;
    const gchar *key = (const gchar *)g_object_get_data(gobject, "session-key");
    if (!key) return;

    gint idx = adw_combo_row_get_selected(ADW_COMBO_ROW(gobject));
    const gchar *level = "medium";
    if (idx == 0) level = "low";
    else if (idx == 2) level = "high";

    if (sessions_status_label)
        gtk_label_set_text(GTK_LABEL(sessions_status_label), "Updating\u2026");

    g_autofree gchar *req = mutation_sessions_patch(key, level, NULL, on_mutation_done, NULL);
    if (!req && sessions_status_label) {
        gtk_label_set_text(GTK_LABEL(sessions_status_label), "Failed to send request");
    }
}

static void on_verbose_changed(GObject *gobject, GParamSpec *pspec, gpointer user_data) {
    (void)pspec; (void)user_data;
    const gchar *key = (const gchar *)g_object_get_data(gobject, "session-key");
    if (!key) return;

    gint idx = adw_combo_row_get_selected(ADW_COMBO_ROW(gobject));
    const gchar *level = "none";
    if (idx == 1) level = "low";
    else if (idx == 2) level = "high";

    if (sessions_status_label)
        gtk_label_set_text(GTK_LABEL(sessions_status_label), "Updating\u2026");

    g_autofree gchar *req = mutation_sessions_patch(key, NULL, level, on_mutation_done, NULL);
    if (!req && sessions_status_label) {
        gtk_label_set_text(GTK_LABEL(sessions_status_label), "Failed to send request");
    }
}

/* Delete confirmation dialog */
static void on_delete_dialog_response(GObject *source, GAsyncResult *result, gpointer user_data) {
    AdwAlertDialog *dialog = ADW_ALERT_DIALOG(source);
    (void)user_data;

    const gchar *response_id = adw_alert_dialog_choose_finish(dialog, result);
    if (g_strcmp0(response_id, "delete") != 0) return;

    const gchar *key = g_object_get_data(G_OBJECT(dialog), "session-key");
    if (!key) return;

    if (sessions_status_label)
        gtk_label_set_text(GTK_LABEL(sessions_status_label), "Deleting\u2026");

    g_autofree gchar *req = mutation_sessions_delete(key, TRUE, on_mutation_done, NULL);
    if (!req && sessions_status_label) {
        gtk_label_set_text(GTK_LABEL(sessions_status_label), "Failed to send request");
    }
}

static void on_session_delete(GtkButton *btn, gpointer user_data) {
    (void)user_data;
    const gchar *key = (const gchar *)g_object_get_data(G_OBJECT(btn), "session-key");
    const gchar *name = (const gchar *)g_object_get_data(G_OBJECT(btn), "session-name");
    if (!key) return;

    g_autofree gchar *body = g_strdup_printf(
        "Delete session \"%s\"? This also removes the transcript.", name ? name : key);

    AdwAlertDialog *dialog = ADW_ALERT_DIALOG(
        adw_alert_dialog_new("Delete Session", body));
    adw_alert_dialog_add_responses(dialog, "cancel", "Cancel", "delete", "Delete", NULL);
    adw_alert_dialog_set_response_appearance(dialog, "delete", ADW_RESPONSE_DESTRUCTIVE);
    adw_alert_dialog_set_default_response(dialog, "cancel");
    adw_alert_dialog_set_close_response(dialog, "cancel");

    g_object_set_data_full(G_OBJECT(dialog), "session-key", g_strdup(key), g_free);

    GtkWidget *toplevel = GTK_WIDGET(gtk_widget_get_root(GTK_WIDGET(btn)));
    adw_alert_dialog_choose(dialog, toplevel, NULL, on_delete_dialog_response, NULL);
}

/* G1: Helper to insert route before #token fragment */
static gchar* dashboard_url_with_route(const gchar *base_url, const gchar *route) {
    if (!base_url || !route) return NULL;
    
    /* Find fragment marker */
    const gchar *fragment = strchr(base_url, '#');
    if (fragment) {
        /* Insert route before fragment */
        gsize base_len = fragment - base_url;
        /* Ensure base ends with / */
        gboolean needs_slash = (base_len == 0 || base_url[base_len - 1] != '/');
        return g_strdup_printf("%.*s%s%s%s",
                              (int)base_len, base_url,
                              needs_slash ? "/" : "",
                              route, fragment);
    } else {
        /* No fragment, append route normally */
        gboolean needs_slash = base_url[strlen(base_url) - 1] != '/';
        return g_strdup_printf("%s%s%s",
                              base_url,
                              needs_slash ? "/" : "",
                              route);
    }
}

static void on_session_log(GtkButton *btn, gpointer user_data) {
    (void)user_data;
    const gchar *key = (const gchar *)g_object_get_data(G_OBJECT(btn), "session-key");
    if (!key) return;

    /* Implement Resource Locality Rule:
       If we have the store path from the data cache, try to open the local log file first.
       If it exists and is readable, open it directly.
       Otherwise, fall back to the dashboard web route. */
    if (sessions_data_cache && sessions_data_cache->path) {
        g_autofree gchar *store_dir = g_path_get_dirname(sessions_data_cache->path);
        g_autofree gchar *local_path = g_build_filename(store_dir, key, "transcript.jsonl", NULL);
        if (g_file_test(local_path, G_FILE_TEST_EXISTS | G_FILE_TEST_IS_REGULAR)) {
            g_autofree gchar *file_uri = g_filename_to_uri(local_path, NULL, NULL);
            if (file_uri) {
                g_app_info_launch_default_for_uri(file_uri, NULL, NULL);
                return; /* Successfully launched local file */
            }
        }
    }

    /* Fallback: Dashboard web route */
    GatewayConfig *cfg = gateway_client_get_config();
    if (!cfg) return;

    g_autofree gchar *url = gateway_config_dashboard_url(cfg);
    if (!url) return;

    /* Dashboard route for session logs: chat/:sessionKey */
    g_autofree gchar *route = g_strdup_printf("chat/%s", key);
    g_autofree gchar *log_url = dashboard_url_with_route(url, route);
    if (log_url) {
        g_app_info_launch_default_for_uri(log_url, NULL, NULL);
    }
}

/* ── Helpers ─────────────────────────────────────────────────────── */

static gchar* format_relative_time(gint64 updated_at_ms) {
    if (updated_at_ms <= 0) return g_strdup("\u2014");

    gint64 now_us = g_get_real_time();
    gint64 now_ms = now_us / 1000;
    gint64 diff_s = (now_ms - updated_at_ms) / 1000;

    if (diff_s < 0) diff_s = 0;
    if (diff_s < 60) return g_strdup("just now");
    if (diff_s < 3600) return g_strdup_printf("%ldm ago", (long)(diff_s / 60));
    if (diff_s < 86400) return g_strdup_printf("%ldh ago", (long)(diff_s / 3600));
    return g_strdup_printf("%ldd ago", (long)(diff_s / 86400));
}

/* ── Session card builder ────────────────────────────────────────── */

static void build_session_card(GatewaySession *s) {
    GtkWidget *frame = gtk_frame_new(NULL);
    gtk_widget_set_margin_top(frame, 6);
    gtk_widget_set_margin_bottom(frame, 2);

    GtkWidget *card = gtk_box_new(GTK_ORIENTATION_VERTICAL, 4);
    gtk_widget_set_margin_start(card, 12);
    gtk_widget_set_margin_end(card, 12);
    gtk_widget_set_margin_top(card, 10);
    gtk_widget_set_margin_bottom(card, 10);

    /* ── Header row: dot + name + channel + model ── */
    GtkWidget *hdr = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);

    /* Status dot */
    const gchar *dot_text = "\u25CB", *dot_class = "dim-label";
    if (s->status && g_strcmp0(s->status, "running") == 0) {
        dot_text = "\u25CF"; dot_class = "success";
    } else if (s->status && (g_strcmp0(s->status, "failed") == 0 ||
                              g_strcmp0(s->status, "killed") == 0 ||
                              g_strcmp0(s->status, "timeout") == 0)) {
        dot_text = "\u25CF"; dot_class = "error";
    } else if (s->status && g_strcmp0(s->status, "done") == 0) {
        dot_text = "\u25CF"; dot_class = "dim-label";
    }
    GtkWidget *dot = gtk_label_new(dot_text);
    gtk_widget_add_css_class(dot, dot_class);
    gtk_box_append(GTK_BOX(hdr), dot);

    /* Session name */
    const gchar *name_str = s->display_name ? s->display_name : s->key;
    GtkWidget *name_lbl = gtk_label_new(name_str);
    gtk_widget_add_css_class(name_lbl, "heading");
    gtk_label_set_xalign(GTK_LABEL(name_lbl), 0.0);
    gtk_label_set_ellipsize(GTK_LABEL(name_lbl), PANGO_ELLIPSIZE_END);
    gtk_widget_set_hexpand(name_lbl, TRUE);
    gtk_box_append(GTK_BOX(hdr), name_lbl);

    /* Kind badge */
    if (s->kind) {
        GtkWidget *kind_lbl = gtk_label_new(s->kind);
        gtk_widget_add_css_class(kind_lbl, "dim-label");
        gtk_box_append(GTK_BOX(hdr), kind_lbl);
    }

    gtk_box_append(GTK_BOX(card), hdr);

    /* ── Detail row: channel | model | updated ── */
    GtkWidget *detail = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 12);

    if (s->channel) {
        GtkWidget *ch = gtk_label_new(s->channel);
        gtk_widget_add_css_class(ch, "dim-label");
        gtk_box_append(GTK_BOX(detail), ch);
    }

    if (s->model) {
        GtkWidget *ml = gtk_label_new(s->model);
        gtk_widget_add_css_class(ml, "dim-label");
        gtk_box_append(GTK_BOX(detail), ml);
    }

    if (s->updated_at > 0) {
        g_autofree gchar *rel = format_relative_time(s->updated_at);
        GtkWidget *ts = gtk_label_new(rel);
        gtk_widget_add_css_class(ts, "dim-label");
        gtk_box_append(GTK_BOX(detail), ts);
    }

    if (s->status) {
        GtkWidget *st = gtk_label_new(s->status);
        const gchar *st_cls = "dim-label";
        if (g_strcmp0(s->status, "running") == 0) st_cls = "success";
        else if (g_strcmp0(s->status, "failed") == 0) st_cls = "error";
        gtk_widget_add_css_class(st, st_cls);
        gtk_box_append(GTK_BOX(detail), st);
    }

    gtk_box_append(GTK_BOX(card), detail);

    /* ── Subject ── */
    if (s->subject) {
        GtkWidget *subj = gtk_label_new(s->subject);
        gtk_widget_add_css_class(subj, "dim-label");
        gtk_label_set_xalign(GTK_LABEL(subj), 0.0);
        gtk_label_set_ellipsize(GTK_LABEL(subj), PANGO_ELLIPSIZE_END);
        gtk_label_set_max_width_chars(GTK_LABEL(subj), 80);
        gtk_box_append(GTK_BOX(card), subj);
    }

    /* ── Token usage ── */
    if (s->total_tokens > 0 || s->context_tokens > 0) {
        g_autofree gchar *tok_text = g_strdup_printf(
            "Tokens: %d in / %d out / %d total (ctx: %d)",
            s->input_tokens, s->output_tokens, s->total_tokens, s->context_tokens);
        GtkWidget *tok = gtk_label_new(tok_text);
        gtk_widget_add_css_class(tok, "dim-label");
        gtk_widget_add_css_class(tok, "monospace");
        gtk_label_set_xalign(GTK_LABEL(tok), 0.0);
        gtk_box_append(GTK_BOX(card), tok);
    }

    /* ── Action buttons ── */
    GtkWidget *actions = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 6);
    gtk_widget_set_margin_top(actions, 6);

    /* Thinking level dropdown */
    GtkStringList *think_model = gtk_string_list_new((const char * const[]){
        "low", "medium", "high", NULL
    });
    GtkWidget *think_combo = adw_combo_row_new();
    adw_combo_row_set_model(ADW_COMBO_ROW(think_combo), G_LIST_MODEL(think_model));
    adw_preferences_row_set_title(ADW_PREFERENCES_ROW(think_combo), "Thinking");
    gtk_widget_add_css_class(think_combo, "flat");
    
    gint think_idx = 1; /* default medium */
    if (s->thinking_level) {
        if (g_strcmp0(s->thinking_level, "low") == 0) think_idx = 0;
        else if (g_strcmp0(s->thinking_level, "high") == 0) think_idx = 2;
    }
    adw_combo_row_set_selected(ADW_COMBO_ROW(think_combo), think_idx);
    g_object_set_data_full(G_OBJECT(think_combo), "session-key", g_strdup(s->key), g_free);
    g_signal_connect(think_combo, "notify::selected", G_CALLBACK(on_thinking_changed), NULL);
    gtk_box_append(GTK_BOX(actions), think_combo);

    /* Verbose level dropdown */
    GtkStringList *verb_model = gtk_string_list_new((const char * const[]){
        "none", "low", "high", NULL
    });
    GtkWidget *verb_combo = adw_combo_row_new();
    adw_combo_row_set_model(ADW_COMBO_ROW(verb_combo), G_LIST_MODEL(verb_model));
    adw_preferences_row_set_title(ADW_PREFERENCES_ROW(verb_combo), "Verbose");
    gtk_widget_add_css_class(verb_combo, "flat");
    
    gint verb_idx = 0; /* default none */
    if (s->verbose_level) {
        if (g_strcmp0(s->verbose_level, "low") == 0) verb_idx = 1;
        else if (g_strcmp0(s->verbose_level, "high") == 0) verb_idx = 2;
    }
    adw_combo_row_set_selected(ADW_COMBO_ROW(verb_combo), verb_idx);
    g_object_set_data_full(G_OBJECT(verb_combo), "session-key", g_strdup(s->key), g_free);
    g_signal_connect(verb_combo, "notify::selected", G_CALLBACK(on_verbose_changed), NULL);
    gtk_box_append(GTK_BOX(actions), verb_combo);

    /* Reset */
    GtkWidget *btn_reset = gtk_button_new_with_label("Reset");
    gtk_widget_add_css_class(btn_reset, "flat");
    g_object_set_data_full(G_OBJECT(btn_reset), "session-key", g_strdup(s->key), g_free);
    g_signal_connect(btn_reset, "clicked", G_CALLBACK(on_session_reset), NULL);
    gtk_box_append(GTK_BOX(actions), btn_reset);

    /* Log */
    GtkWidget *btn_log = gtk_button_new_with_label("Log");
    gtk_widget_add_css_class(btn_log, "flat");
    g_object_set_data_full(G_OBJECT(btn_log), "session-key", g_strdup(s->key), g_free);
    g_signal_connect(btn_log, "clicked", G_CALLBACK(on_session_log), NULL);
    gtk_box_append(GTK_BOX(actions), btn_log);
    GtkWidget *btn_compact = gtk_button_new_with_label("Compact");
    gtk_widget_add_css_class(btn_compact, "flat");
    g_object_set_data_full(G_OBJECT(btn_compact), "session-key", g_strdup(s->key), g_free);
    g_signal_connect(btn_compact, "clicked", G_CALLBACK(on_session_compact), NULL);
    gtk_box_append(GTK_BOX(actions), btn_compact);

    /* Delete */
    GtkWidget *btn_del = gtk_button_new_with_label("Delete");
    gtk_widget_add_css_class(btn_del, "flat");
    gtk_widget_add_css_class(btn_del, "destructive-action");
    g_object_set_data_full(G_OBJECT(btn_del), "session-key", g_strdup(s->key), g_free);
    g_object_set_data_full(G_OBJECT(btn_del), "session-name", g_strdup(name_str), g_free);
    g_signal_connect(btn_del, "clicked", G_CALLBACK(on_session_delete), NULL);
    gtk_box_append(GTK_BOX(actions), btn_del);

    gtk_box_append(GTK_BOX(card), actions);

    gtk_frame_set_child(GTK_FRAME(frame), card);
    gtk_box_append(GTK_BOX(sessions_list_box), frame);
}

/* ── List rebuild ────────────────────────────────────────────────── */

static void sessions_rebuild_list(void) {
    if (!sessions_list_box) return;

    section_box_clear(sessions_list_box);

    if (!sessions_data_cache || sessions_data_cache->n_sessions == 0) {
        GtkWidget *empty = gtk_label_new("No sessions.");
        gtk_widget_add_css_class(empty, "dim-label");
        gtk_label_set_xalign(GTK_LABEL(empty), 0.0);
        gtk_box_append(GTK_BOX(sessions_list_box), empty);
        return;
    }

    for (gint i = 0; i < sessions_data_cache->n_sessions; i++) {
        build_session_card(&sessions_data_cache->sessions[i]);
    }
}

/* ── RPC callback ────────────────────────────────────────────────── */

static void on_sessions_rpc_response(const GatewayRpcResponse *response, gpointer user_data) {
    (void)user_data;
    sessions_fetch_in_flight = FALSE;

    if (!sessions_list_box) return;

    if (!response->ok) {
        if (sessions_status_label) {
            g_autofree gchar *msg = g_strdup_printf("Error: %s",
                response->error_msg ? response->error_msg : "unknown");
            gtk_label_set_text(GTK_LABEL(sessions_status_label), msg);
        }
        return;
    }

    section_mark_fresh(&sessions_last_fetch_us);
    gateway_sessions_data_free(sessions_data_cache);
    sessions_data_cache = gateway_data_parse_sessions(response->payload);

    if (sessions_status_label) {
        if (sessions_data_cache) {
            g_autofree gchar *msg = g_strdup_printf("%d session%s",
                sessions_data_cache->n_sessions,
                sessions_data_cache->n_sessions == 1 ? "" : "s");
            gtk_label_set_text(GTK_LABEL(sessions_status_label), msg);
        } else {
            gtk_label_set_text(GTK_LABEL(sessions_status_label), "Failed to parse response");
        }
    }

    sessions_rebuild_list();
}

/* ── Force refresh (after mutation) ──────────────────────────────── */

static void sessions_force_refresh(void) {
    section_mark_stale(&sessions_last_fetch_us);
    sessions_fetch_in_flight = FALSE;

    if (!sessions_list_box) return;
    if (!gateway_rpc_is_ready()) return;

    sessions_fetch_in_flight = TRUE;
    g_autofree gchar *req_id = gateway_rpc_request(
        "sessions.list", NULL, 0, on_sessions_rpc_response, NULL);
    if (!req_id) {
        sessions_fetch_in_flight = FALSE;
    }
}

/* ── SectionController callbacks ─────────────────────────────────── */

static GtkWidget* sessions_build(void) {
    GtkWidget *scrolled = gtk_scrolled_window_new();
    gtk_scrolled_window_set_policy(GTK_SCROLLED_WINDOW(scrolled),
                                   GTK_POLICY_NEVER, GTK_POLICY_AUTOMATIC);

    GtkWidget *page = gtk_box_new(GTK_ORIENTATION_VERTICAL, 8);
    gtk_widget_set_margin_start(page, 24);
    gtk_widget_set_margin_end(page, 24);
    gtk_widget_set_margin_top(page, 24);
    gtk_widget_set_margin_bottom(page, 24);

    GtkWidget *title = gtk_label_new("Sessions");
    gtk_widget_add_css_class(title, "title-1");
    gtk_label_set_xalign(GTK_LABEL(title), 0.0);
    gtk_box_append(GTK_BOX(page), title);

    sessions_status_label = gtk_label_new("Loading\u2026");
    gtk_widget_add_css_class(sessions_status_label, "dim-label");
    gtk_label_set_xalign(GTK_LABEL(sessions_status_label), 0.0);
    gtk_box_append(GTK_BOX(page), sessions_status_label);

    /* Dashboard handoff button */
    GtkWidget *btn = gtk_button_new_with_label("Open in Dashboard");
    gtk_widget_add_css_class(btn, "flat");
    gtk_widget_set_halign(btn, GTK_ALIGN_START);
    g_signal_connect(btn, "clicked", G_CALLBACK(on_open_dashboard), NULL);
    gtk_box_append(GTK_BOX(page), btn);

    GtkWidget *sep = gtk_separator_new(GTK_ORIENTATION_HORIZONTAL);
    gtk_widget_set_margin_top(sep, 4);
    gtk_widget_set_margin_bottom(sep, 4);
    gtk_box_append(GTK_BOX(page), sep);

    sessions_list_box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 0);
    gtk_box_append(GTK_BOX(page), sessions_list_box);

    gtk_scrolled_window_set_child(GTK_SCROLLED_WINDOW(scrolled), page);
    return scrolled;
}

static void sessions_refresh(void) {
    if (!sessions_list_box || sessions_fetch_in_flight) return;
    /* L7: Check readiness BEFORE freshness - disconnected state must win over cache */
    if (!gateway_rpc_is_ready()) {
        if (sessions_status_label)
            gtk_label_set_text(GTK_LABEL(sessions_status_label), "Gateway not connected");
        return;
    }
    if (!section_is_stale(&sessions_last_fetch_us)) return;

    sessions_fetch_in_flight = TRUE;
    g_autofree gchar *req_id = gateway_rpc_request(
        "sessions.list", NULL, 0, on_sessions_rpc_response, NULL);
    if (!req_id) {
        sessions_fetch_in_flight = FALSE;
        if (sessions_status_label)
            gtk_label_set_text(GTK_LABEL(sessions_status_label), "Failed to send request");
    }
}

static void sessions_destroy(void) {
    sessions_list_box = NULL;
    sessions_status_label = NULL;
    sessions_fetch_in_flight = FALSE;
    gateway_sessions_data_free(sessions_data_cache);
    sessions_data_cache = NULL;
    sessions_last_fetch_us = 0;
}

static void sessions_invalidate(void) {
    section_mark_stale(&sessions_last_fetch_us);
}

/* ── Public ──────────────────────────────────────────────────────── */

static const SectionController sessions_controller = {
    .build      = sessions_build,
    .refresh    = sessions_refresh,
    .destroy    = sessions_destroy,
    .invalidate = sessions_invalidate,
};

const SectionController* section_sessions_get(void) {
    return &sessions_controller;
}
