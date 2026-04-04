/*
 * test_gateway_data.c
 *
 * Unit tests for the gateway data adapter layer (gateway_data.h).
 * Verifies JSON→struct parsing for all five RPC response shapes
 * against the verified gateway contracts.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "../src/gateway_data.h"
#include <json-glib/json-glib.h>
#include <string.h>

static int tests_run = 0;
static int tests_passed = 0;

#define ASSERT(cond, msg) do { \
    tests_run++; \
    if (!(cond)) { \
        g_printerr("FAIL [%s:%d]: %s\n", __FILE__, __LINE__, msg); \
    } else { \
        tests_passed++; \
    } \
} while(0)

static JsonNode* parse_json(const gchar *json_str) {
    JsonParser *parser = json_parser_new();
    GError *error = NULL;
    json_parser_load_from_data(parser, json_str, -1, &error);
    if (error) {
        g_printerr("JSON parse error: %s\n", error->message);
        g_error_free(error);
        g_object_unref(parser);
        return NULL;
    }
    JsonNode *root = json_node_copy(json_parser_get_root(parser));
    g_object_unref(parser);
    return root;
}

/* ── Channels tests ──────────────────────────────────────────────── */

static void test_channels_parse_basic(void) {
    const gchar *json =
        "{"
        "  \"ts\": 1700000000000,"
        "  \"channelOrder\": [\"telegram\", \"discord\"],"
        "  \"channelLabels\": { \"telegram\": \"Telegram\", \"discord\": \"Discord\" },"
        "  \"channelDetailLabels\": { \"telegram\": \"Telegram Bot\" },"
        "  \"channelDefaultAccountId\": { \"telegram\": \"bot-123\" },"
        "  \"channels\": { \"telegram\": { \"connected\": true }, \"discord\": { \"connected\": false } },"
        "  \"channelAccounts\": { \"telegram\": [{}, {}], \"discord\": [{}] }"
        "}";

    JsonNode *node = parse_json(json);
    ASSERT(node != NULL, "channels json parsed");

    GatewayChannelsData *data = gateway_data_parse_channels(node);
    ASSERT(data != NULL, "channels data parsed");
    ASSERT(data->ts == 1700000000000, "channels ts");
    ASSERT(data->n_channels == 2, "channels count");
    ASSERT(data->n_channel_order == 2, "channel_order count");

    ASSERT(g_strcmp0(data->channels[0].channel_id, "telegram") == 0, "ch[0] id");
    ASSERT(g_strcmp0(data->channels[0].label, "Telegram") == 0, "ch[0] label");
    ASSERT(g_strcmp0(data->channels[0].detail_label, "Telegram Bot") == 0, "ch[0] detail_label");
    ASSERT(g_strcmp0(data->channels[0].default_account_id, "bot-123") == 0, "ch[0] default_account_id");
    ASSERT(data->channels[0].connected == TRUE, "ch[0] connected");
    ASSERT(data->channels[0].account_count == 2, "ch[0] account_count");

    ASSERT(g_strcmp0(data->channels[1].channel_id, "discord") == 0, "ch[1] id");
    ASSERT(g_strcmp0(data->channels[1].label, "Discord") == 0, "ch[1] label");
    ASSERT(data->channels[1].detail_label == NULL, "ch[1] detail_label null");
    ASSERT(data->channels[1].connected == FALSE, "ch[1] connected");
    ASSERT(data->channels[1].account_count == 1, "ch[1] account_count");

    gateway_channels_data_free(data);
    json_node_unref(node);
}

static void test_channels_parse_empty(void) {
    JsonNode *node = parse_json("{}");
    GatewayChannelsData *data = gateway_data_parse_channels(node);
    ASSERT(data != NULL, "empty channels data parsed");
    ASSERT(data->n_channels == 0, "empty channels count");
    ASSERT(data->channel_order == NULL, "empty channel_order null");
    gateway_channels_data_free(data);
    json_node_unref(node);
}

static void test_channels_parse_null(void) {
    GatewayChannelsData *data = gateway_data_parse_channels(NULL);
    ASSERT(data == NULL, "null channels returns null");
}

/* ── Skills tests ────────────────────────────────────────────────── */

static void test_skills_parse_basic(void) {
    const gchar *json =
        "{"
        "  \"workspaceDir\": \"/home/user/.openclaw/agent\","
        "  \"managedSkillsDir\": \"/home/user/.openclaw/skills\","
        "  \"skills\": ["
        "    {"
        "      \"name\": \"Web Search\","
        "      \"description\": \"Search the web\","
        "      \"source\": \"bundled\","
        "      \"key\": \"web-search\","
        "      \"primaryEnv\": \"SERP_API_KEY\","
        "      \"emoji\": \"🔍\","
        "      \"homepage\": \"https://example.com\","
        "      \"enabled\": true,"
        "      \"disabled\": false,"
        "      \"installed\": true,"
        "      \"managed\": false,"
        "      \"bundled\": true,"
        "      \"hasUpdate\": false,"
        "      \"eligible\": true,"
        "      \"always\": true,"
        "      \"requirements\": { \"bins\": [\"curl\"], \"env\": [\"SERP_API_KEY\"], \"config\": [\"skills.web-search.enabled\"] },"
        "      \"missing\": { \"env\": [\"SERP_API_KEY\"] },"
        "      \"configChecks\": ["
        "        { \"path\": \"skills.web-search.enabled\", \"value\": true, \"satisfied\": true },"
        "        { \"path\": \"skills.web-search.apiKey\", \"satisfied\": false }"
        "      ],"
        "      \"install\": ["
        "        { \"id\": \"npm\", \"kind\": \"npm\", \"label\": \"Install via npm\", \"bins\": [\"npm\"] }"
        "      ]"
        "    },"
        "    {"
        "      \"name\": \"Code Runner\","
        "      \"description\": \"Run code\","
        "      \"source\": \"managed\","
        "      \"key\": \"code-runner\","
        "      \"enabled\": false,"
        "      \"disabled\": true,"
        "      \"installed\": true,"
        "      \"managed\": true,"
        "      \"bundled\": false,"
        "      \"hasUpdate\": true,"
        "      \"eligible\": false"
        "    }"
        "  ]"
        "}";

    JsonNode *node = parse_json(json);
    GatewaySkillsData *data = gateway_data_parse_skills(node);
    ASSERT(data != NULL, "skills data parsed");
    ASSERT(g_strcmp0(data->workspace_dir, "/home/user/.openclaw/agent") == 0, "workspace_dir");
    ASSERT(data->n_skills == 2, "skills count");

    ASSERT(g_strcmp0(data->skills[0].name, "Web Search") == 0, "skill[0] name");
    ASSERT(data->skills[0].enabled == TRUE, "skill[0] enabled");
    ASSERT(data->skills[0].bundled == TRUE, "skill[0] bundled");
    ASSERT(data->skills[0].has_update == FALSE, "skill[0] has_update");
    ASSERT(data->skills[0].always == TRUE, "skill[0] always");
    ASSERT(g_strcmp0(data->skills[0].primary_env, "SERP_API_KEY") == 0, "skill[0] primaryEnv");
    ASSERT(g_strcmp0(data->skills[0].emoji, "\xf0\x9f\x94\x8d") == 0, "skill[0] emoji");
    ASSERT(g_strcmp0(data->skills[0].homepage, "https://example.com") == 0, "skill[0] homepage");
    /* requirements */
    ASSERT(data->skills[0].n_req_bins == 1, "skill[0] req_bins count");
    ASSERT(g_strcmp0(data->skills[0].req_bins[0], "curl") == 0, "skill[0] req_bins[0]");
    ASSERT(data->skills[0].n_req_env == 1, "skill[0] req_env count");
    ASSERT(data->skills[0].n_req_config == 1, "skill[0] req_config count");
    /* missing */
    ASSERT(data->skills[0].n_missing_env == 1, "skill[0] missing_env count");
    ASSERT(g_strcmp0(data->skills[0].missing_env[0], "SERP_API_KEY") == 0, "skill[0] missing_env[0]");
    ASSERT(data->skills[0].missing_bins == NULL, "skill[0] missing_bins null");
    /* configChecks */
    ASSERT(data->skills[0].n_config_checks == 2, "skill[0] config_checks count");
    ASSERT(g_strcmp0(data->skills[0].config_checks[0].path, "skills.web-search.enabled") == 0, "cc[0] path");
    ASSERT(data->skills[0].config_checks[0].satisfied == TRUE, "cc[0] satisfied");
    ASSERT(g_strcmp0(data->skills[0].config_checks[0].value_str, "true") == 0, "cc[0] value_str");
    ASSERT(data->skills[0].config_checks[1].satisfied == FALSE, "cc[1] satisfied");
    ASSERT(data->skills[0].config_checks[1].value_str == NULL, "cc[1] value_str null");
    /* install */
    ASSERT(data->skills[0].n_install_options == 1, "skill[0] install count");
    ASSERT(g_strcmp0(data->skills[0].install_options[0].id, "npm") == 0, "install[0] id");
    ASSERT(g_strcmp0(data->skills[0].install_options[0].kind, "npm") == 0, "install[0] kind");
    ASSERT(data->skills[0].install_options[0].n_bins == 1, "install[0] bins count");

    ASSERT(g_strcmp0(data->skills[1].name, "Code Runner") == 0, "skill[1] name");
    ASSERT(data->skills[1].disabled == TRUE, "skill[1] disabled");
    ASSERT(data->skills[1].has_update == TRUE, "skill[1] has_update");
    ASSERT(data->skills[1].eligible == FALSE, "skill[1] eligible");
    ASSERT(data->skills[1].n_config_checks == 0, "skill[1] no config_checks");
    ASSERT(data->skills[1].n_install_options == 0, "skill[1] no install");

    gateway_skills_data_free(data);
    json_node_unref(node);
}

static void test_skills_parse_empty(void) {
    JsonNode *node = parse_json("{\"skills\": []}");
    GatewaySkillsData *data = gateway_data_parse_skills(node);
    ASSERT(data != NULL, "empty skills parsed");
    ASSERT(data->n_skills == 0, "empty skills count");
    gateway_skills_data_free(data);
    json_node_unref(node);
}

/* ── Sessions tests ──────────────────────────────────────────────── */

static void test_sessions_parse_basic(void) {
    const gchar *json =
        "{"
        "  \"ts\": 1700000001000,"
        "  \"path\": \"/tmp/sessions\","
        "  \"count\": 2,"
        "  \"defaults\": { \"modelProvider\": \"openai\", \"model\": \"gpt-4\", \"contextTokens\": 8192 },"
        "  \"sessions\": ["
        "    {"
        "      \"key\": \"main\","
        "      \"kind\": \"direct\","
        "      \"displayName\": \"Main Session\","
        "      \"channel\": \"telegram\","
        "      \"subject\": \"user@example.com\","
        "      \"room\": \"room-1\","
        "      \"space\": \"space-A\","
        "      \"status\": \"running\","
        "      \"modelProvider\": \"openai\","
        "      \"model\": \"gpt-4o\","
        "      \"sessionId\": \"sid-42\","
        "      \"thinkingLevel\": \"medium\","
        "      \"verboseLevel\": \"high\","
        "      \"updatedAt\": 1700000000500,"
        "      \"inputTokens\": 100,"
        "      \"outputTokens\": 200,"
        "      \"totalTokens\": 300,"
        "      \"contextTokens\": 8192,"
        "      \"systemSent\": true,"
        "      \"abortedLastRun\": false"
        "    },"
        "    {"
        "      \"key\": \"agent:sub-1:task-abc\","
        "      \"kind\": \"group\","
        "      \"updatedAt\": 1700000000100"
        "    }"
        "  ]"
        "}";

    JsonNode *node = parse_json(json);
    GatewaySessionsData *data = gateway_data_parse_sessions(node);
    ASSERT(data != NULL, "sessions data parsed");
    ASSERT(data->ts == 1700000001000, "sessions ts");
    ASSERT(g_strcmp0(data->path, "/tmp/sessions") == 0, "sessions path");
    ASSERT(data->count == 2, "sessions count");
    ASSERT(data->n_sessions == 2, "sessions array count");
    ASSERT(g_strcmp0(data->defaults.model, "gpt-4") == 0, "defaults model");
    ASSERT(data->defaults.context_tokens == 8192, "defaults context_tokens");

    ASSERT(g_strcmp0(data->sessions[0].key, "main") == 0, "session[0] key");
    ASSERT(g_strcmp0(data->sessions[0].kind, "direct") == 0, "session[0] kind");
    ASSERT(g_strcmp0(data->sessions[0].display_name, "Main Session") == 0, "session[0] display_name");
    ASSERT(g_strcmp0(data->sessions[0].channel, "telegram") == 0, "session[0] channel");
    ASSERT(g_strcmp0(data->sessions[0].room, "room-1") == 0, "session[0] room");
    ASSERT(g_strcmp0(data->sessions[0].space, "space-A") == 0, "session[0] space");
    ASSERT(g_strcmp0(data->sessions[0].status, "running") == 0, "session[0] status");
    ASSERT(g_strcmp0(data->sessions[0].session_id, "sid-42") == 0, "session[0] session_id");
    ASSERT(g_strcmp0(data->sessions[0].thinking_level, "medium") == 0, "session[0] thinking_level");
    ASSERT(g_strcmp0(data->sessions[0].verbose_level, "high") == 0, "session[0] verbose_level");
    ASSERT(data->sessions[0].updated_at == 1700000000500, "session[0] updated_at");
    ASSERT(data->sessions[0].input_tokens == 100, "session[0] input_tokens");
    ASSERT(data->sessions[0].output_tokens == 200, "session[0] output_tokens");
    ASSERT(data->sessions[0].total_tokens == 300, "session[0] total_tokens");
    ASSERT(data->sessions[0].context_tokens == 8192, "session[0] context_tokens");
    ASSERT(data->sessions[0].system_sent == TRUE, "session[0] system_sent");
    ASSERT(data->sessions[0].aborted_last_run == FALSE, "session[0] aborted_last_run");

    ASSERT(g_strcmp0(data->sessions[1].key, "agent:sub-1:task-abc") == 0, "session[1] key");
    ASSERT(g_strcmp0(data->sessions[1].kind, "group") == 0, "session[1] kind");
    ASSERT(data->sessions[1].display_name == NULL, "session[1] display_name null");
    ASSERT(data->sessions[1].status == NULL, "session[1] status null");
    ASSERT(data->sessions[1].input_tokens == 0, "session[1] input_tokens default");
    ASSERT(data->sessions[1].system_sent == FALSE, "session[1] system_sent default");

    gateway_sessions_data_free(data);
    json_node_unref(node);
}

/* ── Cron tests ──────────────────────────────────────────────────── */

static void test_cron_parse_basic(void) {
    const gchar *json =
        "{"
        "  \"jobs\": ["
        "    {"
        "      \"id\": \"job-1\","
        "      \"name\": \"Daily Report\","
        "      \"description\": \"Generates daily summary\","
        "      \"enabled\": true,"
        "      \"autoDelete\": false,"
        "      \"createdAtMs\": 1700000000000,"
        "      \"updatedAtMs\": 1700000001000,"
        "      \"agentId\": \"agent-main\","
        "      \"transcriptSessionKey\": \"sess-abc\","
        "      \"sessionTarget\": \"main\","
        "      \"wakeMode\": \"next-heartbeat\","
        "      \"delivery\": \"async\","
        "      \"schedule\": { \"kind\": \"cron\", \"expr\": \"0 9 * * *\" },"
        "      \"state\": {"
        "        \"nextRunAtMs\": 1700100000000,"
        "        \"lastRunAtMs\": 1700000000000,"
        "        \"lastRunStatus\": \"ok\","
        "        \"lastDurationMs\": 1500"
        "      },"
        "      \"payload\": {"
        "        \"message\": \"Generate report\","
        "        \"thinking\": \"deep\","
        "        \"timeout\": 60"
        "      }"
        "    },"
        "    {"
        "      \"id\": \"job-2\","
        "      \"name\": \"Cleanup\","
        "      \"enabled\": false,"
        "      \"autoDelete\": true,"
        "      \"createdAtMs\": 1700000000000,"
        "      \"updatedAtMs\": 1700000002000,"
        "      \"state\": {"
        "        \"lastRunStatus\": \"error\","
        "        \"lastError\": \"timeout exceeded\""
        "      }"
        "    }"
        "  ],"
        "  \"total\": 5,"
        "  \"offset\": 0,"
        "  \"limit\": 2,"
        "  \"hasMore\": true,"
        "  \"nextOffset\": 2"
        "}";

    JsonNode *node = parse_json(json);
    GatewayCronData *data = gateway_data_parse_cron(node);
    ASSERT(data != NULL, "cron data parsed");
    ASSERT(data->n_jobs == 2, "cron jobs count");
    ASSERT(data->total == 5, "cron total");
    ASSERT(data->offset == 0, "cron offset");
    ASSERT(data->limit == 2, "cron limit");
    ASSERT(data->has_more == TRUE, "cron has_more");

    ASSERT(g_strcmp0(data->jobs[0].id, "job-1") == 0, "job[0] id");
    ASSERT(g_strcmp0(data->jobs[0].name, "Daily Report") == 0, "job[0] name");
    ASSERT(data->jobs[0].enabled == TRUE, "job[0] enabled");
    ASSERT(data->jobs[0].auto_delete == FALSE, "job[0] auto_delete");
    ASSERT(g_strcmp0(data->jobs[0].agent_id, "agent-main") == 0, "job[0] agent_id");
    ASSERT(g_strcmp0(data->jobs[0].transcript_session_key, "sess-abc") == 0, "job[0] transcript_session_key");
    /* Routing fields now at root level, not in payload */
    ASSERT(g_strcmp0(data->jobs[0].session_target, "main") == 0, "job[0] session_target from root");
    ASSERT(g_strcmp0(data->jobs[0].wake_mode, "next-heartbeat") == 0, "job[0] wake_mode from root");
    ASSERT(g_strcmp0(data->jobs[0].delivery, "async") == 0, "job[0] delivery from root");
    /* New schedule schema: kind + expr instead of type + value */
    ASSERT(g_strcmp0(data->jobs[0].schedule_type, "cron") == 0, "job[0] schedule_type");
    ASSERT(g_strcmp0(data->jobs[0].schedule_value, "0 9 * * *") == 0, "job[0] schedule_value");
    ASSERT(data->jobs[0].next_run_at_ms == 1700100000000, "job[0] next_run_at_ms");
    ASSERT(g_strcmp0(data->jobs[0].last_run_status, "ok") == 0, "job[0] last_run_status");
    ASSERT(data->jobs[0].last_duration_ms == 1500, "job[0] last_duration_ms");
    ASSERT(g_strcmp0(data->jobs[0].payload_message, "Generate report") == 0, "job[0] payload_message");
    ASSERT(g_strcmp0(data->jobs[0].payload_thinking, "deep") == 0, "job[0] payload_thinking");
    ASSERT(data->jobs[0].payload_timeout == 60, "job[0] payload_timeout");

    ASSERT(g_strcmp0(data->jobs[1].id, "job-2") == 0, "job[1] id");
    ASSERT(data->jobs[1].enabled == FALSE, "job[1] enabled");
    ASSERT(data->jobs[1].auto_delete == TRUE, "job[1] auto_delete");
    ASSERT(g_strcmp0(data->jobs[1].last_run_status, "error") == 0, "job[1] last_run_status");
    ASSERT(g_strcmp0(data->jobs[1].last_error, "timeout exceeded") == 0, "job[1] last_error");
    ASSERT(data->jobs[1].schedule_type == NULL, "job[1] no schedule_type");
    ASSERT(data->jobs[1].payload_message == NULL, "job[1] no payload_message");

    gateway_cron_data_free(data);
    json_node_unref(node);
}

static void test_cron_parse_schedule_kind_every(void) {
    /* Every schedule with kind=every and everyMs */
    const gchar *json =
        "{"
        "  \"jobs\": ["
        "    {"
        "      \"id\": \"job-every\","
        "      \"name\": \"Every Job\","
        "      \"enabled\": true,"
        "      \"schedule\": { \"kind\": \"every\", \"everyMs\": 60000 }"
        "    }"
        "  ]"
        "}";

    JsonNode *node = parse_json(json);
    GatewayCronData *data = gateway_data_parse_cron(node);
    ASSERT(data != NULL, "cron_every: parsed");
    ASSERT(data->n_jobs == 1, "cron_every: 1 job");
    ASSERT(g_strcmp0(data->jobs[0].schedule_type, "every") == 0, "cron_every: schedule_type");
    ASSERT(g_strcmp0(data->jobs[0].schedule_value, "60000") == 0, "cron_every: schedule_value");
    gateway_cron_data_free(data);
    json_node_unref(node);
}

static void test_cron_parse_schedule_kind_at(void) {
    /* At schedule with kind=at and at timestamp */
    const gchar *json =
        "{"
        "  \"jobs\": ["
        "    {"
        "      \"id\": \"job-at\","
        "      \"name\": \"At Job\","
        "      \"enabled\": true,"
        "      \"schedule\": { \"kind\": \"at\", \"at\": \"2025-04-03T10:00:00Z\" }"
        "    }"
        "  ]"
        "}";

    JsonNode *node = parse_json(json);
    GatewayCronData *data = gateway_data_parse_cron(node);
    ASSERT(data != NULL, "cron_at: parsed");
    ASSERT(data->n_jobs == 1, "cron_at: 1 job");
    ASSERT(g_strcmp0(data->jobs[0].schedule_type, "at") == 0, "cron_at: schedule_type");
    ASSERT(g_strcmp0(data->jobs[0].schedule_value, "2025-04-03T10:00:00Z") == 0, "cron_at: schedule_value");
    gateway_cron_data_free(data);
    json_node_unref(node);
}

static void test_cron_parse_routing_fields_from_root(void) {
    /* Cron job with sessionTarget, wakeMode, delivery at root level (not in payload) */
    const gchar *json =
        "{"
        "  \"jobs\": ["
        "    {"
        "      \"id\": \"job-1\","
        "      \"name\": \"Test Job\","
        "      \"enabled\": true,"
        "      \"sessionTarget\": \"main\","
        "      \"wakeMode\": \"now\","
        "      \"delivery\": \"async\""
        "    }"
        "  ]"
        "}";

    JsonNode *node = parse_json(json);
    GatewayCronData *data = gateway_data_parse_cron(node);
    ASSERT(data != NULL, "cron_routing: parsed");
    ASSERT(data->n_jobs == 1, "cron_routing: 1 job");
    ASSERT(g_strcmp0(data->jobs[0].session_target, "main") == 0, "cron_routing: session_target");
    ASSERT(g_strcmp0(data->jobs[0].wake_mode, "now") == 0, "cron_routing: wake_mode");
    ASSERT(g_strcmp0(data->jobs[0].delivery, "async") == 0, "cron_routing: delivery");
    gateway_cron_data_free(data);
    json_node_unref(node);
}

/* ── Nodes tests ─────────────────────────────────────────────────── */

static void test_nodes_parse_basic(void) {
    const gchar *json =
        "{"
        "  \"ts\": 1700000002000,"
        "  \"nodes\": ["
        "    {"
        "      \"nodeId\": \"node-abc\","
        "      \"displayName\": \"iPhone 15\","
        "      \"platform\": \"ios\","
        "      \"version\": \"1.2.0\","
        "      \"coreVersion\": \"2.0.0\","
        "      \"uiVersion\": \"1.5.0\","
        "      \"deviceFamily\": \"iPhone\","
        "      \"modelIdentifier\": \"iPhone16,1\","
        "      \"remoteIp\": \"192.168.1.42\","
        "      \"paired\": true,"
        "      \"connected\": true,"
        "      \"connectedAtMs\": 1700000001500,"
        "      \"approvedAtMs\": 1699999000000"
        "    },"
        "    {"
        "      \"nodeId\": \"node-xyz\","
        "      \"displayName\": \"iPad\","
        "      \"paired\": true,"
        "      \"connected\": false"
        "    }"
        "  ]"
        "}";

    JsonNode *node = parse_json(json);
    GatewayNodesData *data = gateway_data_parse_nodes(node);
    ASSERT(data != NULL, "nodes data parsed");
    ASSERT(data->ts == 1700000002000, "nodes ts");
    ASSERT(data->n_nodes == 2, "nodes count");

    ASSERT(g_strcmp0(data->nodes[0].node_id, "node-abc") == 0, "node[0] id");
    ASSERT(g_strcmp0(data->nodes[0].display_name, "iPhone 15") == 0, "node[0] display_name");
    ASSERT(g_strcmp0(data->nodes[0].platform, "ios") == 0, "node[0] platform");
    ASSERT(g_strcmp0(data->nodes[0].core_version, "2.0.0") == 0, "node[0] core_version");
    ASSERT(g_strcmp0(data->nodes[0].ui_version, "1.5.0") == 0, "node[0] ui_version");
    ASSERT(g_strcmp0(data->nodes[0].model_identifier, "iPhone16,1") == 0, "node[0] model_identifier");
    ASSERT(g_strcmp0(data->nodes[0].remote_ip, "192.168.1.42") == 0, "node[0] remote_ip");
    ASSERT(data->nodes[0].connected == TRUE, "node[0] connected");
    ASSERT(data->nodes[0].connected_at_ms == 1700000001500, "node[0] connected_at_ms");

    ASSERT(g_strcmp0(data->nodes[1].node_id, "node-xyz") == 0, "node[1] id");
    ASSERT(data->nodes[1].connected == FALSE, "node[1] connected");
    ASSERT(data->nodes[1].platform == NULL, "node[1] platform null");
    ASSERT(data->nodes[1].core_version == NULL, "node[1] core_version null");
    ASSERT(data->nodes[1].remote_ip == NULL, "node[1] remote_ip null");

    gateway_nodes_data_free(data);
    json_node_unref(node);
}

static void test_nodes_parse_empty(void) {
    JsonNode *node = parse_json("{\"ts\": 0, \"nodes\": []}");
    GatewayNodesData *data = gateway_data_parse_nodes(node);
    ASSERT(data != NULL, "empty nodes parsed");
    ASSERT(data->n_nodes == 0, "empty nodes count");
    gateway_nodes_data_free(data);
    json_node_unref(node);
}

/* ══════════════════════════════════════════════════════════════════
 * Negative / malformed / partial / wrong-type tests
 * ══════════════════════════════════════════════════════════════════ */

/* ── Channels negative ───────────────────────────────────────────── */

static void test_channels_wrong_type_channel_order(void) {
    /* channelOrder is string instead of array */
    JsonNode *node = parse_json(
        "{\"channelOrder\": \"not-an-array\", \"channels\": {}}");
    GatewayChannelsData *data = gateway_data_parse_channels(node);
    ASSERT(data != NULL, "ch_wrong_type: parsed without crash");
    ASSERT(data->n_channel_order == 0, "ch_wrong_type: no channel_order");
    ASSERT(data->n_channels == 0, "ch_wrong_type: no channels");
    gateway_channels_data_free(data);
    json_node_unref(node);
}

static void test_channels_labels_wrong_type(void) {
    /* channelLabels is array instead of object */
    JsonNode *node = parse_json(
        "{\"channelOrder\": [\"x\"], \"channelLabels\": [1,2]}");
    GatewayChannelsData *data = gateway_data_parse_channels(node);
    ASSERT(data != NULL, "ch_labels_wrong: parsed");
    ASSERT(data->n_channels == 1, "ch_labels_wrong: 1 channel");
    ASSERT(data->channels[0].label == NULL, "ch_labels_wrong: label is NULL");
    gateway_channels_data_free(data);
    json_node_unref(node);
}

static void test_channels_accounts_not_array(void) {
    /* channelAccounts["x"] is string instead of array */
    JsonNode *node = parse_json(
        "{\"channelOrder\": [\"x\"], \"channelAccounts\": {\"x\": \"bad\"}}");
    GatewayChannelsData *data = gateway_data_parse_channels(node);
    ASSERT(data != NULL, "ch_acct_bad: parsed");
    ASSERT(data->channels[0].account_count == 0, "ch_acct_bad: account_count 0");
    gateway_channels_data_free(data);
    json_node_unref(node);
}

static void test_channels_non_object_payload(void) {
    /* Payload is an array, not an object */
    JsonNode *node = parse_json("[1, 2, 3]");
    GatewayChannelsData *data = gateway_data_parse_channels(node);
    ASSERT(data == NULL, "ch_array_payload: returns NULL");
    json_node_unref(node);
}

/* ── Skills negative ─────────────────────────────────────────────── */

static void test_skills_missing_array(void) {
    /* No "skills" key at all */
    JsonNode *node = parse_json("{\"workspaceDir\": \"/tmp\"}");
    GatewaySkillsData *data = gateway_data_parse_skills(node);
    ASSERT(data != NULL, "sk_no_arr: parsed");
    ASSERT(data->n_skills == 0, "sk_no_arr: 0 skills");
    ASSERT(g_strcmp0(data->workspace_dir, "/tmp") == 0, "sk_no_arr: workspace_dir");
    gateway_skills_data_free(data);
    json_node_unref(node);
}

static void test_skills_array_wrong_type(void) {
    /* "skills" is a string, not an array */
    JsonNode *node = parse_json("{\"skills\": \"nope\"}");
    GatewaySkillsData *data = gateway_data_parse_skills(node);
    ASSERT(data != NULL, "sk_wrong_type: parsed");
    ASSERT(data->n_skills == 0, "sk_wrong_type: 0 skills");
    gateway_skills_data_free(data);
    json_node_unref(node);
}

static void test_skills_mixed_valid_invalid(void) {
    /* One valid skill, one non-object element (number) */
    const gchar *json =
        "{\"skills\": ["
        "  {\"name\": \"Good\", \"enabled\": true},"
        "  42,"
        "  {\"name\": \"Also Good\", \"enabled\": false}"
        "]}";
    JsonNode *node = parse_json(json);
    GatewaySkillsData *data = gateway_data_parse_skills(node);
    ASSERT(data != NULL, "sk_mixed: parsed");
    ASSERT(data->n_skills == 3, "sk_mixed: array len 3");
    ASSERT(g_strcmp0(data->skills[0].name, "Good") == 0, "sk_mixed: skill[0] ok");
    /* skills[1] was non-object → skipped by continue, fields stay zeroed */
    ASSERT(data->skills[1].name == NULL, "sk_mixed: skill[1] zeroed");
    ASSERT(g_strcmp0(data->skills[2].name, "Also Good") == 0, "sk_mixed: skill[2] ok");
    gateway_skills_data_free(data);
    json_node_unref(node);
}

static void test_skills_partial_fields(void) {
    /* Skill with only name, all booleans default to false */
    JsonNode *node = parse_json("{\"skills\": [{\"name\": \"Minimal\"}]}");
    GatewaySkillsData *data = gateway_data_parse_skills(node);
    ASSERT(data != NULL, "sk_partial: parsed");
    ASSERT(g_strcmp0(data->skills[0].name, "Minimal") == 0, "sk_partial: name");
    ASSERT(data->skills[0].enabled == FALSE, "sk_partial: enabled default");
    ASSERT(data->skills[0].disabled == FALSE, "sk_partial: disabled default");
    ASSERT(data->skills[0].installed == FALSE, "sk_partial: installed default");
    ASSERT(data->skills[0].has_update == FALSE, "sk_partial: has_update default");
    ASSERT(data->skills[0].key == NULL, "sk_partial: key NULL");
    ASSERT(data->skills[0].description == NULL, "sk_partial: description NULL");
    gateway_skills_data_free(data);
    json_node_unref(node);
}

static void test_skills_wrong_type_booleans(void) {
    /* Boolean fields are strings instead of booleans */
    JsonNode *node = parse_json(
        "{\"skills\": [{\"name\": \"X\", \"enabled\": \"yes\", \"disabled\": 1}]}");
    GatewaySkillsData *data = gateway_data_parse_skills(node);
    ASSERT(data != NULL, "sk_bool_wrong: parsed");
    ASSERT(data->skills[0].enabled == FALSE, "sk_bool_wrong: string not bool");
    ASSERT(data->skills[0].disabled == FALSE, "sk_bool_wrong: int not bool");
    gateway_skills_data_free(data);
    json_node_unref(node);
}

static void test_skills_null_input(void) {
    GatewaySkillsData *data = gateway_data_parse_skills(NULL);
    ASSERT(data == NULL, "sk_null: returns NULL");
}

/* ── Sessions negative ───────────────────────────────────────────── */

static void test_sessions_missing_array(void) {
    JsonNode *node = parse_json("{\"ts\": 100, \"count\": 0}");
    GatewaySessionsData *data = gateway_data_parse_sessions(node);
    ASSERT(data != NULL, "sess_no_arr: parsed");
    ASSERT(data->n_sessions == 0, "sess_no_arr: 0 sessions");
    ASSERT(data->ts == 100, "sess_no_arr: ts preserved");
    gateway_sessions_data_free(data);
    json_node_unref(node);
}

static void test_sessions_array_wrong_type(void) {
    JsonNode *node = parse_json("{\"sessions\": \"nope\"}");
    GatewaySessionsData *data = gateway_data_parse_sessions(node);
    ASSERT(data != NULL, "sess_wrong_type: parsed");
    ASSERT(data->n_sessions == 0, "sess_wrong_type: 0 sessions");
    gateway_sessions_data_free(data);
    json_node_unref(node);
}

static void test_sessions_partial_item(void) {
    /* Session with only key and kind, all optional fields NULL */
    JsonNode *node = parse_json(
        "{\"sessions\": [{\"key\": \"s1\", \"kind\": \"direct\"}]}");
    GatewaySessionsData *data = gateway_data_parse_sessions(node);
    ASSERT(data != NULL, "sess_partial: parsed");
    ASSERT(data->n_sessions == 1, "sess_partial: 1 session");
    ASSERT(g_strcmp0(data->sessions[0].key, "s1") == 0, "sess_partial: key");
    ASSERT(data->sessions[0].display_name == NULL, "sess_partial: display_name NULL");
    ASSERT(data->sessions[0].channel == NULL, "sess_partial: channel NULL");
    ASSERT(data->sessions[0].status == NULL, "sess_partial: status NULL");
    ASSERT(data->sessions[0].model == NULL, "sess_partial: model NULL");
    ASSERT(data->sessions[0].updated_at == 0, "sess_partial: updated_at 0");
    gateway_sessions_data_free(data);
    json_node_unref(node);
}

static void test_sessions_mixed_valid_invalid(void) {
    /* One valid, one non-object (string), one valid */
    const gchar *json =
        "{\"sessions\": ["
        "  {\"key\": \"a\", \"kind\": \"direct\"},"
        "  \"garbage\","
        "  {\"key\": \"b\", \"kind\": \"group\"}"
        "]}";
    JsonNode *node = parse_json(json);
    GatewaySessionsData *data = gateway_data_parse_sessions(node);
    ASSERT(data != NULL, "sess_mixed: parsed");
    ASSERT(data->n_sessions == 3, "sess_mixed: array len 3");
    ASSERT(g_strcmp0(data->sessions[0].key, "a") == 0, "sess_mixed: [0] ok");
    ASSERT(data->sessions[1].key == NULL, "sess_mixed: [1] zeroed");
    ASSERT(g_strcmp0(data->sessions[2].key, "b") == 0, "sess_mixed: [2] ok");
    gateway_sessions_data_free(data);
    json_node_unref(node);
}

static void test_sessions_wrong_type_fields(void) {
    /* updatedAt is string, key is number */
    JsonNode *node = parse_json(
        "{\"sessions\": [{\"key\": 12345, \"updatedAt\": \"not-a-number\"}]}");
    GatewaySessionsData *data = gateway_data_parse_sessions(node);
    ASSERT(data != NULL, "sess_wrong_fields: parsed");
    ASSERT(data->sessions[0].key == NULL, "sess_wrong_fields: int key → NULL");
    ASSERT(data->sessions[0].updated_at == 0, "sess_wrong_fields: str updated_at → 0");
    gateway_sessions_data_free(data);
    json_node_unref(node);
}

static void test_sessions_null_input(void) {
    GatewaySessionsData *data = gateway_data_parse_sessions(NULL);
    ASSERT(data == NULL, "sess_null: returns NULL");
}

static void test_sessions_empty(void) {
    JsonNode *node = parse_json("{\"sessions\": []}");
    GatewaySessionsData *data = gateway_data_parse_sessions(node);
    ASSERT(data != NULL, "sess_empty: parsed");
    ASSERT(data->n_sessions == 0, "sess_empty: 0 sessions");
    gateway_sessions_data_free(data);
    json_node_unref(node);
}

/* ── Cron negative ───────────────────────────────────────────────── */

static void test_cron_missing_jobs(void) {
    JsonNode *node = parse_json("{\"total\": 5}");
    GatewayCronData *data = gateway_data_parse_cron(node);
    ASSERT(data != NULL, "cron_no_jobs: parsed");
    ASSERT(data->n_jobs == 0, "cron_no_jobs: 0 jobs");
    ASSERT(data->total == 5, "cron_no_jobs: total preserved");
    gateway_cron_data_free(data);
    json_node_unref(node);
}

static void test_cron_jobs_wrong_type(void) {
    JsonNode *node = parse_json("{\"jobs\": \"nope\"}");
    GatewayCronData *data = gateway_data_parse_cron(node);
    ASSERT(data != NULL, "cron_wrong_type: parsed");
    ASSERT(data->n_jobs == 0, "cron_wrong_type: 0 jobs");
    gateway_cron_data_free(data);
    json_node_unref(node);
}

static void test_cron_malformed_state(void) {
    /* state is a string instead of object */
    const gchar *json =
        "{\"jobs\": [{\"id\": \"j1\", \"name\": \"Test\", \"enabled\": true, \"state\": \"broken\"}]}";
    JsonNode *node = parse_json(json);
    GatewayCronData *data = gateway_data_parse_cron(node);
    ASSERT(data != NULL, "cron_bad_state: parsed");
    ASSERT(data->n_jobs == 1, "cron_bad_state: 1 job");
    ASSERT(g_strcmp0(data->jobs[0].id, "j1") == 0, "cron_bad_state: id ok");
    ASSERT(data->jobs[0].next_run_at_ms == 0, "cron_bad_state: next_run default");
    ASSERT(data->jobs[0].last_run_status == NULL, "cron_bad_state: no status");
    gateway_cron_data_free(data);
    json_node_unref(node);
}

static void test_cron_mixed_valid_invalid(void) {
    const gchar *json =
        "{\"jobs\": ["
        "  {\"id\": \"good\", \"name\": \"OK\", \"enabled\": true},"
        "  null,"
        "  {\"id\": \"also-good\", \"name\": \"Fine\"}"
        "]}";
    JsonNode *node = parse_json(json);
    GatewayCronData *data = gateway_data_parse_cron(node);
    ASSERT(data != NULL, "cron_mixed: parsed");
    ASSERT(data->n_jobs == 3, "cron_mixed: array len 3");
    ASSERT(g_strcmp0(data->jobs[0].id, "good") == 0, "cron_mixed: [0] ok");
    ASSERT(data->jobs[1].id == NULL, "cron_mixed: [1] zeroed");
    ASSERT(g_strcmp0(data->jobs[2].id, "also-good") == 0, "cron_mixed: [2] ok");
    gateway_cron_data_free(data);
    json_node_unref(node);
}

static void test_cron_partial_fields(void) {
    /* Job with only id, everything else defaults */
    JsonNode *node = parse_json("{\"jobs\": [{\"id\": \"j1\"}]}");
    GatewayCronData *data = gateway_data_parse_cron(node);
    ASSERT(data != NULL, "cron_partial: parsed");
    ASSERT(g_strcmp0(data->jobs[0].id, "j1") == 0, "cron_partial: id");
    ASSERT(data->jobs[0].name == NULL, "cron_partial: name NULL");
    ASSERT(data->jobs[0].enabled == FALSE, "cron_partial: enabled default");
    ASSERT(data->jobs[0].created_at_ms == 0, "cron_partial: created default");
    gateway_cron_data_free(data);
    json_node_unref(node);
}

static void test_cron_null_input(void) {
    GatewayCronData *data = gateway_data_parse_cron(NULL);
    ASSERT(data == NULL, "cron_null: returns NULL");
}

static void test_cron_empty(void) {
    JsonNode *node = parse_json("{\"jobs\": []}");
    GatewayCronData *data = gateway_data_parse_cron(node);
    ASSERT(data != NULL, "cron_empty: parsed");
    ASSERT(data->n_jobs == 0, "cron_empty: 0 jobs");
    gateway_cron_data_free(data);
    json_node_unref(node);
}

/* ── Nodes negative ──────────────────────────────────────────────── */

static void test_nodes_missing_array(void) {
    JsonNode *node = parse_json("{\"ts\": 999}");
    GatewayNodesData *data = gateway_data_parse_nodes(node);
    ASSERT(data != NULL, "nodes_no_arr: parsed");
    ASSERT(data->n_nodes == 0, "nodes_no_arr: 0 nodes");
    ASSERT(data->ts == 999, "nodes_no_arr: ts preserved");
    gateway_nodes_data_free(data);
    json_node_unref(node);
}

static void test_nodes_array_wrong_type(void) {
    JsonNode *node = parse_json("{\"nodes\": \"nope\"}");
    GatewayNodesData *data = gateway_data_parse_nodes(node);
    ASSERT(data != NULL, "nodes_wrong_type: parsed");
    ASSERT(data->n_nodes == 0, "nodes_wrong_type: 0 nodes");
    gateway_nodes_data_free(data);
    json_node_unref(node);
}

static void test_nodes_partial_fields(void) {
    /* Node with only nodeId */
    JsonNode *node = parse_json(
        "{\"nodes\": [{\"nodeId\": \"n1\"}]}");
    GatewayNodesData *data = gateway_data_parse_nodes(node);
    ASSERT(data != NULL, "nodes_partial: parsed");
    ASSERT(g_strcmp0(data->nodes[0].node_id, "n1") == 0, "nodes_partial: id");
    ASSERT(data->nodes[0].display_name == NULL, "nodes_partial: name NULL");
    ASSERT(data->nodes[0].platform == NULL, "nodes_partial: platform NULL");
    ASSERT(data->nodes[0].connected == FALSE, "nodes_partial: connected default");
    ASSERT(data->nodes[0].paired == FALSE, "nodes_partial: paired default");
    ASSERT(data->nodes[0].connected_at_ms == 0, "nodes_partial: connected_at default");
    gateway_nodes_data_free(data);
    json_node_unref(node);
}

static void test_nodes_mixed_valid_invalid(void) {
    const gchar *json =
        "{\"nodes\": ["
        "  {\"nodeId\": \"ok\", \"connected\": true},"
        "  42,"
        "  {\"nodeId\": \"fine\"}"
        "]}";
    JsonNode *node = parse_json(json);
    GatewayNodesData *data = gateway_data_parse_nodes(node);
    ASSERT(data != NULL, "nodes_mixed: parsed");
    ASSERT(data->n_nodes == 3, "nodes_mixed: array len 3");
    ASSERT(g_strcmp0(data->nodes[0].node_id, "ok") == 0, "nodes_mixed: [0] ok");
    ASSERT(data->nodes[1].node_id == NULL, "nodes_mixed: [1] zeroed");
    ASSERT(g_strcmp0(data->nodes[2].node_id, "fine") == 0, "nodes_mixed: [2] ok");
    gateway_nodes_data_free(data);
    json_node_unref(node);
}

static void test_nodes_wrong_type_fields(void) {
    /* connected is string, connectedAtMs is string */
    JsonNode *node = parse_json(
        "{\"nodes\": [{\"nodeId\": \"n1\", \"connected\": \"yes\", \"connectedAtMs\": \"bad\"}]}");
    GatewayNodesData *data = gateway_data_parse_nodes(node);
    ASSERT(data != NULL, "nodes_wrong_fields: parsed");
    ASSERT(data->nodes[0].connected == FALSE, "nodes_wrong_fields: str → false");
    ASSERT(data->nodes[0].connected_at_ms == 0, "nodes_wrong_fields: str → 0");
    gateway_nodes_data_free(data);
    json_node_unref(node);
}

static void test_nodes_null_input(void) {
    GatewayNodesData *data = gateway_data_parse_nodes(NULL);
    ASSERT(data == NULL, "nodes_null: returns NULL");
}

static void test_nodes_non_object_payload(void) {
    JsonNode *node = parse_json("\"just a string\"");
    GatewayNodesData *data = gateway_data_parse_nodes(node);
    ASSERT(data == NULL, "nodes_str_payload: returns NULL");
    json_node_unref(node);
}

/* ── Cron Status tests ────────────────────────────────────────────── */

static void test_cron_status_parse_basic(void) {
    const gchar *json =
        "{\"enabled\": true, \"storePath\": \"/tmp/cron\", \"nextWakeAtMs\": 1700100000000}";
    JsonNode *node = parse_json(json);
    GatewayCronStatus *data = gateway_data_parse_cron_status(node);
    ASSERT(data != NULL, "cron_status: parsed");
    ASSERT(data->enabled == TRUE, "cron_status: enabled");
    ASSERT(g_strcmp0(data->store_path, "/tmp/cron") == 0, "cron_status: store_path");
    ASSERT(data->next_wake_at_ms == 1700100000000, "cron_status: next_wake_at_ms");
    gateway_cron_status_free(data);
    json_node_unref(node);
}

static void test_cron_status_null(void) {
    GatewayCronStatus *data = gateway_data_parse_cron_status(NULL);
    ASSERT(data == NULL, "cron_status_null: returns NULL");
}

static void test_cron_status_empty(void) {
    JsonNode *node = parse_json("{}");
    GatewayCronStatus *data = gateway_data_parse_cron_status(node);
    ASSERT(data != NULL, "cron_status_empty: parsed");
    ASSERT(data->enabled == FALSE, "cron_status_empty: enabled default");
    ASSERT(data->store_path == NULL, "cron_status_empty: store_path null");
    gateway_cron_status_free(data);
    json_node_unref(node);
}

/* ── Cron Runs tests ─────────────────────────────────────────────── */

static void test_cron_runs_parse_basic(void) {
    const gchar *json =
        "{"
        "  \"entries\": ["
        "    { \"id\": \"run-1\", \"jobId\": \"job-1\", \"status\": \"ok\","
        "      \"timestampMs\": 1700000000000, \"durationMs\": 500, \"summary\": \"Done\" },"
        "    { \"id\": \"run-2\", \"jobId\": \"job-1\", \"status\": \"error\","
        "      \"timestampMs\": 1700000001000, \"error\": \"timeout\" }"
        "  ],"
        "  \"total\": 10, \"offset\": 0, \"limit\": 2, \"hasMore\": true"
        "}";
    JsonNode *node = parse_json(json);
    GatewayCronRunsData *data = gateway_data_parse_cron_runs(node);
    ASSERT(data != NULL, "cron_runs: parsed");
    ASSERT(data->n_entries == 2, "cron_runs: count");
    ASSERT(data->total == 10, "cron_runs: total");
    ASSERT(data->has_more == TRUE, "cron_runs: has_more");
    ASSERT(g_strcmp0(data->entries[0].id, "run-1") == 0, "run[0] id");
    ASSERT(g_strcmp0(data->entries[0].status, "ok") == 0, "run[0] status");
    ASSERT(data->entries[0].duration_ms == 500, "run[0] duration_ms");
    ASSERT(g_strcmp0(data->entries[0].summary, "Done") == 0, "run[0] summary");
    ASSERT(g_strcmp0(data->entries[1].status, "error") == 0, "run[1] status");
    ASSERT(g_strcmp0(data->entries[1].error, "timeout") == 0, "run[1] error");
    gateway_cron_runs_data_free(data);
    json_node_unref(node);
}

static void test_cron_runs_null(void) {
    GatewayCronRunsData *data = gateway_data_parse_cron_runs(NULL);
    ASSERT(data == NULL, "cron_runs_null: returns NULL");
}

/* ── Pairing List tests ──────────────────────────────────────────── */

static void test_pairing_list_parse_basic(void) {
    const gchar *json =
        "{"
        "  \"pending\": ["
        "    { \"requestId\": \"req-1\", \"nodeId\": \"n-1\", \"displayName\": \"Phone\","
        "      \"platform\": \"android\", \"version\": \"1.0\", \"remoteIp\": \"10.0.0.1\","
        "      \"isRepair\": false, \"ts\": 1700000000.0 }"
        "  ],"
        "  \"paired\": ["
        "    { \"nodeId\": \"n-2\", \"displayName\": \"Laptop\", \"platform\": \"linux\","
        "      \"version\": \"2.0\", \"remoteIp\": \"10.0.0.2\", \"approvedAtMs\": 1699999000000.0 }"
        "  ]"
        "}";
    JsonNode *node = parse_json(json);
    GatewayPairingList *data = gateway_data_parse_pairing_list(node);
    ASSERT(data != NULL, "pairing: parsed");
    ASSERT(data->n_pending == 1, "pairing: n_pending");
    ASSERT(data->n_paired == 1, "pairing: n_paired");
    ASSERT(g_strcmp0(data->pending[0].request_id, "req-1") == 0, "pending[0] request_id");
    ASSERT(g_strcmp0(data->pending[0].node_id, "n-1") == 0, "pending[0] node_id");
    ASSERT(g_strcmp0(data->pending[0].platform, "android") == 0, "pending[0] platform");
    ASSERT(data->pending[0].is_repair == FALSE, "pending[0] is_repair");
    ASSERT(g_strcmp0(data->paired[0].node_id, "n-2") == 0, "paired[0] node_id");
    ASSERT(g_strcmp0(data->paired[0].platform, "linux") == 0, "paired[0] platform");
    gateway_pairing_list_free(data);
    json_node_unref(node);
}

static void test_pairing_list_empty(void) {
    JsonNode *node = parse_json("{}");
    GatewayPairingList *data = gateway_data_parse_pairing_list(node);
    ASSERT(data != NULL, "pairing_empty: parsed");
    ASSERT(data->n_pending == 0, "pairing_empty: n_pending");
    ASSERT(data->n_paired == 0, "pairing_empty: n_paired");
    gateway_pairing_list_free(data);
    json_node_unref(node);
}

static void test_pairing_list_null(void) {
    GatewayPairingList *data = gateway_data_parse_pairing_list(NULL);
    ASSERT(data == NULL, "pairing_null: returns NULL");
}

static void test_pairing_list_partial_pending(void) {
    /* Pending request with only requestId */
    JsonNode *node = parse_json(
        "{\"pending\": [{\"requestId\": \"r1\"}]}");
    GatewayPairingList *data = gateway_data_parse_pairing_list(node);
    ASSERT(data != NULL, "pairing_partial: parsed");
    ASSERT(data->n_pending == 1, "pairing_partial: n_pending");
    ASSERT(g_strcmp0(data->pending[0].request_id, "r1") == 0, "pairing_partial: request_id");
    ASSERT(data->pending[0].node_id == NULL, "pairing_partial: node_id NULL");
    ASSERT(data->pending[0].platform == NULL, "pairing_partial: platform NULL");
    ASSERT(data->pending[0].is_repair == FALSE, "pairing_partial: is_repair default");
    ASSERT(data->n_paired == 0, "pairing_partial: n_paired 0");
    gateway_pairing_list_free(data);
    json_node_unref(node);
}

static void test_pairing_list_partial_paired(void) {
    /* Paired node with only nodeId */
    JsonNode *node = parse_json(
        "{\"paired\": [{\"nodeId\": \"n1\"}]}");
    GatewayPairingList *data = gateway_data_parse_pairing_list(node);
    ASSERT(data != NULL, "pairing_partial_paired: parsed");
    ASSERT(data->n_paired == 1, "pairing_partial_paired: n_paired");
    ASSERT(g_strcmp0(data->paired[0].node_id, "n1") == 0, "pairing_partial_paired: node_id");
    ASSERT(data->paired[0].display_name == NULL, "pairing_partial_paired: name NULL");
    ASSERT(data->paired[0].approved_at_ms == 0, "pairing_partial_paired: approved default");
    ASSERT(data->n_pending == 0, "pairing_partial_paired: n_pending 0");
    gateway_pairing_list_free(data);
    json_node_unref(node);
}

static void test_pairing_list_wrong_type_arrays(void) {
    /* pending/paired are strings instead of arrays */
    JsonNode *node = parse_json(
        "{\"pending\": \"nope\", \"paired\": 42}");
    GatewayPairingList *data = gateway_data_parse_pairing_list(node);
    ASSERT(data != NULL, "pairing_wrong_type: parsed");
    ASSERT(data->n_pending == 0, "pairing_wrong_type: n_pending 0");
    ASSERT(data->n_paired == 0, "pairing_wrong_type: n_paired 0");
    gateway_pairing_list_free(data);
    json_node_unref(node);
}

static void test_pairing_list_non_object_payload(void) {
    JsonNode *node = parse_json("\"just a string\"");
    GatewayPairingList *data = gateway_data_parse_pairing_list(node);
    ASSERT(data == NULL, "pairing_str: returns NULL");
    json_node_unref(node);
}

static void test_pairing_list_repair_flag(void) {
    const gchar *json =
        "{\"pending\": ["
        "  { \"requestId\": \"r1\", \"isRepair\": true }"
        "]}";
    JsonNode *node = parse_json(json);
    GatewayPairingList *data = gateway_data_parse_pairing_list(node);
    ASSERT(data != NULL, "pairing_repair: parsed");
    ASSERT(data->pending[0].is_repair == TRUE, "pairing_repair: is_repair true");
    gateway_pairing_list_free(data);
    json_node_unref(node);
}

/* ── Channels with account details test ──────────────────────────── */

static void test_channels_with_account_details(void) {
    const gchar *json =
        "{"
        "  \"ts\": 1700000000000,"
        "  \"channelOrder\": [\"telegram\"],"
        "  \"channelLabels\": { \"telegram\": \"Telegram\" },"
        "  \"channels\": { \"telegram\": { \"connected\": true } },"
        "  \"channelAccounts\": {"
        "    \"telegram\": ["
        "      { \"accountId\": \"bot-1\", \"displayName\": \"MyBot\", \"username\": \"mybot\", \"status\": \"connected\" },"
        "      { \"accountId\": \"bot-2\", \"status\": \"disconnected\" }"
        "    ]"
        "  },"
        "  \"channelDefaultAccountId\": { \"telegram\": \"bot-1\" }"
        "}";

    JsonNode *node = parse_json(json);
    GatewayChannelsData *data = gateway_data_parse_channels(node);
    ASSERT(data != NULL, "ch_acct_detail: parsed");
    ASSERT(data->n_channels == 1, "ch_acct_detail: 1 channel");
    ASSERT(data->channels[0].account_count == 2, "ch_acct_detail: 2 accounts");
    ASSERT(g_strcmp0(data->channels[0].default_account_id, "bot-1") == 0, "ch_acct_detail: default");
    gateway_channels_data_free(data);
    json_node_unref(node);
}

/* ── Config Snapshot tests ───────────────────────────────────────── */

static void test_config_get_parse_basic(void) {
    const gchar *json =
        "{"
        "  \"path\": \"/home/user/.openclaw/config.yaml\","
        "  \"hash\": \"abc123\","
        "  \"exists\": true,"
        "  \"valid\": true,"
        "  \"config\": { \"gateway\": { \"port\": 18789 } },"
        "  \"issues\": [\"minor warning\"]"
        "}";
    JsonNode *node = parse_json(json);
    GatewayConfigSnapshot *data = gateway_data_parse_config_get(node);
    ASSERT(data != NULL, "config_get: parsed");
    ASSERT(g_strcmp0(data->path, "/home/user/.openclaw/config.yaml") == 0, "config_get: path");
    ASSERT(g_strcmp0(data->hash, "abc123") == 0, "config_get: hash");
    ASSERT(data->exists == TRUE, "config_get: exists");
    ASSERT(data->valid == TRUE, "config_get: valid");
    ASSERT(data->config != NULL, "config_get: config not null");
    ASSERT(data->n_issues == 1, "config_get: n_issues");
    ASSERT(g_strcmp0(data->issues[0], "minor warning") == 0, "config_get: issues[0]");
    gateway_config_snapshot_free(data);
    json_node_unref(node);
}

static void test_config_get_null(void) {
    GatewayConfigSnapshot *data = gateway_data_parse_config_get(NULL);
    ASSERT(data == NULL, "config_get_null: returns NULL");
}

static void test_config_get_no_config_obj(void) {
    JsonNode *node = parse_json("{\"path\": \"/tmp/c\", \"exists\": false}");
    GatewayConfigSnapshot *data = gateway_data_parse_config_get(node);
    ASSERT(data != NULL, "config_get_no_obj: parsed");
    ASSERT(data->config == NULL, "config_get_no_obj: config null");
    ASSERT(data->exists == FALSE, "config_get_no_obj: exists false");
    ASSERT(data->issues == NULL, "config_get_no_obj: issues null");
    gateway_config_snapshot_free(data);
    json_node_unref(node);
}

/* ── Config Schema tests ─────────────────────────────────────────── */

static void test_config_schema_parse_basic(void) {
    const gchar *json =
        "{"
        "  \"schema\": { \"type\": \"object\", \"properties\": {} },"
        "  \"uiHints\": { \"secrets\": [\"apiKey\"] }"
        "}";
    JsonNode *node = parse_json(json);
    GatewayConfigSchema *data = gateway_data_parse_config_schema(node);
    ASSERT(data != NULL, "config_schema: parsed");
    ASSERT(data->schema != NULL, "config_schema: schema not null");
    ASSERT(data->ui_hints != NULL, "config_schema: ui_hints not null");
    gateway_config_schema_free(data);
    json_node_unref(node);
}

static void test_config_schema_null(void) {
    GatewayConfigSchema *data = gateway_data_parse_config_schema(NULL);
    ASSERT(data == NULL, "config_schema_null: returns NULL");
}

static void test_config_schema_empty(void) {
    JsonNode *node = parse_json("{}");
    GatewayConfigSchema *data = gateway_data_parse_config_schema(node);
    ASSERT(data != NULL, "config_schema_empty: parsed");
    ASSERT(data->schema == NULL, "config_schema_empty: schema null");
    ASSERT(data->ui_hints == NULL, "config_schema_empty: ui_hints null");
    gateway_config_schema_free(data);
    json_node_unref(node);
}

/* ── Main ────────────────────────────────────────────────────────── */

int main(void) {
    /* Channels — happy path */
    test_channels_parse_basic();
    test_channels_parse_empty();
    test_channels_parse_null();
    /* Channels — negative */
    test_channels_wrong_type_channel_order();
    test_channels_labels_wrong_type();
    test_channels_accounts_not_array();
    test_channels_non_object_payload();

    /* Skills — happy path */
    test_skills_parse_basic();
    test_skills_parse_empty();
    /* Skills — negative */
    test_skills_missing_array();
    test_skills_array_wrong_type();
    test_skills_mixed_valid_invalid();
    test_skills_partial_fields();
    test_skills_wrong_type_booleans();
    test_skills_null_input();

    /* Sessions — happy path */
    test_sessions_parse_basic();
    /* Sessions — negative */
    test_sessions_missing_array();
    test_sessions_array_wrong_type();
    test_sessions_partial_item();
    test_sessions_mixed_valid_invalid();
    test_sessions_wrong_type_fields();
    test_sessions_null_input();
    test_sessions_empty();

    /* Cron — happy path */
    test_cron_parse_basic();
    test_cron_parse_schedule_kind_every();
    test_cron_parse_schedule_kind_at();
    test_cron_parse_routing_fields_from_root();
    /* Cron — negative */
    test_cron_missing_jobs();
    test_cron_jobs_wrong_type();
    test_cron_malformed_state();
    test_cron_mixed_valid_invalid();
    test_cron_partial_fields();
    test_cron_null_input();
    test_cron_empty();

    /* Nodes — happy path */
    test_nodes_parse_basic();
    test_nodes_parse_empty();
    /* Nodes — negative */
    test_nodes_missing_array();
    test_nodes_array_wrong_type();
    test_nodes_partial_fields();
    test_nodes_mixed_valid_invalid();
    test_nodes_wrong_type_fields();
    test_nodes_null_input();
    test_nodes_non_object_payload();

    /* Cron Status */
    test_cron_status_parse_basic();
    test_cron_status_null();
    test_cron_status_empty();

    /* Cron Runs */
    test_cron_runs_parse_basic();
    test_cron_runs_null();

    /* Pairing List */
    test_pairing_list_parse_basic();
    test_pairing_list_empty();
    test_pairing_list_null();
    test_pairing_list_partial_pending();
    test_pairing_list_partial_paired();
    test_pairing_list_wrong_type_arrays();
    test_pairing_list_non_object_payload();
    test_pairing_list_repair_flag();

    /* Channels — account details */
    test_channels_with_account_details();

    /* Config Snapshot */
    test_config_get_parse_basic();
    test_config_get_null();
    test_config_get_no_config_obj();

    /* Config Schema */
    test_config_schema_parse_basic();
    test_config_schema_null();
    test_config_schema_empty();

    g_print("gateway_data: %d/%d tests passed\n", tests_passed, tests_run);
    return (tests_passed == tests_run) ? 0 : 1;
}
