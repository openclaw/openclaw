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
        "      \"enabled\": true,"
        "      \"disabled\": false,"
        "      \"installed\": true,"
        "      \"managed\": false,"
        "      \"bundled\": true,"
        "      \"hasUpdate\": false,"
        "      \"eligible\": true"
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

    ASSERT(g_strcmp0(data->skills[1].name, "Code Runner") == 0, "skill[1] name");
    ASSERT(data->skills[1].disabled == TRUE, "skill[1] disabled");
    ASSERT(data->skills[1].has_update == TRUE, "skill[1] has_update");
    ASSERT(data->skills[1].eligible == FALSE, "skill[1] eligible");

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
        "      \"status\": \"running\","
        "      \"modelProvider\": \"openai\","
        "      \"model\": \"gpt-4o\","
        "      \"updatedAt\": 1700000000500"
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
    ASSERT(data->count == 2, "sessions count");
    ASSERT(data->n_sessions == 2, "sessions array count");

    ASSERT(g_strcmp0(data->sessions[0].key, "main") == 0, "session[0] key");
    ASSERT(g_strcmp0(data->sessions[0].kind, "direct") == 0, "session[0] kind");
    ASSERT(g_strcmp0(data->sessions[0].display_name, "Main Session") == 0, "session[0] display_name");
    ASSERT(g_strcmp0(data->sessions[0].channel, "telegram") == 0, "session[0] channel");
    ASSERT(g_strcmp0(data->sessions[0].status, "running") == 0, "session[0] status");
    ASSERT(data->sessions[0].updated_at == 1700000000500, "session[0] updated_at");

    ASSERT(g_strcmp0(data->sessions[1].key, "agent:sub-1:task-abc") == 0, "session[1] key");
    ASSERT(g_strcmp0(data->sessions[1].kind, "group") == 0, "session[1] kind");
    ASSERT(data->sessions[1].display_name == NULL, "session[1] display_name null");
    ASSERT(data->sessions[1].status == NULL, "session[1] status null");

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
        "      \"createdAtMs\": 1700000000000,"
        "      \"updatedAtMs\": 1700000001000,"
        "      \"state\": {"
        "        \"nextRunAtMs\": 1700100000000,"
        "        \"lastRunAtMs\": 1700000000000,"
        "        \"lastRunStatus\": \"ok\""
        "      }"
        "    },"
        "    {"
        "      \"id\": \"job-2\","
        "      \"name\": \"Cleanup\","
        "      \"enabled\": false,"
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
    ASSERT(data->jobs[0].next_run_at_ms == 1700100000000, "job[0] next_run_at_ms");
    ASSERT(g_strcmp0(data->jobs[0].last_run_status, "ok") == 0, "job[0] last_run_status");

    ASSERT(g_strcmp0(data->jobs[1].id, "job-2") == 0, "job[1] id");
    ASSERT(data->jobs[1].enabled == FALSE, "job[1] enabled");
    ASSERT(g_strcmp0(data->jobs[1].last_run_status, "error") == 0, "job[1] last_run_status");
    ASSERT(g_strcmp0(data->jobs[1].last_error, "timeout exceeded") == 0, "job[1] last_error");

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
        "      \"deviceFamily\": \"iPhone\","
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
    ASSERT(data->nodes[0].connected == TRUE, "node[0] connected");
    ASSERT(data->nodes[0].connected_at_ms == 1700000001500, "node[0] connected_at_ms");

    ASSERT(g_strcmp0(data->nodes[1].node_id, "node-xyz") == 0, "node[1] id");
    ASSERT(data->nodes[1].connected == FALSE, "node[1] connected");
    ASSERT(data->nodes[1].platform == NULL, "node[1] platform null");

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

    g_print("gateway_data: %d/%d tests passed\n", tests_passed, tests_run);
    return (tests_passed == tests_run) ? 0 : 1;
}
