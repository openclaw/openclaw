/*
 * section_control_room.c
 * Description: Control Room section controller for runtime status and quick actions.
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "section_control_room.h"

#include <adwaita.h>

#include "app_window.h"
#include "gateway_mutations.h"
#include "gateway_rpc.h"
#include "json_access.h"
#include "readiness.h"
#include "state.h"

static GtkWidget *control_status_label = NULL;
static GtkWidget *control_summary_label = NULL;
static GtkWidget *control_nodes_box = NULL;
static GtkWidget *control_details_label = NULL;
static GtkWidget *control_gateway_health_label = NULL;
static GtkWidget *control_service_label = NULL;
static GtkWidget *control_version_label = NULL;
static GtkWidget *control_agents_count_label = NULL;
static GtkWidget *control_sessions_count_label = NULL;
static GtkWidget *control_cron_job_entry = NULL;
static GtkWidget *control_abort_session_entry = NULL;

static gboolean control_nodes_fetch_in_flight = FALSE;
static gboolean control_agents_fetch_in_flight = FALSE;
static gboolean control_sessions_fetch_in_flight = FALSE;
static gint64 control_last_fetch_us = 0;
static guint control_generation = 1;

typedef struct {
    guint generation;
} ControlRequestContext;

static ControlRequestContext* control_request_context_new(void) {
    ControlRequestContext *ctx = g_new0(ControlRequestContext, 1);
    ctx->generation = control_generation;
    return ctx;
}

static gboolean control_request_context_is_stale(const ControlRequestContext *ctx) {
    return !ctx || ctx->generation != control_generation;
}

static void control_request_context_free(gpointer data) {
    g_free(data);
}

static void control_request_snapshot(void);

static void control_set_count_label(GtkWidget *label, const gchar *prefix, gint count) {
    if (!label) return;
    g_autofree gchar *text = g_strdup_printf("%s%d", prefix, count);
    gtk_label_set_text(GTK_LABEL(label), text);
}

static void control_set_summary_from_state(void) {
    if (!control_summary_label) return;

    AppState app = state_get_current();
    RuntimeMode mode = state_get_runtime_mode();
    const DesktopReadinessSnapshot *snapshot = state_get_readiness_snapshot();
    ChatGateInfo gate = {0};
    readiness_describe_chat_gate(snapshot, &gate);
    HealthState *health = state_get_health();
    SystemdState *sys = state_get_systemd();
    ReadinessInfo info = {0};
    readiness_evaluate(app, health, sys, &info);

    RuntimeModePresentation mode_presentation = {0};
    runtime_mode_describe(mode, &mode_presentation);

    g_autofree gchar *summary = g_strdup_printf("%s | %s | Chat %s",
                                                info.classification ? info.classification : "Unknown",
                                                mode_presentation.label ? mode_presentation.label : "Runtime unknown",
                                                gate.ready ? "ready" : readiness_chat_block_reason_to_string(gate.reason));
    gtk_label_set_text(GTK_LABEL(control_summary_label), summary);

    if (control_gateway_health_label) {
        const gchar *gateway_health = "Gateway: Connecting";
        if (sys && !sys->active) {
            gateway_health = "Gateway: Service inactive";
        } else if (health && health->http_ok && health->ws_connected && health->rpc_ok && health->auth_ok) {
            gateway_health = "Gateway: Connected";
        } else if (health && health->http_ok) {
            gateway_health = "Gateway: Degraded";
        }
        if (!gate.ready && gate.status) {
            gateway_health = gate.status;
        }
        gtk_label_set_text(GTK_LABEL(control_gateway_health_label), gateway_health);
    }

    if (control_service_label) {
        gtk_label_set_text(GTK_LABEL(control_service_label),
                           (sys && sys->active) ? "Service: Active" : "Service: Inactive");
    }

    if (control_version_label) {
        gtk_label_set_text(GTK_LABEL(control_version_label),
                           (health && health->gateway_version) ? health->gateway_version : "—");
    }

    if (control_details_label) {
        g_autofree gchar *details = g_strdup_printf("State: %s | Setup: %s | Provider: %s | Default model: %s | Catalog: %s | Selected: %s | Agents: %s",
                                                    state_get_current_string(),
                                                    snapshot && snapshot->config_present ? "yes" : "no",
                                                    snapshot && snapshot->provider_configured ? "configured" : "missing",
                                                    snapshot && snapshot->default_model_configured ? "configured" : "missing",
                                                    snapshot && snapshot->model_catalog_available ? "ready" : "unavailable",
                                                    snapshot && snapshot->selected_model_resolved ? "resolved" : "unresolved",
                                                    snapshot && snapshot->agents_available ? "available" : "unavailable");
        gtk_label_set_text(GTK_LABEL(control_details_label), details);
    }
}

static void control_nodes_clear(void) {
    if (!control_nodes_box) return;
    section_box_clear(control_nodes_box);
}

static void on_control_mutation_done(const GatewayRpcResponse *response, gpointer user_data) {
    ControlRequestContext *ctx = (ControlRequestContext *)user_data;
    if (control_request_context_is_stale(ctx)) {
        control_request_context_free(ctx);
        return;
    }
    control_request_context_free(ctx);

    if (!control_status_label) return;
    gtk_label_set_text(GTK_LABEL(control_status_label),
                       (response && response->ok) ? "Action applied" : "Action failed");
    section_mark_stale(&control_last_fetch_us);
}

static void control_maybe_finish_refresh(void) {
    if (control_nodes_fetch_in_flight || control_agents_fetch_in_flight || control_sessions_fetch_in_flight) {
        return;
    }
    section_mark_fresh(&control_last_fetch_us);
    if (control_status_label) {
        gtk_label_set_text(GTK_LABEL(control_status_label), "Snapshot refreshed");
    }
}

static void on_refresh_snapshot_clicked(GtkButton *button, gpointer user_data) {
    (void)button;
    (void)user_data;

    app_window_refresh_snapshot();
    section_mark_stale(&control_last_fetch_us);
    if (control_status_label) {
        gtk_label_set_text(GTK_LABEL(control_status_label), "Refreshing snapshot…");
    }
    control_request_snapshot();
}

static void on_control_agents_response(const GatewayRpcResponse *response, gpointer user_data) {
    ControlRequestContext *ctx = (ControlRequestContext *)user_data;
    if (control_request_context_is_stale(ctx)) {
        control_request_context_free(ctx);
        return;
    }
    control_request_context_free(ctx);

    control_agents_fetch_in_flight = FALSE;

    gint count = 0;
    if (response && response->ok && response->payload && JSON_NODE_HOLDS_OBJECT(response->payload)) {
        JsonObject *obj = json_node_get_object(response->payload);
        JsonNode *agents_node = json_object_get_member(obj, "agents");
        if (agents_node && JSON_NODE_HOLDS_ARRAY(agents_node)) {
            count = (gint)json_array_get_length(json_node_get_array(agents_node));
        }
    }

    control_set_count_label(control_agents_count_label, "", count);
    control_maybe_finish_refresh();
}

static void on_control_sessions_response(const GatewayRpcResponse *response, gpointer user_data) {
    ControlRequestContext *ctx = (ControlRequestContext *)user_data;
    if (control_request_context_is_stale(ctx)) {
        control_request_context_free(ctx);
        return;
    }
    control_request_context_free(ctx);

    control_sessions_fetch_in_flight = FALSE;

    gint count = 0;
    if (response && response->ok && response->payload && JSON_NODE_HOLDS_OBJECT(response->payload)) {
        JsonObject *obj = json_node_get_object(response->payload);
        JsonNode *count_node = json_object_get_member(obj, "count");
        if (count_node && JSON_NODE_HOLDS_VALUE(count_node)) {
            if (json_node_get_value_type(count_node) == G_TYPE_INT64 ||
                json_node_get_value_type(count_node) == G_TYPE_INT) {
                count = (gint)json_node_get_int(count_node);
            }
        } else {
            JsonNode *sessions_node = json_object_get_member(obj, "sessions");
            if (sessions_node && JSON_NODE_HOLDS_ARRAY(sessions_node)) {
                count = (gint)json_array_get_length(json_node_get_array(sessions_node));
            }
        }
    }

    control_set_count_label(control_sessions_count_label, "", count);
    control_maybe_finish_refresh();
}

static void on_run_cron_clicked(GtkButton *button, gpointer user_data) {
    (void)button;
    (void)user_data;
    const gchar *job_id = control_cron_job_entry
                              ? gtk_editable_get_text(GTK_EDITABLE(control_cron_job_entry))
                              : NULL;
    if (!job_id || job_id[0] == '\0') {
        if (control_status_label) {
            gtk_label_set_text(GTK_LABEL(control_status_label), "Provide cron job id to run");
        }
        return;
    }

    ControlRequestContext *ctx = control_request_context_new();
    g_autofree gchar *rid = mutation_cron_run(job_id, on_control_mutation_done, ctx);
    if (!rid && control_status_label) {
        control_request_context_free(ctx);
        gtk_label_set_text(GTK_LABEL(control_status_label), "Cron run request failed");
    }
}

static void on_abort_session_clicked(GtkButton *button, gpointer user_data) {
    (void)button;
    (void)user_data;
    if (!gateway_rpc_is_ready()) {
        gtk_label_set_text(GTK_LABEL(control_status_label), "Gateway not connected");
        return;
    }

    const gchar *session_key = control_abort_session_entry
                                   ? gtk_editable_get_text(GTK_EDITABLE(control_abort_session_entry))
                                   : NULL;
    if (!session_key || session_key[0] == '\0') {
        gtk_label_set_text(GTK_LABEL(control_status_label), "Provide session key to abort");
        return;
    }

    JsonBuilder *b = json_builder_new();
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "sessionKey");
    json_builder_add_string_value(b, session_key);
    json_builder_end_object(b);
    JsonNode *params = json_builder_get_root(b);
    g_object_unref(b);

    ControlRequestContext *ctx = control_request_context_new();
    g_autofree gchar *rid = gateway_rpc_request("chat.abort", params, 0,
                                                on_control_mutation_done, ctx);
    json_node_unref(params);
    if (!rid) {
        control_request_context_free(ctx);
        gtk_label_set_text(GTK_LABEL(control_status_label), "Abort request failed");
    }
}

static void on_control_nodes_response(const GatewayRpcResponse *response, gpointer user_data) {
    ControlRequestContext *ctx = (ControlRequestContext *)user_data;
    if (control_request_context_is_stale(ctx)) {
        control_request_context_free(ctx);
        return;
    }
    control_request_context_free(ctx);

    control_nodes_fetch_in_flight = FALSE;

    if (!control_status_label) return;

    control_nodes_clear();
    control_set_summary_from_state();

    if (!response || !response->ok || !response->payload || !JSON_NODE_HOLDS_OBJECT(response->payload)) {
        gtk_label_set_text(GTK_LABEL(control_status_label), "Failed to load node snapshot");
        control_maybe_finish_refresh();
        return;
    }

    JsonObject *obj = json_node_get_object(response->payload);
    JsonArray *nodes = NULL;
    if (json_object_has_member(obj, "nodes")) {
        JsonNode *nn = json_object_get_member(obj, "nodes");
        if (nn && JSON_NODE_HOLDS_ARRAY(nn)) nodes = json_node_get_array(nn);
    }

    if (!nodes || json_array_get_length(nodes) == 0) {
        GtkWidget *empty = gtk_label_new("No remote instances found");
        gtk_widget_add_css_class(empty, "dim-label");
        gtk_label_set_xalign(GTK_LABEL(empty), 0.0);
        gtk_box_append(GTK_BOX(control_nodes_box), empty);
    } else {
        guint len = json_array_get_length(nodes);
        for (guint i = 0; i < len; i++) {
            JsonNode *n = json_array_get_element(nodes, i);
            if (!n || !JSON_NODE_HOLDS_OBJECT(n)) continue;
            JsonObject *node = json_node_get_object(n);
            const gchar *node_id = oc_json_string_member(node, "nodeId");
            if (!node_id) node_id = "unknown";
            const gchar *name = oc_json_string_member(node, "displayName");
            if (!name) name = node_id;
            gboolean connected = oc_json_bool_member(node, "connected", FALSE);
            const gchar *platform = oc_json_string_member(node, "platform");
            if (!platform) platform = "?";
            const gchar *version = oc_json_string_member(node, "version");
            if (!version) version = "?";
            gboolean paired = oc_json_bool_member(node, "paired", FALSE);
            g_autofree gchar *line = g_strdup_printf("%s (%s) — %s | %s %s | %s",
                                                     name,
                                                     node_id,
                                                     connected ? "connected" : "disconnected",
                                                     platform,
                                                     version,
                                                     paired ? "paired" : "unpaired");
            GtkWidget *lbl = gtk_label_new(line);
            gtk_label_set_xalign(GTK_LABEL(lbl), 0.0);
            gtk_box_append(GTK_BOX(control_nodes_box), lbl);
        }
    }

    control_maybe_finish_refresh();
}

static void control_request_snapshot(void) {
    if (!gateway_rpc_is_ready()) {
        if (control_status_label) {
            gtk_label_set_text(GTK_LABEL(control_status_label), "Gateway not connected");
        }
        return;
    }

    if (!control_nodes_fetch_in_flight) {
        control_nodes_fetch_in_flight = TRUE;
        ControlRequestContext *nodes_ctx = control_request_context_new();
        g_autofree gchar *rid_nodes = gateway_rpc_request("node.list", NULL, 0,
                                                          on_control_nodes_response, nodes_ctx);
        if (!rid_nodes) {
            control_request_context_free(nodes_ctx);
            control_nodes_fetch_in_flight = FALSE;
        }
    }

    if (!control_agents_fetch_in_flight) {
        control_agents_fetch_in_flight = TRUE;
        ControlRequestContext *agents_ctx = control_request_context_new();
        g_autofree gchar *rid_agents = gateway_rpc_request("agents.list", NULL, 0,
                                                           on_control_agents_response, agents_ctx);
        if (!rid_agents) {
            control_request_context_free(agents_ctx);
            control_agents_fetch_in_flight = FALSE;
        }
    }

    if (!control_sessions_fetch_in_flight) {
        control_sessions_fetch_in_flight = TRUE;
        ControlRequestContext *sessions_ctx = control_request_context_new();
        g_autofree gchar *rid_sessions = gateway_rpc_request("sessions.list", NULL, 0,
                                                             on_control_sessions_response, sessions_ctx);
        if (!rid_sessions) {
            control_request_context_free(sessions_ctx);
            control_sessions_fetch_in_flight = FALSE;
        }
    }
}

static GtkWidget* control_build(void) {
    GtkWidget *scrolled = gtk_scrolled_window_new();
    gtk_scrolled_window_set_policy(GTK_SCROLLED_WINDOW(scrolled),
                                   GTK_POLICY_NEVER, GTK_POLICY_AUTOMATIC);

    GtkWidget *page = gtk_box_new(GTK_ORIENTATION_VERTICAL, 8);
    gtk_widget_set_margin_start(page, 24);
    gtk_widget_set_margin_end(page, 24);
    gtk_widget_set_margin_top(page, 24);
    gtk_widget_set_margin_bottom(page, 24);

    GtkWidget *title = gtk_label_new("Control Room");
    gtk_widget_add_css_class(title, "title-1");
    gtk_label_set_xalign(GTK_LABEL(title), 0.0);
    gtk_box_append(GTK_BOX(page), title);

    control_status_label = gtk_label_new("Loading…");
    gtk_widget_add_css_class(control_status_label, "dim-label");
    gtk_label_set_xalign(GTK_LABEL(control_status_label), 0.0);
    gtk_box_append(GTK_BOX(page), control_status_label);

    control_summary_label = gtk_label_new("State: —");
    gtk_label_set_xalign(GTK_LABEL(control_summary_label), 0.0);
    gtk_box_append(GTK_BOX(page), control_summary_label);

    control_details_label = gtk_label_new("Details: —");
    gtk_widget_add_css_class(control_details_label, "dim-label");
    gtk_label_set_xalign(GTK_LABEL(control_details_label), 0.0);
    gtk_box_append(GTK_BOX(page), control_details_label);

    GtkWidget *runtime_group = gtk_box_new(GTK_ORIENTATION_VERTICAL, 4);
    gtk_widget_set_margin_top(runtime_group, 8);
    gtk_box_append(GTK_BOX(runtime_group), section_info_row("Gateway", 120, &control_gateway_health_label));
    gtk_box_append(GTK_BOX(runtime_group), section_info_row("Service", 120, &control_service_label));
    gtk_box_append(GTK_BOX(runtime_group), section_info_row("Server Version", 120, &control_version_label));
    gtk_box_append(GTK_BOX(runtime_group), section_info_row("Agents", 120, &control_agents_count_label));
    gtk_box_append(GTK_BOX(runtime_group), section_info_row("Sessions", 120, &control_sessions_count_label));
    gtk_box_append(GTK_BOX(page), runtime_group);

    GtkWidget *refresh_row = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
    GtkWidget *refresh_btn = gtk_button_new_with_label("Refresh Snapshot");
    gtk_widget_add_css_class(refresh_btn, "suggested-action");
    g_signal_connect(refresh_btn, "clicked", G_CALLBACK(on_refresh_snapshot_clicked), NULL);
    gtk_box_append(GTK_BOX(refresh_row), refresh_btn);
    gtk_box_append(GTK_BOX(page), refresh_row);

    GtkWidget *cron_row = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
    GtkWidget *cron_btn = gtk_button_new_with_label("Run Cron Job");
    control_cron_job_entry = gtk_entry_new();
    gtk_entry_set_placeholder_text(GTK_ENTRY(control_cron_job_entry), "cron job id (for cron.run)");
    gtk_widget_set_size_request(control_cron_job_entry, 220, -1);
    g_signal_connect(cron_btn, "clicked", G_CALLBACK(on_run_cron_clicked), NULL);
    gtk_box_append(GTK_BOX(cron_row), control_cron_job_entry);
    gtk_box_append(GTK_BOX(cron_row), cron_btn);
    gtk_box_append(GTK_BOX(page), cron_row);

    GtkWidget *abort_row = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
    GtkWidget *abort_btn = gtk_button_new_with_label("Abort Active Chat Session");
    control_abort_session_entry = gtk_entry_new();
    gtk_entry_set_placeholder_text(GTK_ENTRY(control_abort_session_entry), "session key (for chat.abort)");
    gtk_widget_set_hexpand(control_abort_session_entry, TRUE);
    g_signal_connect(abort_btn, "clicked", G_CALLBACK(on_abort_session_clicked), NULL);
    gtk_box_append(GTK_BOX(abort_row), control_abort_session_entry);
    gtk_box_append(GTK_BOX(abort_row), abort_btn);
    gtk_box_append(GTK_BOX(page), abort_row);

    GtkWidget *nodes_title = gtk_label_new("Remote Instances");
    gtk_widget_add_css_class(nodes_title, "heading");
    gtk_label_set_xalign(GTK_LABEL(nodes_title), 0.0);
    gtk_widget_set_margin_top(nodes_title, 8);
    gtk_box_append(GTK_BOX(page), nodes_title);

    control_nodes_box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 3);
    gtk_box_append(GTK_BOX(page), control_nodes_box);

    gtk_scrolled_window_set_child(GTK_SCROLLED_WINDOW(scrolled), page);
    return scrolled;
}

static void control_refresh(void) {
    if (!control_status_label) return;
    control_set_summary_from_state();
    if (!gateway_rpc_is_ready()) {
        gtk_label_set_text(GTK_LABEL(control_status_label), "Gateway not connected");
        return;
    }
    if (!section_is_stale(&control_last_fetch_us)) return;

    gtk_label_set_text(GTK_LABEL(control_status_label), "Refreshing snapshot…");
    control_request_snapshot();
}

static void control_destroy(void) {
    control_generation++;

    control_status_label = NULL;
    control_summary_label = NULL;
    control_details_label = NULL;
    control_gateway_health_label = NULL;
    control_service_label = NULL;
    control_version_label = NULL;
    control_agents_count_label = NULL;
    control_sessions_count_label = NULL;
    control_cron_job_entry = NULL;
    control_abort_session_entry = NULL;
    control_nodes_box = NULL;
    control_nodes_fetch_in_flight = FALSE;
    control_agents_fetch_in_flight = FALSE;
    control_sessions_fetch_in_flight = FALSE;
    control_last_fetch_us = 0;
}

static void control_invalidate(void) {
    section_mark_stale(&control_last_fetch_us);
}

static const SectionController control_controller = {
    .build = control_build,
    .refresh = control_refresh,
    .destroy = control_destroy,
    .invalidate = control_invalidate,
};

const SectionController* section_control_room_get(void) {
    return &control_controller;
}
