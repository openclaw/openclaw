/*
 * section_usage.c
 * Description: Usage section controller for gateway usage and cost summaries.
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "section_usage.h"

#include <adwaita.h>

#include "format_utils.h"
#include "gateway_rpc.h"
#include "json_access.h"
#include "ui_model_utils.h"

static GtkWidget *usage_status_label = NULL;
static GtkWidget *usage_summary_label = NULL;
static GtkWidget *usage_cost_label = NULL;
static GtkWidget *usage_retros_box = NULL;
static GtkWidget *usage_days_dropdown = NULL;
static GtkStringList *usage_days_model = NULL;

static gboolean usage_fetch_in_flight = FALSE;
static gint64 usage_last_fetch_us = 0;
static guint usage_generation = 1;

static gint usage_selected_days = 30;

typedef struct {
    guint generation;
} UsageRequestContext;

static UsageRequestContext* usage_request_context_new(void) {
    UsageRequestContext *ctx = g_new0(UsageRequestContext, 1);
    ctx->generation = usage_generation;
    return ctx;
}

static gboolean usage_request_context_is_stale(const UsageRequestContext *ctx) {
    return !ctx || ctx->generation != usage_generation;
}

static void usage_request_context_free(gpointer data) {
    g_free(data);
}

static void usage_clear_retros(void) {
    if (!usage_retros_box) return;
    section_box_clear(usage_retros_box);
}

static void usage_add_retros_line(const gchar *text) {
    GtkWidget *lbl = gtk_label_new(text);
    gtk_label_set_xalign(GTK_LABEL(lbl), 0.0);
    gtk_label_set_wrap(GTK_LABEL(lbl), TRUE);
    gtk_widget_add_css_class(lbl, "dim-label");
    gtk_box_append(GTK_BOX(usage_retros_box), lbl);
}

static void usage_request_sessions_usage(void);

static void on_usage_sessions_response(const GatewayRpcResponse *response, gpointer user_data) {
    UsageRequestContext *ctx = (UsageRequestContext *)user_data;
    if (usage_request_context_is_stale(ctx)) {
        usage_request_context_free(ctx);
        return;
    }
    usage_request_context_free(ctx);

    usage_clear_retros();

    if (!response || !response->ok || !response->payload || !JSON_NODE_HOLDS_OBJECT(response->payload)) {
        usage_add_retros_line("Failed to load session usage details.");
        return;
    }

    JsonObject *obj = json_node_get_object(response->payload);
    JsonArray *sessions = NULL;
    if (json_object_has_member(obj, "sessions")) {
        JsonNode *sn = json_object_get_member(obj, "sessions");
        if (sn && JSON_NODE_HOLDS_ARRAY(sn)) sessions = json_node_get_array(sn);
    }

    if (!sessions || json_array_get_length(sessions) == 0) {
        usage_add_retros_line("No session-level usage in this range.");
        return;
    }

    guint len = MIN(json_array_get_length(sessions), 10);
    for (guint i = 0; i < len; i++) {
        JsonNode *n = json_array_get_element(sessions, i);
        if (!n || !JSON_NODE_HOLDS_OBJECT(n)) continue;
        JsonObject *row = json_node_get_object(n);

        const gchar *key = oc_json_string_member(row, "key");
        if (!key) key = "(session)";
        JsonObject *usage = NULL;
        if (json_object_has_member(row, "usage")) {
            JsonNode *un = json_object_get_member(row, "usage");
            if (un && JSON_NODE_HOLDS_OBJECT(un)) usage = json_node_get_object(un);
        }
        guint64 tokens = usage && json_object_has_member(usage, "totalTokens")
                             ? (guint64)json_object_get_int_member(usage, "totalTokens")
                             : 0;
        gdouble cost = usage && json_object_has_member(usage, "totalCost")
                           ? json_object_get_double_member(usage, "totalCost")
                           : 0.0;

        g_autofree gchar *tokens_fmt = format_compact_count(tokens);
        g_autofree gchar *cost_fmt = format_money_usd(cost);
        g_autofree gchar *line = g_strdup_printf("%s — %s tokens, $%s", key, tokens_fmt, cost_fmt);
        usage_add_retros_line(line);
    }
}

static void usage_request_sessions_usage(void) {
    if (!gateway_rpc_is_ready()) return;

    JsonBuilder *b = json_builder_new();
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "startDate");
    GDateTime *now = g_date_time_new_now_local();
    GDateTime *start = g_date_time_add_days(now, -(usage_selected_days - 1));
    g_autofree gchar *start_str = g_date_time_format(start, "%Y-%m-%d");
    json_builder_add_string_value(b, start_str);
    json_builder_set_member_name(b, "endDate");
    g_autofree gchar *end_str = g_date_time_format(now, "%Y-%m-%d");
    json_builder_add_string_value(b, end_str);
    g_date_time_unref(start);
    g_date_time_unref(now);
    json_builder_set_member_name(b, "limit");
    json_builder_add_int_value(b, 20);
    json_builder_end_object(b);
    JsonNode *params = json_builder_get_root(b);
    g_object_unref(b);

    UsageRequestContext *ctx = usage_request_context_new();
    g_autofree gchar *rid = gateway_rpc_request("sessions.usage", params, 0,
                                                on_usage_sessions_response, ctx);
    json_node_unref(params);
    if (!rid) {
        usage_request_context_free(ctx);
        usage_add_retros_line("Failed to request sessions.usage.");
    }
}

static void on_usage_cost_response(const GatewayRpcResponse *response, gpointer user_data) {
    UsageRequestContext *ctx = (UsageRequestContext *)user_data;
    if (usage_request_context_is_stale(ctx)) {
        usage_request_context_free(ctx);
        return;
    }
    usage_request_context_free(ctx);

    if (!usage_cost_label) return;

    if (!response || !response->ok || !response->payload || !JSON_NODE_HOLDS_OBJECT(response->payload)) {
        gtk_label_set_text(GTK_LABEL(usage_cost_label), "Cost: unavailable");
        usage_request_sessions_usage();
        return;
    }

    JsonObject *obj = json_node_get_object(response->payload);
    JsonObject *totals = NULL;
    if (json_object_has_member(obj, "totals")) {
        JsonNode *tn = json_object_get_member(obj, "totals");
        if (tn && JSON_NODE_HOLDS_OBJECT(tn)) totals = json_node_get_object(tn);
    }
    gdouble total = totals && json_object_has_member(totals, "totalCost")
                        ? json_object_get_double_member(totals, "totalCost")
                        : 0.0;
    guint64 total_tokens = totals && json_object_has_member(totals, "totalTokens")
                               ? (guint64)json_object_get_int_member(totals, "totalTokens")
                               : 0;
    guint daily_count = 0;
    if (json_object_has_member(obj, "daily")) {
        JsonNode *dn = json_object_get_member(obj, "daily");
        if (dn && JSON_NODE_HOLDS_ARRAY(dn)) daily_count = json_array_get_length(json_node_get_array(dn));
    }
    g_autofree gchar *cost = format_money_usd(total);
    g_autofree gchar *tok = format_compact_count(total_tokens);
    g_autofree gchar *line = g_strdup_printf("Cost %dd: $%s | Tokens: %s | Daily points: %u",
                                             usage_selected_days, cost, tok, daily_count);
    gtk_label_set_text(GTK_LABEL(usage_cost_label), line);

    usage_request_sessions_usage();
}

static void on_usage_status_response(const GatewayRpcResponse *response, gpointer user_data) {
    UsageRequestContext *ctx = (UsageRequestContext *)user_data;
    if (usage_request_context_is_stale(ctx)) {
        usage_request_context_free(ctx);
        return;
    }
    usage_request_context_free(ctx);

    usage_fetch_in_flight = FALSE;

    if (!usage_status_label || !usage_summary_label) return;

    if (!response || !response->ok || !response->payload || !JSON_NODE_HOLDS_OBJECT(response->payload)) {
        gtk_label_set_text(GTK_LABEL(usage_status_label), "Failed to load usage status");
        return;
    }

    JsonObject *obj = json_node_get_object(response->payload);
    JsonNode *providers_node = json_object_get_member(obj, "providers");
    guint providers_count = 0;
    GString *summary = g_string_new(NULL);
    if (providers_node && JSON_NODE_HOLDS_ARRAY(providers_node)) {
        JsonArray *providers = json_node_get_array(providers_node);
        providers_count = json_array_get_length(providers);
        guint shown = MIN(providers_count, 3);
        for (guint i = 0; i < shown; i++) {
            JsonNode *n = json_array_get_element(providers, i);
            if (!n || !JSON_NODE_HOLDS_OBJECT(n)) continue;
            JsonObject *p = json_node_get_object(n);
            const gchar *name = oc_json_string_member(p, "displayName");
            if (!name) name = oc_json_string_member(p, "provider");
            if (!name) name = "provider";
            const gchar *plan = oc_json_string_member(p, "plan");
            guint windows = 0;
            const gchar *provider_error = oc_json_string_member(p, "error");
            JsonNode *wn = json_object_get_member(p, "windows");
            if (wn && JSON_NODE_HOLDS_ARRAY(wn)) {
                JsonArray *wa = json_node_get_array(wn);
                windows = json_array_get_length(wa);
            }
            if (summary->len > 0) g_string_append(summary, " | ");
            if (provider_error && provider_error[0] != '\0') {
                g_string_append_printf(summary, "%s (error: %s)", name, provider_error);
            } else if (plan && plan[0] != '\0') {
                g_string_append_printf(summary, "%s (%s, %u windows)",
                                       name,
                                       plan,
                                       windows);
            } else {
                g_string_append_printf(summary, "%s (%u windows)",
                                       name,
                                       windows);
            }
        }
    }

    if (summary->len == 0) {
        g_string_append(summary, "No provider usage snapshots available");
    }

    gtk_label_set_text(GTK_LABEL(usage_summary_label), summary->str);
    g_string_free(summary, TRUE);
    g_autofree gchar *status = g_strdup_printf("Usage providers: %u", providers_count);
    gtk_label_set_text(GTK_LABEL(usage_status_label), status);

    section_mark_fresh(&usage_last_fetch_us);

    JsonBuilder *b = json_builder_new();
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "days");
    json_builder_add_int_value(b, usage_selected_days);
    json_builder_end_object(b);
    JsonNode *params = json_builder_get_root(b);
    g_object_unref(b);

    UsageRequestContext *cost_ctx = usage_request_context_new();
    g_autofree gchar *rid = gateway_rpc_request("usage.cost", params, 0,
                                                on_usage_cost_response, cost_ctx);
    json_node_unref(params);
    if (!rid) {
        usage_request_context_free(cost_ctx);
        gtk_label_set_text(GTK_LABEL(usage_cost_label), "Cost: unavailable");
        usage_request_sessions_usage();
    }
}

static void on_usage_days_changed(GtkDropDown *dropdown, GParamSpec *pspec, gpointer user_data) {
    (void)pspec;
    (void)user_data;
    guint idx = gtk_drop_down_get_selected(dropdown);
    usage_selected_days = (idx == 0) ? 7 : (idx == 1 ? 14 : 30);
    section_mark_stale(&usage_last_fetch_us);
}

static GtkWidget* usage_build(void) {
    GtkWidget *scrolled = gtk_scrolled_window_new();
    gtk_scrolled_window_set_policy(GTK_SCROLLED_WINDOW(scrolled),
                                   GTK_POLICY_NEVER, GTK_POLICY_AUTOMATIC);

    GtkWidget *page = gtk_box_new(GTK_ORIENTATION_VERTICAL, 8);
    gtk_widget_set_margin_start(page, 24);
    gtk_widget_set_margin_end(page, 24);
    gtk_widget_set_margin_top(page, 24);
    gtk_widget_set_margin_bottom(page, 24);

    GtkWidget *title = gtk_label_new("Usage");
    gtk_widget_add_css_class(title, "title-1");
    gtk_label_set_xalign(GTK_LABEL(title), 0.0);
    gtk_box_append(GTK_BOX(page), title);

    usage_status_label = gtk_label_new("Loading…");
    gtk_widget_add_css_class(usage_status_label, "dim-label");
    gtk_label_set_xalign(GTK_LABEL(usage_status_label), 0.0);
    gtk_box_append(GTK_BOX(page), usage_status_label);

    usage_summary_label = gtk_label_new("Providers: —");
    gtk_label_set_xalign(GTK_LABEL(usage_summary_label), 0.0);
    gtk_box_append(GTK_BOX(page), usage_summary_label);

    usage_cost_label = gtk_label_new("Cost: —");
    gtk_label_set_xalign(GTK_LABEL(usage_cost_label), 0.0);
    gtk_box_append(GTK_BOX(page), usage_cost_label);

    usage_days_model = gtk_string_list_new((const char*[]){"7 days", "14 days", "30 days", NULL});
    usage_days_dropdown = gtk_drop_down_new(G_LIST_MODEL(usage_days_model), NULL);
    gtk_drop_down_set_selected(GTK_DROP_DOWN(usage_days_dropdown), 2);
    g_signal_connect(usage_days_dropdown, "notify::selected",
                     G_CALLBACK(on_usage_days_changed), NULL);
    gtk_box_append(GTK_BOX(page), usage_days_dropdown);

    GtkWidget *retros_title = gtk_label_new("Session Usage (Top 10)");
    gtk_widget_add_css_class(retros_title, "heading");
    gtk_label_set_xalign(GTK_LABEL(retros_title), 0.0);
    gtk_widget_set_margin_top(retros_title, 8);
    gtk_box_append(GTK_BOX(page), retros_title);

    usage_retros_box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 3);
    gtk_box_append(GTK_BOX(page), usage_retros_box);

    gtk_scrolled_window_set_child(GTK_SCROLLED_WINDOW(scrolled), page);
    return scrolled;
}

static void usage_refresh(void) {
    if (!usage_status_label || usage_fetch_in_flight) return;
    if (!gateway_rpc_is_ready()) {
        gtk_label_set_text(GTK_LABEL(usage_status_label), "Gateway not connected");
        usage_clear_retros();
        usage_add_retros_line("Reconnect gateway to fetch usage.");
        return;
    }
    if (!section_is_stale(&usage_last_fetch_us)) return;

    usage_fetch_in_flight = TRUE;
    UsageRequestContext *ctx = usage_request_context_new();
    g_autofree gchar *rid = gateway_rpc_request("usage.status", NULL, 0,
                                                on_usage_status_response, ctx);
    if (!rid) {
        usage_request_context_free(ctx);
        usage_fetch_in_flight = FALSE;
        gtk_label_set_text(GTK_LABEL(usage_status_label), "Failed to request usage.status");
    }
}

static void usage_destroy(void) {
    usage_generation++;

    usage_status_label = NULL;
    usage_summary_label = NULL;
    usage_cost_label = NULL;
    usage_retros_box = NULL;
    ui_dropdown_detach_model(usage_days_dropdown, (gpointer *)&usage_days_model);
    usage_days_dropdown = NULL;
    usage_days_model = NULL;
    usage_fetch_in_flight = FALSE;
    usage_last_fetch_us = 0;
    usage_selected_days = 30;
}

static void usage_invalidate(void) {
    section_mark_stale(&usage_last_fetch_us);
}

static const SectionController usage_controller = {
    .build = usage_build,
    .refresh = usage_refresh,
    .destroy = usage_destroy,
    .invalidate = usage_invalidate,
};

const SectionController* section_usage_get(void) {
    return &usage_controller;
}
