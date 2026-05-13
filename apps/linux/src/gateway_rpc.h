/*
 * gateway_rpc.h
 *
 * Gateway RPC request/response layer for the OpenClaw Linux Companion App.
 *
 * Provides an outbound request API over the authenticated WebSocket connection,
 * with unique request ID generation, a pending-request registry, response
 * correlation, per-request timeouts, and graceful error handling.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#ifndef OPENCLAW_LINUX_GATEWAY_RPC_H
#define OPENCLAW_LINUX_GATEWAY_RPC_H

#include "gateway_protocol.h"
#include <glib.h>
#include <json-glib/json-glib.h>

/* Default per-request timeout in milliseconds */
#define GATEWAY_RPC_DEFAULT_TIMEOUT_MS 15000

typedef struct {
    gboolean ok;
    JsonNode *payload;     /* owned; caller must json_node_unref when done */
    gchar    *error_code;  /* NULL on success */
    gchar    *error_msg;   /* NULL on success */
} GatewayRpcResponse;

typedef void (*GatewayRpcCallback)(const GatewayRpcResponse *response,
                                   gpointer user_data);

/*
 * Send an RPC request over the authenticated WS connection.
 *
 * method:      gateway method name (e.g. "channels.status")
 * params_json: optional JsonNode* for the params object (ownership NOT taken;
 *              caller retains ownership). Pass NULL for empty params.
 * timeout_ms:  per-request timeout; 0 uses GATEWAY_RPC_DEFAULT_TIMEOUT_MS.
 * callback:    invoked on the main thread with the response or error.
 * user_data:   passed to callback.
 *
 * Returns a request ID string (caller-owned, g_free when done), or NULL if the
 * request could not be sent (e.g. WS not connected). On NULL return, the
 * callback is NOT invoked.
 */
gchar* gateway_rpc_request(const gchar *method,
                           JsonNode *params_json,
                           guint timeout_ms,
                           GatewayRpcCallback callback,
                           gpointer user_data);

/*
 * Called by gateway_ws when an authenticated GATEWAY_FRAME_RES is received.
 * Returns TRUE if the frame was consumed by a pending RPC request.
 */
gboolean gateway_rpc_handle_response(const GatewayFrame *frame);

/*
 * Fail all pending requests with a connection-loss error.
 * Called by gateway_ws on disconnect / reconnect / shutdown.
 */
void gateway_rpc_fail_all_pending(const gchar *reason);

/*
 * Returns TRUE if the WS connection is authenticated and ready for RPC.
 */
gboolean gateway_rpc_is_ready(void);

/*
 * Free a GatewayRpcResponse's owned members (but not the struct itself,
 * as it is typically stack-allocated by the RPC layer).
 */
void gateway_rpc_response_free_members(GatewayRpcResponse *response);

#endif /* OPENCLAW_LINUX_GATEWAY_RPC_H */
