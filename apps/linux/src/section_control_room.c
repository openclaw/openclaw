/*
 * section_control_room.c
 * Description: Control Room section controller for runtime status and quick actions.
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "section_control_room.h"

#include <adwaita.h>

#include "gateway_mutations.h"
#include "gateway_rpc.h"
#include "json_access.h"
#include "readiness.h"
#include "state.h"

static GtkWidget *control_status_label = NULL;
static GtkWidget *control_summary_label = NULL;
static GtkWidget *control_nodes_box = NULL;
static GtkWidget *control_details_label = NULL;
static GtkWidget *control_cron_job_entry = NULL;
static GtkWidget *control_abort_session_entry = NULL;

static gboolean control_fetch_in_flight = FALSE;
static gint64 control_last_fetch_us = 0;

static void control_set_summary_from_state(void) {
    if (!control_summary_label) return;

    AppState app = state_get_current();
    RuntimeMode mode = state_get_runtime_mode();
    gboolean ws = gateway_rpc_is_ready();
    HealthState *health = state_get_health();
    SystemdState *sys = state_get_systemd();
    ReadinessInfo info = {0};
    readiness_evaluate(app, health, sys, &info);

    RuntimeModePresentation mode_presentation = {0};
    runtime_mode_describe(mode, &mode_presentation);

    g_autofree gchar *summary = g_strdup_printf("%s | %s | RPC %s",
                                                info.classification ? info.classification : "Unknown",
                                                mode_presentation.label ? mode_presentation.label : "Runtime unknown",
                                                ws ? "connected" : "disconnected");
    gtk_label_set_text(GTK_LABEL(control_summary_label), summary);

    if (control_details_label) {
        g_autofree gchar *details = g_strdup_printf("State: %s | Setup: %s | Model config: %s",
                                                    state_get_current_string(),
                                                    health && health->setup_detected ? "yes" : "no",
                                                    health && health->has_model_config ? "present" : "missing");
        gtk_label_set_text(GTK_LABEL(control_details_label), details);
    }
}

static void control_nodes_clear(void) {
    if (!control_nodes_box) return;
    section_box_clear(control_nodes_box);
}

static void on_control_mutation_done(const GatewayRpcResponse *response, gpointer user_data) {
    (void)user_data;
    if (!control_status_label) return;
    gtk_label_set_text(GTK_LABEL(control_status_label), response->ok ? "Action applied" : "Action failed");
    section_mark_stale(&control_last_fetch_us);
}

static void on_probe_channels_clicked(GtkButton *button, gpointer user_data) {
    (void)button;
    (void)user_data;
    g_autofree gchar *rid = mutation_channels_status(TRUE, on_control_mutation_done, NULL);
    if (!rid && control_status_label) {
        gtk_label_set_text(GTK_LABEL(control_status_label), "Probe request failed");
    }
}

static void on_refresh_config_clicked(GtkButton *button, gpointer user_data) {
    (void)button;
    (void)user_data;
    g_autofree gchar *rid = mutation_config_get(NULL, on_control_mutation_done, NULL);
    if (!rid && control_status_label) {
        gtk_label_set_text(GTK_LABEL(control_status_label), "Config refresh request failed");
    }
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

    g_autofree gchar *rid = mutation_cron_run(job_id, on_control_mutation_done, NULL);
    if (!rid && control_status_label) {
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

    g_autofree gchar *rid = gateway_rpc_request("chat.abort", params, 0,
                                                on_control_mutation_done, NULL);
    json_node_unref(params);
    if (!rid) {
        gtk_label_set_text(GTK_LABEL(control_status_label), "Abort request failed");
    }
}

static void on_control_nodes_response(const GatewayRpcResponse *response, gpointer user_data) {
    (void)user_data;
    control_fetch_in_flight = FALSE;

    if (!control_status_label) return;

    control_nodes_clear();
    control_set_summary_from_state();

    if (!response->ok || !response->payload || !JSON_NODE_HOLDS_OBJECT(response->payload)) {
        gtk_label_set_text(GTK_LABEL(control_status_label), "Failed to load nodes");
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

    section_mark_fresh(&control_last_fetch_us);
    gtk_label_set_text(GTK_LABEL(control_status_label), "Control room updated");
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

    GtkWidget *actions = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
    GtkWidget *probe_btn = gtk_button_new_with_label("Probe Channels");
    GtkWidget *cfg_btn = gtk_button_new_with_label("Refresh Config Snapshot");
    GtkWidget *cron_btn = gtk_button_new_with_label("Run Cron Job");
    GtkWidget *abort_btn = gtk_button_new_with_label("Abort Active Chat Session");
    control_cron_job_entry = gtk_entry_new();
    gtk_entry_set_placeholder_text(GTK_ENTRY(control_cron_job_entry), "cron job id (for cron.run)");
    gtk_widget_set_size_request(control_cron_job_entry, 220, -1);
    control_abort_session_entry = gtk_entry_new();
    gtk_entry_set_placeholder_text(GTK_ENTRY(control_abort_session_entry), "session key (for chat.abort)");
    gtk_widget_set_hexpand(control_abort_session_entry, TRUE);
    g_signal_connect(probe_btn, "clicked", G_CALLBACK(on_probe_channels_clicked), NULL);
    g_signal_connect(cfg_btn, "clicked", G_CALLBACK(on_refresh_config_clicked), NULL);
    g_signal_connect(cron_btn, "clicked", G_CALLBACK(on_run_cron_clicked), NULL);
    g_signal_connect(abort_btn, "clicked", G_CALLBACK(on_abort_session_clicked), NULL);
    gtk_box_append(GTK_BOX(actions), probe_btn);
    gtk_box_append(GTK_BOX(actions), cfg_btn);
    gtk_box_append(GTK_BOX(actions), control_cron_job_entry);
    gtk_box_append(GTK_BOX(actions), cron_btn);
    gtk_box_append(GTK_BOX(actions), control_abort_session_entry);
    gtk_box_append(GTK_BOX(actions), abort_btn);
    gtk_box_append(GTK_BOX(page), actions);

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
    if (!control_status_label || control_fetch_in_flight) return;
    control_set_summary_from_state();
    if (!gateway_rpc_is_ready()) {
        gtk_label_set_text(GTK_LABEL(control_status_label), "Gateway not connected");
        return;
    }
    if (!section_is_stale(&control_last_fetch_us)) return;

    control_fetch_in_flight = TRUE;
    g_autofree gchar *rid = gateway_rpc_request("node.list", NULL, 0,
                                                on_control_nodes_response, NULL);
    if (!rid) {
        control_fetch_in_flight = FALSE;
        gtk_label_set_text(GTK_LABEL(control_status_label), "Failed to request node.list");
    }
}

static void control_destroy(void) {
    control_status_label = NULL;
    control_summary_label = NULL;
    control_details_label = NULL;
    control_cron_job_entry = NULL;
    control_abort_session_entry = NULL;
    control_nodes_box = NULL;
    control_fetch_in_flight = FALSE;
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
