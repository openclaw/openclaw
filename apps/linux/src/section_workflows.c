/*
 * section_workflows.c
 * Description: Workflows section controller for displaying bindings and hooks.
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "section_workflows.h"

#include <adwaita.h>

#include "gateway_data.h"
#include "gateway_rpc.h"
#include "json_access.h"

static GtkWidget *workflows_status_label = NULL;
static GtkWidget *workflows_list_box = NULL;
static gboolean workflows_fetch_in_flight = FALSE;
static gint64 workflows_last_fetch_us = 0;
static guint workflows_generation = 1;

typedef struct {
    guint generation;
} WorkflowsRequestContext;

static WorkflowsRequestContext* workflows_request_context_new(void) {
    WorkflowsRequestContext *ctx = g_new0(WorkflowsRequestContext, 1);
    ctx->generation = workflows_generation;
    return ctx;
}

static gboolean workflows_request_context_is_stale(const WorkflowsRequestContext *ctx) {
    return !ctx || ctx->generation != workflows_generation;
}

static void workflows_request_context_free(gpointer data) {
    g_free(data);
}

static void workflows_clear(void) {
    if (!workflows_list_box) return;
    section_box_clear(workflows_list_box);
}

static void workflows_add_line(const gchar *text, gboolean dim) {
    GtkWidget *lbl = gtk_label_new(text ? text : "");
    gtk_label_set_xalign(GTK_LABEL(lbl), 0.0);
    gtk_label_set_wrap(GTK_LABEL(lbl), TRUE);
    if (dim) gtk_widget_add_css_class(lbl, "dim-label");
    gtk_box_append(GTK_BOX(workflows_list_box), lbl);
}

static void workflows_render_from_config(const GatewayConfigSnapshot *cfg) {
    if (!cfg || !cfg->config) {
        workflows_add_line("Config payload unavailable.", TRUE);
        return;
    }

    JsonObject *root = cfg->config;
    JsonNode *bindings_node = json_object_get_member(root, "bindings");
    JsonNode *hooks_node = json_object_get_member(root, "hooks");

    guint rendered = 0;
    if (bindings_node && JSON_NODE_HOLDS_ARRAY(bindings_node)) {
        JsonArray *arr = json_node_get_array(bindings_node);
        guint len = json_array_get_length(arr);
        workflows_add_line("Agent Bindings", FALSE);
        for (guint i = 0; i < len; i++) {
            JsonNode *n = json_array_get_element(arr, i);
            if (!n || !JSON_NODE_HOLDS_OBJECT(n)) continue;
            JsonObject *b = json_node_get_object(n);
            const gchar *agent_id = oc_json_string_member(b, "agentId");
            if (!agent_id) agent_id = "(agent)";
            const gchar *channel = "?";
            const gchar *peer_kind = "any";
            const gchar *peer_id = "*";
            if (json_object_has_member(b, "match")) {
                JsonNode *mn = json_object_get_member(b, "match");
                if (mn && JSON_NODE_HOLDS_OBJECT(mn)) {
                    JsonObject *match = json_node_get_object(mn);
                    const gchar *channel_member = oc_json_string_member(match, "channel");
                    if (channel_member) channel = channel_member;
                    if (json_object_has_member(match, "peer")) {
                        JsonNode *pn = json_object_get_member(match, "peer");
                        if (pn && JSON_NODE_HOLDS_OBJECT(pn)) {
                            JsonObject *peer = json_node_get_object(pn);
                            const gchar *kind_member = oc_json_string_member(peer, "kind");
                            const gchar *id_member = oc_json_string_member(peer, "id");
                            if (kind_member) peer_kind = kind_member;
                            if (id_member) peer_id = id_member;
                        }
                    }
                }
            }
            g_autofree gchar *title = g_strdup_printf("%s -> %s", agent_id, channel);
            g_autofree gchar *subtitle = g_strdup_printf("Peer: %s:%s", peer_kind, peer_id);
            workflows_add_line(title, FALSE);
            workflows_add_line(subtitle, TRUE);
            rendered++;
        }
    }

    if (hooks_node && JSON_NODE_HOLDS_OBJECT(hooks_node)) {
        JsonObject *hooks = json_node_get_object(hooks_node);
        if (json_object_has_member(hooks, "internal")) {
            JsonNode *internal_node = json_object_get_member(hooks, "internal");
            if (internal_node && JSON_NODE_HOLDS_OBJECT(internal_node)) {
                workflows_add_line("Internal hooks configured", TRUE);
                rendered++;
            }
        }
    }

    if (rendered == 0) {
        workflows_add_line("No binding/hook workflows configured.", TRUE);
    }
}

static void on_workflows_response(const GatewayRpcResponse *response, gpointer user_data) {
    WorkflowsRequestContext *ctx = (WorkflowsRequestContext *)user_data;
    if (workflows_request_context_is_stale(ctx)) {
        workflows_request_context_free(ctx);
        return;
    }
    workflows_request_context_free(ctx);

    workflows_fetch_in_flight = FALSE;

    if (!workflows_status_label) return;

    workflows_clear();

    if (!response || !response->ok || !response->payload) {
        gtk_label_set_text(GTK_LABEL(workflows_status_label), "Failed to load config.get");
        workflows_add_line("Unable to inspect bindings from gateway config.", TRUE);
        return;
    }

    GatewayConfigSnapshot *cfg = gateway_data_parse_config_get(response->payload);
    workflows_render_from_config(cfg);
    gateway_config_snapshot_free(cfg);

    section_mark_fresh(&workflows_last_fetch_us);
    gtk_label_set_text(GTK_LABEL(workflows_status_label), "Workflow bindings loaded from config");
}

static GtkWidget* workflows_build(void) {
    GtkWidget *scrolled = gtk_scrolled_window_new();
    gtk_scrolled_window_set_policy(GTK_SCROLLED_WINDOW(scrolled),
                                   GTK_POLICY_NEVER, GTK_POLICY_AUTOMATIC);

    GtkWidget *page = gtk_box_new(GTK_ORIENTATION_VERTICAL, 8);
    gtk_widget_set_margin_start(page, 24);
    gtk_widget_set_margin_end(page, 24);
    gtk_widget_set_margin_top(page, 24);
    gtk_widget_set_margin_bottom(page, 24);

    GtkWidget *title = gtk_label_new("Workflows");
    gtk_widget_add_css_class(title, "title-1");
    gtk_label_set_xalign(GTK_LABEL(title), 0.0);
    gtk_box_append(GTK_BOX(page), title);

    workflows_status_label = gtk_label_new("Loading…");
    gtk_widget_add_css_class(workflows_status_label, "dim-label");
    gtk_label_set_xalign(GTK_LABEL(workflows_status_label), 0.0);
    gtk_box_append(GTK_BOX(page), workflows_status_label);

    workflows_list_box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 4);
    gtk_box_append(GTK_BOX(page), workflows_list_box);

    gtk_scrolled_window_set_child(GTK_SCROLLED_WINDOW(scrolled), page);
    return scrolled;
}

static void workflows_refresh(void) {
    if (!workflows_status_label || workflows_fetch_in_flight) return;
    if (!gateway_rpc_is_ready()) {
        gtk_label_set_text(GTK_LABEL(workflows_status_label), "Gateway not connected");
        return;
    }
    if (!section_is_stale(&workflows_last_fetch_us)) return;

    workflows_fetch_in_flight = TRUE;
    WorkflowsRequestContext *ctx = workflows_request_context_new();
    g_autofree gchar *rid = gateway_rpc_request("config.get", NULL, 0,
                                                on_workflows_response, ctx);
    if (!rid) {
        workflows_request_context_free(ctx);
        workflows_fetch_in_flight = FALSE;
        gtk_label_set_text(GTK_LABEL(workflows_status_label), "Failed to request config.get");
    }
}

static void workflows_destroy(void) {
    workflows_generation++;

    workflows_status_label = NULL;
    workflows_list_box = NULL;
    workflows_fetch_in_flight = FALSE;
    workflows_last_fetch_us = 0;
}

static void workflows_invalidate(void) {
    section_mark_stale(&workflows_last_fetch_us);
}

static const SectionController workflows_controller = {
    .build = workflows_build,
    .refresh = workflows_refresh,
    .destroy = workflows_destroy,
    .invalidate = workflows_invalidate,
};

const SectionController* section_workflows_get(void) {
    return &workflows_controller;
}
