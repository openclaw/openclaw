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

    const gchar *type_str = json_object_get_string_member(obj, "type");
    if (!type_str) return NULL;

    GatewayFrame *frame = g_new0(GatewayFrame, 1);

    if (g_strcmp0(type_str, "req") == 0) {
        frame->type = GATEWAY_FRAME_REQ;
        if (json_object_has_member(obj, "id"))
            frame->id = g_strdup(json_object_get_string_member(obj, "id"));
        if (json_object_has_member(obj, "method"))
            frame->method = g_strdup(json_object_get_string_member(obj, "method"));
        if (json_object_has_member(obj, "params"))
            frame->payload = json_node_copy(json_object_get_member(obj, "params"));
    } else if (g_strcmp0(type_str, "res") == 0) {
        frame->type = GATEWAY_FRAME_RES;
        if (json_object_has_member(obj, "id"))
            frame->id = g_strdup(json_object_get_string_member(obj, "id"));
        if (json_object_has_member(obj, "error")) {
            JsonObject *err_obj = json_object_get_object_member(obj, "error");
            if (err_obj) {
                if (json_object_has_member(err_obj, "code"))
                    frame->code = g_strdup(json_object_get_string_member(err_obj, "code"));
                if (json_object_has_member(err_obj, "message"))
                    frame->error = g_strdup(json_object_get_string_member(err_obj, "message"));
            }
        }
        if (json_object_has_member(obj, "payload"))
            frame->payload = json_node_copy(json_object_get_member(obj, "payload"));
    } else if (g_strcmp0(type_str, "event") == 0) {
        frame->type = GATEWAY_FRAME_EVENT;
        if (json_object_has_member(obj, "event"))
            frame->event_type = g_strdup(json_object_get_string_member(obj, "event"));
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
    g_autoptr(JsonBuilder) builder = json_builder_new();

    json_builder_begin_object(builder);

    json_builder_set_member_name(builder, "type");
    json_builder_add_string_value(builder, "req");

    json_builder_set_member_name(builder, "id");
    json_builder_add_string_value(builder, request_id);

    json_builder_set_member_name(builder, "method");
    json_builder_add_string_value(builder, "connect");

    json_builder_set_member_name(builder, "params");
    json_builder_begin_object(builder);

    /* Protocol version range (ConnectParamsSchema requires both) */
    json_builder_set_member_name(builder, "minProtocol");
    json_builder_add_int_value(builder, GATEWAY_PROTOCOL_VERSION);
    json_builder_set_member_name(builder, "maxProtocol");
    json_builder_add_int_value(builder, GATEWAY_PROTOCOL_VERSION);

    /* Client identity — version and platform are required by ConnectParamsSchema */
    json_builder_set_member_name(builder, "client");
    json_builder_begin_object(builder);
    json_builder_set_member_name(builder, "id");
    json_builder_add_string_value(builder, client_id);
    json_builder_set_member_name(builder, "mode");
    json_builder_add_string_value(builder, client_mode);
    json_builder_set_member_name(builder, "version");
    json_builder_add_string_value(builder, version ? version : "dev");
    json_builder_set_member_name(builder, "platform");
    json_builder_add_string_value(builder, platform ? platform : "linux");
    if (client_display_name) {
        json_builder_set_member_name(builder, "displayName");
        json_builder_add_string_value(builder, client_display_name);
    }
    json_builder_end_object(builder); /* /client */

    /* Role and scopes */
    json_builder_set_member_name(builder, "role");
    json_builder_add_string_value(builder, role);

    if (scopes) {
        json_builder_set_member_name(builder, "scopes");
        json_builder_begin_array(builder);
        for (gint i = 0; scopes[i]; i++) {
            json_builder_add_string_value(builder, scopes[i]);
        }
        json_builder_end_array(builder);
    }

    /*
     * Auth material — nested under params.auth per ConnectParamsSchema.
     * auth_mode == "none": omit auth object entirely.
     * auth_mode == "token": include auth.token only.
     * auth_mode == "password": include auth.password only.
     * If auth_mode is NULL, include whichever credential is available.
     */
    gboolean include_token = FALSE;
    gboolean include_password = FALSE;

    if (g_strcmp0(auth_mode, "none") == 0) {
        /* No auth */
    } else if (g_strcmp0(auth_mode, "password") == 0) {
        include_password = (password != NULL);
    } else if (g_strcmp0(auth_mode, "token") == 0) {
        include_token = (token != NULL);
    } else {
        /* Fallback: include whatever is available */
        include_token = (token != NULL);
        include_password = (password != NULL);
    }

    if (include_token || include_password) {
        json_builder_set_member_name(builder, "auth");
        json_builder_begin_object(builder);
        if (include_token) {
            json_builder_set_member_name(builder, "token");
            json_builder_add_string_value(builder, token);
        }
        if (include_password) {
            json_builder_set_member_name(builder, "password");
            json_builder_add_string_value(builder, password);
        }
        json_builder_end_object(builder); /* /auth */
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

gchar* gateway_protocol_extract_challenge_nonce(const GatewayFrame *frame) {
    if (!frame || frame->type != GATEWAY_FRAME_EVENT) return NULL;
    if (g_strcmp0(frame->event_type, "connect.challenge") != 0) return NULL;
    if (!frame->payload || !JSON_NODE_HOLDS_OBJECT(frame->payload)) return NULL;

    JsonObject *obj = json_node_get_object(frame->payload);
    if (json_object_has_member(obj, "nonce")) {
        const gchar *nonce = json_object_get_string_member(obj, "nonce");
        if (nonce && nonce[0] != '\0') {
            return g_strdup(nonce);
        }
    }
    return NULL;
}

gboolean gateway_protocol_parse_hello_ok(const GatewayFrame *frame,
    gchar **out_auth_source,
    gdouble *out_tick_interval_ms)
{
    if (!frame || frame->type != GATEWAY_FRAME_RES) return FALSE;
    if (frame->error) return FALSE;
    if (!frame->payload || !JSON_NODE_HOLDS_OBJECT(frame->payload)) return FALSE;

    JsonObject *obj = json_node_get_object(frame->payload);

    /* Policy is strictly required and must be an object */
    JsonNode *policy_node = json_object_get_member(obj, "policy");
    if (!policy_node || !JSON_NODE_HOLDS_OBJECT(policy_node)) {
        return FALSE;
    }
    JsonObject *policy = json_node_get_object(policy_node);

    /* Auth is optional, but if present must be an object */
    JsonObject *auth = NULL;
    JsonNode *auth_node = json_object_get_member(obj, "auth");
    if (auth_node) {
        if (!JSON_NODE_HOLDS_OBJECT(auth_node)) {
            return FALSE;
        }
        auth = json_node_get_object(auth_node);
    }

    if (out_auth_source) {
        *out_auth_source = NULL;
        if (auth && json_object_has_member(auth, "source")) {
            *out_auth_source = g_strdup(json_object_get_string_member(auth, "source"));
        }
    }

    if (out_tick_interval_ms) {
        *out_tick_interval_ms = 30000.0;
        if (json_object_has_member(policy, "tickIntervalMs")) {
            *out_tick_interval_ms = json_object_get_double_member(policy, "tickIntervalMs");
        }
    }

    return TRUE;
}
