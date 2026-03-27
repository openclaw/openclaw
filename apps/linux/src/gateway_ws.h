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
} GatewayWsStatus;

typedef void (*GatewayWsStatusCallback)(const GatewayWsStatus *status, gpointer user_data);

void gateway_ws_init(void);
void gateway_ws_connect(const gchar *ws_url, const gchar *auth_mode,
                        const gchar *token, const gchar *password,
                        GatewayWsStatusCallback callback, gpointer user_data);
void gateway_ws_disconnect(void);
void gateway_ws_shutdown(void);
GatewayWsState gateway_ws_get_state(void);
const gchar* gateway_ws_get_last_error(void);
const gchar* gateway_ws_state_to_string(GatewayWsState state);

#endif /* OPENCLAW_LINUX_GATEWAY_WS_H */
