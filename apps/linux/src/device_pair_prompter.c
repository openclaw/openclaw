/*
 * device_pair_prompter.c
 *
 * Queue-driven pairing approval dispatcher. Subscribes to the gateway
 * event stream for:
 *   - "device.pair.requested"       : another device wants to pair; we
 *                                     approve/reject from this companion
 *                                     (for operator UI-class clients).
 *   - "device.pairing.required"     : this companion's handshake was
 *                                     rejected with PAIRING_REQUIRED;
 *                                     show the bootstrap window.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "device_pair_prompter.h"
#include "pairing_bootstrap_window.h"
#include "gateway_ws.h"
#include "gateway_rpc.h"
#include "json_access.h"
#include "log.h"

#include <string.h>

typedef struct {
    guint              event_listener_id;
    GtkWindow         *parent;
    GQueue            *pending;           /* of OcPairRequestInfo* */
    gboolean           presenting;
    /*
     * Request id of the currently-presented approval (NULL when not
     * presenting). Stored separately from the hook contract so the
     * resolved-event handler can reach the active request without
     * chasing the info pointer (which the hook owns during present).
     */
    gchar             *active_request_id;

    /* Test seam */
    OcPairPresentHook  present_hook;
    gpointer           present_hook_user_data;
} PromptState;

static PromptState g_state = {0};

/* Forward declarations for helpers used before their definitions. */
static gboolean queue_contains_request_id(const gchar *request_id);
static void     remove_request_from_queue(const gchar *request_id);

static void pop_and_present_next(void);

/* ──────────────────────────── parent lifetime ──────────────────────────── */

/*
 * Weak-ref callback invoked by GObject when the currently-tracked parent
 * window is finalized. The app is tray-first — the main window can be
 * destroyed while the process stays alive — so we must clear the parent
 * pointer before any later pairing UI tries to present transient-for a
 * dead GtkWindow.
 */
static void on_parent_destroyed(gpointer data, GObject *where_the_object_was) {
    (void)data;
    if (g_state.parent == (GtkWindow *)where_the_object_was) {
        g_state.parent = NULL;
    }
}

/*
 * Attach / detach the weak ref on g_state.parent. Broken out so the
 * init / set_parent / shutdown paths can share one implementation and so
 * a unit-test seam can drive the "parent goes away" transition without
 * standing up a real GtkWindow.
 */
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

/* ──────────────────────────── helpers ──────────────────────────── */

static OcPairRequestInfo* build_info_from_payload(JsonNode *payload) {
    if (!payload || !JSON_NODE_HOLDS_OBJECT(payload)) return NULL;
    JsonObject *obj = json_node_get_object(payload);

    const gchar *request_id = oc_json_string_member(obj, "requestId");
    if (!request_id) request_id = oc_json_string_member(obj, "id");

    /*
     * Top-level `deviceId` is the REQUESTER's deviceId (see
     * `DevicePairRequestedEventSchema` in the gateway protocol
     * schema). Capture it so `handle_device_pair_requested` can drop
     * requests originated by this very Linux companion — the operator
     * cannot approve their own handshake from the same machine, and
     * leaving such entries in the queue leaves the tray "Pairing…"
     * affordance spuriously actionable. */
    const gchar *requester_device_id = oc_json_string_member(obj, "deviceId");

    JsonObject *client = oc_json_object_member(obj, "client");
    const gchar *client_id = client ? oc_json_string_member(client, "id") : NULL;
    const gchar *platform = client ? oc_json_string_member(client, "platform") : NULL;
    const gchar *display = client ? oc_json_string_member(client, "displayName") : NULL;
    /* The gateway event also flattens clientId / platform / displayName at
     * the top level (schema above). Fall back to those when the embedded
     * `client` object is absent. */
    if (!client_id) client_id = oc_json_string_member(obj, "clientId");
    if (!platform)  platform  = oc_json_string_member(obj, "platform");
    if (!display)   display   = oc_json_string_member(obj, "displayName");

    const gchar *host = oc_json_string_member(obj, "remoteAddress");
    if (!host) host = oc_json_string_member(obj, "host");
    if (!host) host = oc_json_string_member(obj, "remoteIp");

    GPtrArray *scopes = g_ptr_array_new();
    JsonArray *scope_arr = oc_json_array_member(obj, "scopes");
    if (scope_arr) {
        guint n = json_array_get_length(scope_arr);
        for (guint i = 0; i < n; i++) {
            JsonNode *node = json_array_get_element(scope_arr, i);
            if (node && JSON_NODE_HOLDS_VALUE(node) &&
                json_node_get_value_type(node) == G_TYPE_STRING) {
                g_ptr_array_add(scopes, g_strdup(json_node_get_string(node)));
            }
        }
    }
    g_ptr_array_add(scopes, NULL);

    OcPairRequestInfo *info = oc_pair_request_info_new(
        request_id, client_id, platform, display, host,
        requester_device_id,
        (const gchar * const *)scopes->pdata);

    /* free the gchars; oc_pair_request_info_new copied them. */
    for (guint i = 0; i < scopes->len; i++) {
        if (scopes->pdata[i]) g_free(scopes->pdata[i]);
    }
    g_ptr_array_free(scopes, TRUE);
    return info;
}

static void on_decision_rpc_response(const GatewayRpcResponse *response,
                                     gpointer                  user_data)
{
    const gchar *method = (const gchar *)user_data;
    if (!response) return;
    if (!response->ok) {
        OC_LOG_WARN(OPENCLAW_LOG_CAT_GATEWAY,
                    "device pair %s RPC failed: %s",
                    method ? method : "(unknown)",
                    response->error_msg ? response->error_msg : "(no detail)");
    }
}

static void send_decision_rpc(const OcPairRequestInfo *info,
                              OcPairDecision decision)
{
    const gchar *method = NULL;
    if (decision == OC_PAIR_DECISION_APPROVE) method = "device.pair.approve";
    else if (decision == OC_PAIR_DECISION_REJECT) method = "device.pair.reject";
    else return; /* Later = no RPC, re-queue handled by caller */

    if (!info->request_id || !info->request_id[0]) {
        OC_LOG_WARN(OPENCLAW_LOG_CAT_GATEWAY,
                    "device pair decision lacks request_id; skipping RPC");
        return;
    }

    g_autoptr(JsonBuilder) b = json_builder_new();
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "requestId");
    json_builder_add_string_value(b, info->request_id);
    json_builder_end_object(b);
    g_autoptr(JsonNode) params = json_builder_get_root(b);

    g_autofree gchar *req_id = gateway_rpc_request(
        method, params, 0, on_decision_rpc_response, (gpointer)method);
    if (!req_id) {
        OC_LOG_WARN(OPENCLAW_LOG_CAT_GATEWAY,
                    "device pair %s RPC dispatch failed (WS not ready)", method);
    } else {
        OC_LOG_INFO(OPENCLAW_LOG_CAT_GATEWAY,
                    "device pair %s RPC dispatched request_id=%s",
                    method, info->request_id);
    }
}

/* ──────────────────────────── queue core ──────────────────────────── */

static void on_decision_recorded(const OcPairRequestInfo *info,
                                 OcPairDecision decision,
                                 gpointer user_data)
{
    (void)user_data;
    g_state.presenting = FALSE;
    g_clear_pointer(&g_state.active_request_id, g_free);

    switch (decision) {
    case OC_PAIR_DECISION_APPROVE:
    case OC_PAIR_DECISION_REJECT:
        send_decision_rpc(info, decision);
        break;
    case OC_PAIR_DECISION_LATER:
        /* Re-queue at the tail so other requests can make progress;
         * operator explicitly deferred this one. */
        g_queue_push_tail(g_state.pending,
            oc_pair_request_info_new(info->request_id, info->client_id,
                                     info->platform, info->display_name,
                                     info->host_address,
                                     info->requester_device_id,
                                     (const gchar * const *)info->scopes));
        break;
    }

    pop_and_present_next();
}

static void default_present(const OcPairRequestInfo *info,
                            OcPairDecisionCallback   record_decision,
                            gpointer                 record_user_data,
                            gpointer                 hook_user_data)
{
    (void)hook_user_data;
    device_pair_approval_window_present(g_state.parent, info,
                                        record_decision, record_user_data);
}

static void pop_and_present_next(void) {
    if (g_state.presenting) return;
    if (!g_state.pending || g_queue_is_empty(g_state.pending)) return;

    OcPairRequestInfo *info = g_queue_pop_head(g_state.pending);
    g_state.presenting = TRUE;
    g_clear_pointer(&g_state.active_request_id, g_free);
    if (info && info->request_id) {
        g_state.active_request_id = g_strdup(info->request_id);
    }

    OcPairPresentHook hook = g_state.present_hook ? g_state.present_hook : default_present;

    /* The hook must invoke on_decision_recorded exactly once. Until then,
     * g_state.presenting stays TRUE and further events only enqueue. */
    hook(info, on_decision_recorded, NULL, g_state.present_hook_user_data);

    /* The info copy belongs to the hook via on_decision_recorded's callback
     * contract: the caller retains ownership only until record_decision is
     * invoked. When the default Adw dialog presenter is used, it copies the
     * info internally; we can free ours here. In-test hooks do the same. */
    oc_pair_request_info_free(info);
}

/* ──────────────────────────── event pipeline ──────────────────────────── */

static gboolean queue_contains_request_id(const gchar *request_id) {
    if (!request_id || !g_state.pending) return FALSE;
    for (GList *it = g_state.pending->head; it; it = it->next) {
        const OcPairRequestInfo *entry = it->data;
        if (entry && g_strcmp0(entry->request_id, request_id) == 0) return TRUE;
    }
    return FALSE;
}

static void remove_request_from_queue(const gchar *request_id) {
    if (!request_id || !g_state.pending) return;
    GList *it = g_state.pending->head;
    while (it) {
        GList *next = it->next;
        OcPairRequestInfo *entry = it->data;
        if (entry && g_strcmp0(entry->request_id, request_id) == 0) {
            g_queue_delete_link(g_state.pending, it);
            oc_pair_request_info_free(entry);
        }
        it = next;
    }
}

static void handle_device_pair_requested(JsonNode *payload) {
    OcPairRequestInfo *info = build_info_from_payload(payload);
    if (!info || !info->request_id || info->request_id[0] == '\0') {
        OC_LOG_WARN(OPENCLAW_LOG_CAT_GATEWAY,
                    "device.pair.requested: missing request id; dropping");
        oc_pair_request_info_free(info);
        return;
    }

    /*
     * Self-origin filter: if the requester's deviceId equals our own,
     * this is OUR handshake waiting for an operator on SOME device to
     * approve it. We can never approve-ourselves locally — that's
     * exactly what the bootstrap window / `device.pairing.required`
     * path handles. Queueing the event would leave the tray "Pairing…"
     * affordance spuriously actionable and would paper over the
     * bootstrap UX. Drop with a single log line.
     */
    const gchar *own_device_id = gateway_ws_get_device_id();
    if (own_device_id && own_device_id[0] &&
        info->requester_device_id && info->requester_device_id[0] &&
        g_strcmp0(info->requester_device_id, own_device_id) == 0) {
        OC_LOG_INFO(OPENCLAW_LOG_CAT_GATEWAY,
                    "device.pair.requested request_id=%s originated by this "
                    "device (deviceId=%s); not enqueueing for local approval",
                    info->request_id, info->requester_device_id);
        oc_pair_request_info_free(info);
        return;
    }

    /*
     * Dedupe: the same requestId can legitimately arrive via multiple
     * sources — a live `device.pair.requested` event, a list seed issued
     * when WS reconnects, or a re-seed after a token-repair cycle. We
     * treat the first enqueue as authoritative and drop later arrivals
     * that target the same id, whether that id is queued or actively
     * presented.
     */
    if (g_strcmp0(g_state.active_request_id, info->request_id) == 0 ||
        queue_contains_request_id(info->request_id)) {
        OC_LOG_DEBUG(OPENCLAW_LOG_CAT_GATEWAY,
                     "device.pair.requested request_id=%s already tracked; "
                     "dropping duplicate",
                     info->request_id);
        oc_pair_request_info_free(info);
        return;
    }

    OC_LOG_INFO(OPENCLAW_LOG_CAT_GATEWAY,
                "device.pair.requested request_id=%s client_id=%s "
                "requester_device_id=%s (queue size %u -> %u)",
                info->request_id,
                info->client_id ? info->client_id : "",
                info->requester_device_id ? info->requester_device_id : "",
                g_state.pending ? g_queue_get_length(g_state.pending) : 0,
                (g_state.pending ? g_queue_get_length(g_state.pending) : 0) + 1);
    g_queue_push_tail(g_state.pending, info);
    pop_and_present_next();
}

static void handle_device_pair_resolved(JsonNode *payload) {
    if (!payload || !JSON_NODE_HOLDS_OBJECT(payload)) return;
    JsonObject *obj = json_node_get_object(payload);
    const gchar *request_id = oc_json_string_member(obj, "requestId");
    if (!request_id) request_id = oc_json_string_member(obj, "id");
    if (!request_id || !request_id[0]) {
        OC_LOG_DEBUG(OPENCLAW_LOG_CAT_GATEWAY,
                     "device.pair.resolved: missing request id; ignoring");
        return;
    }

    const gchar *outcome = oc_json_string_member(obj, "decision");
    if (!outcome) outcome = oc_json_string_member(obj, "outcome");

    OC_LOG_INFO(OPENCLAW_LOG_CAT_GATEWAY,
                "device.pair.resolved request_id=%s outcome=%s",
                request_id, outcome ? outcome : "(n/a)");

    /*
     * Three cases:
     *   1. request is currently being presented to the local operator →
     *      close the dialog silently and advance the queue;
     *   2. request is queued but not yet presented → drop it from the queue;
     *   3. request is unknown → no-op (e.g. already handled locally, or
     *      the resolve event refers to a request that was never queued
     *      on this companion).
     */
    if (g_strcmp0(g_state.active_request_id, request_id) == 0) {
        /* `device_pair_approval_window_dismiss_if` closes the Adw dialog
         * without firing the decision callback, so we must drive state
         * forward here. */
        device_pair_approval_window_dismiss_if(request_id);
        g_state.presenting = FALSE;
        g_clear_pointer(&g_state.active_request_id, g_free);
        pop_and_present_next();
        return;
    }
    remove_request_from_queue(request_id);
}

/* ──────────────────────────── list seeding ──────────────────────────── */

/*
 * Build a GHashTable (key=requestId string, value=NULL) of every request
 * id present in a `device.pair.list`-shaped payload. Used to reconcile
 * the local queue against the server's current truth on reconnect.
 */
static GHashTable* build_request_id_set_from_list(JsonArray *arr) {
    GHashTable *set = g_hash_table_new_full(g_str_hash, g_str_equal, g_free, NULL);
    if (!arr) return set;
    guint n = json_array_get_length(arr);
    for (guint i = 0; i < n; i++) {
        JsonNode *entry = json_array_get_element(arr, i);
        if (!entry || !JSON_NODE_HOLDS_OBJECT(entry)) continue;
        JsonObject *obj = json_node_get_object(entry);
        const gchar *rid = oc_json_string_member(obj, "requestId");
        if (!rid) rid = oc_json_string_member(obj, "id");
        if (rid && rid[0] != '\0') {
            g_hash_table_add(set, g_strdup(rid));
        }
    }
    return set;
}

/*
 * Prune any queued or currently-presented approval request whose id is
 * NOT in `server_ids`. Counterpart to `handle_device_pair_resolved`
 * that fires on transport reconnect instead of on live events — the
 * prune lets us recover cleanly from `device.pair.resolved` events
 * that were emitted while Linux was offline.
 */
static void reconcile_local_queue_against_server(GHashTable *server_ids) {
    if (!server_ids) return;

    /* Drop stale queue entries. */
    if (g_state.pending) {
        GList *link = g_state.pending->head;
        while (link) {
            GList *next = link->next;
            OcPairRequestInfo *info = link->data;
            if (info && info->request_id &&
                !g_hash_table_contains(server_ids, info->request_id)) {
                OC_LOG_INFO(OPENCLAW_LOG_CAT_GATEWAY,
                            "device.pair reconcile drop queued request_id=%s "
                            "(not in server list)",
                            info->request_id);
                g_queue_delete_link(g_state.pending, link);
                oc_pair_request_info_free(info);
            }
            link = next;
        }
    }

    /* Dismiss the active dialog if its request was resolved elsewhere. */
    if (g_state.presenting && g_state.active_request_id &&
        !g_hash_table_contains(server_ids, g_state.active_request_id)) {
        OC_LOG_INFO(OPENCLAW_LOG_CAT_GATEWAY,
                    "device.pair reconcile dismiss active request_id=%s "
                    "(not in server list)",
                    g_state.active_request_id);
        device_pair_approval_window_dismiss_if(g_state.active_request_id);
        g_state.presenting = FALSE;
        g_clear_pointer(&g_state.active_request_id, g_free);
        pop_and_present_next();
    }
}

static void seed_from_list_payload(JsonNode *payload) {
    if (!payload || !JSON_NODE_HOLDS_OBJECT(payload)) return;
    JsonObject *root = json_node_get_object(payload);
    JsonArray *arr = oc_json_array_member(root, "requests");
    if (!arr) arr = oc_json_array_member(root, "pending");
    /*
     * Reconcile FIRST: an empty server list must still prune the
     * local queue, even though there's nothing to enqueue. Without
     * this, a stale request left by a prior session keeps the tray
     * "Pairing…" affordance spuriously actionable.
     */
    g_autoptr(GHashTable) server_ids = build_request_id_set_from_list(arr);
    reconcile_local_queue_against_server(server_ids);

    if (!arr) return;
    guint n = json_array_get_length(arr);
    for (guint i = 0; i < n; i++) {
        JsonNode *entry = json_array_get_element(arr, i);
        if (!entry) continue;
        handle_device_pair_requested(entry);
    }
}

static void on_pair_list_response(const GatewayRpcResponse *response,
                                  gpointer user_data)
{
    (void)user_data;
    if (!response) return;
    if (!response->ok) {
        OC_LOG_WARN(OPENCLAW_LOG_CAT_GATEWAY,
                    "device.pair.list RPC failed: %s",
                    response->error_msg ? response->error_msg : "(no detail)");
        return;
    }
    seed_from_list_payload(response->payload);
}

static void handle_pairing_required(JsonNode *payload) {
    const gchar *request_id = NULL;
    const gchar *detail = NULL;
    if (payload && JSON_NODE_HOLDS_OBJECT(payload)) {
        JsonObject *obj = json_node_get_object(payload);
        request_id = oc_json_string_member(obj, "requestId");
        detail = oc_json_string_member(obj, "detail");
        if (!detail) detail = oc_json_string_member(obj, "message");
    }
    /*
     * Ask gateway_ws for the locally-loaded deviceId so the bootstrap
     * window can render the "This machine" fingerprint alongside the
     * CLI fallback command — actionable metadata is rendered by the
     * bootstrap window itself (request id + CLI command + copy button).
     */
    pairing_bootstrap_window_show(g_state.parent,
                                  request_id,
                                  gateway_ws_get_device_id(),
                                  detail);
}

static void on_ws_event(const gchar *event_type,
                        const JsonNode *payload,
                        gpointer user_data)
{
    (void)user_data;
    if (!event_type) return;
    if (g_strcmp0(event_type, "device.pair.requested") == 0) {
        handle_device_pair_requested((JsonNode *)payload);
    } else if (g_strcmp0(event_type, "device.pair.resolved") == 0) {
        handle_device_pair_resolved((JsonNode *)payload);
    } else if (g_strcmp0(event_type, "device.pairing.required") == 0) {
        handle_pairing_required((JsonNode *)payload);
    }
}

/* ──────────────────────────── public API ──────────────────────────── */

void device_pair_prompter_init(GtkWindow *parent) {
    parent_assign(parent);
    if (g_state.event_listener_id != 0) return;
    if (!g_state.pending) {
        g_state.pending = g_queue_new();
    }
    g_state.event_listener_id = gateway_ws_event_subscribe(on_ws_event, NULL);
}

void device_pair_prompter_shutdown(void) {
    if (g_state.event_listener_id != 0) {
        gateway_ws_event_unsubscribe(g_state.event_listener_id);
        g_state.event_listener_id = 0;
    }
    if (g_state.pending) {
        while (!g_queue_is_empty(g_state.pending)) {
            oc_pair_request_info_free(g_queue_pop_head(g_state.pending));
        }
        g_queue_free(g_state.pending);
        g_state.pending = NULL;
    }
    g_state.presenting = FALSE;
    g_clear_pointer(&g_state.active_request_id, g_free);
    parent_clear_ref();
}

void device_pair_prompter_set_parent(GtkWindow *parent) {
    parent_assign(parent);
}

void device_pair_prompter_seed_from_server(void) {
    if (!g_state.pending) {
        g_state.pending = g_queue_new();
    }
    g_autofree gchar *req_id = gateway_rpc_request(
        "device.pair.list", NULL, 0, on_pair_list_response, NULL);
    if (!req_id) {
        OC_LOG_DEBUG(OPENCLAW_LOG_CAT_GATEWAY,
                     "device.pair.list seed skipped: WS not ready");
    }
}

guint device_pair_prompter_pending_count(void) {
    guint queued = g_state.pending ? g_queue_get_length(g_state.pending) : 0;
    /*
     * A request that's currently being presented is still "pending" from
     * the operator's point of view — it counts toward the tray badge so
     * the "Pairing…" action stays actionable while the dialog is up.
     */
    return queued + (g_state.presenting ? 1u : 0u);
}

void device_pair_prompter_raise(void) {
    /*
     * Bootstrap wins when the transport itself is blocked on approval;
     * without it, no further pair events can flow anyway.
     *
     * Use the raise-only primitive, NOT show(). The tray "Pairing…"
     * handler does not carry a fresh copy of the gateway's request id,
     * deviceId, or detail text, and a show() call with NULL arguments
     * used to silently downgrade the visible metadata (e.g. replace
     * the approve-<requestId> CLI command with the generic `pair list`
     * fallback). Raise only presents.
     */
    if (pairing_bootstrap_window_is_visible()) {
        pairing_bootstrap_window_raise();
        return;
    }
    if (g_state.presenting) {
        device_pair_approval_window_raise_active();
    }
}

void device_pair_prompter_notify_transport_authenticated(void) {
    /*
     * Once the WS transport successfully authenticates, the PAIRING_REQUIRED
     * bootstrap window is stale by construction — the handshake is no
     * longer blocked on pair approval. Hiding it is idempotent; the real
     * gate is `pairing_bootstrap_window_hide()` checking its own
     * singleton, so this is safe to call on every CONNECTED transition.
     *
     * Keeping the call here (rather than in gateway_client) means a
     * single module owns the full show → raise → hide lifecycle of the
     * bootstrap surface. No other caller may drive those APIs directly.
     */
    pairing_bootstrap_window_hide();
}

void device_pair_prompter_test_set_present_hook(OcPairPresentHook hook,
                                                gpointer          hook_user_data)
{
    g_state.present_hook = hook;
    g_state.present_hook_user_data = hook_user_data;
}

void device_pair_prompter_test_inject_event(JsonNode *payload) {
    if (!g_state.pending) {
        g_state.pending = g_queue_new();
    }
    handle_device_pair_requested(payload);
}

void device_pair_prompter_test_inject_resolved(JsonNode *payload) {
    if (!g_state.pending) {
        g_state.pending = g_queue_new();
    }
    handle_device_pair_resolved(payload);
}

void device_pair_prompter_test_seed_from_payload(JsonNode *payload) {
    if (!g_state.pending) {
        g_state.pending = g_queue_new();
    }
    seed_from_list_payload(payload);
}

guint device_pair_prompter_test_queue_len(void) {
    if (!g_state.pending) return 0;
    return g_queue_get_length(g_state.pending);
}

gboolean device_pair_prompter_test_is_presenting(void) {
    return g_state.presenting;
}

gpointer device_pair_prompter_test_get_parent(void) {
    return g_state.parent;
}

void device_pair_prompter_test_simulate_parent_destroyed(gpointer addr) {
    /*
     * Mirror exactly what GObject's weak-ref plumbing would do on
     * finalize. We can't run the production on_parent_destroyed path
     * via a real GtkWindow in a headless unit test, so drive the
     * observable transition directly and then remove the weak ref
     * ourselves so shutdown doesn't try to unref a stale GObject.
     */
    if (g_state.parent == (GtkWindow *)addr) {
        g_object_weak_unref(G_OBJECT(g_state.parent), on_parent_destroyed, NULL);
        g_state.parent = NULL;
    }
}
