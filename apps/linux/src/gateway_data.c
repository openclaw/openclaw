/*
 * gateway_data.c
 *
 * Gateway data adapter layer for the OpenClaw Linux Companion App.
 *
 * Parses JSON RPC response payloads into plain C structs, matching the
 * verified gateway contracts (channels.status, skills.status, sessions.list,
 * cron.list, node.list). No GTK dependency.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "gateway_data.h"
#include <string.h>

/* ── Helpers ─────────────────────────────────────────────────────── */

static gchar* json_get_string_or_null(JsonObject *obj, const gchar *member) {
    if (!obj || !json_object_has_member(obj, member)) return NULL;
    JsonNode *node = json_object_get_member(obj, member);
    if (!node || json_node_is_null(node)) return NULL;
    if (json_node_get_value_type(node) != G_TYPE_STRING) return NULL;
    const gchar *val = json_node_get_string(node);
    return val ? g_strdup(val) : NULL;
}

static gint64 json_get_int64_or_zero(JsonObject *obj, const gchar *member) {
    if (!obj || !json_object_has_member(obj, member)) return 0;
    JsonNode *node = json_object_get_member(obj, member);
    if (!node || json_node_is_null(node)) return 0;
    GType vt = json_node_get_value_type(node);
    if (vt == G_TYPE_INT64) return json_node_get_int(node);
    if (vt == G_TYPE_DOUBLE) return (gint64)json_node_get_double(node);
    return 0;
}

static gboolean json_get_bool_or_false(JsonObject *obj, const gchar *member) {
    if (!obj || !json_object_has_member(obj, member)) return FALSE;
    JsonNode *node = json_object_get_member(obj, member);
    if (!node || json_node_is_null(node)) return FALSE;
    if (json_node_get_value_type(node) == G_TYPE_BOOLEAN)
        return json_node_get_boolean(node);
    return FALSE;
}

static gint json_get_int_or_zero(JsonObject *obj, const gchar *member) {
    return (gint)json_get_int64_or_zero(obj, member);
}

/* ── Channels ────────────────────────────────────────────────────── */

void gateway_channels_data_free(GatewayChannelsData *data) {
    if (!data) return;
    for (gint i = 0; i < data->n_channels; i++) {
        g_free(data->channels[i].channel_id);
        g_free(data->channels[i].label);
        g_free(data->channels[i].detail_label);
        g_free(data->channels[i].default_account_id);
    }
    g_free(data->channels);
    g_strfreev(data->channel_order);
    g_free(data);
}

GatewayChannelsData* gateway_data_parse_channels(JsonNode *payload) {
    if (!payload || !JSON_NODE_HOLDS_OBJECT(payload)) return NULL;
    JsonObject *root = json_node_get_object(payload);

    GatewayChannelsData *data = g_new0(GatewayChannelsData, 1);
    data->ts = json_get_int64_or_zero(root, "ts");

    /* channelOrder: string[] */
    JsonArray *order_arr = NULL;
    if (json_object_has_member(root, "channelOrder")) {
        JsonNode *n = json_object_get_member(root, "channelOrder");
        if (n && JSON_NODE_HOLDS_ARRAY(n))
            order_arr = json_node_get_array(n);
    }

    if (order_arr) {
        guint len = json_array_get_length(order_arr);
        data->n_channel_order = (gint)len;
        data->channel_order = g_new0(gchar*, len + 1);
        for (guint i = 0; i < len; i++) {
            const gchar *s = json_array_get_string_element(order_arr, i);
            data->channel_order[i] = g_strdup(s ? s : "");
        }
        data->channel_order[len] = NULL;
    }

    /* channelLabels: Record<string, string> */
    JsonObject *labels = NULL;
    if (json_object_has_member(root, "channelLabels")) {
        JsonNode *n = json_object_get_member(root, "channelLabels");
        if (n && JSON_NODE_HOLDS_OBJECT(n))
            labels = json_node_get_object(n);
    }

    /* channelDetailLabels: Record<string, string> */
    JsonObject *detail_labels = NULL;
    if (json_object_has_member(root, "channelDetailLabels")) {
        JsonNode *n = json_object_get_member(root, "channelDetailLabels");
        if (n && JSON_NODE_HOLDS_OBJECT(n))
            detail_labels = json_node_get_object(n);
    }

    /* channelDefaultAccountId: Record<string, string> */
    JsonObject *default_accounts = NULL;
    if (json_object_has_member(root, "channelDefaultAccountId")) {
        JsonNode *n = json_object_get_member(root, "channelDefaultAccountId");
        if (n && JSON_NODE_HOLDS_OBJECT(n))
            default_accounts = json_node_get_object(n);
    }

    /* channels: Record<string, { connected?: boolean }> */
    JsonObject *channels_obj = NULL;
    if (json_object_has_member(root, "channels")) {
        JsonNode *n = json_object_get_member(root, "channels");
        if (n && JSON_NODE_HOLDS_OBJECT(n))
            channels_obj = json_node_get_object(n);
    }

    /* channelAccounts: Record<string, array> — count per channel */
    JsonObject *accounts_obj = NULL;
    if (json_object_has_member(root, "channelAccounts")) {
        JsonNode *n = json_object_get_member(root, "channelAccounts");
        if (n && JSON_NODE_HOLDS_OBJECT(n))
            accounts_obj = json_node_get_object(n);
    }

    /* Build channel list from channelOrder */
    if (data->channel_order && data->n_channel_order > 0) {
        data->n_channels = data->n_channel_order;
        data->channels = g_new0(GatewayChannel, data->n_channels);

        for (gint i = 0; i < data->n_channels; i++) {
            const gchar *cid = data->channel_order[i];
            data->channels[i].channel_id = g_strdup(cid);

            if (labels)
                data->channels[i].label = json_get_string_or_null(labels, cid);
            if (detail_labels)
                data->channels[i].detail_label = json_get_string_or_null(detail_labels, cid);
            if (default_accounts)
                data->channels[i].default_account_id = json_get_string_or_null(default_accounts, cid);

            if (channels_obj && json_object_has_member(channels_obj, cid)) {
                JsonNode *cn = json_object_get_member(channels_obj, cid);
                if (cn && JSON_NODE_HOLDS_OBJECT(cn)) {
                    JsonObject *co = json_node_get_object(cn);
                    data->channels[i].connected = json_get_bool_or_false(co, "connected");
                }
            }

            if (accounts_obj && json_object_has_member(accounts_obj, cid)) {
                JsonNode *an = json_object_get_member(accounts_obj, cid);
                if (an && JSON_NODE_HOLDS_ARRAY(an))
                    data->channels[i].account_count = (gint)json_array_get_length(json_node_get_array(an));
            }
        }
    }

    return data;
}

/* ── Skills ──────────────────────────────────────────────────────── */

void gateway_skills_data_free(GatewaySkillsData *data) {
    if (!data) return;
    for (gint i = 0; i < data->n_skills; i++) {
        g_free(data->skills[i].name);
        g_free(data->skills[i].description);
        g_free(data->skills[i].source);
        g_free(data->skills[i].key);
    }
    g_free(data->skills);
    g_free(data->workspace_dir);
    g_free(data);
}

GatewaySkillsData* gateway_data_parse_skills(JsonNode *payload) {
    if (!payload || !JSON_NODE_HOLDS_OBJECT(payload)) return NULL;
    JsonObject *root = json_node_get_object(payload);

    GatewaySkillsData *data = g_new0(GatewaySkillsData, 1);
    data->workspace_dir = json_get_string_or_null(root, "workspaceDir");

    JsonArray *skills_arr = NULL;
    if (json_object_has_member(root, "skills")) {
        JsonNode *n = json_object_get_member(root, "skills");
        if (n && JSON_NODE_HOLDS_ARRAY(n))
            skills_arr = json_node_get_array(n);
    }

    if (skills_arr) {
        guint len = json_array_get_length(skills_arr);
        data->n_skills = (gint)len;
        data->skills = g_new0(GatewaySkill, len);

        for (guint i = 0; i < len; i++) {
            JsonNode *elem = json_array_get_element(skills_arr, i);
            if (!elem || !JSON_NODE_HOLDS_OBJECT(elem)) continue;
            JsonObject *obj = json_node_get_object(elem);

            data->skills[i].name = json_get_string_or_null(obj, "name");
            data->skills[i].description = json_get_string_or_null(obj, "description");
            data->skills[i].source = json_get_string_or_null(obj, "source");
            data->skills[i].key = json_get_string_or_null(obj, "key");
            data->skills[i].enabled = json_get_bool_or_false(obj, "enabled");
            data->skills[i].disabled = json_get_bool_or_false(obj, "disabled");
            data->skills[i].installed = json_get_bool_or_false(obj, "installed");
            data->skills[i].managed = json_get_bool_or_false(obj, "managed");
            data->skills[i].bundled = json_get_bool_or_false(obj, "bundled");
            data->skills[i].has_update = json_get_bool_or_false(obj, "hasUpdate");
            data->skills[i].eligible = json_get_bool_or_false(obj, "eligible");
        }
    }

    return data;
}

/* ── Sessions ────────────────────────────────────────────────────── */

void gateway_sessions_data_free(GatewaySessionsData *data) {
    if (!data) return;
    for (gint i = 0; i < data->n_sessions; i++) {
        g_free(data->sessions[i].key);
        g_free(data->sessions[i].kind);
        g_free(data->sessions[i].display_name);
        g_free(data->sessions[i].channel);
        g_free(data->sessions[i].subject);
        g_free(data->sessions[i].status);
        g_free(data->sessions[i].model_provider);
        g_free(data->sessions[i].model);
    }
    g_free(data->sessions);
    g_free(data);
}

GatewaySessionsData* gateway_data_parse_sessions(JsonNode *payload) {
    if (!payload || !JSON_NODE_HOLDS_OBJECT(payload)) return NULL;
    JsonObject *root = json_node_get_object(payload);

    GatewaySessionsData *data = g_new0(GatewaySessionsData, 1);
    data->ts = json_get_int64_or_zero(root, "ts");
    data->count = json_get_int_or_zero(root, "count");

    JsonArray *sessions_arr = NULL;
    if (json_object_has_member(root, "sessions")) {
        JsonNode *n = json_object_get_member(root, "sessions");
        if (n && JSON_NODE_HOLDS_ARRAY(n))
            sessions_arr = json_node_get_array(n);
    }

    if (sessions_arr) {
        guint len = json_array_get_length(sessions_arr);
        data->n_sessions = (gint)len;
        data->sessions = g_new0(GatewaySession, len);

        for (guint i = 0; i < len; i++) {
            JsonNode *elem = json_array_get_element(sessions_arr, i);
            if (!elem || !JSON_NODE_HOLDS_OBJECT(elem)) continue;
            JsonObject *obj = json_node_get_object(elem);

            data->sessions[i].key = json_get_string_or_null(obj, "key");
            data->sessions[i].kind = json_get_string_or_null(obj, "kind");
            data->sessions[i].display_name = json_get_string_or_null(obj, "displayName");
            data->sessions[i].channel = json_get_string_or_null(obj, "channel");
            data->sessions[i].subject = json_get_string_or_null(obj, "subject");
            data->sessions[i].status = json_get_string_or_null(obj, "status");
            data->sessions[i].model_provider = json_get_string_or_null(obj, "modelProvider");
            data->sessions[i].model = json_get_string_or_null(obj, "model");
            data->sessions[i].updated_at = json_get_int64_or_zero(obj, "updatedAt");
        }
    }

    return data;
}

/* ── Cron ────────────────────────────────────────────────────────── */

void gateway_cron_data_free(GatewayCronData *data) {
    if (!data) return;
    for (gint i = 0; i < data->n_jobs; i++) {
        g_free(data->jobs[i].id);
        g_free(data->jobs[i].name);
        g_free(data->jobs[i].description);
        g_free(data->jobs[i].last_run_status);
        g_free(data->jobs[i].last_error);
    }
    g_free(data->jobs);
    g_free(data);
}

GatewayCronData* gateway_data_parse_cron(JsonNode *payload) {
    if (!payload || !JSON_NODE_HOLDS_OBJECT(payload)) return NULL;
    JsonObject *root = json_node_get_object(payload);

    GatewayCronData *data = g_new0(GatewayCronData, 1);
    data->total = json_get_int_or_zero(root, "total");
    data->offset = json_get_int_or_zero(root, "offset");
    data->limit = json_get_int_or_zero(root, "limit");
    data->has_more = json_get_bool_or_false(root, "hasMore");

    JsonArray *jobs_arr = NULL;
    if (json_object_has_member(root, "jobs")) {
        JsonNode *n = json_object_get_member(root, "jobs");
        if (n && JSON_NODE_HOLDS_ARRAY(n))
            jobs_arr = json_node_get_array(n);
    }

    if (jobs_arr) {
        guint len = json_array_get_length(jobs_arr);
        data->n_jobs = (gint)len;
        data->jobs = g_new0(GatewayCronJob, len);

        for (guint i = 0; i < len; i++) {
            JsonNode *elem = json_array_get_element(jobs_arr, i);
            if (!elem || !JSON_NODE_HOLDS_OBJECT(elem)) continue;
            JsonObject *obj = json_node_get_object(elem);

            data->jobs[i].id = json_get_string_or_null(obj, "id");
            data->jobs[i].name = json_get_string_or_null(obj, "name");
            data->jobs[i].description = json_get_string_or_null(obj, "description");
            data->jobs[i].enabled = json_get_bool_or_false(obj, "enabled");
            data->jobs[i].created_at_ms = json_get_int64_or_zero(obj, "createdAtMs");
            data->jobs[i].updated_at_ms = json_get_int64_or_zero(obj, "updatedAtMs");

            /* Nested state object */
            if (json_object_has_member(obj, "state")) {
                JsonNode *sn = json_object_get_member(obj, "state");
                if (sn && JSON_NODE_HOLDS_OBJECT(sn)) {
                    JsonObject *state = json_node_get_object(sn);
                    data->jobs[i].next_run_at_ms = json_get_int64_or_zero(state, "nextRunAtMs");
                    data->jobs[i].last_run_at_ms = json_get_int64_or_zero(state, "lastRunAtMs");
                    data->jobs[i].last_run_status = json_get_string_or_null(state, "lastRunStatus");
                    data->jobs[i].last_error = json_get_string_or_null(state, "lastError");
                }
            }
        }
    }

    return data;
}

/* ── Nodes ───────────────────────────────────────────────────────── */

void gateway_nodes_data_free(GatewayNodesData *data) {
    if (!data) return;
    for (gint i = 0; i < data->n_nodes; i++) {
        g_free(data->nodes[i].node_id);
        g_free(data->nodes[i].display_name);
        g_free(data->nodes[i].platform);
        g_free(data->nodes[i].version);
        g_free(data->nodes[i].device_family);
    }
    g_free(data->nodes);
    g_free(data);
}

GatewayNodesData* gateway_data_parse_nodes(JsonNode *payload) {
    if (!payload || !JSON_NODE_HOLDS_OBJECT(payload)) return NULL;
    JsonObject *root = json_node_get_object(payload);

    GatewayNodesData *data = g_new0(GatewayNodesData, 1);
    data->ts = json_get_int64_or_zero(root, "ts");

    JsonArray *nodes_arr = NULL;
    if (json_object_has_member(root, "nodes")) {
        JsonNode *n = json_object_get_member(root, "nodes");
        if (n && JSON_NODE_HOLDS_ARRAY(n))
            nodes_arr = json_node_get_array(n);
    }

    if (nodes_arr) {
        guint len = json_array_get_length(nodes_arr);
        data->n_nodes = (gint)len;
        data->nodes = g_new0(GatewayNode, len);

        for (guint i = 0; i < len; i++) {
            JsonNode *elem = json_array_get_element(nodes_arr, i);
            if (!elem || !JSON_NODE_HOLDS_OBJECT(elem)) continue;
            JsonObject *obj = json_node_get_object(elem);

            data->nodes[i].node_id = json_get_string_or_null(obj, "nodeId");
            data->nodes[i].display_name = json_get_string_or_null(obj, "displayName");
            data->nodes[i].platform = json_get_string_or_null(obj, "platform");
            data->nodes[i].version = json_get_string_or_null(obj, "version");
            data->nodes[i].device_family = json_get_string_or_null(obj, "deviceFamily");
            data->nodes[i].paired = json_get_bool_or_false(obj, "paired");
            data->nodes[i].connected = json_get_bool_or_false(obj, "connected");
            data->nodes[i].connected_at_ms = json_get_int64_or_zero(obj, "connectedAtMs");
            data->nodes[i].approved_at_ms = json_get_int64_or_zero(obj, "approvedAtMs");
        }
    }

    return data;
}
