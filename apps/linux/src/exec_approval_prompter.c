/*
 * exec_approval_prompter.c
 *
 * Subscribe to `exec.approval.requested` / `exec.approval.resolved`
 * events, queue requests one-at-a-time, present an Adw dialog (or a
 * test seam hook) for the operator's decision, and dispatch the result
 * back to the gateway via `exec.approval.resolve` RPC.
 *
 * Mirrors the contract proven by `device_pair_prompter.c`. Per Tranche B
 * scope, exec.approval.list seeding is intentionally NOT wired here —
 * the response envelope is not yet contractually fixed for cross-client
 * reuse.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "exec_approval_prompter.h"

#include "exec_approval_store.h"
#include "exec_approval_window.h"
#include "gateway_rpc.h"
#include "gateway_ws.h"
#include "json_access.h"
#include "log.h"

#include <string.h>

typedef struct {
    guint                     event_listener_id;
    GtkWindow                *parent;
    GQueue                   *pending;            /* of OcExecApprovalRequest* */
    gboolean                  presenting;
    /* Active request id; tracked separately so the resolved-event
     * handler can compare without dereferencing the hook-owned pointer. */
    gchar                    *active_request_id;
    /* Test seam */
    OcExecApprovalPresentHook present_hook;
    gpointer                  present_hook_user_data;
} ExecPromptState;

static ExecPromptState g_state = {0};

/* ── Forward decls ── */
static void try_present_next(void);
static gboolean queue_contains_request_id(const gchar *request_id);
static void     remove_request_from_queue(const gchar *request_id);
static OcExecQuickMode resolve_effective_quick_mode(void);

/* ── Parent lifetime (mirrors device_pair_prompter.c) ── */

static void on_parent_destroyed(gpointer data, GObject *where_the_object_was) {
    (void)data;
    if (g_state.parent == (GtkWindow *)where_the_object_was) {
        g_state.parent = NULL;
    }
}

static void parent_clear_ref(void) {
    if (g_state.parent) {
        g_object_weak_unref(G_OBJECT(g_state.parent), on_parent_destroyed, NULL);
        g_state.parent = NULL;
    }
}

static void parent_assign(GtkWindow *parent) {
    if (g_state.parent == parent) return;
    parent_clear_ref();
    if (parent) {
        g_state.parent = parent;
        g_object_weak_ref(G_OBJECT(parent), on_parent_destroyed, NULL);
    }
}

/* ── RPC dispatch ── */

static void on_resolve_rpc_response(const GatewayRpcResponse *response,
                                    gpointer user_data) {
    g_autofree gchar *id_copy = (gchar *)user_data;
    if (!response) return;
    if (!response->ok) {
        OC_LOG_WARN(OPENCLAW_LOG_CAT_GATEWAY,
                    "exec.approval.resolve RPC failed (id=%s): %s",
                    id_copy ? id_copy : "(null)",
                    response->error_msg ? response->error_msg : "(no detail)");
    }
}

static void send_resolve_rpc(const OcExecApprovalRequest *req,
                             OcExecDecision decision) {
    if (!req || !req->id || req->id[0] == '\0') {
        OC_LOG_WARN(OPENCLAW_LOG_CAT_GATEWAY,
                    "exec.approval.resolve skipped: missing request id");
        return;
    }

    const gchar *decision_str = oc_exec_decision_to_string(decision);

    g_autoptr(JsonBuilder) b = json_builder_new();
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "id");
    json_builder_add_string_value(b, req->id);
    json_builder_set_member_name(b, "decision");
    json_builder_add_string_value(b, decision_str);
    json_builder_end_object(b);
    g_autoptr(JsonNode) params = json_builder_get_root(b);

    /* Pass a heap-owned id copy as user_data so the response logger can
     * report which request the failure was for, without surviving the
     * prompter teardown. */
    gchar *id_copy = g_strdup(req->id);
    g_autofree gchar *rpc_req_id = gateway_rpc_request(
        "exec.approval.resolve", params, 0,
        on_resolve_rpc_response, id_copy);
    if (!rpc_req_id) {
        g_free(id_copy);
        OC_LOG_WARN(OPENCLAW_LOG_CAT_GATEWAY,
                    "exec.approval.resolve dispatch failed for id=%s "
                    "(WS not ready)",
                    req->id);
    } else {
        OC_LOG_INFO(OPENCLAW_LOG_CAT_GATEWAY,
                    "exec.approval.resolve dispatched id=%s decision=%s",
                    req->id, decision_str);
    }
}

/* ── Queue core ── */

static void on_decision_recorded(const OcExecApprovalRequest *req,
                                 OcExecDecision decision,
                                 gpointer user_data) {
    (void)user_data;
    g_state.presenting = FALSE;
    g_clear_pointer(&g_state.active_request_id, g_free);

    /* Honor `allowedDecisions`: if the gateway constrained the set and
     * the operator (or auto-policy) picked an excluded decision,
     * downgrade to allow-once or deny rather than forwarding garbage. */
    if (!oc_exec_approval_request_allows_decision(req, oc_exec_decision_to_string(decision))) {
        if (decision == OC_EXEC_DECISION_ALLOW_ALWAYS &&
            oc_exec_approval_request_allows_decision(req, "allow-once")) {
            OC_LOG_DEBUG(OPENCLAW_LOG_CAT_GATEWAY,
                         "exec approval id=%s downgrading allow-always -> allow-once "
                         "(not in allowedDecisions)",
                         req->id ? req->id : "(null)");
            decision = OC_EXEC_DECISION_ALLOW_ONCE;
        } else {
            OC_LOG_DEBUG(OPENCLAW_LOG_CAT_GATEWAY,
                         "exec approval id=%s requested decision not allowed; sending deny",
                         req->id ? req->id : "(null)");
            decision = OC_EXEC_DECISION_DENY;
        }
    }

    send_resolve_rpc(req, decision);
    try_present_next();
}

static void default_present(const OcExecApprovalRequest *req,
                            OcExecDecisionCallback record_decision,
                            gpointer record_user_data,
                            gpointer hook_user_data) {
    (void)hook_user_data;
    exec_approval_window_present(g_state.parent, req, record_decision, record_user_data);
}

static OcExecQuickMode resolve_effective_quick_mode(void) {
    return exec_approval_store_get_quick_mode();
}

/*
 * Decide whether the request can be auto-resolved without prompting,
 * based on the persisted quick mode. Returns TRUE and writes
 * `*out_decision` when auto-resolved.
 */
static gboolean try_auto_resolve(const OcExecApprovalRequest *req,
                                 OcExecDecision *out_decision) {
    OcExecQuickMode mode = resolve_effective_quick_mode();
    switch (mode) {
    case OC_EXEC_QUICK_MODE_DENY:
        *out_decision = OC_EXEC_DECISION_DENY;
        return TRUE;
    case OC_EXEC_QUICK_MODE_ALLOW:
        *out_decision = oc_exec_approval_request_allows_decision(req, "allow-once")
                            ? OC_EXEC_DECISION_ALLOW_ONCE
                            : OC_EXEC_DECISION_DENY;
        return TRUE;
    case OC_EXEC_QUICK_MODE_ASK:
    default:
        return FALSE;
    }
}

static void try_present_next(void) {
    if (g_state.presenting) return;
    if (!g_state.pending || g_queue_is_empty(g_state.pending)) return;

    OcExecApprovalRequest *req = g_queue_pop_head(g_state.pending);
    if (!req) return;

    /* Drop expired entries silently. The gateway's record is already
     * cleared at this point, so any decision RPC we send would race a
     * "not found" error path. */
    gint64 now_ms = oc_exec_approval_now_ms();
    if (oc_exec_approval_request_is_expired(req, now_ms)) {
        OC_LOG_DEBUG(OPENCLAW_LOG_CAT_GATEWAY,
                     "exec approval id=%s expired (expiresAtMs=%" G_GINT64_FORMAT
                     " now_ms=%" G_GINT64_FORMAT "); dropping",
                     req->id, req->expires_at_ms, now_ms);
        oc_exec_approval_request_free(req);
        try_present_next();
        return;
    }

    OcExecDecision auto_decision = OC_EXEC_DECISION_DENY;
    if (try_auto_resolve(req, &auto_decision)) {
        OC_LOG_INFO(OPENCLAW_LOG_CAT_GATEWAY,
                    "exec approval id=%s auto-resolved as %s",
                    req->id, oc_exec_decision_to_string(auto_decision));
        send_resolve_rpc(req, auto_decision);
        oc_exec_approval_request_free(req);
        try_present_next();
        return;
    }

    g_state.presenting = TRUE;
    g_clear_pointer(&g_state.active_request_id, g_free);
    g_state.active_request_id = g_strdup(req->id);

    OcExecApprovalPresentHook hook = g_state.present_hook
        ? g_state.present_hook
        : default_present;

    /* Hook MUST invoke `record_decision` exactly once. While it does
     * not, `presenting` stays TRUE and further events only enqueue. */
    hook(req, on_decision_recorded, NULL, g_state.present_hook_user_data);

    /* The default presenter (or any well-behaved test hook) takes its
     * own copy via oc_exec_approval_request_copy(). Free our local. */
    oc_exec_approval_request_free(req);
}

/* ── Event pipeline ── */

static gboolean queue_contains_request_id(const gchar *request_id) {
    if (!request_id || !g_state.pending) return FALSE;
    for (GList *it = g_state.pending->head; it; it = it->next) {
        const OcExecApprovalRequest *entry = it->data;
        if (entry && g_strcmp0(entry->id, request_id) == 0) return TRUE;
    }
    return FALSE;
}

static void remove_request_from_queue(const gchar *request_id) {
    if (!request_id || !g_state.pending) return;
    GList *it = g_state.pending->head;
    while (it) {
        GList *next = it->next;
        OcExecApprovalRequest *entry = it->data;
        if (entry && g_strcmp0(entry->id, request_id) == 0) {
            g_queue_delete_link(g_state.pending, it);
            oc_exec_approval_request_free(entry);
        }
        it = next;
    }
}

static void handle_exec_approval_requested(JsonNode *payload) {
    OcExecApprovalRequest *req = oc_exec_approval_request_new_from_event(payload);
    if (!req) {
        OC_LOG_WARN(OPENCLAW_LOG_CAT_GATEWAY,
                    "exec.approval.requested: invalid payload; dropping");
        return;
    }

    /* Dedupe against active + queued ids. */
    if (g_strcmp0(g_state.active_request_id, req->id) == 0 ||
        queue_contains_request_id(req->id)) {
        OC_LOG_DEBUG(OPENCLAW_LOG_CAT_GATEWAY,
                     "exec.approval.requested id=%s already tracked; "
                     "dropping duplicate",
                     req->id);
        oc_exec_approval_request_free(req);
        return;
    }

    OC_LOG_INFO(OPENCLAW_LOG_CAT_GATEWAY,
                "exec.approval.requested id=%s agent=%s "
                "(queue size %u -> %u)",
                req->id,
                req->agent_id ? req->agent_id : "",
                g_state.pending ? g_queue_get_length(g_state.pending) : 0,
                (g_state.pending ? g_queue_get_length(g_state.pending) : 0) + 1);

    g_queue_push_tail(g_state.pending, req);
    try_present_next();
}

static void handle_exec_approval_resolved(JsonNode *payload) {
    if (!payload || !JSON_NODE_HOLDS_OBJECT(payload)) return;
    JsonObject *obj = json_node_get_object(payload);
    const gchar *request_id = oc_json_string_member(obj, "id");
    if (!request_id) request_id = oc_json_string_member(obj, "requestId");
    if (!request_id || !request_id[0]) return;

    const gchar *decision = oc_json_string_member(obj, "decision");
    OC_LOG_INFO(OPENCLAW_LOG_CAT_GATEWAY,
                "exec.approval.resolved id=%s decision=%s",
                request_id, decision ? decision : "(n/a)");

    if (g_strcmp0(g_state.active_request_id, request_id) == 0) {
        /* `dismiss_if` closes the dialog without firing the decision
         * callback; we drive state forward here. */
        exec_approval_window_dismiss_if(request_id);
        g_state.presenting = FALSE;
        g_clear_pointer(&g_state.active_request_id, g_free);
        try_present_next();
        return;
    }
    remove_request_from_queue(request_id);
}

static void on_ws_event(const gchar *event_type,
                        const JsonNode *payload,
                        gpointer user_data) {
    (void)user_data;
    if (!event_type) return;
    if (g_strcmp0(event_type, "exec.approval.requested") == 0) {
        handle_exec_approval_requested((JsonNode *)payload);
    } else if (g_strcmp0(event_type, "exec.approval.resolved") == 0) {
        handle_exec_approval_resolved((JsonNode *)payload);
    }
}

/* ── Public API ── */

void exec_approval_prompter_init(GtkWindow *parent) {
    parent_assign(parent);
    if (g_state.event_listener_id != 0) return;
    if (!g_state.pending) {
        g_state.pending = g_queue_new();
    }
    g_state.event_listener_id = gateway_ws_event_subscribe(on_ws_event, NULL);
}

void exec_approval_prompter_shutdown(void) {
    if (g_state.event_listener_id != 0) {
        gateway_ws_event_unsubscribe(g_state.event_listener_id);
        g_state.event_listener_id = 0;
    }
    if (g_state.pending) {
        while (!g_queue_is_empty(g_state.pending)) {
            oc_exec_approval_request_free(g_queue_pop_head(g_state.pending));
        }
        g_queue_free(g_state.pending);
        g_state.pending = NULL;
    }
    g_state.presenting = FALSE;
    g_clear_pointer(&g_state.active_request_id, g_free);
    parent_clear_ref();
}

void exec_approval_prompter_set_parent(GtkWindow *parent) {
    parent_assign(parent);
}

guint exec_approval_prompter_pending_count(void) {
    guint queued = g_state.pending ? g_queue_get_length(g_state.pending) : 0;
    return queued + (g_state.presenting ? 1u : 0u);
}

void exec_approval_prompter_test_set_present_hook(OcExecApprovalPresentHook hook,
                                                  gpointer hook_user_data) {
    g_state.present_hook = hook;
    g_state.present_hook_user_data = hook_user_data;
}

void exec_approval_prompter_test_inject_event(JsonNode *payload) {
    if (!g_state.pending) g_state.pending = g_queue_new();
    handle_exec_approval_requested(payload);
}

void exec_approval_prompter_test_inject_resolved(JsonNode *payload) {
    if (!g_state.pending) g_state.pending = g_queue_new();
    handle_exec_approval_resolved(payload);
}

guint exec_approval_prompter_test_queue_len(void) {
    if (!g_state.pending) return 0;
    return g_queue_get_length(g_state.pending);
}

gboolean exec_approval_prompter_test_is_presenting(void) {
    return g_state.presenting;
}

gpointer exec_approval_prompter_test_get_parent(void) {
    return g_state.parent;
}
