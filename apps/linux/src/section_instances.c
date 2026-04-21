/*
 * section_instances.c
 *
 * Instances section controller for the OpenClaw Linux Companion App.
 *
 * Complete native instance management: local instance card, enhanced
 * remote node cards with full detail fields, pending pairing requests
 * with Approve/Reject actions, and force-refresh. RPC fetch via
 * node.list and node.pair.list.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "section_instances.h"
#include "gateway_rpc.h"
#include "gateway_data.h"
#include "gateway_mutations.h"
#include "gateway_config.h"
#include "gateway_client.h"
#include "state.h"
#include "readiness.h"
#include "display_model.h"
#include <adwaita.h>

/* ── State ───────────────────────────────────────────────────────── */

/* Local instance card widgets */
static GtkWidget *inst_hostname_label = NULL;
static GtkWidget *inst_platform_label = NULL;
static GtkWidget *inst_version_label = NULL;
static GtkWidget *inst_runtime_label = NULL;
static GtkWidget *inst_endpoint_label = NULL;
static GtkWidget *inst_unit_label = NULL;
static GtkWidget *inst_state_label = NULL;

/* Remote nodes */
static GtkWidget *inst_remote_box = NULL;
static GtkWidget *inst_remote_status_label = NULL;
static GtkWidget *inst_copy_debug_btn = NULL;
static GatewayNodesData *inst_nodes_cache = NULL;
static gboolean inst_nodes_fetch_in_flight = FALSE;
static gint64 inst_last_fetch_us = 0;

/* Pending pair requests */
static GtkWidget *inst_pairing_box = NULL;
static GtkWidget *inst_pairing_status_label = NULL;
static GatewayPairingList *inst_pairing_cache = NULL;
static gboolean inst_pairing_fetch_in_flight = FALSE;
static guint inst_generation = 1;

typedef struct {
    guint generation;
} InstancesRequestContext;

static InstancesRequestContext* instances_request_context_new(void) {
    InstancesRequestContext *ctx = g_new0(InstancesRequestContext, 1);
    ctx->generation = inst_generation;
    return ctx;
}

static gboolean instances_request_context_is_stale(const InstancesRequestContext *ctx) {
    return !ctx || ctx->generation != inst_generation;
}

static void instances_request_context_free(gpointer data) {
    g_free(data);
}

/* Forward declarations */
static void inst_rebuild_remote_nodes(void);
static void inst_rebuild_pairing(void);
static void inst_force_refresh(void);
static void inst_fetch_pairing(void);

/* ── Externs ─────────────────────────────────────────────────────── */

extern GatewayConfig* gateway_client_get_config(void);
extern void systemd_get_runtime_context(gchar **out_profile, gchar **out_state_dir, gchar **out_config_path);

/* ── Helpers ─────────────────────────────────────────────────────── */

static GtkWidget* inst_card_row(const char *heading, GtkWidget **out_value) {
    return section_info_row(heading, 120, out_value);
}

static gchar* format_relative_time_ms(gint64 ts_ms) {
    if (ts_ms <= 0) return g_strdup("\u2014");
    gint64 now_ms = g_get_real_time() / 1000;
    gint64 diff_s = (now_ms - ts_ms) / 1000;
    if (diff_s < 0) diff_s = 0;
    if (diff_s < 60) return g_strdup("just now");
    if (diff_s < 3600) return g_strdup_printf("%ldm ago", (long)(diff_s / 60));
    if (diff_s < 86400) return g_strdup_printf("%ldh ago", (long)(diff_s / 3600));
    return g_strdup_printf("%ldd ago", (long)(diff_s / 86400));
}

static void add_detail_row(GtkWidget *parent, const gchar *label, const gchar *value) {
    if (!value) return;
    GtkWidget *row = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
    GtkWidget *h = gtk_label_new(label);
    gtk_widget_add_css_class(h, "dim-label");
    gtk_widget_set_size_request(h, 100, -1);
    gtk_label_set_xalign(GTK_LABEL(h), 0.0);
    gtk_box_append(GTK_BOX(row), h);
    GtkWidget *v = gtk_label_new(value);
    gtk_label_set_xalign(GTK_LABEL(v), 0.0);
    gtk_label_set_ellipsize(GTK_LABEL(v), PANGO_ELLIPSIZE_END);
    gtk_box_append(GTK_BOX(row), v);
    gtk_box_append(GTK_BOX(parent), row);
}

/* ── Mutation callbacks ──────────────────────────────────────────── */

static void on_mutation_done(const GatewayRpcResponse *response, gpointer user_data) {
    InstancesRequestContext *ctx = (InstancesRequestContext *)user_data;
    if (instances_request_context_is_stale(ctx)) {
        instances_request_context_free(ctx);
        return;
    }
    instances_request_context_free(ctx);

    if (!response || !response->ok) {
        if (inst_remote_status_label) {
            g_autofree gchar *msg = g_strdup_printf("Error: %s",
                response && response->error_msg ? response->error_msg : "unknown");
            gtk_label_set_text(GTK_LABEL(inst_remote_status_label), msg);
        }
    }

    inst_force_refresh();
}

/* ── Pairing action handlers ─────────────────────────────────────── */

static void on_pair_approve(GtkButton *btn, gpointer user_data) {
    (void)user_data;
    const gchar *req_id = (const gchar *)g_object_get_data(G_OBJECT(btn), "request-id");
    if (!req_id) return;

    gtk_widget_set_sensitive(GTK_WIDGET(btn), FALSE);
    if (inst_pairing_status_label)
        gtk_label_set_text(GTK_LABEL(inst_pairing_status_label), "Approving\u2026");

    InstancesRequestContext *ctx = instances_request_context_new();
    g_autofree gchar *req = mutation_node_pair_approve(req_id, on_mutation_done, ctx);
    if (!req) {
        instances_request_context_free(ctx);
        gtk_widget_set_sensitive(GTK_WIDGET(btn), TRUE);
        if (inst_pairing_status_label)
            gtk_label_set_text(GTK_LABEL(inst_pairing_status_label), "Failed to send request");
    }
}

static void on_pair_reject(GtkButton *btn, gpointer user_data) {
    (void)user_data;
    const gchar *req_id = (const gchar *)g_object_get_data(G_OBJECT(btn), "request-id");
    if (!req_id) return;

    gtk_widget_set_sensitive(GTK_WIDGET(btn), FALSE);
    if (inst_pairing_status_label)
        gtk_label_set_text(GTK_LABEL(inst_pairing_status_label), "Rejecting\u2026");

    InstancesRequestContext *ctx = instances_request_context_new();
    g_autofree gchar *req = mutation_node_pair_reject(req_id, on_mutation_done, ctx);
    if (!req) {
        instances_request_context_free(ctx);
        gtk_widget_set_sensitive(GTK_WIDGET(btn), TRUE);
        if (inst_pairing_status_label)
            gtk_label_set_text(GTK_LABEL(inst_pairing_status_label), "Failed to send request");
    }
}

static void on_refresh_nodes(GtkButton *btn, gpointer user_data) {
    (void)btn; (void)user_data;
    inst_force_refresh();
}

static gchar* inst_build_debug_summary(void) {
    GString *s = g_string_new("OpenClaw Linux Instances Debug\n");

    gint pending_count = 0;
    gint paired_count = 0;
    if (inst_pairing_cache) {
        pending_count = inst_pairing_cache->n_pending;
        paired_count = inst_pairing_cache->n_paired;
    }
    g_string_append_printf(s, "Pending pair requests: %d\n", pending_count);
    g_string_append_printf(s, "Paired nodes: %d\n", paired_count);

    gint total_nodes = inst_nodes_cache ? inst_nodes_cache->n_nodes : 0;
    g_string_append_printf(s, "Nodes: %d\n", total_nodes);

    if (inst_nodes_cache) {
        for (gint i = 0; i < inst_nodes_cache->n_nodes; i++) {
            GatewayNode *nd = &inst_nodes_cache->nodes[i];
            g_string_append_printf(
                s,
                "- %s (%s) status=%s paired=%s platform=%s version=%s\n",
                nd->display_name ? nd->display_name : "unknown",
                nd->node_id ? nd->node_id : "unknown",
                nd->connected ? "connected" : "disconnected",
                nd->paired ? "true" : "false",
                nd->platform ? nd->platform : "unknown",
                nd->version ? nd->version : "unknown");
        }
    }

    return g_string_free(s, FALSE);
}

static gboolean on_copy_debug_label_reset(gpointer data) {
    GtkWidget *btn = GTK_WIDGET(data);
    if (btn) {
        gtk_button_set_label(GTK_BUTTON(btn), "Copy Debug Info");
    }
    return G_SOURCE_REMOVE;
}

static void on_copy_debug(GtkButton *btn, gpointer user_data) {
    (void)user_data;
    g_autofree gchar *summary = inst_build_debug_summary();
    if (!summary) return;

    GdkClipboard *cb = gdk_display_get_clipboard(gdk_display_get_default());
    gdk_clipboard_set_text(cb, summary);

    gtk_button_set_label(GTK_BUTTON(btn), "Copied!");
    g_timeout_add_seconds(2, on_copy_debug_label_reset, btn);
}

/* ── Remote node card builder ────────────────────────────────────── */

static void build_node_card(GatewayNode *nd) {
    GtkWidget *frame = gtk_frame_new(NULL);
    gtk_widget_set_margin_top(frame, 4);

    GtkWidget *card = gtk_box_new(GTK_ORIENTATION_VERTICAL, 2);
    gtk_widget_set_margin_start(card, 12);
    gtk_widget_set_margin_end(card, 12);
    gtk_widget_set_margin_top(card, 8);
    gtk_widget_set_margin_bottom(card, 8);

    /* Header: dot + name + platform */
    GtkWidget *hdr = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);

    GtkWidget *dot = gtk_label_new(nd->connected ? "\u25CF" : "\u25CB");
    gtk_widget_add_css_class(dot, nd->connected ? "success" : "dim-label");
    gtk_box_append(GTK_BOX(hdr), dot);

    GtkWidget *name_lbl = gtk_label_new(
        nd->display_name ? nd->display_name : nd->node_id);
    gtk_widget_add_css_class(name_lbl, "heading");
    gtk_label_set_xalign(GTK_LABEL(name_lbl), 0.0);
    gtk_widget_set_hexpand(name_lbl, TRUE);
    gtk_box_append(GTK_BOX(hdr), name_lbl);

    if (nd->platform) {
        GtkWidget *plat = gtk_label_new(nd->platform);
        gtk_widget_add_css_class(plat, "dim-label");
        gtk_box_append(GTK_BOX(hdr), plat);
    }

    if (nd->paired) {
        GtkWidget *pbadge = gtk_label_new("paired");
        gtk_widget_add_css_class(pbadge, "success");
        gtk_box_append(GTK_BOX(hdr), pbadge);
    }

    gtk_box_append(GTK_BOX(card), hdr);

    /* Detail rows */
    add_detail_row(card, "Version", nd->version);
    add_detail_row(card, "Device", nd->device_family);
    add_detail_row(card, "Model", nd->model_identifier);
    add_detail_row(card, "Remote IP", nd->remote_ip);
    add_detail_row(card, "Core", nd->core_version);
    add_detail_row(card, "UI", nd->ui_version);

    if (nd->connected_at_ms > 0) {
        g_autofree gchar *ct = format_relative_time_ms(nd->connected_at_ms);
        g_autofree gchar *ct_text = g_strdup_printf("Connected %s", ct);
        add_detail_row(card, "Connected", ct_text);
    }

    if (nd->approved_at_ms > 0) {
        g_autofree gchar *at = format_relative_time_ms(nd->approved_at_ms);
        g_autofree gchar *at_text = g_strdup_printf("Approved %s", at);
        add_detail_row(card, "Approved", at_text);
    }

    gtk_frame_set_child(GTK_FRAME(frame), card);
    gtk_box_append(GTK_BOX(inst_remote_box), frame);
}

/* ── Remote nodes rebuild ────────────────────────────────────────── */

static void inst_rebuild_remote_nodes(void) {
    if (!inst_remote_box) return;

    section_box_clear(inst_remote_box);

    if (!inst_nodes_cache || inst_nodes_cache->n_nodes == 0) {
        GtkWidget *empty = gtk_label_new("No remote instances.");
        gtk_widget_add_css_class(empty, "dim-label");
        gtk_label_set_xalign(GTK_LABEL(empty), 0.0);
        gtk_box_append(GTK_BOX(inst_remote_box), empty);
        return;
    }

    for (gint i = 0; i < inst_nodes_cache->n_nodes; i++) {
        build_node_card(&inst_nodes_cache->nodes[i]);
    }
}

/* ── Pairing rebuild ─────────────────────────────────────────────── */

static void inst_rebuild_pairing(void) {
    if (!inst_pairing_box) return;

    section_box_clear(inst_pairing_box);

    if (!inst_pairing_cache) return;

    /* Pending pair requests */
    if (inst_pairing_cache->n_pending > 0) {
        GtkWidget *pend_title = gtk_label_new("Pending Requests");
        gtk_widget_add_css_class(pend_title, "heading");
        gtk_label_set_xalign(GTK_LABEL(pend_title), 0.0);
        gtk_widget_set_margin_top(pend_title, 4);
        gtk_box_append(GTK_BOX(inst_pairing_box), pend_title);

        for (gint i = 0; i < inst_pairing_cache->n_pending; i++) {
            GatewayPendingPairRequest *pr = &inst_pairing_cache->pending[i];

            GtkWidget *frame = gtk_frame_new(NULL);
            gtk_widget_set_margin_top(frame, 4);

            GtkWidget *card = gtk_box_new(GTK_ORIENTATION_VERTICAL, 4);
            gtk_widget_set_margin_start(card, 12);
            gtk_widget_set_margin_end(card, 12);
            gtk_widget_set_margin_top(card, 8);
            gtk_widget_set_margin_bottom(card, 8);

            /* Header */
            GtkWidget *hdr = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
            GtkWidget *dot = gtk_label_new("\u25CE");
            gtk_widget_add_css_class(dot, "warning");
            gtk_box_append(GTK_BOX(hdr), dot);

            GtkWidget *name = gtk_label_new(
                pr->display_name ? pr->display_name : pr->node_id);
            gtk_widget_add_css_class(name, "heading");
            gtk_label_set_xalign(GTK_LABEL(name), 0.0);
            gtk_widget_set_hexpand(name, TRUE);
            gtk_box_append(GTK_BOX(hdr), name);

            if (pr->is_repair) {
                GtkWidget *repair = gtk_label_new("re-pair");
                gtk_widget_add_css_class(repair, "warning");
                gtk_box_append(GTK_BOX(hdr), repair);
            }

            gtk_box_append(GTK_BOX(card), hdr);

            /* Details */
            add_detail_row(card, "Platform", pr->platform);
            add_detail_row(card, "Version", pr->version);
            add_detail_row(card, "Remote IP", pr->remote_ip);

            /* Approve / Reject buttons */
            GtkWidget *actions = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 6);
            gtk_widget_set_margin_top(actions, 4);

            GtkWidget *btn_approve = gtk_button_new_with_label("Approve");
            gtk_widget_add_css_class(btn_approve, "suggested-action");
            g_object_set_data_full(G_OBJECT(btn_approve), "request-id",
                g_strdup(pr->request_id), g_free);
            g_signal_connect(btn_approve, "clicked", G_CALLBACK(on_pair_approve), NULL);
            gtk_box_append(GTK_BOX(actions), btn_approve);

            GtkWidget *btn_reject = gtk_button_new_with_label("Reject");
            gtk_widget_add_css_class(btn_reject, "flat");
            gtk_widget_add_css_class(btn_reject, "destructive-action");
            g_object_set_data_full(G_OBJECT(btn_reject), "request-id",
                g_strdup(pr->request_id), g_free);
            g_signal_connect(btn_reject, "clicked", G_CALLBACK(on_pair_reject), NULL);
            gtk_box_append(GTK_BOX(actions), btn_reject);

            gtk_box_append(GTK_BOX(card), actions);

            gtk_frame_set_child(GTK_FRAME(frame), card);
            gtk_box_append(GTK_BOX(inst_pairing_box), frame);
        }
    }

    /* Already paired nodes */
    if (inst_pairing_cache->n_paired > 0) {
        GtkWidget *paired_title = gtk_label_new("Paired Nodes");
        gtk_widget_add_css_class(paired_title, "heading");
        gtk_label_set_xalign(GTK_LABEL(paired_title), 0.0);
        gtk_widget_set_margin_top(paired_title, 8);
        gtk_box_append(GTK_BOX(inst_pairing_box), paired_title);

        for (gint i = 0; i < inst_pairing_cache->n_paired; i++) {
            GatewayPairedNode *pn = &inst_pairing_cache->paired[i];

            GtkWidget *row = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
            gtk_widget_set_margin_top(row, 2);

            GtkWidget *dot = gtk_label_new("\u25CF");
            gtk_widget_add_css_class(dot, "success");
            gtk_box_append(GTK_BOX(row), dot);

            GtkWidget *name = gtk_label_new(
                pn->display_name ? pn->display_name : pn->node_id);
            gtk_label_set_xalign(GTK_LABEL(name), 0.0);
            gtk_widget_set_hexpand(name, TRUE);
            gtk_box_append(GTK_BOX(row), name);

            if (pn->platform) {
                GtkWidget *plat = gtk_label_new(pn->platform);
                gtk_widget_add_css_class(plat, "dim-label");
                gtk_box_append(GTK_BOX(row), plat);
            }

            if (pn->approved_at_ms > 0) {
                g_autofree gchar *at = format_relative_time_ms((gint64)pn->approved_at_ms);
                GtkWidget *ts = gtk_label_new(at);
                gtk_widget_add_css_class(ts, "dim-label");
                gtk_box_append(GTK_BOX(row), ts);
            }

            gtk_box_append(GTK_BOX(inst_pairing_box), row);
        }
    }

    /* Update pairing status */
    if (inst_pairing_status_label) {
        g_autofree gchar *msg = g_strdup_printf(
            "%d pending, %d paired",
            inst_pairing_cache->n_pending, inst_pairing_cache->n_paired);
        gtk_label_set_text(GTK_LABEL(inst_pairing_status_label), msg);
    }
}

/* ── RPC callbacks ───────────────────────────────────────────────── */

static void on_nodes_rpc_response(const GatewayRpcResponse *response, gpointer user_data) {
    InstancesRequestContext *ctx = (InstancesRequestContext *)user_data;
    if (instances_request_context_is_stale(ctx)) {
        instances_request_context_free(ctx);
        return;
    }
    instances_request_context_free(ctx);

    inst_nodes_fetch_in_flight = FALSE;

    if (!inst_remote_box) return;

    if (!response || !response->ok) {
        if (inst_remote_status_label) {
            g_autofree gchar *msg = g_strdup_printf("Error: %s",
                response && response->error_msg ? response->error_msg : "unknown");
            gtk_label_set_text(GTK_LABEL(inst_remote_status_label), msg);
        }
        return;
    }

    section_mark_fresh(&inst_last_fetch_us);
    gateway_nodes_data_free(inst_nodes_cache);
    inst_nodes_cache = gateway_data_parse_nodes(response->payload);

    if (inst_remote_status_label) {
        if (inst_nodes_cache) {
            gint connected = 0;
            for (gint i = 0; i < inst_nodes_cache->n_nodes; i++) {
                if (inst_nodes_cache->nodes[i].connected) connected++;
            }
            g_autofree gchar *msg = g_strdup_printf("%d node%s (%d online)",
                inst_nodes_cache->n_nodes,
                inst_nodes_cache->n_nodes == 1 ? "" : "s",
                connected);
            gtk_label_set_text(GTK_LABEL(inst_remote_status_label), msg);
        } else {
            gtk_label_set_text(GTK_LABEL(inst_remote_status_label), "Failed to parse response");
        }
    }

    inst_rebuild_remote_nodes();

    /* Also fetch pairing list */
    inst_fetch_pairing();
}

static void on_pairing_rpc_response(const GatewayRpcResponse *response, gpointer user_data) {
    InstancesRequestContext *ctx = (InstancesRequestContext *)user_data;
    if (instances_request_context_is_stale(ctx)) {
        instances_request_context_free(ctx);
        return;
    }
    instances_request_context_free(ctx);

    inst_pairing_fetch_in_flight = FALSE;

    if (!inst_pairing_box) return;

    if (!response || !response->ok) {
        if (inst_pairing_status_label) {
            g_autofree gchar *msg = g_strdup_printf("Error: %s",
                response && response->error_msg ? response->error_msg : "unknown");
            gtk_label_set_text(GTK_LABEL(inst_pairing_status_label), msg);
        }
        return;
    }

    gateway_pairing_list_free(inst_pairing_cache);
    inst_pairing_cache = gateway_data_parse_pairing_list(response->payload);

    inst_rebuild_pairing();
}

/* ── Pairing fetch ───────────────────────────────────────────────── */

static void inst_fetch_pairing(void) {
    if (!inst_pairing_box || inst_pairing_fetch_in_flight) return;
    if (!gateway_rpc_is_ready()) return;

    inst_pairing_fetch_in_flight = TRUE;
    InstancesRequestContext *ctx = instances_request_context_new();
    g_autofree gchar *req = mutation_node_pair_list(on_pairing_rpc_response, ctx);
    if (!req) {
        instances_request_context_free(ctx);
        inst_pairing_fetch_in_flight = FALSE;
    }
}

/* ── Force refresh (after mutation) ──────────────────────────────── */

static void inst_force_refresh(void) {
    section_mark_stale(&inst_last_fetch_us);
    inst_nodes_fetch_in_flight = FALSE;
    inst_pairing_fetch_in_flight = FALSE;

    if (!inst_remote_box) return;
    if (!gateway_rpc_is_ready()) return;

    inst_nodes_fetch_in_flight = TRUE;
    InstancesRequestContext *nodes_ctx = instances_request_context_new();
    g_autofree gchar *req_id = gateway_rpc_request(
        "node.list", NULL, 0, on_nodes_rpc_response, nodes_ctx);
    if (!req_id) {
        instances_request_context_free(nodes_ctx);
        inst_nodes_fetch_in_flight = FALSE;
    }

    inst_pairing_fetch_in_flight = TRUE;
    InstancesRequestContext *pair_ctx = instances_request_context_new();
    g_autofree gchar *req_id_pair = mutation_node_pair_list(on_pairing_rpc_response, pair_ctx);
    if (!req_id_pair) {
        instances_request_context_free(pair_ctx);
        inst_pairing_fetch_in_flight = FALSE;
        if (inst_remote_status_label) gtk_label_set_text(GTK_LABEL(inst_remote_status_label), "");
    }
}

/* ── Local instance refresh (local-only, no RPC) ─────────────────── */

static void section_instances_refresh_local(void) {
    if (!inst_hostname_label) return;

    AppState current = state_get_current();
    RuntimeMode rm = state_get_runtime_mode();
    HealthState *health = state_get_health();
    SystemdState *sys = state_get_systemd();

    ReadinessInfo ri;
    readiness_evaluate(current, health, sys, &ri);

    DashboardDisplayModel dm;
    dashboard_display_model_build(current, rm, &ri, health, sys, &dm);

    g_autofree gchar *hostname = g_strdup(g_get_host_name());
    gtk_label_set_text(GTK_LABEL(inst_hostname_label), hostname ? hostname : "\u2014");
    gtk_label_set_text(GTK_LABEL(inst_platform_label), "Linux");
    gtk_label_set_text(GTK_LABEL(inst_version_label),
        dm.gateway_version ? dm.gateway_version : "\u2014");
    gtk_label_set_text(GTK_LABEL(inst_runtime_label),
        dm.runtime_label ? dm.runtime_label : "\u2014");

    GatewayConfig *cfg = gateway_client_get_config();
    if (cfg) {
        g_autofree gchar *ep = g_strdup_printf("%s:%d", cfg->host ? cfg->host : "127.0.0.1", cfg->port);
        gtk_label_set_text(GTK_LABEL(inst_endpoint_label), ep);
    } else {
        gtk_label_set_text(GTK_LABEL(inst_endpoint_label), "\u2014");
    }

    gtk_label_set_text(GTK_LABEL(inst_unit_label),
        dm.unit_name ? dm.unit_name : "\u2014");

    if (dm.active_state && dm.sub_state) {
        g_autofree gchar *state_text = g_strdup_printf("%s (%s)", dm.active_state, dm.sub_state);
        gtk_label_set_text(GTK_LABEL(inst_state_label), state_text);
    } else {
        gtk_label_set_text(GTK_LABEL(inst_state_label),
            dm.active_state ? dm.active_state : "\u2014");
    }
}

/* ── SectionController callbacks ─────────────────────────────────── */

static GtkWidget* instances_build(void) {
    GtkWidget *scrolled = gtk_scrolled_window_new();
    gtk_scrolled_window_set_policy(GTK_SCROLLED_WINDOW(scrolled),
                                   GTK_POLICY_NEVER, GTK_POLICY_AUTOMATIC);

    GtkWidget *page = gtk_box_new(GTK_ORIENTATION_VERTICAL, 4);
    gtk_widget_set_margin_start(page, 24);
    gtk_widget_set_margin_end(page, 24);
    gtk_widget_set_margin_top(page, 24);
    gtk_widget_set_margin_bottom(page, 24);

    GtkWidget *title = gtk_label_new("Instances");
    gtk_widget_add_css_class(title, "title-1");
    gtk_label_set_xalign(GTK_LABEL(title), 0.0);
    gtk_box_append(GTK_BOX(page), title);

    GtkWidget *subtitle = gtk_label_new("Local gateway instance and remote nodes.");
    gtk_widget_add_css_class(subtitle, "dim-label");
    gtk_label_set_xalign(GTK_LABEL(subtitle), 0.0);
    gtk_box_append(GTK_BOX(page), subtitle);

    /* Local instance card */
    GtkWidget *card_frame = gtk_frame_new(NULL);
    gtk_widget_set_margin_top(card_frame, 12);

    GtkWidget *card = gtk_box_new(GTK_ORIENTATION_VERTICAL, 2);
    gtk_widget_set_margin_start(card, 16);
    gtk_widget_set_margin_end(card, 16);
    gtk_widget_set_margin_top(card, 12);
    gtk_widget_set_margin_bottom(card, 12);

    GtkWidget *card_title = gtk_label_new("Local Instance");
    gtk_widget_add_css_class(card_title, "heading");
    gtk_label_set_xalign(GTK_LABEL(card_title), 0.0);
    gtk_box_append(GTK_BOX(card), card_title);

    GtkWidget *sep = gtk_separator_new(GTK_ORIENTATION_HORIZONTAL);
    gtk_widget_set_margin_top(sep, 4);
    gtk_widget_set_margin_bottom(sep, 4);
    gtk_box_append(GTK_BOX(card), sep);

    gtk_box_append(GTK_BOX(card), inst_card_row("Hostname", &inst_hostname_label));
    gtk_box_append(GTK_BOX(card), inst_card_row("Platform", &inst_platform_label));
    gtk_box_append(GTK_BOX(card), inst_card_row("Version", &inst_version_label));
    gtk_box_append(GTK_BOX(card), inst_card_row("Runtime", &inst_runtime_label));
    gtk_box_append(GTK_BOX(card), inst_card_row("Endpoint", &inst_endpoint_label));
    gtk_box_append(GTK_BOX(card), inst_card_row("Unit", &inst_unit_label));
    gtk_box_append(GTK_BOX(card), inst_card_row("Service State", &inst_state_label));

    gtk_frame_set_child(GTK_FRAME(card_frame), card);
    gtk_box_append(GTK_BOX(page), card_frame);

    /* Remote nodes section */
    GtkWidget *remote_hdr = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
    gtk_widget_set_margin_top(remote_hdr, 16);

    GtkWidget *remote_title = gtk_label_new("Remote Instances");
    gtk_widget_add_css_class(remote_title, "heading");
    gtk_label_set_xalign(GTK_LABEL(remote_title), 0.0);
    gtk_widget_set_hexpand(remote_title, TRUE);
    gtk_box_append(GTK_BOX(remote_hdr), remote_title);

    GtkWidget *btn_refresh = gtk_button_new_with_label("Refresh");
    gtk_widget_add_css_class(btn_refresh, "flat");
    g_signal_connect(btn_refresh, "clicked", G_CALLBACK(on_refresh_nodes), NULL);
    gtk_box_append(GTK_BOX(remote_hdr), btn_refresh);

    inst_copy_debug_btn = gtk_button_new_with_label("Copy Debug Info");
    gtk_widget_add_css_class(inst_copy_debug_btn, "flat");
    g_signal_connect(inst_copy_debug_btn, "clicked", G_CALLBACK(on_copy_debug), NULL);
    gtk_box_append(GTK_BOX(remote_hdr), inst_copy_debug_btn);

    gtk_box_append(GTK_BOX(page), remote_hdr);

    inst_remote_status_label = gtk_label_new("Loading\u2026");
    gtk_widget_add_css_class(inst_remote_status_label, "dim-label");
    gtk_label_set_xalign(GTK_LABEL(inst_remote_status_label), 0.0);
    gtk_box_append(GTK_BOX(page), inst_remote_status_label);

    inst_remote_box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 4);
    gtk_widget_set_margin_top(inst_remote_box, 4);
    gtk_box_append(GTK_BOX(page), inst_remote_box);

    /* Pairing section */
    GtkWidget *pair_sep = gtk_separator_new(GTK_ORIENTATION_HORIZONTAL);
    gtk_widget_set_margin_top(pair_sep, 12);
    gtk_widget_set_margin_bottom(pair_sep, 4);
    gtk_box_append(GTK_BOX(page), pair_sep);

    GtkWidget *pair_title = gtk_label_new("Node Pairing");
    gtk_widget_add_css_class(pair_title, "heading");
    gtk_label_set_xalign(GTK_LABEL(pair_title), 0.0);
    gtk_box_append(GTK_BOX(page), pair_title);

    inst_pairing_status_label = gtk_label_new("Loading\u2026");
    gtk_widget_add_css_class(inst_pairing_status_label, "dim-label");
    gtk_label_set_xalign(GTK_LABEL(inst_pairing_status_label), 0.0);
    gtk_box_append(GTK_BOX(page), inst_pairing_status_label);

    inst_pairing_box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 4);
    gtk_widget_set_margin_top(inst_pairing_box, 4);
    gtk_box_append(GTK_BOX(page), inst_pairing_box);

    gtk_scrolled_window_set_child(GTK_SCROLLED_WINDOW(scrolled), page);
    return scrolled;
}

static void instances_refresh(void) {
    section_instances_refresh_local();
    if (!inst_remote_box || inst_nodes_fetch_in_flight) return;
    if (!section_is_stale(&inst_last_fetch_us)) return;
    if (!gateway_rpc_is_ready()) {
        if (inst_remote_status_label)
            gtk_label_set_text(GTK_LABEL(inst_remote_status_label), "Gateway not connected");
        return;
    }

    inst_nodes_fetch_in_flight = TRUE;
    InstancesRequestContext *nodes_ctx = instances_request_context_new();
    g_autofree gchar *req_id = gateway_rpc_request(
        "node.list", NULL, 0, on_nodes_rpc_response, nodes_ctx);
    if (!req_id) {
        instances_request_context_free(nodes_ctx);
        inst_nodes_fetch_in_flight = FALSE;
        if (inst_remote_status_label)
            gtk_label_set_text(GTK_LABEL(inst_remote_status_label), "Failed to send request");
    }

    if (!inst_pairing_fetch_in_flight) {
        inst_fetch_pairing();
    }
}

static void instances_destroy(void) {
    inst_generation++;

    inst_hostname_label = NULL;
    inst_platform_label = NULL;
    inst_version_label = NULL;
    inst_runtime_label = NULL;
    inst_endpoint_label = NULL;
    inst_unit_label = NULL;
    inst_state_label = NULL;
    inst_remote_box = NULL;
    inst_remote_status_label = NULL;
    inst_copy_debug_btn = NULL;
    inst_pairing_box = NULL;
    inst_pairing_status_label = NULL;
    inst_nodes_fetch_in_flight = FALSE;
    inst_pairing_fetch_in_flight = FALSE;
    gateway_nodes_data_free(inst_nodes_cache);
    inst_nodes_cache = NULL;
    gateway_pairing_list_free(inst_pairing_cache);
    inst_pairing_cache = NULL;
    inst_last_fetch_us = 0;
}

static void instances_invalidate(void) {
    section_mark_stale(&inst_last_fetch_us);
}

/* ── Public ──────────────────────────────────────────────────────── */

static const SectionController instances_controller = {
    .build      = instances_build,
    .refresh    = instances_refresh,
    .destroy    = instances_destroy,
    .invalidate = instances_invalidate,
};

const SectionController* section_instances_get(void) {
    return &instances_controller;
}
