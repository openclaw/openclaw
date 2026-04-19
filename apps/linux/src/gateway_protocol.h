/*
 * gateway_protocol.h
 *
 * Gateway JSON RPC protocol framing for the OpenClaw Linux Companion App.
 *
 * Handles frame parsing/encoding for the gateway WebSocket protocol (v3):
 * connect.challenge events, connect requests with signed device identity,
 * response parsing, event handling, and request/response correlation by
 * UUID id.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#ifndef OPENCLAW_LINUX_GATEWAY_PROTOCOL_H
#define OPENCLAW_LINUX_GATEWAY_PROTOCOL_H

#include <glib.h>
#include <json-glib/json-glib.h>

#include "device_identity.h"

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
    gchar *code;            /* for error res frames (top-level ErrorCode) */
    gchar *error;          /* for error res frames (message) */
    gchar *detail_code;    /* for error res frames: error.details.code (e.g. "AUTH_TOKEN_MISMATCH") */
    gchar *detail_request_id; /* for error res frames: error.details.requestId (pairing) */
    gboolean detail_can_retry_with_device_token;
    JsonNode *payload;     /* parsed payload (owned) */
    gchar *event_type;     /* for event frames (e.g. "connect.challenge", "tick") */
} GatewayFrame;

GatewayFrame* gateway_protocol_parse_frame(const gchar *json_str);
void gateway_frame_free(GatewayFrame *frame);

/*
 * Legacy connect-request builder — kept for existing call sites and tests.
 * Does NOT emit a signed params.device envelope; Linux cannot acquire
 * operator scopes with this path. Prefer gateway_protocol_build_connect_v2.
 */
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

/*
 * Device-bound connect-request builder — mirrors GatewayChannel.sendConnect
 * in apps/shared/OpenClawKit (Swift) and the Control UI TS builder.
 *
 * Emits:
 *   params.auth       = { token?, deviceToken?, password? }  (per auth selector)
 *   params.device     = { id, publicKey, signature, signedAt, nonce }
 *                       signed with Ed25519 over the canonical v3 payload.
 *
 * Required: connect_nonce (from connect.challenge event) and identity
 *   when operator-scope access is needed. If both are NULL, no signed
 *   device envelope is emitted (legacy parity with the 11-arg shim).
 *
 * Auth selector (mirrors selectConnectAuth in GatewayChannel.swift):
 *   - explicit `token` wins and becomes auth.token
 *   - if identity is present AND no explicit token AND `stored_token` is
 *     provided, the stored device token is used as auth.token (primary)
 *   - if `retry_with_device_token` is TRUE, `stored_token` is additionally
 *     placed in auth.deviceToken for the one-shot mismatch retry
 *   - `password` is used when auth_mode == "password"
 *
 * The `signature_token` embedded in the canonical v3 payload follows
 * buildDeviceAuthPayloadV3 semantics: the explicit token if present,
 * else the stored device token used for auth, else empty string.
 */
typedef struct {
    const gchar *request_id;
    const gchar *client_id;
    const gchar *client_mode;
    const gchar *client_display_name;
    const gchar *role;
    const gchar * const *scopes;

    /* Auth material */
    const gchar *auth_mode;      /* "none" | "token" | "password" | NULL (auto) */
    const gchar *token;          /* explicit shared token (if any) */
    const gchar *password;       /* explicit password (if any) */
    const gchar *stored_token;   /* stored device token (from device-auth.json) */
    gboolean     retry_with_device_token; /* one-shot mismatch retry */

    /* Client metadata */
    const gchar *platform;
    const gchar *version;
    const gchar *device_family;

    /* Device identity (optional). When identity != NULL and nonce != NULL,
     * a signed params.device envelope is emitted. */
    const OcDeviceIdentity *identity;
    const gchar *connect_nonce;
    gint64       signed_at_ms; /* 0 => use g_get_real_time()/1000 */
} GatewayConnectBuildParams;

gchar* gateway_protocol_build_connect_v2(const GatewayConnectBuildParams *params);

gchar* gateway_protocol_extract_challenge_nonce(const GatewayFrame *frame);

/*
 * Parse hello-ok result frame. In addition to basic validation (existing
 * behavior), extracts hello.auth.* fields used by the device-token
 * persistence/reuse lifecycle. All out params may be NULL.
 *
 *   out_auth_source      : hello.auth.source  (e.g. "device-token")
 *   out_tick_interval_ms : hello.policy.tickIntervalMs
 *   out_device_token     : hello.auth.deviceToken  (persist verbatim)
 *   out_auth_role        : hello.auth.role          (e.g. "operator")
 *   out_auth_scopes      : hello.auth.scopes as NULL-terminated strv
 *
 * Output strings/arrays are caller-owned; free with g_free / g_strfreev.
 */
gboolean gateway_protocol_parse_hello_ok(const GatewayFrame *frame,
    gchar **out_auth_source,
    gdouble *out_tick_interval_ms);

gboolean gateway_protocol_parse_hello_ok_v2(const GatewayFrame *frame,
    gchar   **out_auth_source,
    gdouble  *out_tick_interval_ms,
    gchar   **out_device_token,
    gchar   **out_auth_role,
    gchar  ***out_auth_scopes);

#endif /* OPENCLAW_LINUX_GATEWAY_PROTOCOL_H */
