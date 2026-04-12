/*
 * section_logs.c
 * Description: Logs section controller for tail rendering and level filters.
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "section_logs.h"

#include <adwaita.h>

#include "gateway_rpc.h"
#include "json_access.h"

static GtkWidget *logs_status_label = NULL;
static GtkWidget *logs_text_view = NULL;
static GtkWidget *logs_filter_entry = NULL;
static gboolean logs_fetch_in_flight = FALSE;
static gint64 logs_last_fetch_us = 0;
static guint logs_generation = 1;

typedef struct {
    guint generation;
} LogsRequestContext;

static LogsRequestContext* logs_request_context_new(void) {
    LogsRequestContext *ctx = g_new0(LogsRequestContext, 1);
    ctx->generation = logs_generation;
    return ctx;
}

static gboolean logs_request_context_is_stale(const LogsRequestContext *ctx) {
    return !ctx || ctx->generation != logs_generation;
}

static void logs_request_context_free(gpointer data) {
    g_free(data);
}

static void logs_trigger_fetch(gboolean force);

static void logs_set_text(const gchar *text) {
    if (!logs_text_view) return;
    GtkTextBuffer *buf = gtk_text_view_get_buffer(GTK_TEXT_VIEW(logs_text_view));
    gtk_text_buffer_set_text(buf, text ? text : "", -1);
}

static void on_logs_tail_response(const GatewayRpcResponse *response, gpointer user_data) {
    LogsRequestContext *ctx = (LogsRequestContext *)user_data;
    if (logs_request_context_is_stale(ctx)) {
        logs_request_context_free(ctx);
        return;
    }
    logs_request_context_free(ctx);

    logs_fetch_in_flight = FALSE;

    if (!logs_status_label) return;

    if (!response || !response->ok || !response->payload || !JSON_NODE_HOLDS_OBJECT(response->payload)) {
        gtk_label_set_text(GTK_LABEL(logs_status_label), "Failed to load logs");
        logs_set_text("Could not fetch logs.tail");
        return;
    }

    JsonObject *obj = json_node_get_object(response->payload);
    GString *out = g_string_new(NULL);
    const gchar *filter = logs_filter_entry ? gtk_editable_get_text(GTK_EDITABLE(logs_filter_entry)) : NULL;
    gboolean has_filter = (filter && filter[0] != '\0');
    guint shown = 0;
    guint total = 0;

    gboolean truncated = FALSE;
    gboolean reset = FALSE;
    if (json_object_has_member(obj, "truncated")) {
        JsonNode *tn = json_object_get_member(obj, "truncated");
        if (tn && JSON_NODE_HOLDS_VALUE(tn) && json_node_get_value_type(tn) == G_TYPE_BOOLEAN) {
            truncated = json_node_get_boolean(tn);
        }
    }
    if (json_object_has_member(obj, "reset")) {
        JsonNode *rn = json_object_get_member(obj, "reset");
        if (rn && JSON_NODE_HOLDS_VALUE(rn) && json_node_get_value_type(rn) == G_TYPE_BOOLEAN) {
            reset = json_node_get_boolean(rn);
        }
    }

    if (json_object_has_member(obj, "lines")) {
        JsonNode *ln = json_object_get_member(obj, "lines");
        if (ln && JSON_NODE_HOLDS_ARRAY(ln)) {
            JsonArray *arr = json_node_get_array(ln);
            guint len = json_array_get_length(arr);
            total = len;
            for (guint i = 0; i < len; i++) {
                JsonNode *n = json_array_get_element(arr, i);
                if (n && JSON_NODE_HOLDS_VALUE(n) && json_node_get_value_type(n) == G_TYPE_STRING) {
                    const gchar *line = json_node_get_string(n);
                    if (has_filter && !g_strrstr(line, filter)) continue;
                    g_string_append(out, line);
                    g_string_append_c(out, '\n');
                    shown++;
                }
            }
        }
    } else {
        const gchar *text = oc_json_string_member(obj, "text");
        if (text) {
            g_string_append(out, text);
            shown = 1;
            total = 1;
        }
    }

    if (shown == 0 && total == 0 && !has_filter) {
        g_string_assign(out, "No logs returned by gateway.");
    } else {
        if (shown == 0 && has_filter) {
            g_string_assign(out, "No log lines match the current filter.");
        } else if (shown == 0 && !has_filter) {
            g_string_assign(out, "No log lines available.");
        }
    }

    logs_set_text(out->str);
    g_string_free(out, TRUE);

    section_mark_fresh(&logs_last_fetch_us);
    g_autofree gchar *status = g_strdup_printf("Logs updated | shown %u/%u%s%s",
                                               shown,
                                               total,
                                               truncated ? " | truncated" : "",
                                               reset ? " | reset" : "");
    gtk_label_set_text(GTK_LABEL(logs_status_label), status);
}

static void on_logs_refresh_clicked(GtkButton *button, gpointer user_data) {
    (void)button;
    (void)user_data;
    logs_trigger_fetch(TRUE);
}

static void on_logs_filter_changed(GtkEditable *editable, gpointer user_data) {
    (void)editable;
    (void)user_data;
    section_mark_stale(&logs_last_fetch_us);
}

static GtkWidget* logs_build(void) {
    GtkWidget *scrolled = gtk_scrolled_window_new();
    gtk_scrolled_window_set_policy(GTK_SCROLLED_WINDOW(scrolled),
                                   GTK_POLICY_NEVER, GTK_POLICY_AUTOMATIC);

    GtkWidget *page = gtk_box_new(GTK_ORIENTATION_VERTICAL, 8);
    gtk_widget_set_margin_start(page, 24);
    gtk_widget_set_margin_end(page, 24);
    gtk_widget_set_margin_top(page, 24);
    gtk_widget_set_margin_bottom(page, 24);

    GtkWidget *title = gtk_label_new("Logs");
    gtk_widget_add_css_class(title, "title-1");
    gtk_label_set_xalign(GTK_LABEL(title), 0.0);
    gtk_box_append(GTK_BOX(page), title);

    logs_status_label = gtk_label_new("Loading…");
    gtk_widget_add_css_class(logs_status_label, "dim-label");
    gtk_label_set_xalign(GTK_LABEL(logs_status_label), 0.0);
    gtk_box_append(GTK_BOX(page), logs_status_label);

    GtkWidget *controls = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
    logs_filter_entry = gtk_entry_new();
    gtk_entry_set_placeholder_text(GTK_ENTRY(logs_filter_entry), "Filter contains text…");
    gtk_widget_set_hexpand(logs_filter_entry, TRUE);
    g_signal_connect(logs_filter_entry, "changed", G_CALLBACK(on_logs_filter_changed), NULL);
    gtk_box_append(GTK_BOX(controls), logs_filter_entry);

    GtkWidget *refresh_btn = gtk_button_new_with_label("Refresh Logs");
    g_signal_connect(refresh_btn, "clicked", G_CALLBACK(on_logs_refresh_clicked), NULL);
    gtk_box_append(GTK_BOX(controls), refresh_btn);
    gtk_box_append(GTK_BOX(page), controls);

    logs_text_view = gtk_text_view_new();
    gtk_text_view_set_editable(GTK_TEXT_VIEW(logs_text_view), FALSE);
    gtk_text_view_set_monospace(GTK_TEXT_VIEW(logs_text_view), TRUE);
    gtk_widget_set_vexpand(logs_text_view, TRUE);
    gtk_box_append(GTK_BOX(page), logs_text_view);

    gtk_scrolled_window_set_child(GTK_SCROLLED_WINDOW(scrolled), page);
    return scrolled;
}

static void logs_trigger_fetch(gboolean force) {
    if (!logs_status_label || logs_fetch_in_flight) return;
    if (!gateway_rpc_is_ready()) {
        gtk_label_set_text(GTK_LABEL(logs_status_label), "Gateway not connected");
        logs_set_text("Connect to gateway and click Refresh Logs.");
        return;
    }
    if (!force && !section_is_stale(&logs_last_fetch_us)) return;

    logs_fetch_in_flight = TRUE;

    JsonBuilder *b = json_builder_new();
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "limit");
    json_builder_add_int_value(b, 200);
    json_builder_end_object(b);
    JsonNode *params = json_builder_get_root(b);
    g_object_unref(b);

    LogsRequestContext *ctx = logs_request_context_new();
    g_autofree gchar *rid = gateway_rpc_request("logs.tail", params, 0,
                                                on_logs_tail_response, ctx);
    json_node_unref(params);
    if (!rid) {
        logs_request_context_free(ctx);
        logs_fetch_in_flight = FALSE;
        gtk_label_set_text(GTK_LABEL(logs_status_label), "Failed to request logs.tail");
    }
}

static void logs_refresh(void) {
    logs_trigger_fetch(FALSE);
}

static void logs_destroy(void) {
    logs_generation++;

    logs_status_label = NULL;
    logs_text_view = NULL;
    logs_filter_entry = NULL;
    logs_fetch_in_flight = FALSE;
    logs_last_fetch_us = 0;
}

static void logs_invalidate(void) {
    section_mark_stale(&logs_last_fetch_us);
}

static const SectionController logs_controller = {
    .build = logs_build,
    .refresh = logs_refresh,
    .destroy = logs_destroy,
    .invalidate = logs_invalidate,
};

const SectionController* section_logs_get(void) {
    return &logs_controller;
}
