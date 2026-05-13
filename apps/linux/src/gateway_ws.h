/*
 * gateway_ws.h
 *
 * Persistent WebSocket client for the OpenClaw Linux Companion App.
 *
 * Maintains a long-lived WebSocket connection to the local gateway,
 * handling the challenge→connect→auth handshake, receive loop,
 * reconnect with exponential backoff, tick watchdog, and keepalive.
 * Mirrors the shared/macOS gateway protocol semantics as implemented
 * in GatewayChannelActor (GatewayChannel.swift).
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#ifndef OPENCLAW_LINUX_GATEWAY_WS_H
#define OPENCLAW_LINUX_GATEWAY_WS_H

#include <glib.h>
#include <json-glib/json-glib.h>

typedef enum {
    GATEWAY_WS_DISCONNECTED,
    GATEWAY_WS_CONNECTING,
    GATEWAY_WS_CHALLENGE_WAIT,
    GATEWAY_WS_AUTHENTICATING,
    GATEWAY_WS_CONNECTED,
    GATEWAY_WS_AUTH_FAILED,
    GATEWAY_WS_ERROR
} GatewayWsState;

typedef struct {
    GatewayWsState state;
    gchar *auth_source;
    gchar *last_error;
    gboolean rpc_ok;
    /*
     * Set TRUE when the last auth rejection was code=PAIRING_REQUIRED.
     * Reconnect is paused until operator approves the pairing request;
     * the tray / bootstrap window listens on this field and the
     * synthesized "device.pairing.required" event.
     */
    gboolean pairing_required;
    gchar *pairing_request_id;
} GatewayWsStatus;

typedef void (*GatewayWsStatusCallback)(const GatewayWsStatus *status, gpointer user_data);
typedef void (*GatewayWsEventCallback)(const gchar *event_type,
                                       const JsonNode *payload,
                                       gpointer user_data);

void gateway_ws_init(void);

/*
 * Set the effective state directory used by the WS client to load and
 * persist the device identity and per-role device tokens. Must be called
 * before gateway_ws_connect() on first setup; subsequent calls update the
 * path and, when different, force identity reload on the next connect.
 * Passing NULL disables identity-bound connect (legacy behavior).
 */
void gateway_ws_set_identity_context(const gchar *state_dir);

/*
 * Clear the one-shot device-token retry budget and resume reconnect.
 * Called by the pairing UX after operator approves a pending pair request
 * so the next handshake can try fresh credentials.
 */
void gateway_ws_resume_after_pairing_approved(void);

void gateway_ws_connect(const gchar *ws_url, const gchar *auth_mode,
                        const gchar *token, const gchar *password,
                        GatewayWsStatusCallback callback, gpointer user_data);
void gateway_ws_disconnect(void);
void gateway_ws_shutdown(void);
GatewayWsState gateway_ws_get_state(void);
const gchar* gateway_ws_get_last_error(void);
const gchar* gateway_ws_state_to_string(GatewayWsState state);

/*
 * Return TRUE when the gateway rejected our most recent connect with a
 * PAIRING_REQUIRED detail and no subsequent connect has succeeded. Used
 * by the tray and main-window status surfaces to badge the operator.
 */
gboolean gateway_ws_is_pairing_required(void);

/*
 * Return the locally-loaded deviceId (lowercase-hex SHA-256 of the raw
 * public key) or NULL if the identity has not been loaded yet / no
 * identity context was set. The returned string is owned by the WS
 * client and valid until the next identity reload; callers must copy
 * if they need to retain it.
 */
const gchar* gateway_ws_get_device_id(void);

/*
 * Return the request id from the most recent PAIRING_REQUIRED rejection
 * if one was carried on the error details. NULL when pairing is not
 * required or when the gateway did not include a request id.
 * Caller must copy if the value needs to outlive the next connect.
 */
const gchar* gateway_ws_get_pairing_request_id(void);

/*
 * Send a raw text frame over the authenticated WebSocket connection.
 * Used by gateway_rpc to dispatch outbound request frames.
 * Returns TRUE if the frame was sent, FALSE if the connection is not open.
 */
gboolean gateway_ws_send_text(const gchar *text);

/*
 * Subscribe to gateway event frames (type="event").
 * Returns a listener id (0 on failure). Callback runs on main thread.
 */
guint gateway_ws_event_subscribe(GatewayWsEventCallback callback, gpointer user_data);

/* Unsubscribe a previously registered listener id. */
void gateway_ws_event_unsubscribe(guint listener_id);

#endif /* OPENCLAW_LINUX_GATEWAY_WS_H */
