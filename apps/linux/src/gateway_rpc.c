/*
 * gateway_rpc.c
 *
 * Gateway RPC request/response layer for the OpenClaw Linux Companion App.
 *
 * Implements outbound request dispatch, pending-request registry with
 * GHashTable<request_id, PendingRpcRequest>, response correlation,
 * per-request timeouts, and connection-loss cleanup.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "gateway_rpc.h"
#include "gateway_ws.h"
#include "log.h"
#include <string.h>

typedef struct {
    gchar               *request_id;
    gchar               *method;
    GatewayRpcCallback   callback;
    gpointer             user_data;
    guint                timeout_id;
} PendingRpcRequest;

/* Pending request registry: request_id → PendingRpcRequest* */
static GHashTable *pending_requests = NULL;

/* Forward declarations */
static void pending_rpc_request_free(PendingRpcRequest *req);
static gboolean on_request_timeout(gpointer user_data);
static gboolean ws_send_rpc_frame(const gchar *request_id, const gchar *method,
                              JsonNode *params_json);

static void ensure_registry(void) {
    if (!pending_requests) {
        pending_requests = g_hash_table_new_full(
            g_str_hash, g_str_equal,
            NULL, /* key is owned by PendingRpcRequest */
            (GDestroyNotify)pending_rpc_request_free);
    }
}

static void pending_rpc_request_free(PendingRpcRequest *req) {
    if (!req) return;
    if (req->timeout_id) {
        g_source_remove(req->timeout_id);
        req->timeout_id = 0;
    }
    g_free(req->request_id);
    g_free(req->method);
    g_free(req);
}

gchar* gateway_rpc_request(const gchar *method,
                           JsonNode *params_json,
                           guint timeout_ms,
                           GatewayRpcCallback callback,
                           gpointer user_data) {
    if (!method || !callback) return NULL;

    if (!gateway_rpc_is_ready()) {
        OC_LOG_WARN(OPENCLAW_LOG_CAT_GATEWAY,
                    "rpc request rejected: WS not connected (method=%s)", method);
        return NULL;
    }

    ensure_registry();

    gchar *request_id = g_uuid_string_random();
    if (!request_id) return NULL;

    PendingRpcRequest *pending = g_new0(PendingRpcRequest, 1);
    pending->request_id = g_strdup(request_id);
    pending->method = g_strdup(method);
    pending->callback = callback;
    pending->user_data = user_data;

    guint effective_timeout = timeout_ms > 0 ? timeout_ms : GATEWAY_RPC_DEFAULT_TIMEOUT_MS;
    pending->timeout_id = g_timeout_add(effective_timeout, on_request_timeout,
                                        g_strdup(request_id));

    g_hash_table_insert(pending_requests, pending->request_id, pending);

    OC_LOG_DEBUG(OPENCLAW_LOG_CAT_GATEWAY,
                 "rpc request sent id=%s method=%s timeout=%u ms",
                 request_id, method, effective_timeout);

    /* D1: If send fails, remove pending request immediately and return NULL */
    if (!ws_send_rpc_frame(request_id, method, params_json)) {
        g_hash_table_remove(pending_requests, request_id);
        g_free(request_id);
        return NULL;
    }

    return request_id;
}

gboolean gateway_rpc_handle_response(const GatewayFrame *frame) {
    if (!frame || frame->type != GATEWAY_FRAME_RES) return FALSE;
    if (!frame->id || !pending_requests) return FALSE;

    PendingRpcRequest *pending = g_hash_table_lookup(pending_requests, frame->id);
    if (!pending) return FALSE;

    /* Remove timeout before invoking callback */
    if (pending->timeout_id) {
        g_source_remove(pending->timeout_id);
        pending->timeout_id = 0;
    }

    OC_LOG_DEBUG(OPENCLAW_LOG_CAT_GATEWAY,
                 "rpc response received id=%s method=%s ok=%s",
                 frame->id, pending->method,
                 frame->error ? "false" : "true");

    GatewayRpcResponse response = {
        .ok = (frame->error == NULL),
        .payload = frame->payload ? json_node_copy(frame->payload) : NULL,
        .error_code = frame->code ? g_strdup(frame->code) : NULL,
        .error_msg = frame->error ? g_strdup(frame->error) : NULL,
    };

    GatewayRpcCallback cb = pending->callback;
    gpointer cb_data = pending->user_data;

    /* Remove from registry (frees the PendingRpcRequest but not response) */
    g_hash_table_remove(pending_requests, frame->id);

    cb(&response, cb_data);

    gateway_rpc_response_free_members(&response);
    return TRUE;
}

void gateway_rpc_fail_all_pending(const gchar *reason) {
    if (!pending_requests) return;

    guint count = g_hash_table_size(pending_requests);
    if (count == 0) return;

    OC_LOG_WARN(OPENCLAW_LOG_CAT_GATEWAY,
                "rpc failing %u pending requests: %s", count,
                reason ? reason : "unknown");

    /* Collect all entries first since callback might re-enter */
    GList *values = g_hash_table_get_values(pending_requests);
    GList *entries = NULL;
    for (GList *l = values; l; l = l->next) {
        PendingRpcRequest *req = l->data;
        /* Detach timeout so pending_rpc_request_free doesn't double-remove */
        if (req->timeout_id) {
            g_source_remove(req->timeout_id);
            req->timeout_id = 0;
        }
        entries = g_list_prepend(entries, req);
    }
    g_list_free(values);

    /* Clear the table without calling destroy (we handle it below) */
    g_hash_table_steal_all(pending_requests);

    gchar *err_msg = g_strdup_printf("Connection lost: %s",
                                     reason ? reason : "unknown");

    for (GList *l = entries; l; l = l->next) {
        PendingRpcRequest *req = l->data;

        GatewayRpcResponse response = {
            .ok = FALSE,
            .payload = NULL,
            .error_code = g_strdup("CONNECTION_LOST"),
            .error_msg = g_strdup(err_msg),
        };

        req->callback(&response, req->user_data);
        gateway_rpc_response_free_members(&response);

        /* Free the request manually since we used steal_all */
        g_free(req->request_id);
        g_free(req->method);
        g_free(req);
    }

    g_list_free(entries);
    g_free(err_msg);
}

gboolean gateway_rpc_is_ready(void) {
    return gateway_ws_get_state() == GATEWAY_WS_CONNECTED;
}

void gateway_rpc_response_free_members(GatewayRpcResponse *response) {
    if (!response) return;
    if (response->payload) {
        json_node_unref(response->payload);
        response->payload = NULL;
    }
    g_free(response->error_code);
    response->error_code = NULL;
    g_free(response->error_msg);
    response->error_msg = NULL;
}

/* --- Internal helpers --- */

static gboolean on_request_timeout(gpointer user_data) {
    gchar *request_id = user_data;
    if (!request_id || !pending_requests) {
        g_free(request_id);
        return G_SOURCE_REMOVE;
    }

    PendingRpcRequest *pending = g_hash_table_lookup(pending_requests, request_id);
    if (!pending) {
        g_free(request_id);
        return G_SOURCE_REMOVE;
    }

    /* Clear timeout_id before removal so destroy doesn't double-remove */
    pending->timeout_id = 0;

    OC_LOG_WARN(OPENCLAW_LOG_CAT_GATEWAY,
                "rpc request timed out id=%s method=%s", request_id, pending->method);

    GatewayRpcResponse response = {
        .ok = FALSE,
        .payload = NULL,
        .error_code = g_strdup("TIMEOUT"),
        .error_msg = g_strdup_printf("Request timed out: %s", pending->method),
    };

    GatewayRpcCallback cb = pending->callback;
    gpointer cb_data = pending->user_data;

    g_hash_table_remove(pending_requests, request_id);
    g_free(request_id);

    cb(&response, cb_data);
    gateway_rpc_response_free_members(&response);

    return G_SOURCE_REMOVE;
}

/* D1: Returns TRUE if the frame was successfully sent */
static gboolean ws_send_rpc_frame(const gchar *request_id, const gchar *method,
                              JsonNode *params_json) {
    g_autoptr(JsonBuilder) builder = json_builder_new();

    json_builder_begin_object(builder);

    json_builder_set_member_name(builder, "type");
    json_builder_add_string_value(builder, "req");

    json_builder_set_member_name(builder, "id");
    json_builder_add_string_value(builder, request_id);

    json_builder_set_member_name(builder, "method");
    json_builder_add_string_value(builder, method);

    json_builder_set_member_name(builder, "params");
    if (params_json) {
        json_builder_add_value(builder, json_node_copy(params_json));
    } else {
        json_builder_begin_object(builder);
        json_builder_end_object(builder);
    }

    json_builder_end_object(builder);

    g_autoptr(JsonGenerator) gen = json_generator_new();
    JsonNode *root = json_builder_get_root(builder);
    json_generator_set_root(gen, root);
    g_autofree gchar *json_str = json_generator_to_data(gen, NULL);
    json_node_unref(root);

    if (json_str) {
        if (!gateway_ws_send_text(json_str)) {
            return FALSE;
        }
    }
    return TRUE;
}
