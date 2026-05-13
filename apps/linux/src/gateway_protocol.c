/*
 * gateway_protocol.c
 *
 * Gateway JSON RPC protocol framing for the OpenClaw Linux Companion App.
 *
 * Implements frame parsing/encoding for gateway protocol v3, matching
 * the shared protocol as defined in GatewayModels.swift:
 *   - "req" frames: { type: "req", id, method, params }
 *   - "res" frames: { type: "res", id, payload | error }
 *   - "event" frames: { type: "event", event, payload }
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "gateway_protocol.h"
#include "json_access.h"
#include "log.h"
#include <string.h>

GatewayFrame* gateway_protocol_parse_frame(const gchar *json_str) {
    if (!json_str) return NULL;

    g_autoptr(JsonParser) parser = json_parser_new();
    g_autoptr(GError) error = NULL;
    if (!json_parser_load_from_data(parser, json_str, -1, &error)) {
        OC_LOG_WARN(OPENCLAW_LOG_CAT_GATEWAY, "protocol parse error: %s", error->message);
        return NULL;
    }

    JsonNode *root = json_parser_get_root(parser);
    if (!root || !JSON_NODE_HOLDS_OBJECT(root)) {
        return NULL;
    }

    JsonObject *obj = json_node_get_object(root);
    if (!json_object_has_member(obj, "type")) {
        return NULL;
    }

    const gchar *type_str = oc_json_string_member(obj, "type");
    if (!type_str) return NULL;

    GatewayFrame *frame = g_new0(GatewayFrame, 1);

    if (g_strcmp0(type_str, "req") == 0) {
        frame->type = GATEWAY_FRAME_REQ;
        frame->id = g_strdup(oc_json_string_member(obj, "id"));
        frame->method = g_strdup(oc_json_string_member(obj, "method"));
        if (json_object_has_member(obj, "params"))
            frame->payload = json_node_copy(json_object_get_member(obj, "params"));
    } else if (g_strcmp0(type_str, "res") == 0) {
        frame->type = GATEWAY_FRAME_RES;
        frame->id = g_strdup(oc_json_string_member(obj, "id"));
        if (json_object_has_member(obj, "error")) {
            JsonObject *err_obj = oc_json_object_member(obj, "error");
            if (err_obj) {
                frame->code = g_strdup(oc_json_string_member(err_obj, "code"));
                frame->error = g_strdup(oc_json_string_member(err_obj, "message"));
                JsonObject *details = oc_json_object_member(err_obj, "details");
                if (details) {
                    frame->detail_code = g_strdup(oc_json_string_member(details, "code"));
                    frame->detail_request_id = g_strdup(oc_json_string_member(details, "requestId"));
                    frame->detail_can_retry_with_device_token =
                        oc_json_bool_member(details, "canRetryWithDeviceToken", FALSE);
                }
            }
        }
        if (json_object_has_member(obj, "payload"))
            frame->payload = json_node_copy(json_object_get_member(obj, "payload"));
    } else if (g_strcmp0(type_str, "event") == 0) {
        frame->type = GATEWAY_FRAME_EVENT;
        frame->event_type = g_strdup(oc_json_string_member(obj, "event"));
        if (json_object_has_member(obj, "payload"))
            frame->payload = json_node_copy(json_object_get_member(obj, "payload"));
    } else {
        frame->type = GATEWAY_FRAME_UNKNOWN;
    }

    return frame;
}

void gateway_frame_free(GatewayFrame *frame) {
    if (!frame) return;
    g_free(frame->id);
    g_free(frame->method);
    g_free(frame->code);
    g_free(frame->error);
    g_free(frame->detail_code);
    g_free(frame->detail_request_id);
    g_free(frame->event_type);
    if (frame->payload) json_node_unref(frame->payload);
    g_free(frame);
}

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
    const gchar *version)
{
    GatewayConnectBuildParams p = {0};
    p.request_id = request_id;
    p.client_id = client_id;
    p.client_mode = client_mode;
    p.client_display_name = client_display_name;
    p.role = role;
    p.scopes = scopes;
    p.auth_mode = auth_mode;
    p.token = token;
    p.password = password;
    p.platform = platform;
    p.version = version;
    /* No identity/nonce — emits legacy unsigned connect frame. */
    return gateway_protocol_build_connect_v2(&p);
}

gchar* gateway_protocol_extract_challenge_nonce(const GatewayFrame *frame) {
    if (!frame || frame->type != GATEWAY_FRAME_EVENT) return NULL;
    if (g_strcmp0(frame->event_type, "connect.challenge") != 0) return NULL;
    if (!frame->payload || !JSON_NODE_HOLDS_OBJECT(frame->payload)) return NULL;

    JsonObject *obj = json_node_get_object(frame->payload);
    const gchar *nonce = oc_json_string_member(obj, "nonce");
    if (nonce && nonce[0] != '\0') {
        return g_strdup(nonce);
    }
    return NULL;
}

/* Static helpers for strict JSON type validation */

static gboolean json_node_is_string_value(JsonNode *node) {
    return JSON_NODE_HOLDS_VALUE(node) && json_node_get_value_type(node) == G_TYPE_STRING;
}

static gboolean json_node_is_numeric_value(JsonNode *node) {
    if (!JSON_NODE_HOLDS_VALUE(node)) return FALSE;
    GType t = json_node_get_value_type(node);
    return t == G_TYPE_INT64 || t == G_TYPE_DOUBLE || t == G_TYPE_INT || t == G_TYPE_UINT;
}

static gboolean json_node_is_integer_value(JsonNode *node) {
    if (!JSON_NODE_HOLDS_VALUE(node)) return FALSE;
    GType t = json_node_get_value_type(node);
    return t == G_TYPE_INT64 || t == G_TYPE_INT || t == G_TYPE_UINT;
}

static gboolean json_object_has_required_nonempty_string(JsonObject *obj, const gchar *key) {
    if (!json_object_has_member(obj, key)) return FALSE;
    JsonNode *node = json_object_get_member(obj, key);
    if (!json_node_is_string_value(node)) return FALSE;
    const gchar *val = json_node_get_string(node);
    if (!val || val[0] == '\0') return FALSE;
    return TRUE;
}

static gboolean json_object_has_required_positive_integer(JsonObject *obj, const gchar *key) {
    if (!json_object_has_member(obj, key)) return FALSE;
    JsonNode *node = json_object_get_member(obj, key);
    if (!json_node_is_integer_value(node)) return FALSE;
    gint64 val = json_node_get_int(node);
    if (val < 1) return FALSE;
    return TRUE;
}

static gboolean json_object_get_required_positive_number(JsonObject *obj, const gchar *key, gdouble *out) {
    if (!json_object_has_member(obj, key)) return FALSE;
    JsonNode *node = json_object_get_member(obj, key);
    if (!json_node_is_numeric_value(node)) return FALSE;
    gdouble val = json_node_get_double(node);
    if (val <= 0) return FALSE;
    *out = val;
    return TRUE;
}

gboolean gateway_protocol_parse_hello_ok(const GatewayFrame *frame,
    gchar **out_auth_source,
    gdouble *out_tick_interval_ms)
{
    return gateway_protocol_parse_hello_ok_v2(
        frame, out_auth_source, out_tick_interval_ms, NULL, NULL, NULL);
}

gboolean gateway_protocol_parse_hello_ok_v2(const GatewayFrame *frame,
    gchar   **out_auth_source,
    gdouble  *out_tick_interval_ms,
    gchar   **out_device_token,
    gchar   **out_auth_role,
    gchar  ***out_auth_scopes)
{
    if (out_auth_source) *out_auth_source = NULL;
    if (out_device_token) *out_device_token = NULL;
    if (out_auth_role) *out_auth_role = NULL;
    if (out_auth_scopes) *out_auth_scopes = NULL;

    if (!frame || frame->type != GATEWAY_FRAME_RES) return FALSE;
    if (frame->error) return FALSE;
    if (!frame->payload || !JSON_NODE_HOLDS_OBJECT(frame->payload)) return FALSE;

    JsonObject *obj = json_node_get_object(frame->payload);

    /* Require type field to be "hello-ok" per HelloOkSchema */
    if (!json_object_has_member(obj, "type")) {
        return FALSE;
    }
    const gchar *type_str = oc_json_string_member(obj, "type");
    if (g_strcmp0(type_str, "hello-ok") != 0) {
        return FALSE;
    }

    /* protocol: required integer >= 1 (integer types only, no double) */
    if (!json_object_has_required_positive_integer(obj, "protocol")) {
        return FALSE;
    }

    /* server: required object with non-empty version and connId strings */
    JsonNode *server_node = json_object_get_member(obj, "server");
    if (!server_node || !JSON_NODE_HOLDS_OBJECT(server_node)) {
        return FALSE;
    }
    JsonObject *server = json_node_get_object(server_node);
    if (!json_object_has_required_nonempty_string(server, "version") ||
        !json_object_has_required_nonempty_string(server, "connId")) {
        return FALSE;
    }

    /* features: required object with methods and events arrays */
    JsonNode *features_node = json_object_get_member(obj, "features");
    if (!features_node || !JSON_NODE_HOLDS_OBJECT(features_node)) {
        return FALSE;
    }
    JsonObject *features = json_node_get_object(features_node);
    if (!json_object_has_member(features, "methods") ||
        !json_object_has_member(features, "events")) {
        return FALSE;
    }
    JsonNode *methods_node = json_object_get_member(features, "methods");
    JsonNode *events_node = json_object_get_member(features, "events");
    if (!JSON_NODE_HOLDS_ARRAY(methods_node) || !JSON_NODE_HOLDS_ARRAY(events_node)) {
        return FALSE;
    }

    /* snapshot: required (can be any valid JSON, but must be present) */
    if (!json_object_has_member(obj, "snapshot")) {
        return FALSE;
    }

    /* Policy is strictly required and must be an object */
    JsonNode *policy_node = json_object_get_member(obj, "policy");
    if (!policy_node || !JSON_NODE_HOLDS_OBJECT(policy_node)) {
        return FALSE;
    }
    JsonObject *policy = json_node_get_object(policy_node);

    /* policy.maxPayload: required integer >= 1 (integer types only, no double) */
    if (!json_object_has_required_positive_integer(policy, "maxPayload")) {
        return FALSE;
    }

    /* policy.maxBufferedBytes: required integer >= 1 (integer types only, no double) */
    if (!json_object_has_required_positive_integer(policy, "maxBufferedBytes")) {
        return FALSE;
    }

    /* tickIntervalMs: required positive numeric per HelloOkSchema */
    gdouble tick_ms;
    if (!json_object_get_required_positive_number(policy, "tickIntervalMs", &tick_ms)) {
        return FALSE;
    }

    /* Auth is optional, but if present must be an object */
    JsonObject *auth = NULL;
    JsonNode *auth_node = json_object_get_member(obj, "auth");
    if (auth_node) {
        if (!JSON_NODE_HOLDS_OBJECT(auth_node)) {
            return FALSE;
        }
        auth = json_node_get_object(auth_node);
    }

    if (auth) {
        if (out_auth_source) {
            *out_auth_source = g_strdup(oc_json_string_member(auth, "source"));
        }
        if (out_device_token) {
            const gchar *dt = oc_json_string_member(auth, "deviceToken");
            if (dt && dt[0] != '\0') {
                *out_device_token = g_strdup(dt);
            }
        }
        if (out_auth_role) {
            const gchar *r = oc_json_string_member(auth, "role");
            if (r && r[0] != '\0') {
                *out_auth_role = g_strdup(r);
            }
        }
        if (out_auth_scopes) {
            JsonArray *arr = oc_json_array_member(auth, "scopes");
            if (arr) {
                guint n = json_array_get_length(arr);
                GPtrArray *strv = g_ptr_array_new();
                for (guint i = 0; i < n; i++) {
                    JsonNode *sn = json_array_get_element(arr, i);
                    if (sn && JSON_NODE_HOLDS_VALUE(sn) &&
                        json_node_get_value_type(sn) == G_TYPE_STRING) {
                        g_ptr_array_add(strv, g_strdup(json_node_get_string(sn)));
                    }
                }
                g_ptr_array_add(strv, NULL);
                *out_auth_scopes = (gchar **)g_ptr_array_free(strv, FALSE);
            }
        }
    }

    if (out_tick_interval_ms) {
        *out_tick_interval_ms = tick_ms;
    }

    return TRUE;
}

/* ───────── gateway_protocol_build_connect_v2 (signed device envelope) ───────── */

static gchar* build_scopes_csv(const gchar * const *scopes) {
    if (!scopes) return g_strdup("");
    GString *s = g_string_new(NULL);
    for (gsize i = 0; scopes[i]; i++) {
        if (i > 0) g_string_append_c(s, ',');
        g_string_append(s, scopes[i]);
    }
    return g_string_free(s, FALSE);
}

static gchar* normalize_metadata_field_ascii_lower(const gchar *value) {
    if (!value) return g_strdup("");
    g_autofree gchar *trimmed = g_strstrip(g_strdup(value));
    if (trimmed[0] == '\0') return g_strdup("");
    /* ASCII-only lowercase, to match normalizeDeviceMetadataForAuth (TS)
     * and normalizeMetadataField (Swift). */
    gsize len = strlen(trimmed);
    gchar *out = g_malloc(len + 1);
    for (gsize i = 0; i < len; i++) {
        gchar c = trimmed[i];
        if (c >= 'A' && c <= 'Z') c = (gchar)(c + 32);
        out[i] = c;
    }
    out[len] = '\0';
    return out;
}

/*
 * Canonical v3 device-auth payload (see src/gateway/device-auth.ts
 * buildDeviceAuthPayloadV3 and apps/shared/.../DeviceAuthPayload.swift buildV3):
 *   v3 | deviceId | clientId | clientMode | role | scopesCSV | signedAtMs
 *      | token    | nonce    | platform  | deviceFamily
 */
static gchar* build_canonical_payload_v3(
    const gchar *device_id,
    const gchar *client_id,
    const gchar *client_mode,
    const gchar *role,
    const gchar * const *scopes,
    gint64       signed_at_ms,
    const gchar *signature_token,
    const gchar *nonce,
    const gchar *platform,
    const gchar *device_family)
{
    g_autofree gchar *scopes_csv = build_scopes_csv(scopes);
    g_autofree gchar *platform_norm = normalize_metadata_field_ascii_lower(platform);
    g_autofree gchar *family_norm = normalize_metadata_field_ascii_lower(device_family);
    g_autofree gchar *signed_at_str = g_strdup_printf("%" G_GINT64_FORMAT, signed_at_ms);
    const gchar *tok = signature_token ? signature_token : "";
    return g_strjoin("|",
        "v3",
        device_id ? device_id : "",
        client_id ? client_id : "",
        client_mode ? client_mode : "",
        role ? role : "",
        scopes_csv,
        signed_at_str,
        tok,
        nonce ? nonce : "",
        platform_norm,
        family_norm,
        NULL);
}

gchar* gateway_protocol_build_connect_v2(const GatewayConnectBuildParams *p) {
    if (!p) return NULL;

    /* ── Auth selector (mirrors GatewayChannel.selectConnectAuth) ──
     * explicit `token` wins for auth.token. If identity+nonce are present,
     * the requesting side may fall back to a stored device token to avoid
     * a pointless no-auth handshake that the gateway would reject.
     */
    const gchar *auth_token = NULL;  /* goes into auth.token */
    const gchar *device_tok = NULL;  /* goes into auth.deviceToken */
    const gchar *password = NULL;    /* goes into auth.password */

    gboolean mode_password = (g_strcmp0(p->auth_mode, "password") == 0);
    gboolean mode_none = (g_strcmp0(p->auth_mode, "none") == 0);

    if (mode_password) {
        password = (p->password && p->password[0] != '\0') ? p->password : NULL;
    } else if (!mode_none) {
        if (p->token && p->token[0] != '\0') {
            auth_token = p->token;
        } else if (p->identity && p->stored_token && p->stored_token[0] != '\0') {
            auth_token = p->stored_token;
        }
        if (p->retry_with_device_token && p->stored_token && p->stored_token[0] != '\0') {
            device_tok = p->stored_token;
        }
    }
    const gchar *signature_token = auth_token ? auth_token : "";

    g_autoptr(JsonBuilder) builder = json_builder_new();

    json_builder_begin_object(builder);

    json_builder_set_member_name(builder, "type");
    json_builder_add_string_value(builder, "req");

    json_builder_set_member_name(builder, "id");
    json_builder_add_string_value(builder, p->request_id);

    json_builder_set_member_name(builder, "method");
    json_builder_add_string_value(builder, "connect");

    json_builder_set_member_name(builder, "params");
    json_builder_begin_object(builder);

    /* Protocol version range (ConnectParamsSchema requires both) */
    json_builder_set_member_name(builder, "minProtocol");
    json_builder_add_int_value(builder, GATEWAY_PROTOCOL_VERSION);
    json_builder_set_member_name(builder, "maxProtocol");
    json_builder_add_int_value(builder, GATEWAY_PROTOCOL_VERSION);

    /* Client metadata */
    const gchar *platform = (p->platform && p->platform[0]) ? p->platform : "linux";
    const gchar *version = (p->version && p->version[0]) ? p->version : "dev";
    json_builder_set_member_name(builder, "client");
    json_builder_begin_object(builder);
    json_builder_set_member_name(builder, "id");
    json_builder_add_string_value(builder, p->client_id);
    json_builder_set_member_name(builder, "mode");
    json_builder_add_string_value(builder, p->client_mode);
    json_builder_set_member_name(builder, "version");
    json_builder_add_string_value(builder, version);
    json_builder_set_member_name(builder, "platform");
    json_builder_add_string_value(builder, platform);
    if (p->client_display_name) {
        json_builder_set_member_name(builder, "displayName");
        json_builder_add_string_value(builder, p->client_display_name);
    }
    if (p->device_family && p->device_family[0]) {
        json_builder_set_member_name(builder, "deviceFamily");
        json_builder_add_string_value(builder, p->device_family);
    }
    json_builder_end_object(builder); /* /client */

    /* Role + scopes */
    json_builder_set_member_name(builder, "role");
    json_builder_add_string_value(builder, p->role);

    if (p->scopes) {
        json_builder_set_member_name(builder, "scopes");
        json_builder_begin_array(builder);
        for (gsize i = 0; p->scopes[i]; i++) {
            json_builder_add_string_value(builder, p->scopes[i]);
        }
        json_builder_end_array(builder);
    }

    /* Auth object */
    if (auth_token || device_tok || password) {
        json_builder_set_member_name(builder, "auth");
        json_builder_begin_object(builder);
        if (auth_token) {
            json_builder_set_member_name(builder, "token");
            json_builder_add_string_value(builder, auth_token);
        }
        if (device_tok) {
            json_builder_set_member_name(builder, "deviceToken");
            json_builder_add_string_value(builder, device_tok);
        }
        if (password) {
            json_builder_set_member_name(builder, "password");
            json_builder_add_string_value(builder, password);
        }
        json_builder_end_object(builder); /* /auth */
    }

    /* Signed device envelope — emitted when identity + nonce are present. */
    if (p->identity && p->connect_nonce && p->connect_nonce[0] != '\0') {
        gint64 signed_at_ms = p->signed_at_ms > 0 ? p->signed_at_ms : (gint64)(g_get_real_time() / 1000);
        g_autofree gchar *payload = build_canonical_payload_v3(
            p->identity->device_id,
            p->client_id,
            p->client_mode,
            p->role,
            p->scopes,
            signed_at_ms,
            signature_token,
            p->connect_nonce,
            platform,
            p->device_family);
        g_autofree gchar *signature_b64url = oc_device_identity_sign_base64url(p->identity, payload);
        g_autofree gchar *public_key_b64url = oc_device_identity_public_key_base64url(p->identity);
        if (signature_b64url && public_key_b64url) {
            json_builder_set_member_name(builder, "device");
            json_builder_begin_object(builder);
            json_builder_set_member_name(builder, "id");
            json_builder_add_string_value(builder, p->identity->device_id);
            json_builder_set_member_name(builder, "publicKey");
            json_builder_add_string_value(builder, public_key_b64url);
            json_builder_set_member_name(builder, "signature");
            json_builder_add_string_value(builder, signature_b64url);
            json_builder_set_member_name(builder, "signedAt");
            json_builder_add_int_value(builder, signed_at_ms);
            json_builder_set_member_name(builder, "nonce");
            json_builder_add_string_value(builder, p->connect_nonce);
            json_builder_end_object(builder); /* /device */
        }
    }

    json_builder_end_object(builder); /* /params */
    json_builder_end_object(builder); /* /root */

    g_autoptr(JsonGenerator) gen = json_generator_new();
    JsonNode *root = json_builder_get_root(builder);
    json_generator_set_root(gen, root);
    gchar *result = json_generator_to_data(gen, NULL);
    json_node_unref(root);
    return result;
}
