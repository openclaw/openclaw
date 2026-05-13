/*
 * gateway_mutations.c
 *
 * Mutation RPC helpers for the OpenClaw Linux Companion App.
 *
 * Builds JSON params objects and dispatches mutation RPCs via
 * gateway_rpc_request. Each helper returns the request ID (caller-owned)
 * or NULL if the request could not be sent.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "gateway_mutations.h"

/* ── JSON param builder helpers ──────────────────────────────────── */

JsonNode* mutation_params_new_empty(void) {
    JsonBuilder *b = json_builder_new();
    json_builder_begin_object(b);
    json_builder_end_object(b);
    JsonNode *node = json_builder_get_root(b);
    g_object_unref(b);
    return node;
}

JsonNode* mutation_params_new_object(void) {
    return mutation_params_new_empty();
}

static JsonNode* build_params_with_key(const gchar *key_name, const gchar *key_value) {
    JsonBuilder *b = json_builder_new();
    json_builder_begin_object(b);
    json_builder_set_member_name(b, key_name);
    json_builder_add_string_value(b, key_value);
    json_builder_end_object(b);
    JsonNode *node = json_builder_get_root(b);
    g_object_unref(b);
    return node;
}

/* ── Skills mutations ────────────────────────────────────────────── */

gchar* mutation_skills_enable(const gchar *skill_key, gboolean enable,
                              GatewayRpcCallback cb, gpointer data) {
    JsonBuilder *b = json_builder_new();
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "skillKey");
    json_builder_add_string_value(b, skill_key);
    json_builder_set_member_name(b, "enabled");
    json_builder_add_boolean_value(b, enable);
    json_builder_end_object(b);
    JsonNode *params = json_builder_get_root(b);
    g_object_unref(b);

    gchar *rid = gateway_rpc_request("skills.update", params, 0, cb, data);
    json_node_unref(params);
    return rid;
}

gchar* mutation_skills_install(const gchar *name, const gchar *install_id,
                               GatewayRpcCallback cb, gpointer data) {
    JsonBuilder *b = json_builder_new();
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "name");
    json_builder_add_string_value(b, name);
    if (install_id) {
        json_builder_set_member_name(b, "installId");
        json_builder_add_string_value(b, install_id);
    }
    json_builder_end_object(b);
    JsonNode *params = json_builder_get_root(b);
    g_object_unref(b);

    gchar *rid = gateway_rpc_request("skills.install", params, 30000, cb, data);
    json_node_unref(params);
    return rid;
}

gchar* mutation_skills_update(const gchar *skill_key,
                              GatewayRpcCallback cb, gpointer data) {
    JsonNode *params = build_params_with_key("skillKey", skill_key);
    gchar *rid = gateway_rpc_request("skills.update", params, 30000, cb, data);
    json_node_unref(params);
    return rid;
}

gchar* mutation_skills_update_env(const gchar *skill_key, const gchar *env_name,
                                  const gchar *value,
                                  GatewayRpcCallback cb, gpointer data) {
    JsonBuilder *b = json_builder_new();
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "skillKey");
    json_builder_add_string_value(b, skill_key);
    
    json_builder_set_member_name(b, "env");
    json_builder_begin_object(b);
    json_builder_set_member_name(b, env_name);
    json_builder_add_string_value(b, value ? value : "");
    json_builder_end_object(b);
    
    json_builder_end_object(b);
    JsonNode *params = json_builder_get_root(b);
    g_object_unref(b);

    gchar *rid = gateway_rpc_request("skills.update", params, 0, cb, data);
    json_node_unref(params);
    return rid;
}

gchar* mutation_skills_update_api_key(const gchar *skill_key, const gchar *api_key,
                                      GatewayRpcCallback cb, gpointer data) {
    JsonBuilder *b = json_builder_new();
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "skillKey");
    json_builder_add_string_value(b, skill_key);
    if (api_key) {
        json_builder_set_member_name(b, "apiKey");
        json_builder_add_string_value(b, api_key);
    }
    json_builder_end_object(b);
    JsonNode *params = json_builder_get_root(b);
    g_object_unref(b);

    gchar *rid = gateway_rpc_request("skills.update", params, 0, cb, data);
    json_node_unref(params);
    return rid;
}

/* ── Sessions mutations ──────────────────────────────────────────── */

gchar* mutation_sessions_patch(const gchar *session_key,
                               const gchar *thinking_level,
                               const gchar *verbose_level,
                               const gchar *model,
                               GatewayRpcCallback cb, gpointer data) {
    JsonBuilder *b = json_builder_new();
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "key");
    json_builder_add_string_value(b, session_key);
    if (thinking_level) {
        json_builder_set_member_name(b, "thinkingLevel");
        json_builder_add_string_value(b, thinking_level);
    }
    if (verbose_level) {
        json_builder_set_member_name(b, "verboseLevel");
        json_builder_add_string_value(b, verbose_level);
    }
    if (model) {
        json_builder_set_member_name(b, "model");
        json_builder_add_string_value(b, model);
    }
    json_builder_end_object(b);
    JsonNode *params = json_builder_get_root(b);
    g_object_unref(b);

    gchar *rid = gateway_rpc_request("sessions.patch", params, 0, cb, data);
    json_node_unref(params);
    return rid;
}

gchar* mutation_sessions_reset(const gchar *session_key,
                               GatewayRpcCallback cb, gpointer data) {
    JsonNode *params = build_params_with_key("key", session_key);
    gchar *rid = gateway_rpc_request("sessions.reset", params, 0, cb, data);
    json_node_unref(params);
    return rid;
}

gchar* mutation_sessions_delete(const gchar *session_key,
                                gboolean delete_transcript,
                                GatewayRpcCallback cb, gpointer data) {
    JsonBuilder *b = json_builder_new();
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "key");
    json_builder_add_string_value(b, session_key);
    json_builder_set_member_name(b, "deleteTranscript");
    json_builder_add_boolean_value(b, delete_transcript);
    json_builder_end_object(b);
    JsonNode *params = json_builder_get_root(b);
    g_object_unref(b);

    gchar *rid = gateway_rpc_request("sessions.delete", params, 0, cb, data);
    json_node_unref(params);
    return rid;
}

gchar* mutation_sessions_compact(const gchar *session_key,
                                 GatewayRpcCallback cb, gpointer data) {
    JsonNode *params = build_params_with_key("key", session_key);
    gchar *rid = gateway_rpc_request("sessions.compact", params, 0, cb, data);
    json_node_unref(params);
    return rid;
}

/* ── Cron mutations ──────────────────────────────────────────────── */

gchar* mutation_cron_enable(const gchar *job_id, gboolean enable,
                            GatewayRpcCallback cb, gpointer data) {
    JsonBuilder *b = json_builder_new();
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "id");
    json_builder_add_string_value(b, job_id);
    
    json_builder_set_member_name(b, "patch");
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "enabled");
    json_builder_add_boolean_value(b, enable);
    json_builder_end_object(b);
    
    json_builder_end_object(b);
    JsonNode *params = json_builder_get_root(b);
    g_object_unref(b);

    gchar *rid = gateway_rpc_request("cron.update", params, 0, cb, data);
    json_node_unref(params);
    return rid;
}

gchar* mutation_cron_remove(const gchar *job_id,
                            GatewayRpcCallback cb, gpointer data) {
    JsonNode *params = build_params_with_key("id", job_id);
    gchar *rid = gateway_rpc_request("cron.remove", params, 0, cb, data);
    json_node_unref(params);
    return rid;
}

gchar* mutation_cron_run(const gchar *job_id,
                         GatewayRpcCallback cb, gpointer data) {
    JsonBuilder *b = json_builder_new();
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "id");
    json_builder_add_string_value(b, job_id);
    json_builder_set_member_name(b, "mode");
    json_builder_add_string_value(b, "force");
    json_builder_end_object(b);
    JsonNode *params = json_builder_get_root(b);
    g_object_unref(b);

    gchar *rid = gateway_rpc_request("cron.run", params, 0, cb, data);
    json_node_unref(params);
    return rid;
}

/*
 * Append the shared cron job field block into an existing JsonBuilder. The
 * caller is responsible for begin/end of the surrounding object so that the
 * same helper serves both the add root and the update patch sub-object.
 *
 * Optional-field semantics:
 *   - description / agentId / payload omitted when their backing string is
 *     NULL or empty. Validation of "must have a prompt" lives at the call
 *     site (for example the create UI), not here.
 */
static void mutation_build_cron_job_fields(JsonBuilder *b,
                                           const GatewayCronJobMutationFields *fields) {
    json_builder_set_member_name(b, "name");
    json_builder_add_string_value(b, fields->name);

    if (fields->description && *fields->description != '\0') {
        json_builder_set_member_name(b, "description");
        json_builder_add_string_value(b, fields->description);
    }
    if (fields->agent_id && *fields->agent_id != '\0') {
        json_builder_set_member_name(b, "agentId");
        json_builder_add_string_value(b, fields->agent_id);
    }

    json_builder_set_member_name(b, "schedule");
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "kind");
    json_builder_add_string_value(b, fields->schedule_kind);
    json_builder_set_member_name(b, "expr");
    json_builder_add_string_value(b, fields->schedule_expr);
    json_builder_end_object(b);

    json_builder_set_member_name(b, "sessionTarget");
    json_builder_add_string_value(b, fields->session_target);

    json_builder_set_member_name(b, "wakeMode");
    json_builder_add_string_value(b, fields->wake_mode);

    if (fields->prompt && *fields->prompt != '\0') {
        json_builder_set_member_name(b, "payload");
        json_builder_begin_object(b);
        json_builder_set_member_name(b, "kind");
        json_builder_add_string_value(b, "agentTurn");
        json_builder_set_member_name(b, "message");
        json_builder_add_string_value(b, fields->prompt);
        json_builder_end_object(b);
    }
}

gchar* mutation_cron_add(const GatewayCronJobMutationFields *fields,
                         GatewayRpcCallback cb, gpointer data) {
    g_return_val_if_fail(fields != NULL, NULL);

    JsonBuilder *b = json_builder_new();
    json_builder_begin_object(b);
    mutation_build_cron_job_fields(b, fields);
    json_builder_set_member_name(b, "enabled");
    json_builder_add_boolean_value(b, TRUE);
    json_builder_end_object(b);
    JsonNode *params = json_builder_get_root(b);
    g_object_unref(b);

    gchar *rid = gateway_rpc_request("cron.add", params, 0, cb, data);
    json_node_unref(params);
    return rid;
}

gchar* mutation_cron_update(const gchar *id,
                            const GatewayCronJobMutationFields *fields,
                            GatewayRpcCallback cb, gpointer data) {
    g_return_val_if_fail(id != NULL, NULL);
    g_return_val_if_fail(fields != NULL, NULL);

    JsonBuilder *b = json_builder_new();
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "id");
    json_builder_add_string_value(b, id);
    json_builder_set_member_name(b, "patch");
    json_builder_begin_object(b);
    mutation_build_cron_job_fields(b, fields);
    json_builder_end_object(b);
    json_builder_end_object(b);
    JsonNode *params = json_builder_get_root(b);
    g_object_unref(b);

    gchar *rid = gateway_rpc_request("cron.update", params, 0, cb, data);
    json_node_unref(params);
    return rid;
}

/* ── Channels mutations ──────────────────────────────────────────── */

gchar* mutation_channels_status(gboolean probe,
                                GatewayRpcCallback cb, gpointer data) {
    JsonBuilder *b = json_builder_new();
    json_builder_begin_object(b);
    if (probe) {
        json_builder_set_member_name(b, "probe");
        json_builder_add_boolean_value(b, TRUE);
    }
    json_builder_end_object(b);
    JsonNode *params = json_builder_get_root(b);
    g_object_unref(b);

    gchar *rid = gateway_rpc_request("channels.status", params, 0, cb, data);
    json_node_unref(params);
    return rid;
}

gchar* mutation_channels_logout(const gchar *channel, const gchar *account_id,
                                GatewayRpcCallback cb, gpointer data) {
    JsonBuilder *b = json_builder_new();
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "channel");
    json_builder_add_string_value(b, channel);
    if (account_id) {
        json_builder_set_member_name(b, "accountId");
        json_builder_add_string_value(b, account_id);
    }
    json_builder_end_object(b);
    JsonNode *params = json_builder_get_root(b);
    g_object_unref(b);

    gchar *rid = gateway_rpc_request("channels.logout", params, 0, cb, data);
    json_node_unref(params);
    return rid;
}

gchar* mutation_web_login_start(GatewayRpcCallback cb, gpointer data) {
    JsonNode *params = mutation_params_new_empty();
    gchar *rid = gateway_rpc_request("web.login.start", params, 0, cb, data);
    json_node_unref(params);
    return rid;
}

gchar* mutation_web_login_wait(guint timeout_ms, const gchar *account_id,
                               GatewayRpcCallback cb, gpointer data) {
    JsonBuilder *b = json_builder_new();
    json_builder_begin_object(b);
    if (timeout_ms > 0) {
        json_builder_set_member_name(b, "timeoutMs");
        json_builder_add_int_value(b, timeout_ms);
    }
    if (account_id) {
        json_builder_set_member_name(b, "accountId");
        json_builder_add_string_value(b, account_id);
    }
    json_builder_end_object(b);
    JsonNode *params = json_builder_get_root(b);
    g_object_unref(b);

    guint effective_timeout = timeout_ms > 0 ? timeout_ms : 60000;
    gchar *rid = gateway_rpc_request("web.login.wait", params,
                                     effective_timeout, cb, data);
    json_node_unref(params);
    return rid;
}

/* ── Config mutations ────────────────────────────────────────────── */

gchar* mutation_config_get(const gchar *scope,
                           GatewayRpcCallback cb, gpointer data) {
    JsonBuilder *b = json_builder_new();
    json_builder_begin_object(b);
    if (scope) {
        json_builder_set_member_name(b, "scope");
        json_builder_add_string_value(b, scope);
    }
    json_builder_end_object(b);
    JsonNode *params = json_builder_get_root(b);
    g_object_unref(b);

    gchar *rid = gateway_rpc_request("config.get", params, 0, cb, data);
    json_node_unref(params);
    return rid;
}

gchar* mutation_config_schema(const gchar *scope,
                              GatewayRpcCallback cb, gpointer data) {
    JsonBuilder *b = json_builder_new();
    json_builder_begin_object(b);
    if (scope) {
        json_builder_set_member_name(b, "scope");
        json_builder_add_string_value(b, scope);
    }
    json_builder_end_object(b);
    JsonNode *params = json_builder_get_root(b);
    g_object_unref(b);

    gchar *rid = gateway_rpc_request("config.schema", params, 0, cb, data);
    json_node_unref(params);
    return rid;
}

gchar* mutation_config_set(const gchar *raw_json, const gchar *base_hash,
                           GatewayRpcCallback cb, gpointer data) {
    JsonBuilder *b = json_builder_new();
    json_builder_begin_object(b);
    if (raw_json) {
        json_builder_set_member_name(b, "raw");
        json_builder_add_string_value(b, raw_json);
    }
    if (base_hash) {
        json_builder_set_member_name(b, "baseHash");
        json_builder_add_string_value(b, base_hash);
    }
    json_builder_end_object(b);
    JsonNode *params = json_builder_get_root(b);
    g_object_unref(b);

    gchar *rid = gateway_rpc_request("config.set", params, 0, cb, data);
    json_node_unref(params);
    return rid;
}

/* ── Nodes (Instances) mutations ─────────────────────────────────── */

gchar* mutation_node_pair_approve(const gchar *request_id,
                                  GatewayRpcCallback cb, gpointer data) {
    JsonNode *params = build_params_with_key("requestId", request_id);
    gchar *rid = gateway_rpc_request("node.pair.approve", params, 0, cb, data);
    json_node_unref(params);
    return rid;
}

gchar* mutation_node_pair_reject(const gchar *request_id,
                                 GatewayRpcCallback cb, gpointer data) {
    JsonNode *params = build_params_with_key("requestId", request_id);
    gchar *rid = gateway_rpc_request("node.pair.reject", params, 0, cb, data);
    json_node_unref(params);
    return rid;
}

gchar* mutation_node_list(GatewayRpcCallback cb, gpointer data) {
    JsonNode *params = mutation_params_new_empty();
    gchar *rid = gateway_rpc_request("node.list", params, 0, cb, data);
    json_node_unref(params);
    return rid;
}

gchar* mutation_node_pair_list(GatewayRpcCallback cb, gpointer data) {
    JsonNode *params = mutation_params_new_empty();
    gchar *rid = gateway_rpc_request("node.pair.list", params, 0, cb, data);
    json_node_unref(params);
    return rid;
}

/* ── System mutations ────────────────────────────────────────────── */

gchar* mutation_system_set_heartbeats(gboolean enabled,
                                      GatewayRpcCallback cb, gpointer data) {
    JsonBuilder *b = json_builder_new();
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "enabled");
    json_builder_add_boolean_value(b, enabled);
    json_builder_end_object(b);
    JsonNode *params = json_builder_get_root(b);
    g_object_unref(b);

    gchar *rid = gateway_rpc_request("set-heartbeats", params, 0, cb, data);
    json_node_unref(params);
    return rid;
}
