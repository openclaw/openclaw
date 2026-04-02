/*
 * gateway_protocol.h
 *
 * Gateway JSON RPC protocol framing for the OpenClaw Linux Companion App.
 *
 * Handles frame parsing/encoding for the gateway WebSocket protocol (v3):
 * connect.challenge events, connect requests, response parsing, event
 * handling, and request/response correlation by UUID id.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#ifndef OPENCLAW_LINUX_GATEWAY_PROTOCOL_H
#define OPENCLAW_LINUX_GATEWAY_PROTOCOL_H

#include <glib.h>
#include <json-glib/json-glib.h>

#define GATEWAY_PROTOCOL_VERSION 3

typedef enum {
    GATEWAY_FRAME_REQ,
    GATEWAY_FRAME_RES,
    GATEWAY_FRAME_EVENT,
    GATEWAY_FRAME_UNKNOWN
} GatewayFrameType;

typedef struct {
    GatewayFrameType type;
    gchar *id;             /* request/response correlation ID */
    gchar *method;         /* for req frames */
    gchar *code;            /* for error res frames (string code from protocol) */
    gchar *error;          /* for error res frames */
    JsonNode *payload;     /* parsed payload (owned) */
    gchar *event_type;     /* for event frames (e.g. "connect.challenge", "tick") */
} GatewayFrame;

GatewayFrame* gateway_protocol_parse_frame(const gchar *json_str);
void gateway_frame_free(GatewayFrame *frame);

gchar* gateway_protocol_build_connect_request(
    const gchar *request_id,
    const gchar *client_id,
    const gchar *client_mode,
    const gchar *client_display_name,
    const gchar *role,
    const gchar * const *scopes,
    const gchar *auth_mode,
    const gchar *token,
    const gchar *password,
    const gchar *platform,
    const gchar *version);

gchar* gateway_protocol_extract_challenge_nonce(const GatewayFrame *frame);

gboolean gateway_protocol_parse_hello_ok(const GatewayFrame *frame,
    gchar **out_auth_source,
    gdouble *out_tick_interval_ms);

#endif /* OPENCLAW_LINUX_GATEWAY_PROTOCOL_H */
