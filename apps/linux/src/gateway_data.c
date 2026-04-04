/*
 * gateway_data.c
 *
 * Gateway data adapter layer for the OpenClaw Linux Companion App.
 *
 * Parses JSON RPC response payloads into plain C structs, matching the
 * verified gateway contracts (channels.status, skills.status, sessions.list,
 * cron.list, node.list, cron.status, cron.runs, node.pair.list,
 * config.get, config.schema). No GTK dependency.
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

static gdouble json_get_double_or_zero(JsonObject *obj, const gchar *member) {
    if (!obj || !json_object_has_member(obj, member)) return 0.0;
    JsonNode *node = json_object_get_member(obj, member);
    if (!node || json_node_is_null(node)) return 0.0;
    GType vt = json_node_get_value_type(node);
    if (vt == G_TYPE_DOUBLE) return json_node_get_double(node);
    if (vt == G_TYPE_INT64) return (gdouble)json_node_get_int(node);
    return 0.0;
}

static gchar** json_get_string_array(JsonObject *obj, const gchar *member, gint *out_len) {
    *out_len = 0;
    if (!obj || !json_object_has_member(obj, member)) return NULL;
    JsonNode *n = json_object_get_member(obj, member);
    if (!n || !JSON_NODE_HOLDS_ARRAY(n)) return NULL;
    JsonArray *arr = json_node_get_array(n);
    guint len = json_array_get_length(arr);
    if (len == 0) return NULL;
    gchar **result = g_new0(gchar*, len + 1);
    for (guint i = 0; i < len; i++) {
        JsonNode *elem = json_array_get_element(arr, i);
        if (elem && json_node_get_value_type(elem) == G_TYPE_STRING) {
            const gchar *s = json_node_get_string(elem);
            result[i] = g_strdup(s ? s : "");
        } else {
            result[i] = g_strdup("");
        }
    }
    result[len] = NULL;
    *out_len = (gint)len;
    return result;
}

static gchar* json_format_value_for_display(JsonNode *node) {
    if (!node || json_node_is_null(node)) return NULL;
    GType vt = json_node_get_value_type(node);
    if (vt == G_TYPE_BOOLEAN)
        return g_strdup(json_node_get_boolean(node) ? "true" : "false");
    if (vt == G_TYPE_INT64)
        return g_strdup_printf("%" G_GINT64_FORMAT, json_node_get_int(node));
    if (vt == G_TYPE_DOUBLE)
        return g_strdup_printf("%g", json_node_get_double(node));
    if (vt == G_TYPE_STRING) {
        const gchar *s = json_node_get_string(node);
        return s ? g_strdup(s) : NULL;
    }
    return NULL;
}

/* ── Channels ────────────────────────────────────────────────────── */

static void gateway_channel_account_clear(GatewayChannelAccount *acct) {
    g_free(acct->account_id);
    g_free(acct->display_name);
    g_free(acct->mode);
    g_free(acct->dm_policy);
    g_free(acct->last_error);
}

void gateway_channels_data_free(GatewayChannelsData *data) {
    if (!data) return;
    for (gint i = 0; i < data->n_channels; i++) {
        g_free(data->channels[i].channel_id);
        g_free(data->channels[i].label);
        g_free(data->channels[i].detail_label);
        g_free(data->channels[i].system_image);
        g_free(data->channels[i].default_account_id);
        for (gint j = 0; j < data->channels[i].n_accounts; j++)
            gateway_channel_account_clear(&data->channels[i].accounts[j]);
        g_free(data->channels[i].accounts);
        if (data->channels[i].raw_status)
            json_object_unref(data->channels[i].raw_status);
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

    /* channelSystemImages: Record<string, string> */
    JsonObject *sys_images = NULL;
    if (json_object_has_member(root, "channelSystemImages")) {
        JsonNode *n = json_object_get_member(root, "channelSystemImages");
        if (n && JSON_NODE_HOLDS_OBJECT(n))
            sys_images = json_node_get_object(n);
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
            if (sys_images)
                data->channels[i].system_image = json_get_string_or_null(sys_images, cid);
            if (default_accounts)
                data->channels[i].default_account_id = json_get_string_or_null(default_accounts, cid);

            if (channels_obj && json_object_has_member(channels_obj, cid)) {
                JsonNode *cn = json_object_get_member(channels_obj, cid);
                if (cn && JSON_NODE_HOLDS_OBJECT(cn)) {
                    JsonObject *co = json_node_get_object(cn);
                    data->channels[i].connected = json_get_bool_or_false(co, "connected");
                    data->channels[i].raw_status = json_object_ref(co);
                }
            }

            if (accounts_obj && json_object_has_member(accounts_obj, cid)) {
                JsonNode *an = json_object_get_member(accounts_obj, cid);
                if (an && JSON_NODE_HOLDS_ARRAY(an)) {
                    JsonArray *acct_arr = json_node_get_array(an);
                    guint acct_len = json_array_get_length(acct_arr);
                    data->channels[i].account_count = (gint)acct_len;
                    if (acct_len > 0) {
                        data->channels[i].n_accounts = (gint)acct_len;
                        data->channels[i].accounts = g_new0(GatewayChannelAccount, acct_len);
                        for (guint j = 0; j < acct_len; j++) {
                            JsonNode *ae = json_array_get_element(acct_arr, j);
                            if (!ae || !JSON_NODE_HOLDS_OBJECT(ae)) continue;
                            JsonObject *ao = json_node_get_object(ae);
                            GatewayChannelAccount *acct = &data->channels[i].accounts[j];
                            acct->account_id = json_get_string_or_null(ao, "accountId");
                            acct->configured = json_get_bool_or_false(ao, "configured");
                            acct->enabled = json_get_bool_or_false(ao, "enabled");
                            acct->running = json_get_bool_or_false(ao, "running");
                            acct->connected = json_get_bool_or_false(ao, "connected");
                            acct->linked = json_get_bool_or_false(ao, "linked");
                            acct->display_name = json_get_string_or_null(ao, "displayName");
                            acct->mode = json_get_string_or_null(ao, "mode");
                            acct->dm_policy = json_get_string_or_null(ao, "dmPolicy");
                            acct->last_inbound_at = json_get_double_or_zero(ao, "lastInboundAt");
                            acct->last_outbound_at = json_get_double_or_zero(ao, "lastOutboundAt");
                            acct->last_error = json_get_string_or_null(ao, "lastError");
                        }
                    }
                }
            }
        }
    }

    return data;
}

/* ── Skills ──────────────────────────────────────────────────────── */

static void gateway_skill_clear(GatewaySkill *s) {
    g_free(s->name);
    g_free(s->description);
    g_free(s->source);
    g_free(s->key);
    g_free(s->primary_env);
    g_free(s->emoji);
    g_free(s->homepage);
    g_strfreev(s->req_bins);
    g_strfreev(s->req_env);
    g_strfreev(s->req_config);
    g_strfreev(s->missing_bins);
    g_strfreev(s->missing_env);
    g_strfreev(s->missing_config);
    for (gint j = 0; j < s->n_config_checks; j++) {
        g_free(s->config_checks[j].path);
        g_free(s->config_checks[j].value_str);
    }
    g_free(s->config_checks);
    for (gint j = 0; j < s->n_install_options; j++) {
        g_free(s->install_options[j].id);
        g_free(s->install_options[j].kind);
        g_free(s->install_options[j].label);
        g_strfreev(s->install_options[j].bins);
    }
    g_free(s->install_options);
}

void gateway_skills_data_free(GatewaySkillsData *data) {
    if (!data) return;
    for (gint i = 0; i < data->n_skills; i++)
        gateway_skill_clear(&data->skills[i]);
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

            GatewaySkill *sk = &data->skills[i];
            sk->name = json_get_string_or_null(obj, "name");
            sk->description = json_get_string_or_null(obj, "description");
            sk->source = json_get_string_or_null(obj, "source");
            sk->key = json_get_string_or_null(obj, "key");
            sk->primary_env = json_get_string_or_null(obj, "primaryEnv");
            sk->emoji = json_get_string_or_null(obj, "emoji");
            sk->homepage = json_get_string_or_null(obj, "homepage");
            sk->enabled = json_get_bool_or_false(obj, "enabled");
            sk->disabled = json_get_bool_or_false(obj, "disabled");
            sk->installed = json_get_bool_or_false(obj, "installed");
            sk->managed = json_get_bool_or_false(obj, "managed");
            sk->bundled = json_get_bool_or_false(obj, "bundled");
            sk->has_update = json_get_bool_or_false(obj, "hasUpdate");
            sk->eligible = json_get_bool_or_false(obj, "eligible");
            sk->always = json_get_bool_or_false(obj, "always");

            /* requirements: { bins?, env?, config? } */
            if (json_object_has_member(obj, "requirements")) {
                JsonNode *rn = json_object_get_member(obj, "requirements");
                if (rn && JSON_NODE_HOLDS_OBJECT(rn)) {
                    JsonObject *req = json_node_get_object(rn);
                    sk->req_bins = json_get_string_array(req, "bins", &sk->n_req_bins);
                    sk->req_env = json_get_string_array(req, "env", &sk->n_req_env);
                    sk->req_config = json_get_string_array(req, "config", &sk->n_req_config);
                }
            }

            /* missing: { bins?, env?, config? } */
            if (json_object_has_member(obj, "missing")) {
                JsonNode *mn = json_object_get_member(obj, "missing");
                if (mn && JSON_NODE_HOLDS_OBJECT(mn)) {
                    JsonObject *miss = json_node_get_object(mn);
                    sk->missing_bins = json_get_string_array(miss, "bins", &sk->n_missing_bins);
                    sk->missing_env = json_get_string_array(miss, "env", &sk->n_missing_env);
                    sk->missing_config = json_get_string_array(miss, "config", &sk->n_missing_config);
                }
            }

            /* configChecks: [{ path, value?, satisfied }] */
            if (json_object_has_member(obj, "configChecks")) {
                JsonNode *ccn = json_object_get_member(obj, "configChecks");
                if (ccn && JSON_NODE_HOLDS_ARRAY(ccn)) {
                    JsonArray *cca = json_node_get_array(ccn);
                    guint cclen = json_array_get_length(cca);
                    sk->n_config_checks = (gint)cclen;
                    sk->config_checks = g_new0(GatewaySkillConfigCheck, cclen);
                    for (guint j = 0; j < cclen; j++) {
                        JsonNode *ce = json_array_get_element(cca, j);
                        if (!ce || !JSON_NODE_HOLDS_OBJECT(ce)) continue;
                        JsonObject *co = json_node_get_object(ce);
                        sk->config_checks[j].path = json_get_string_or_null(co, "path");
                        sk->config_checks[j].satisfied = json_get_bool_or_false(co, "satisfied");
                        if (json_object_has_member(co, "value")) {
                            JsonNode *vn = json_object_get_member(co, "value");
                            sk->config_checks[j].value_str = json_format_value_for_display(vn);
                        }
                    }
                }
            }

            /* install: [{ id, kind, label, bins? }] */
            if (json_object_has_member(obj, "install")) {
                JsonNode *isn = json_object_get_member(obj, "install");
                if (isn && JSON_NODE_HOLDS_ARRAY(isn)) {
                    JsonArray *isa = json_node_get_array(isn);
                    guint islen = json_array_get_length(isa);
                    sk->n_install_options = (gint)islen;
                    sk->install_options = g_new0(GatewaySkillInstallOption, islen);
                    for (guint j = 0; j < islen; j++) {
                        JsonNode *ie = json_array_get_element(isa, j);
                        if (!ie || !JSON_NODE_HOLDS_OBJECT(ie)) continue;
                        JsonObject *io = json_node_get_object(ie);
                        sk->install_options[j].id = json_get_string_or_null(io, "id");
                        sk->install_options[j].kind = json_get_string_or_null(io, "kind");
                        sk->install_options[j].label = json_get_string_or_null(io, "label");
                        sk->install_options[j].bins = json_get_string_array(io, "bins", &sk->install_options[j].n_bins);
                    }
                }
            }
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
        g_free(data->sessions[i].room);
        g_free(data->sessions[i].space);
        g_free(data->sessions[i].status);
        g_free(data->sessions[i].model_provider);
        g_free(data->sessions[i].model);
        g_free(data->sessions[i].session_id);
        g_free(data->sessions[i].thinking_level);
        g_free(data->sessions[i].verbose_level);
    }
    g_free(data->sessions);
    g_free(data->path);
    g_free(data->defaults.model);
    g_free(data);
}

GatewaySessionsData* gateway_data_parse_sessions(JsonNode *payload) {
    if (!payload || !JSON_NODE_HOLDS_OBJECT(payload)) return NULL;
    JsonObject *root = json_node_get_object(payload);

    GatewaySessionsData *data = g_new0(GatewaySessionsData, 1);
    data->ts = json_get_int64_or_zero(root, "ts");
    data->path = json_get_string_or_null(root, "path");
    data->count = json_get_int_or_zero(root, "count");

    /* defaults: { model?, contextTokens? } */
    if (json_object_has_member(root, "defaults")) {
        JsonNode *dn = json_object_get_member(root, "defaults");
        if (dn && JSON_NODE_HOLDS_OBJECT(dn)) {
            JsonObject *dobj = json_node_get_object(dn);
            data->defaults.model = json_get_string_or_null(dobj, "model");
            data->defaults.context_tokens = json_get_int_or_zero(dobj, "contextTokens");
        }
    }

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

            GatewaySession *sess = &data->sessions[i];
            sess->key = json_get_string_or_null(obj, "key");
            sess->kind = json_get_string_or_null(obj, "kind");
            sess->display_name = json_get_string_or_null(obj, "displayName");
            sess->channel = json_get_string_or_null(obj, "channel");
            sess->subject = json_get_string_or_null(obj, "subject");
            sess->room = json_get_string_or_null(obj, "room");
            sess->space = json_get_string_or_null(obj, "space");
            sess->status = json_get_string_or_null(obj, "status");
            sess->model_provider = json_get_string_or_null(obj, "modelProvider");
            sess->model = json_get_string_or_null(obj, "model");
            sess->session_id = json_get_string_or_null(obj, "sessionId");
            sess->thinking_level = json_get_string_or_null(obj, "thinkingLevel");
            sess->verbose_level = json_get_string_or_null(obj, "verboseLevel");
            sess->updated_at = json_get_int64_or_zero(obj, "updatedAt");
            sess->input_tokens = json_get_int_or_zero(obj, "inputTokens");
            sess->output_tokens = json_get_int_or_zero(obj, "outputTokens");
            sess->total_tokens = json_get_int_or_zero(obj, "totalTokens");
            sess->context_tokens = json_get_int_or_zero(obj, "contextTokens");
            sess->system_sent = json_get_bool_or_false(obj, "systemSent");
            sess->aborted_last_run = json_get_bool_or_false(obj, "abortedLastRun");
        }
    }

    return data;
}

/* ── Cron ────────────────────────────────────────────────────────── */

static void gateway_cron_job_clear(GatewayCronJob *j) {
    g_free(j->id);
    g_free(j->name);
    g_free(j->description);
    g_free(j->schedule_type);
    g_free(j->schedule_value);
    g_free(j->last_run_status);
    g_free(j->last_error);
    g_free(j->payload_message);
    g_free(j->payload_thinking);
    g_free(j->payload_event);
    g_free(j->session_target);
    g_free(j->wake_mode);
    g_free(j->delivery);
    g_free(j->agent_id);
    g_free(j->transcript_session_key);
}

void gateway_cron_data_free(GatewayCronData *data) {
    if (!data) return;
    for (gint i = 0; i < data->n_jobs; i++)
        gateway_cron_job_clear(&data->jobs[i]);
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

            GatewayCronJob *job = &data->jobs[i];
            job->id = json_get_string_or_null(obj, "id");
            job->name = json_get_string_or_null(obj, "name");
            job->description = json_get_string_or_null(obj, "description");
            job->enabled = json_get_bool_or_false(obj, "enabled");
            job->auto_delete = json_get_bool_or_false(obj, "autoDelete");
            job->created_at_ms = json_get_int64_or_zero(obj, "createdAtMs");
            job->updated_at_ms = json_get_int64_or_zero(obj, "updatedAtMs");
            job->agent_id = json_get_string_or_null(obj, "agentId");
            job->transcript_session_key = json_get_string_or_null(obj, "transcriptSessionKey");

            /* Routing fields are at the job root level, not in payload */
            job->session_target = json_get_string_or_null(obj, "sessionTarget");
            job->wake_mode = json_get_string_or_null(obj, "wakeMode");
            job->delivery = json_get_string_or_null(obj, "delivery");

            /* schedule: { kind, expr } for cron, { kind, everyMs } for every, { kind, at } for at */
            if (json_object_has_member(obj, "schedule")) {
                JsonNode *scn = json_object_get_member(obj, "schedule");
                if (scn && JSON_NODE_HOLDS_OBJECT(scn)) {
                    JsonObject *sch = json_node_get_object(scn);
                    job->schedule_type = json_get_string_or_null(sch, "kind");
                    if (job->schedule_type) {
                        if (g_strcmp0(job->schedule_type, "cron") == 0) {
                            job->schedule_value = json_get_string_or_null(sch, "expr");
                        } else if (g_strcmp0(job->schedule_type, "every") == 0) {
                            gint64 every_ms = json_get_int64_or_zero(sch, "everyMs");
                            if (every_ms > 0) {
                                job->schedule_value = g_strdup_printf("%" G_GINT64_FORMAT, every_ms);
                            }
                        } else if (g_strcmp0(job->schedule_type, "at") == 0) {
                            job->schedule_value = json_get_string_or_null(sch, "at");
                        }
                    }
                }
            }

            /* Nested state object */
            if (json_object_has_member(obj, "state")) {
                JsonNode *sn = json_object_get_member(obj, "state");
                if (sn && JSON_NODE_HOLDS_OBJECT(sn)) {
                    JsonObject *state = json_node_get_object(sn);
                    job->next_run_at_ms = json_get_int64_or_zero(state, "nextRunAtMs");
                    job->last_run_at_ms = json_get_int64_or_zero(state, "lastRunAtMs");
                    job->last_run_status = json_get_string_or_null(state, "lastRunStatus");
                    job->last_error = json_get_string_or_null(state, "lastError");
                    job->last_duration_ms = json_get_int64_or_zero(state, "lastDurationMs");
                }
            }

            /* payload fields */
            if (json_object_has_member(obj, "payload")) {
                JsonNode *pn = json_object_get_member(obj, "payload");
                if (pn && JSON_NODE_HOLDS_OBJECT(pn)) {
                    JsonObject *pay = json_node_get_object(pn);
                    job->payload_message = json_get_string_or_null(pay, "message");
                    job->payload_thinking = json_get_string_or_null(pay, "thinking");
                    job->payload_event = json_get_string_or_null(pay, "event");
                    job->payload_timeout = json_get_int_or_zero(pay, "timeout");
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
        g_free(data->nodes[i].core_version);
        g_free(data->nodes[i].ui_version);
        g_free(data->nodes[i].device_family);
        g_free(data->nodes[i].model_identifier);
        g_free(data->nodes[i].remote_ip);
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
            data->nodes[i].core_version = json_get_string_or_null(obj, "coreVersion");
            data->nodes[i].ui_version = json_get_string_or_null(obj, "uiVersion");
            data->nodes[i].device_family = json_get_string_or_null(obj, "deviceFamily");
            data->nodes[i].model_identifier = json_get_string_or_null(obj, "modelIdentifier");
            data->nodes[i].remote_ip = json_get_string_or_null(obj, "remoteIp");
            data->nodes[i].paired = json_get_bool_or_false(obj, "paired");
            data->nodes[i].connected = json_get_bool_or_false(obj, "connected");
            data->nodes[i].connected_at_ms = json_get_int64_or_zero(obj, "connectedAtMs");
            data->nodes[i].approved_at_ms = json_get_int64_or_zero(obj, "approvedAtMs");
        }
    }

    return data;
}

/* ── Cron Status ─────────────────────────────────────────────────── */

void gateway_cron_status_free(GatewayCronStatus *data) {
    if (!data) return;
    g_free(data->store_path);
    g_free(data);
}

GatewayCronStatus* gateway_data_parse_cron_status(JsonNode *payload) {
    if (!payload || !JSON_NODE_HOLDS_OBJECT(payload)) return NULL;
    JsonObject *root = json_node_get_object(payload);
    GatewayCronStatus *data = g_new0(GatewayCronStatus, 1);
    data->enabled = json_get_bool_or_false(root, "enabled");
    data->store_path = json_get_string_or_null(root, "storePath");
    data->next_wake_at_ms = json_get_int64_or_zero(root, "nextWakeAtMs");
    return data;
}

/* ── Cron Runs ───────────────────────────────────────────────────── */

void gateway_cron_runs_data_free(GatewayCronRunsData *data) {
    if (!data) return;
    for (gint i = 0; i < data->n_entries; i++) {
        g_free(data->entries[i].id);
        g_free(data->entries[i].job_id);
        g_free(data->entries[i].status);
        g_free(data->entries[i].summary);
        g_free(data->entries[i].error);
    }
    g_free(data->entries);
    g_free(data);
}

GatewayCronRunsData* gateway_data_parse_cron_runs(JsonNode *payload) {
    if (!payload || !JSON_NODE_HOLDS_OBJECT(payload)) return NULL;
    JsonObject *root = json_node_get_object(payload);
    GatewayCronRunsData *data = g_new0(GatewayCronRunsData, 1);
    data->total = json_get_int_or_zero(root, "total");
    data->offset = json_get_int_or_zero(root, "offset");
    data->limit = json_get_int_or_zero(root, "limit");
    data->has_more = json_get_bool_or_false(root, "hasMore");

    JsonArray *arr = NULL;
    if (json_object_has_member(root, "entries")) {
        JsonNode *n = json_object_get_member(root, "entries");
        if (n && JSON_NODE_HOLDS_ARRAY(n))
            arr = json_node_get_array(n);
    }
    if (arr) {
        guint len = json_array_get_length(arr);
        data->n_entries = (gint)len;
        data->entries = g_new0(GatewayCronRunEntry, len);
        for (guint i = 0; i < len; i++) {
            JsonNode *elem = json_array_get_element(arr, i);
            if (!elem || !JSON_NODE_HOLDS_OBJECT(elem)) continue;
            JsonObject *obj = json_node_get_object(elem);
            data->entries[i].id = json_get_string_or_null(obj, "id");
            data->entries[i].job_id = json_get_string_or_null(obj, "jobId");
            data->entries[i].status = json_get_string_or_null(obj, "status");
            data->entries[i].timestamp_ms = json_get_int64_or_zero(obj, "timestampMs");
            data->entries[i].duration_ms = json_get_int64_or_zero(obj, "durationMs");
            data->entries[i].summary = json_get_string_or_null(obj, "summary");
            data->entries[i].error = json_get_string_or_null(obj, "error");
        }
    }
    return data;
}

/* ── Node Pairing ────────────────────────────────────────────────── */

void gateway_pairing_list_free(GatewayPairingList *data) {
    if (!data) return;
    for (gint i = 0; i < data->n_pending; i++) {
        g_free(data->pending[i].request_id);
        g_free(data->pending[i].node_id);
        g_free(data->pending[i].display_name);
        g_free(data->pending[i].platform);
        g_free(data->pending[i].version);
        g_free(data->pending[i].remote_ip);
    }
    g_free(data->pending);
    for (gint i = 0; i < data->n_paired; i++) {
        g_free(data->paired[i].node_id);
        g_free(data->paired[i].display_name);
        g_free(data->paired[i].platform);
        g_free(data->paired[i].version);
        g_free(data->paired[i].remote_ip);
    }
    g_free(data->paired);
    g_free(data);
}

GatewayPairingList* gateway_data_parse_pairing_list(JsonNode *payload) {
    if (!payload || !JSON_NODE_HOLDS_OBJECT(payload)) return NULL;
    JsonObject *root = json_node_get_object(payload);
    GatewayPairingList *data = g_new0(GatewayPairingList, 1);

    /* pending: [{ requestId, nodeId, displayName?, platform?, version?, remoteIp?, isRepair?, ts }] */
    if (json_object_has_member(root, "pending")) {
        JsonNode *pn = json_object_get_member(root, "pending");
        if (pn && JSON_NODE_HOLDS_ARRAY(pn)) {
            JsonArray *arr = json_node_get_array(pn);
            guint len = json_array_get_length(arr);
            data->n_pending = (gint)len;
            data->pending = g_new0(GatewayPendingPairRequest, len);
            for (guint i = 0; i < len; i++) {
                JsonNode *elem = json_array_get_element(arr, i);
                if (!elem || !JSON_NODE_HOLDS_OBJECT(elem)) continue;
                JsonObject *obj = json_node_get_object(elem);
                data->pending[i].request_id = json_get_string_or_null(obj, "requestId");
                data->pending[i].node_id = json_get_string_or_null(obj, "nodeId");
                data->pending[i].display_name = json_get_string_or_null(obj, "displayName");
                data->pending[i].platform = json_get_string_or_null(obj, "platform");
                data->pending[i].version = json_get_string_or_null(obj, "version");
                data->pending[i].remote_ip = json_get_string_or_null(obj, "remoteIp");
                data->pending[i].is_repair = json_get_bool_or_false(obj, "isRepair");
                data->pending[i].ts = json_get_double_or_zero(obj, "ts");
            }
        }
    }

    /* paired: [{ nodeId, displayName?, platform?, version?, remoteIp?, approvedAtMs? }] */
    if (json_object_has_member(root, "paired")) {
        JsonNode *pn = json_object_get_member(root, "paired");
        if (pn && JSON_NODE_HOLDS_ARRAY(pn)) {
            JsonArray *arr = json_node_get_array(pn);
            guint len = json_array_get_length(arr);
            data->n_paired = (gint)len;
            data->paired = g_new0(GatewayPairedNode, len);
            for (guint i = 0; i < len; i++) {
                JsonNode *elem = json_array_get_element(arr, i);
                if (!elem || !JSON_NODE_HOLDS_OBJECT(elem)) continue;
                JsonObject *obj = json_node_get_object(elem);
                data->paired[i].node_id = json_get_string_or_null(obj, "nodeId");
                data->paired[i].display_name = json_get_string_or_null(obj, "displayName");
                data->paired[i].platform = json_get_string_or_null(obj, "platform");
                data->paired[i].version = json_get_string_or_null(obj, "version");
                data->paired[i].remote_ip = json_get_string_or_null(obj, "remoteIp");
                data->paired[i].approved_at_ms = json_get_double_or_zero(obj, "approvedAtMs");
            }
        }
    }

    return data;
}

/* ── Config Get ──────────────────────────────────────────────────── */

void gateway_config_snapshot_free(GatewayConfigSnapshot *data) {
    if (!data) return;
    g_free(data->path);
    g_free(data->hash);
    if (data->config)
        json_object_unref(data->config);
    g_strfreev(data->issues);
    g_free(data);
}

GatewayConfigSnapshot* gateway_data_parse_config_get(JsonNode *payload) {
    if (!payload || !JSON_NODE_HOLDS_OBJECT(payload)) return NULL;
    JsonObject *root = json_node_get_object(payload);
    GatewayConfigSnapshot *data = g_new0(GatewayConfigSnapshot, 1);
    data->path = json_get_string_or_null(root, "path");
    data->hash = json_get_string_or_null(root, "hash");
    data->exists = json_get_bool_or_false(root, "exists");
    data->valid = json_get_bool_or_false(root, "valid");

    if (json_object_has_member(root, "config")) {
        JsonNode *cn = json_object_get_member(root, "config");
        if (cn && JSON_NODE_HOLDS_OBJECT(cn))
            data->config = json_object_ref(json_node_get_object(cn));
    }

    data->issues = json_get_string_array(root, "issues", &data->n_issues);
    return data;
}

/* ── Config Schema ───────────────────────────────────────────────── */

void gateway_config_schema_free(GatewayConfigSchema *data) {
    if (!data) return;
    if (data->schema)
        json_object_unref(data->schema);
    if (data->ui_hints)
        json_object_unref(data->ui_hints);
    g_free(data);
}

GatewayConfigSchema* gateway_data_parse_config_schema(JsonNode *payload) {
    if (!payload || !JSON_NODE_HOLDS_OBJECT(payload)) return NULL;
    JsonObject *root = json_node_get_object(payload);
    GatewayConfigSchema *data = g_new0(GatewayConfigSchema, 1);

    if (json_object_has_member(root, "schema")) {
        JsonNode *sn = json_object_get_member(root, "schema");
        if (sn && JSON_NODE_HOLDS_OBJECT(sn))
            data->schema = json_object_ref(json_node_get_object(sn));
    }

    if (json_object_has_member(root, "uiHints")) {
        JsonNode *hn = json_object_get_member(root, "uiHints");
        if (hn && JSON_NODE_HOLDS_OBJECT(hn))
            data->ui_hints = json_object_ref(json_node_get_object(hn));
    }

    return data;
}
