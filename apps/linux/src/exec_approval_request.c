/*
 * exec_approval_request.c
 *
 * Pure-C parser/value-type implementation. See header for the payload
 * contract.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "exec_approval_request.h"

#include "json_access.h"

#include <string.h>

static gint64 json_object_int64_member_or(JsonObject *obj,
                                          const gchar *member,
                                          gint64 fallback) {
    if (!obj || !member || !json_object_has_member(obj, member)) return fallback;
    JsonNode *node = json_object_get_member(obj, member);
    if (!node || !JSON_NODE_HOLDS_VALUE(node)) return fallback;
    GType t = json_node_get_value_type(node);
    if (t == G_TYPE_INT64) return json_node_get_int(node);
    if (t == G_TYPE_DOUBLE) return (gint64)json_node_get_double(node);
    return fallback;
}

static gchar** parse_string_array_member(JsonObject *obj, const gchar *member) {
    JsonArray *arr = oc_json_array_member(obj, member);
    if (!arr) return NULL;
    guint n = json_array_get_length(arr);
    GPtrArray *out = g_ptr_array_sized_new(n + 1);
    for (guint i = 0; i < n; i++) {
        JsonNode *node = json_array_get_element(arr, i);
        if (!node || !JSON_NODE_HOLDS_VALUE(node)) continue;
        if (json_node_get_value_type(node) != G_TYPE_STRING) continue;
        const gchar *s = json_node_get_string(node);
        if (!s || s[0] == '\0') continue;
        g_ptr_array_add(out, g_strdup(s));
    }
    g_ptr_array_add(out, NULL);
    return (gchar **)g_ptr_array_free(out, FALSE);
}

static gchar* dup_or_null(const gchar *s) {
    return (s && s[0] != '\0') ? g_strdup(s) : NULL;
}

OcExecApprovalRequest* oc_exec_approval_request_new_from_event(JsonNode *payload) {
    if (!payload || !JSON_NODE_HOLDS_OBJECT(payload)) return NULL;
    JsonObject *root = json_node_get_object(payload);

    const gchar *id = oc_json_string_member(root, "id");
    if (!id || id[0] == '\0') return NULL;

    JsonObject *request = oc_json_object_member(root, "request");
    if (!request) return NULL;

    const gchar *command = oc_json_string_member(request, "command");
    if (!command || command[0] == '\0') return NULL;

    gint64 created_at_ms = json_object_int64_member_or(root, "createdAtMs", 0);
    gint64 expires_at_ms = json_object_int64_member_or(root, "expiresAtMs", 0);
    if (created_at_ms <= 0 || expires_at_ms <= 0) return NULL;

    OcExecApprovalRequest *req = g_new0(OcExecApprovalRequest, 1);
    req->id = g_strdup(id);
    req->command = g_strdup(command);
    req->cwd = dup_or_null(oc_json_string_member(request, "cwd"));
    req->host = dup_or_null(oc_json_string_member(request, "host"));
    req->node_id = dup_or_null(oc_json_string_member(request, "nodeId"));
    req->agent_id = dup_or_null(oc_json_string_member(request, "agentId"));
    req->resolved_path = dup_or_null(oc_json_string_member(request, "resolvedPath"));
    req->security = dup_or_null(oc_json_string_member(request, "security"));
    req->ask = dup_or_null(oc_json_string_member(request, "ask"));
    req->session_key = dup_or_null(oc_json_string_member(request, "sessionKey"));
    req->allowed_decisions = parse_string_array_member(request, "allowedDecisions");
    req->created_at_ms = created_at_ms;
    req->expires_at_ms = expires_at_ms;
    return req;
}

OcExecApprovalRequest* oc_exec_approval_request_copy(const OcExecApprovalRequest *src) {
    if (!src) return NULL;
    OcExecApprovalRequest *dst = g_new0(OcExecApprovalRequest, 1);
    dst->id = g_strdup(src->id);
    dst->command = g_strdup(src->command);
    dst->cwd = src->cwd ? g_strdup(src->cwd) : NULL;
    dst->host = src->host ? g_strdup(src->host) : NULL;
    dst->node_id = src->node_id ? g_strdup(src->node_id) : NULL;
    dst->agent_id = src->agent_id ? g_strdup(src->agent_id) : NULL;
    dst->resolved_path = src->resolved_path ? g_strdup(src->resolved_path) : NULL;
    dst->security = src->security ? g_strdup(src->security) : NULL;
    dst->ask = src->ask ? g_strdup(src->ask) : NULL;
    dst->session_key = src->session_key ? g_strdup(src->session_key) : NULL;
    if (src->allowed_decisions) {
        dst->allowed_decisions = g_strdupv(src->allowed_decisions);
    }
    dst->created_at_ms = src->created_at_ms;
    dst->expires_at_ms = src->expires_at_ms;
    return dst;
}

void oc_exec_approval_request_free(OcExecApprovalRequest *req) {
    if (!req) return;
    g_free(req->id);
    g_free(req->command);
    g_free(req->cwd);
    g_free(req->host);
    g_free(req->node_id);
    g_free(req->agent_id);
    g_free(req->resolved_path);
    g_free(req->security);
    g_free(req->ask);
    g_free(req->session_key);
    g_strfreev(req->allowed_decisions);
    g_free(req);
}

gboolean oc_exec_approval_request_allows_decision(const OcExecApprovalRequest *req,
                                                  const gchar *decision) {
    if (!req || !decision) return FALSE;
    /* Omitted constraint = all decisions allowed. */
    if (!req->allowed_decisions) return TRUE;
    for (gsize i = 0; req->allowed_decisions[i]; i++) {
        if (g_strcmp0(req->allowed_decisions[i], decision) == 0) return TRUE;
    }
    return FALSE;
}

gboolean oc_exec_approval_request_is_expired(const OcExecApprovalRequest *req,
                                             gint64 now_ms) {
    if (!req) return TRUE;
    if (req->expires_at_ms <= 0) return FALSE;
    return now_ms >= req->expires_at_ms;
}

gint64 oc_exec_approval_now_ms(void) {
    return g_get_real_time() / 1000;
}
