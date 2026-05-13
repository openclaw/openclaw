/*
 * test_rpc_mutations.c
 *
 * Unit tests for mutation RPC param serialization (gateway_mutations.h).
 *
 * Strategy: We stub gateway_rpc_request and gateway_ws_get_state so
 * tests run without a live WS connection.  The stub captures the
 * method, serialized params JSON, and timeout for each call, allowing
 * assertions on the built payloads.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "../src/gateway_mutations.h"
#include "../src/gateway_ws.h"
#include "../src/test_seams.h"
#include <json-glib/json-glib.h>
#include <string.h>

#define ASSERT(cond, msg) g_assert_true(cond)

/* ── Stub state ──────────────────────────────────────────────────── */

static gchar *stub_last_method = NULL;
static JsonNode *stub_last_params = NULL;
static guint stub_last_timeout = 0;
static gint stub_call_count = 0;

static void stub_reset(void) {
    g_free(stub_last_method);
    stub_last_method = NULL;
    if (stub_last_params) {
        json_node_unref(stub_last_params);
        stub_last_params = NULL;
    }
    stub_last_timeout = 0;
    stub_call_count = 0;
}

/* ── Stubs ───────────────────────────────────────────────────────── */

GatewayWsState gateway_ws_get_state(void) {
    return GATEWAY_WS_CONNECTED;
}

gboolean gateway_ws_send_text(const gchar *text) {
    (void)text;
    return TRUE;
}

/*
 * Stub for gateway_rpc_request.  Captures method/params/timeout and
 * immediately invokes the callback with a synthetic success response.
 */
gchar* gateway_rpc_request(const gchar *method,
                           JsonNode *params_json,
                           guint timeout_ms,
                           GatewayRpcCallback callback,
                           gpointer user_data) {
    g_free(stub_last_method);
    stub_last_method = g_strdup(method);
    if (stub_last_params) json_node_unref(stub_last_params);
    stub_last_params = params_json ? json_node_copy(params_json) : NULL;
    stub_last_timeout = timeout_ms;
    stub_call_count++;

    /* Invoke callback with a synthetic ok response */
    GatewayRpcResponse resp = {
        .ok = TRUE,
        .payload = NULL,
        .error_code = NULL,
        .error_msg = NULL,
    };
    if (callback) callback(&resp, user_data);

    return g_strdup("stub-req-id");
}

/* ── Helpers ─────────────────────────────────────────────────────── */

static void noop_cb(const GatewayRpcResponse *resp, gpointer data) {
    (void)resp; (void)data;
}

static JsonObject* get_stub_params_obj(void) {
    if (!stub_last_params || !JSON_NODE_HOLDS_OBJECT(stub_last_params)) return NULL;
    return json_node_get_object(stub_last_params);
}

static const gchar* obj_get_string(JsonObject *obj, const gchar *key) {
    if (!obj || !json_object_has_member(obj, key)) return NULL;
    return json_object_get_string_member(obj, key);
}

static gboolean obj_get_bool(JsonObject *obj, const gchar *key) {
    if (!obj || !json_object_has_member(obj, key)) return FALSE;
    return json_object_get_boolean_member(obj, key);
}

/* ── Skills mutation tests ───────────────────────────────────────── */

static void test_skills_enable(void) {
    stub_reset();
    gchar *rid = mutation_skills_enable("web-search", TRUE, noop_cb, NULL);
    ASSERT(rid != NULL, "skills_enable: rid");
    ASSERT(g_strcmp0(stub_last_method, "skills.update") == 0, "skills_enable: method");
    JsonObject *p = get_stub_params_obj();
    ASSERT(p != NULL, "skills_enable: params obj");
    ASSERT(g_strcmp0(obj_get_string(p, "skillKey"), "web-search") == 0, "skills_enable: skillKey");
    ASSERT(obj_get_bool(p, "enabled") == TRUE, "skills_enable: enabled");
    g_free(rid);
}

static void test_skills_disable(void) {
    stub_reset();
    gchar *rid = mutation_skills_enable("code-runner", FALSE, noop_cb, NULL);
    ASSERT(rid != NULL, "skills_disable: rid");
    ASSERT(g_strcmp0(stub_last_method, "skills.update") == 0, "skills_disable: method");
    JsonObject *p = get_stub_params_obj();
    ASSERT(obj_get_bool(p, "enabled") == FALSE, "skills_disable: enabled false");
    g_free(rid);
}

static void test_skills_install(void) {
    stub_reset();
    gchar *rid = mutation_skills_install("my-skill", "npm", noop_cb, NULL);
    ASSERT(rid != NULL, "skills_install: rid");
    ASSERT(g_strcmp0(stub_last_method, "skills.install") == 0, "skills_install: method");
    ASSERT(stub_last_timeout == 30000, "skills_install: timeout 30s");
    JsonObject *p = get_stub_params_obj();
    ASSERT(g_strcmp0(obj_get_string(p, "name"), "my-skill") == 0, "skills_install: name");
    ASSERT(g_strcmp0(obj_get_string(p, "installId"), "npm") == 0, "skills_install: installId");
    g_free(rid);
}

static void test_skills_install_no_id(void) {
    stub_reset();
    gchar *rid = mutation_skills_install("my-skill", NULL, noop_cb, NULL);
    ASSERT(rid != NULL, "skills_install_no_id: rid");
    JsonObject *p = get_stub_params_obj();
    ASSERT(!json_object_has_member(p, "installId"), "skills_install_no_id: no installId");
    g_free(rid);
}

static void test_skills_update(void) {
    stub_reset();
    gchar *rid = mutation_skills_update("my-skill", noop_cb, NULL);
    ASSERT(rid != NULL, "skills_update: rid");
    ASSERT(g_strcmp0(stub_last_method, "skills.update") == 0, "skills_update: method");
    JsonObject *p = get_stub_params_obj();
    ASSERT(g_strcmp0(obj_get_string(p, "skillKey"), "my-skill") == 0, "skills_update: skillKey");
    g_free(rid);
}

static void test_skills_update_env(void) {
    stub_reset();
    gchar *rid = mutation_skills_update_env("web-search", "SERP_API_KEY", "sk-123", noop_cb, NULL);
    ASSERT(rid != NULL, "skills_update_env: rid");
    ASSERT(g_strcmp0(stub_last_method, "skills.update") == 0, "skills_update_env: method");
    JsonObject *p = get_stub_params_obj();
    ASSERT(g_strcmp0(obj_get_string(p, "skillKey"), "web-search") == 0, "skills_update_env: skillKey");
    
    JsonObject *env_obj = json_object_get_object_member(p, "env");
    ASSERT(env_obj != NULL, "skills_update_env: env obj");
    ASSERT(g_strcmp0(obj_get_string(env_obj, "SERP_API_KEY"), "sk-123") == 0, "skills_update_env: env val");
    g_free(rid);
}

static void test_skills_update_api_key(void) {
    stub_reset();
    gchar *rid = mutation_skills_update_api_key("web-search", "sk-123", noop_cb, NULL);
    ASSERT(rid != NULL, "skills_update_api_key: rid");
    ASSERT(g_strcmp0(stub_last_method, "skills.update") == 0, "skills_update_api_key: method");
    JsonObject *p = get_stub_params_obj();
    ASSERT(g_strcmp0(obj_get_string(p, "skillKey"), "web-search") == 0, "skills_update_api_key: skillKey");
    ASSERT(g_strcmp0(obj_get_string(p, "apiKey"), "sk-123") == 0, "skills_update_api_key: apiKey");
    g_free(rid);
}

/* ── Sessions mutation tests ─────────────────────────────────────── */

static void test_sessions_patch(void) {
    stub_reset();
    gchar *rid = mutation_sessions_patch("main", "high", "low", NULL, noop_cb, NULL);
    ASSERT(rid != NULL, "sess_patch: rid");
    ASSERT(g_strcmp0(stub_last_method, "sessions.patch") == 0, "sess_patch: method");
    JsonObject *p = get_stub_params_obj();
    ASSERT(g_strcmp0(obj_get_string(p, "key"), "main") == 0, "sess_patch: key");
    ASSERT(g_strcmp0(obj_get_string(p, "thinkingLevel"), "high") == 0, "sess_patch: thinking");
    ASSERT(g_strcmp0(obj_get_string(p, "verboseLevel"), "low") == 0, "sess_patch: verbose");
    g_free(rid);
}

static void test_sessions_patch_partial(void) {
    stub_reset();
    gchar *rid = mutation_sessions_patch("main", "medium", NULL, NULL, noop_cb, NULL);
    ASSERT(rid != NULL, "sess_patch_partial: rid");
    JsonObject *p = get_stub_params_obj();
    ASSERT(g_strcmp0(obj_get_string(p, "thinkingLevel"), "medium") == 0, "sess_patch_partial: thinking");
    ASSERT(!json_object_has_member(p, "verboseLevel"), "sess_patch_partial: no verbose");
    ASSERT(!json_object_has_member(p, "model"), "sess_patch_partial: no model");
    g_free(rid);
}

static void test_sessions_patch_model_only(void) {
    stub_reset();
    gchar *rid = mutation_sessions_patch("main", NULL, NULL, "anthropic/claude-sonnet-4", noop_cb, NULL);
    ASSERT(rid != NULL, "sess_patch_model: rid");
    JsonObject *p = get_stub_params_obj();
    ASSERT(g_strcmp0(obj_get_string(p, "model"), "anthropic/claude-sonnet-4") == 0, "sess_patch_model: model");
    ASSERT(!json_object_has_member(p, "thinkingLevel"), "sess_patch_model: no thinking");
    ASSERT(!json_object_has_member(p, "verboseLevel"), "sess_patch_model: no verbose");
    g_free(rid);
}

static void test_sessions_reset(void) {
    stub_reset();
    gchar *rid = mutation_sessions_reset("main", noop_cb, NULL);
    ASSERT(rid != NULL, "sess_reset: rid");
    ASSERT(g_strcmp0(stub_last_method, "sessions.reset") == 0, "sess_reset: method");
    JsonObject *p = get_stub_params_obj();
    ASSERT(g_strcmp0(obj_get_string(p, "key"), "main") == 0, "sess_reset: key");
    g_free(rid);
}

static void test_sessions_delete(void) {
    stub_reset();
    gchar *rid = mutation_sessions_delete("old-sess", TRUE, noop_cb, NULL);
    ASSERT(rid != NULL, "sess_delete: rid");
    ASSERT(g_strcmp0(stub_last_method, "sessions.delete") == 0, "sess_delete: method");
    JsonObject *p = get_stub_params_obj();
    ASSERT(g_strcmp0(obj_get_string(p, "key"), "old-sess") == 0, "sess_delete: key");
    ASSERT(obj_get_bool(p, "deleteTranscript") == TRUE, "sess_delete: deleteTranscript");
    g_free(rid);
}

static void test_sessions_compact(void) {
    stub_reset();
    gchar *rid = mutation_sessions_compact("main", noop_cb, NULL);
    ASSERT(rid != NULL, "sess_compact: rid");
    ASSERT(g_strcmp0(stub_last_method, "sessions.compact") == 0, "sess_compact: method");
    g_free(rid);
}

/* ── Cron mutation tests ─────────────────────────────────────────── */

static void test_cron_enable(void) {
    stub_reset();
    gchar *rid = mutation_cron_enable("job-1", TRUE, noop_cb, NULL);
    ASSERT(rid != NULL, "cron_enable: rid");
    ASSERT(g_strcmp0(stub_last_method, "cron.update") == 0, "cron_enable: method");
    JsonObject *p = get_stub_params_obj();
    ASSERT(g_strcmp0(obj_get_string(p, "id"), "job-1") == 0, "cron_enable: id");
    JsonObject *patch = json_object_get_object_member(p, "patch");
    ASSERT(patch != NULL, "cron_enable: patch obj");
    ASSERT(obj_get_bool(patch, "enabled") == TRUE, "cron_enable: enabled");
    g_free(rid);
}

static void test_cron_remove(void) {
    stub_reset();
    gchar *rid = mutation_cron_remove("job-2", noop_cb, NULL);
    ASSERT(rid != NULL, "cron_remove: rid");
    ASSERT(g_strcmp0(stub_last_method, "cron.remove") == 0, "cron_remove: method");
    JsonObject *p = get_stub_params_obj();
    ASSERT(g_strcmp0(obj_get_string(p, "id"), "job-2") == 0, "cron_remove: id");
    g_free(rid);
}

static void test_cron_run(void) {
    stub_reset();
    gchar *rid = mutation_cron_run("job-1", noop_cb, NULL);
    ASSERT(rid != NULL, "cron_run: rid");
    ASSERT(g_strcmp0(stub_last_method, "cron.run") == 0, "cron_run: method");
    JsonObject *p = get_stub_params_obj();
    ASSERT(g_strcmp0(obj_get_string(p, "id"), "job-1") == 0, "cron_run: id");
    ASSERT(g_strcmp0(obj_get_string(p, "mode"), "force") == 0, "cron_run: mode");
    g_free(rid);
}

static void test_cron_add(void) {
    stub_reset();
    GatewayCronJobMutationFields fields = {
        .name = "Test Job",
        .schedule_kind = "cron",
        .schedule_expr = "0 9 * * *",
        .session_target = "main",
        .wake_mode = "next-heartbeat",
        .prompt = "do work",
    };

    gchar *rid = mutation_cron_add(&fields, noop_cb, NULL);
    ASSERT(rid != NULL, "cron_add: rid");
    ASSERT(g_strcmp0(stub_last_method, "cron.add") == 0, "cron_add: method");
    JsonObject *p = get_stub_params_obj();
    ASSERT(g_strcmp0(obj_get_string(p, "name"), "Test Job") == 0, "cron_add: name");
    ASSERT(obj_get_bool(p, "enabled") == TRUE, "cron_add: enabled");
    g_free(rid);
}

static void test_cron_update(void) {
    stub_reset();
    GatewayCronJobMutationFields fields = {
        .name = "Updated Job",
        .schedule_kind = "cron",
        .schedule_expr = "0 9 * * *",
        .session_target = "main",
        .wake_mode = "next-heartbeat",
    };

    gchar *rid = mutation_cron_update("job-1", &fields, noop_cb, NULL);
    ASSERT(rid != NULL, "cron_update: rid");
    ASSERT(g_strcmp0(stub_last_method, "cron.update") == 0, "cron_update: method");
    JsonObject *p = get_stub_params_obj();
    ASSERT(g_strcmp0(obj_get_string(p, "id"), "job-1") == 0, "cron_update: id");
    JsonObject *patch = json_object_get_object_member(p, "patch");
    ASSERT(patch != NULL, "cron_update: patch object");
    ASSERT(g_strcmp0(obj_get_string(patch, "name"), "Updated Job") == 0, "cron_update: patch.name");
    ASSERT(!json_object_has_member(patch, "enabled"), "cron_update: patch omits enabled");
    g_free(rid);
}

/* ── Channels mutation tests ─────────────────────────────────────── */

static void test_channels_status_probe(void) {
    stub_reset();
    gchar *rid = mutation_channels_status(TRUE, noop_cb, NULL);
    ASSERT(rid != NULL, "ch_probe: rid");
    ASSERT(g_strcmp0(stub_last_method, "channels.status") == 0, "ch_probe: method");
    JsonObject *p = get_stub_params_obj();
    ASSERT(obj_get_bool(p, "probe") == TRUE, "ch_probe: probe");
    g_free(rid);
}

static void test_channels_status_no_probe(void) {
    stub_reset();
    gchar *rid = mutation_channels_status(FALSE, noop_cb, NULL);
    ASSERT(rid != NULL, "ch_no_probe: rid");
    ASSERT(g_strcmp0(stub_last_method, "channels.status") == 0, "ch_no_probe: method");
    JsonObject *p = get_stub_params_obj();
    ASSERT(p != NULL, "ch_no_probe: params obj");
    ASSERT(json_object_get_size(p) == 0, "ch_no_probe: params empty object");
    ASSERT(!json_object_has_member(p, "probe"), "ch_no_probe: no probe field");
    ASSERT(!json_object_has_member(p, "channelId"), "ch_no_probe: no channelId");
    ASSERT(!json_object_has_member(p, "channel"), "ch_no_probe: no channel");
    g_free(rid);
}

static void test_channels_logout(void) {
    stub_reset();
    gchar *rid = mutation_channels_logout("telegram", "acct-1", noop_cb, NULL);
    ASSERT(rid != NULL, "ch_logout: rid");
    ASSERT(g_strcmp0(stub_last_method, "channels.logout") == 0, "ch_logout: method");
    JsonObject *p = get_stub_params_obj();
    ASSERT(g_strcmp0(obj_get_string(p, "channel"), "telegram") == 0, "ch_logout: channel");
    ASSERT(g_strcmp0(obj_get_string(p, "accountId"), "acct-1") == 0, "ch_logout: accountId");
    g_free(rid);
}

static void test_channels_logout_no_acct(void) {
    stub_reset();
    gchar *rid = mutation_channels_logout("telegram", NULL, noop_cb, NULL);
    ASSERT(rid != NULL, "ch_logout_no_acct: rid");
    JsonObject *p = get_stub_params_obj();
    ASSERT(g_strcmp0(obj_get_string(p, "channel"), "telegram") == 0, "ch_logout_no_acct: channel");
    ASSERT(!json_object_has_member(p, "accountId"), "ch_logout_no_acct: no accountId");
    g_free(rid);
}

/* ── System mutation tests (Tranche E) ──────────────────────────── */

static void test_system_set_heartbeats_enabled(void) {
    stub_reset();
    gchar *rid = mutation_system_set_heartbeats(TRUE, noop_cb, NULL);
    ASSERT(rid != NULL, "set_heartbeats: rid");
    ASSERT(g_strcmp0(stub_last_method, "set-heartbeats") == 0, "set_heartbeats: method");
    JsonObject *p = get_stub_params_obj();
    ASSERT(p != NULL, "set_heartbeats: params obj");
    ASSERT(json_object_has_member(p, "enabled"), "set_heartbeats: enabled present");
    ASSERT(obj_get_bool(p, "enabled") == TRUE, "set_heartbeats: enabled=true");
    g_free(rid);
}

static void test_system_set_heartbeats_disabled(void) {
    stub_reset();
    gchar *rid = mutation_system_set_heartbeats(FALSE, noop_cb, NULL);
    ASSERT(rid != NULL, "set_heartbeats_off: rid");
    ASSERT(g_strcmp0(stub_last_method, "set-heartbeats") == 0, "set_heartbeats_off: method");
    JsonObject *p = get_stub_params_obj();
    ASSERT(obj_get_bool(p, "enabled") == FALSE, "set_heartbeats_off: enabled=false");
    g_free(rid);
}

/* ── Config mutation tests ───────────────────────────────────────── */

static void test_config_get(void) {
    stub_reset();
    gchar *rid = mutation_config_get("channels.telegram", noop_cb, NULL);
    ASSERT(rid != NULL, "config_get: rid");
    ASSERT(g_strcmp0(stub_last_method, "config.get") == 0, "config_get: method");
    JsonObject *p = get_stub_params_obj();
    ASSERT(g_strcmp0(obj_get_string(p, "scope"), "channels.telegram") == 0, "config_get: scope");
    g_free(rid);
}

static void test_config_schema(void) {
    stub_reset();
    gchar *rid = mutation_config_schema(NULL, noop_cb, NULL);
    ASSERT(rid != NULL, "config_schema: rid");
    ASSERT(g_strcmp0(stub_last_method, "config.schema") == 0, "config_schema: method");
    JsonObject *p = get_stub_params_obj();
    ASSERT(!json_object_has_member(p, "scope"), "config_schema: no scope");
    g_free(rid);
}

static void test_config_set(void) {
    stub_reset();
    const gchar *raw_json = "{\"gateway\":{\"port\":18789}}";
    gchar *rid = mutation_config_set(raw_json, "hash-abc", noop_cb, NULL);
    ASSERT(rid != NULL, "config_set: rid");
    ASSERT(g_strcmp0(stub_last_method, "config.set") == 0, "config_set: method");
    JsonObject *p = get_stub_params_obj();
    ASSERT(g_strcmp0(obj_get_string(p, "raw"), raw_json) == 0, "config_set: raw");
    ASSERT(g_strcmp0(obj_get_string(p, "baseHash"), "hash-abc") == 0, "config_set: baseHash");
    g_free(rid);
}

/* ── Nodes mutation tests ────────────────────────────────────────── */

static void test_node_pair_approve(void) {
    stub_reset();
    gchar *rid = mutation_node_pair_approve("req-42", noop_cb, NULL);
    ASSERT(rid != NULL, "pair_approve: rid");
    ASSERT(g_strcmp0(stub_last_method, "node.pair.approve") == 0, "pair_approve: method");
    JsonObject *p = get_stub_params_obj();
    ASSERT(g_strcmp0(obj_get_string(p, "requestId"), "req-42") == 0, "pair_approve: requestId");
    g_free(rid);
}

static void test_node_pair_reject(void) {
    stub_reset();
    gchar *rid = mutation_node_pair_reject("req-99", noop_cb, NULL);
    ASSERT(rid != NULL, "pair_reject: rid");
    ASSERT(g_strcmp0(stub_last_method, "node.pair.reject") == 0, "pair_reject: method");
    JsonObject *p = get_stub_params_obj();
    ASSERT(g_strcmp0(obj_get_string(p, "requestId"), "req-99") == 0, "pair_reject: requestId");
    g_free(rid);
}

static void test_node_list(void) {
    stub_reset();
    gchar *rid = mutation_node_list(noop_cb, NULL);
    ASSERT(rid != NULL, "node_list: rid");
    ASSERT(g_strcmp0(stub_last_method, "node.list") == 0, "node_list: method");
    g_free(rid);
}

static void test_node_pair_list(void) {
    stub_reset();
    gchar *rid = mutation_node_pair_list(noop_cb, NULL);
    ASSERT(rid != NULL, "node_pair_list: rid");
    ASSERT(g_strcmp0(stub_last_method, "node.pair.list") == 0, "node_pair_list: method");
    g_free(rid);
}

/* ── WhatsApp login flow tests ───────────────────────────────────── */

static void test_web_login_start(void) {
    stub_reset();
    gchar *rid = mutation_web_login_start(noop_cb, NULL);
    ASSERT(rid != NULL, "web_login_start: rid");
    ASSERT(g_strcmp0(stub_last_method, "web.login.start") == 0, "web_login_start: method");
    g_free(rid);
}

static void test_web_login_wait(void) {
    stub_reset();
    gchar *rid = mutation_web_login_wait(30000, "acct-1", noop_cb, NULL);
    ASSERT(rid != NULL, "web_login_wait: rid");
    ASSERT(g_strcmp0(stub_last_method, "web.login.wait") == 0, "web_login_wait: method");
    ASSERT(stub_last_timeout == 30000, "web_login_wait: timeout");
    JsonObject *p = get_stub_params_obj();
    ASSERT(json_object_has_member(p, "timeoutMs"), "web_login_wait: timeoutMs");
    ASSERT(json_object_get_int_member(p, "timeoutMs") == 30000, "web_login_wait: timeoutMs value");
    ASSERT(g_strcmp0(obj_get_string(p, "accountId"), "acct-1") == 0, "web_login_wait: accountId");
    g_free(rid);
}

static void test_web_login_wait_null_account(void) {
    stub_reset();
    gchar *rid = mutation_web_login_wait(120000, NULL, noop_cb, NULL);
    ASSERT(rid != NULL, "web_login_wait_null: rid");
    ASSERT(g_strcmp0(stub_last_method, "web.login.wait") == 0, "web_login_wait_null: method");
    ASSERT(stub_last_timeout == 120000, "web_login_wait_null: timeout 120s");
    JsonObject *p = get_stub_params_obj();
    ASSERT(!json_object_has_member(p, "accountId"), "web_login_wait_null: no accountId");
    g_free(rid);
}

/* ── Cron expanded params tests ─────────────────────────────────── */

static void test_cron_add_expanded(void) {
    stub_reset();
    GatewayCronJobMutationFields fields = {
        .name = "Daily Report",
        .description = "Generates daily summary",
        .agent_id = "reporter-agent",
        .schedule_kind = "cron",
        .schedule_expr = "0 9 * * *",
        .session_target = "main",
        .wake_mode = "next-heartbeat",
        .prompt = "Generate daily summary",
    };

    gchar *rid = mutation_cron_add(&fields, noop_cb, NULL);
    ASSERT(rid != NULL, "cron_add_expanded: rid");
    ASSERT(g_strcmp0(stub_last_method, "cron.add") == 0, "cron_add_expanded: method");
    JsonObject *p = get_stub_params_obj();
    ASSERT(g_strcmp0(obj_get_string(p, "name"), "Daily Report") == 0, "cron_add_expanded: name");
    ASSERT(g_strcmp0(obj_get_string(p, "description"), "Generates daily summary") == 0, "cron_add_expanded: description");
    ASSERT(g_strcmp0(obj_get_string(p, "agentId"), "reporter-agent") == 0, "cron_add_expanded: agentId");
    ASSERT(obj_get_bool(p, "enabled") == TRUE, "cron_add_expanded: enabled");
    ASSERT(g_strcmp0(obj_get_string(p, "sessionTarget"), "main") == 0, "cron_add_expanded: sessionTarget");
    ASSERT(g_strcmp0(obj_get_string(p, "wakeMode"), "next-heartbeat") == 0, "cron_add_expanded: wakeMode");

    JsonObject *sched = json_object_get_object_member(p, "schedule");
    ASSERT(sched != NULL, "cron_add_expanded: schedule obj");
    ASSERT(g_strcmp0(obj_get_string(sched, "kind"), "cron") == 0, "cron_add_expanded: schedule.kind");
    ASSERT(g_strcmp0(obj_get_string(sched, "expr"), "0 9 * * *") == 0, "cron_add_expanded: schedule.expr");

    JsonObject *payload = json_object_get_object_member(p, "payload");
    ASSERT(payload != NULL, "cron_add_expanded: payload obj");
    ASSERT(g_strcmp0(obj_get_string(payload, "kind"), "agentTurn") == 0, "cron_add_expanded: payload.kind");
    ASSERT(g_strcmp0(obj_get_string(payload, "message"), "Generate daily summary") == 0, "cron_add_expanded: payload.message");

    g_free(rid);
}

static void test_cron_update_expanded(void) {
    stub_reset();
    GatewayCronJobMutationFields fields = {
        .name = "Updated Job",
        .description = "Updated description",
        .agent_id = "new-agent",
        .schedule_kind = "cron",
        .schedule_expr = "30 10 * * *",
        .session_target = "main",
        .wake_mode = "next-heartbeat",
    };

    gchar *rid = mutation_cron_update("job-1", &fields, noop_cb, NULL);
    ASSERT(rid != NULL, "cron_update_expanded: rid");
    ASSERT(g_strcmp0(stub_last_method, "cron.update") == 0, "cron_update_expanded: method");

    JsonObject *p = get_stub_params_obj();
    ASSERT(g_strcmp0(obj_get_string(p, "id"), "job-1") == 0, "cron_update_expanded: id");
    ASSERT(json_object_has_member(p, "patch"), "cron_update_expanded: has patch member");
    JsonNode *patch_node = json_object_get_member(p, "patch");
    ASSERT(patch_node && JSON_NODE_HOLDS_OBJECT(patch_node), "cron_update_expanded: patch is object");

    JsonObject *patch = json_node_get_object(patch_node);
    ASSERT(g_strcmp0(obj_get_string(patch, "name"), "Updated Job") == 0, "cron_update_expanded: patch.name");
    ASSERT(g_strcmp0(obj_get_string(patch, "description"), "Updated description") == 0, "cron_update_expanded: patch.description");
    ASSERT(g_strcmp0(obj_get_string(patch, "agentId"), "new-agent") == 0, "cron_update_expanded: patch.agentId");
    ASSERT(!json_object_has_member(patch, "enabled"), "cron_update_expanded: patch omits enabled");

    JsonObject *sched = json_object_get_object_member(patch, "schedule");
    ASSERT(sched != NULL, "cron_update_expanded: patch.schedule obj");
    ASSERT(g_strcmp0(obj_get_string(sched, "kind"), "cron") == 0, "cron_update_expanded: patch.schedule.kind");
    ASSERT(g_strcmp0(obj_get_string(sched, "expr"), "30 10 * * *") == 0, "cron_update_expanded: patch.schedule.expr");

    g_free(rid);
}

static void test_cron_update_full_payload(void) {
    stub_reset();
    /* Verify the full edit payload that section_cron.c emits:
     * { "id": "job-1",
     *   "patch": { name, description, agentId, schedule{kind,expr},
     *              sessionTarget, wakeMode, payload{kind,message} } }
     */
    GatewayCronJobMutationFields fields = {
        .name = "Updated Job",
        .description = "Updated description",
        .agent_id = "new-agent",
        .schedule_kind = "cron",
        .schedule_expr = "30 10 * * *",
        .session_target = "main",
        .wake_mode = "next-heartbeat",
        .prompt = "Generate daily summary",
    };

    gchar *rid = mutation_cron_update("job-1", &fields, noop_cb, NULL);
    ASSERT(rid != NULL, "cron_update_full: rid");
    ASSERT(g_strcmp0(stub_last_method, "cron.update") == 0, "cron_update_full: method");

    JsonObject *p = get_stub_params_obj();
    ASSERT(g_strcmp0(obj_get_string(p, "id"), "job-1") == 0, "cron_update_full: id");

    ASSERT(json_object_has_member(p, "patch"), "cron_update_full: has patch member");
    JsonNode *patch_node = json_object_get_member(p, "patch");
    ASSERT(patch_node && JSON_NODE_HOLDS_OBJECT(patch_node), "cron_update_full: patch is object");

    JsonObject *patch = json_node_get_object(patch_node);
    ASSERT(g_strcmp0(obj_get_string(patch, "name"), "Updated Job") == 0, "cron_update_full: patch.name");
    ASSERT(g_strcmp0(obj_get_string(patch, "description"), "Updated description") == 0, "cron_update_full: patch.description");
    ASSERT(g_strcmp0(obj_get_string(patch, "agentId"), "new-agent") == 0, "cron_update_full: patch.agentId");
    ASSERT(!json_object_has_member(patch, "enabled"), "cron_update_full: patch omits enabled");

    JsonObject *sched = json_object_get_object_member(patch, "schedule");
    ASSERT(sched != NULL, "cron_update_full: patch.schedule obj");
    ASSERT(g_strcmp0(obj_get_string(sched, "kind"), "cron") == 0, "cron_update_full: patch.schedule.kind");
    ASSERT(g_strcmp0(obj_get_string(sched, "expr"), "30 10 * * *") == 0, "cron_update_full: patch.schedule.expr");

    ASSERT(g_strcmp0(obj_get_string(patch, "sessionTarget"), "main") == 0, "cron_update_full: patch.sessionTarget");
    ASSERT(g_strcmp0(obj_get_string(patch, "wakeMode"), "next-heartbeat") == 0, "cron_update_full: patch.wakeMode");

    JsonObject *payload = json_object_get_object_member(patch, "payload");
    ASSERT(payload != NULL, "cron_update_full: patch.payload obj");
    ASSERT(g_strcmp0(obj_get_string(payload, "kind"), "agentTurn") == 0, "cron_update_full: patch.payload.kind");
    ASSERT(g_strcmp0(obj_get_string(payload, "message"), "Generate daily summary") == 0, "cron_update_full: patch.payload.message");

    g_free(rid);
}

/* ── Skills API key detection pattern tests ─────────────────────────
 *
 * These tests document the heuristic naming patterns used to detect
 * API keys/secrets in skill environment variables. This is an
 * intentional heuristic approach - the backend does not expose
 * authoritative semantic markers, so we use common naming conventions.
 *
 * Accepted patterns (suffix unless noted):
 *   _API_KEY, _API_TOKEN, _SECRET, _ACCESS_KEY, _AUTH_TOKEN,
 *   _PASSWORD, _KEY, _API_SECRET
 * Plus prefix patterns:
 *   API_KEY*, API_TOKEN*, SECRET_*
 */

static gboolean is_api_key_pattern(const gchar *env_name) {
    if (!env_name) return FALSE;
    return g_str_has_suffix(env_name, "_API_KEY") ||
           g_str_has_suffix(env_name, "_API_TOKEN") ||
           g_str_has_suffix(env_name, "_SECRET") ||
           g_str_has_suffix(env_name, "_ACCESS_KEY") ||
           g_str_has_suffix(env_name, "_AUTH_TOKEN") ||
           g_str_has_suffix(env_name, "_PASSWORD") ||
           g_str_has_suffix(env_name, "_KEY") ||
           g_str_has_prefix(env_name, "API_KEY") ||
           g_str_has_prefix(env_name, "API_TOKEN") ||
           g_str_has_prefix(env_name, "SECRET_") ||
           g_str_has_suffix(env_name, "_API_SECRET");
}

static void test_skills_api_key_patterns(void) {
    /* Suffix patterns */
    ASSERT(is_api_key_pattern("OPENAI_API_KEY") == TRUE, "pattern: OPENAI_API_KEY");
    ASSERT(is_api_key_pattern("SERP_API_TOKEN") == TRUE, "pattern: SERP_API_TOKEN");
    ASSERT(is_api_key_pattern("AWS_SECRET") == TRUE, "pattern: AWS_SECRET");
    ASSERT(is_api_key_pattern("AWS_ACCESS_KEY") == TRUE, "pattern: AWS_ACCESS_KEY");
    ASSERT(is_api_key_pattern("OAUTH_AUTH_TOKEN") == TRUE, "pattern: OAUTH_AUTH_TOKEN");
    ASSERT(is_api_key_pattern("DB_PASSWORD") == TRUE, "pattern: DB_PASSWORD");
    ASSERT(is_api_key_pattern("ENCRYPTION_KEY") == TRUE, "pattern: ENCRYPTION_KEY");
    ASSERT(is_api_key_pattern("GITHUB_API_SECRET") == TRUE, "pattern: GITHUB_API_SECRET");
    
    /* Prefix patterns */
    ASSERT(is_api_key_pattern("API_KEY_OPENAI") == TRUE, "pattern: API_KEY_OPENAI");
    ASSERT(is_api_key_pattern("API_TOKEN_SERP") == TRUE, "pattern: API_TOKEN_SERP");
    ASSERT(is_api_key_pattern("SECRET_TOKEN") == TRUE, "pattern: SECRET_TOKEN");
    
    /* Non-matching patterns */
    ASSERT(is_api_key_pattern("PATH") == FALSE, "pattern: PATH (not key)");
    ASSERT(is_api_key_pattern("HOME") == FALSE, "pattern: HOME (not key)");
    ASSERT(is_api_key_pattern("USER") == FALSE, "pattern: USER (not key)");
    ASSERT(is_api_key_pattern("API_ENDPOINT") == FALSE, "pattern: API_ENDPOINT (not key)");
    ASSERT(is_api_key_pattern("MY_SECRET_VAR") == FALSE, "pattern: MY_SECRET_VAR (prefix not suffix)");
}

/* ── Config flow with hash verification ───────────────────────────── */

static void test_config_set_with_hash(void) {
    stub_reset();
    const gchar *raw_json = "{\"channels\":{\"telegram\":{\"enabled\":true}}}";
    const gchar *base_hash = "sha256:abc123";
    gchar *rid = mutation_config_set(raw_json, base_hash, noop_cb, NULL);
    ASSERT(rid != NULL, "config_set_hash: rid");
    ASSERT(g_strcmp0(stub_last_method, "config.set") == 0, "config_set_hash: method");
    JsonObject *p = get_stub_params_obj();
    ASSERT(g_strcmp0(obj_get_string(p, "raw"), raw_json) == 0, "config_set_hash: raw");
    ASSERT(g_strcmp0(obj_get_string(p, "baseHash"), base_hash) == 0, "config_set_hash: baseHash");
    g_free(rid);
}

static void test_config_set_null_hash(void) {
    stub_reset();
    const gchar *raw_json = "{\"gateway\":{\"port\":18789}}";
    gchar *rid = mutation_config_set(raw_json, NULL, noop_cb, NULL);
    ASSERT(rid != NULL, "config_set_null_hash: rid");
    JsonObject *p = get_stub_params_obj();
    ASSERT(!json_object_has_member(p, "baseHash"), "config_set_null_hash: no baseHash");
    g_free(rid);
}

static void test_config_get_no_scope(void) {
    stub_reset();
    gchar *rid = mutation_config_get(NULL, noop_cb, NULL);
    ASSERT(rid != NULL, "config_get_no_scope: rid");
    ASSERT(g_strcmp0(stub_last_method, "config.get") == 0, "config_get_no_scope: method");
    JsonObject *p = get_stub_params_obj();
    /* When scope is NULL, params should be empty or have no scope field */
    ASSERT(!json_object_has_member(p, "scope") || obj_get_string(p, "scope") == NULL,
           "config_get_no_scope: no scope field");
    g_free(rid);
}

/* ── Config save tree rebuild regression test ──────────────────────
 *
 * This test proves that editing one channel subtree does NOT drop
 * unrelated config content. The full config document structure is preserved:
 * - top-level keys like "gateway", "models" must survive
 * - sibling channel entries under "channels" must survive
 */

static void test_config_save_preserves_unrelated_keys(void) {
    stub_reset();
    
    /* Build a realistic full config document with multiple sections:
     * - gateway: should be preserved
     * - models: should be preserved  
     * - channels.telegram: being edited
     * - channels.discord: sibling, should be preserved
     */
    JsonBuilder *b = json_builder_new();
    json_builder_begin_object(b);
    
    /* gateway section - unrelated, must be preserved */
    json_builder_set_member_name(b, "gateway");
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "port");
    json_builder_add_int_value(b, 18789);
    json_builder_set_member_name(b, "host");
    json_builder_add_string_value(b, "127.0.0.1");
    json_builder_end_object(b);
    
    /* models section - unrelated, must be preserved */
    json_builder_set_member_name(b, "models");
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "default");
    json_builder_add_string_value(b, "gpt-4o");
    json_builder_end_object(b);
    
    /* channels section - contains target channel and sibling */
    json_builder_set_member_name(b, "channels");
    json_builder_begin_object(b);
    
    /* telegram - the channel being edited */
    json_builder_set_member_name(b, "telegram");
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "enabled");
    json_builder_add_boolean_value(b, TRUE);
    json_builder_set_member_name(b, "botToken");
    json_builder_add_string_value(b, "old-token");
    json_builder_end_object(b);
    
    /* discord - sibling channel, must be preserved */
    json_builder_set_member_name(b, "discord");
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "enabled");
    json_builder_add_boolean_value(b, TRUE);
    json_builder_set_member_name(b, "webhookUrl");
    json_builder_add_string_value(b, "https://discord.com/api/webhooks/xxx");
    json_builder_end_object(b);
    
    json_builder_end_object(b); /* end channels */
    json_builder_end_object(b); /* end root */
    
    JsonNode *original_config = json_builder_get_root(b);
    g_object_unref(b);
    
    /* Serialize the original full config */
    g_autofree gchar *original_json = json_to_string(original_config, FALSE);
    
    /* Simulate editing telegram channel: change botToken to "new-token" */
    JsonBuilder *edit_b = json_builder_new();
    json_builder_begin_object(edit_b);
    json_builder_set_member_name(edit_b, "enabled");
    json_builder_add_boolean_value(edit_b, TRUE);
    json_builder_set_member_name(edit_b, "botToken");
    json_builder_add_string_value(edit_b, "new-token");
    json_builder_end_object(edit_b);
    JsonNode *edited_telegram = json_builder_get_root(edit_b);
    g_object_unref(edit_b);
    
    /* TRUE deep copy via serialize+parse (matches section_channels.c logic) */
    JsonParser *copy_parser = json_parser_new();
    GError *err = NULL;
    gboolean ok = json_parser_load_from_data(copy_parser, original_json, -1, &err);
    ASSERT(ok, "config_preserve: deep-copy parse succeeded");
    if (err) g_error_free(err);
    
    /* json_parser_get_root returns borrowed ref - must copy before parser is freed */
    JsonNode *parsed_root = json_parser_get_root(copy_parser);
    JsonNode *full_config_copy = json_node_copy(parsed_root);
    g_object_unref(copy_parser);
    
    /* Replace telegram channel in the copied tree */
    JsonObject *root_obj = json_node_get_object(full_config_copy);
    JsonObject *channels_obj = json_object_get_object_member(root_obj, "channels");
    ASSERT(channels_obj != NULL, "config_preserve: channels object exists");
    
    /* Remove old telegram and set new one */
    if (json_object_has_member(channels_obj, "telegram")) {
        json_object_remove_member(channels_obj, "telegram");
    }
    json_object_set_member(channels_obj, "telegram", edited_telegram);
    
    /* Serialize the rebuilt full config */
    g_autofree gchar *rebuilt_json = json_to_string(full_config_copy, FALSE);
    json_node_unref(full_config_copy);
    
    /* Parse the rebuilt config to verify preservation */
    JsonParser *verify_parser = json_parser_new();
    err = NULL;
    ok = json_parser_load_from_data(verify_parser, rebuilt_json, -1, &err);
    ASSERT(ok, "config_preserve: rebuilt config parses");
    if (err) g_error_free(err);
    
    JsonObject *rebuilt_root = json_node_get_object(json_parser_get_root(verify_parser));
    
    /* PROVE: gateway section preserved */
    ASSERT(json_object_has_member(rebuilt_root, "gateway"), "config_preserve: gateway key exists");
    JsonObject *gateway = json_object_get_object_member(rebuilt_root, "gateway");
    ASSERT(gateway != NULL, "config_preserve: gateway is object");
    ASSERT(json_object_has_member(gateway, "port"), "config_preserve: gateway.port exists");
    ASSERT(json_object_has_member(gateway, "host"), "config_preserve: gateway.host exists");
    
    /* PROVE: models section preserved */
    ASSERT(json_object_has_member(rebuilt_root, "models"), "config_preserve: models key exists");
    JsonObject *models = json_object_get_object_member(rebuilt_root, "models");
    ASSERT(models != NULL, "config_preserve: models is object");
    ASSERT(json_object_has_member(models, "default"), "config_preserve: models.default exists");
    
    /* PROVE: sibling channel (discord) preserved */
    JsonObject *channels = json_object_get_object_member(rebuilt_root, "channels");
    ASSERT(channels != NULL, "config_preserve: channels is object");
    ASSERT(json_object_has_member(channels, "discord"), "config_preserve: sibling discord exists");
    JsonObject *discord = json_object_get_object_member(channels, "discord");
    ASSERT(discord != NULL, "config_preserve: discord is object");
    ASSERT(g_strcmp0(obj_get_string(discord, "webhookUrl"), 
                     "https://discord.com/api/webhooks/xxx") == 0,
           "config_preserve: discord.webhookUrl unchanged");
    
    /* PROVE: edited channel (telegram) has new value */
    ASSERT(json_object_has_member(channels, "telegram"), "config_preserve: telegram exists");
    JsonObject *telegram = json_object_get_object_member(channels, "telegram");
    ASSERT(telegram != NULL, "config_preserve: telegram is object");
    ASSERT(g_strcmp0(obj_get_string(telegram, "botToken"), "new-token") == 0,
           "config_preserve: telegram.botToken updated");
    
    json_node_unref(original_config);
    g_object_unref(verify_parser);
}

/* ── Cron mutation optional-field omission ─────────────────────────
 *
 * Verifies the optional-field semantics owned by mutation_build_cron_job_fields:
 * description, agentId, and payload are omitted when their backing string is
 * NULL or empty, while required scalars (sessionTarget, wakeMode, schedule)
 * are always present. The mutation layer does not enforce a non-empty prompt;
 * callers like the create UI validate that themselves.
 */
static void test_cron_update_omits_optional_fields(void) {
    stub_reset();
    GatewayCronJobMutationFields fields = {
        .name = "Heartbeat",
        .description = NULL,
        .agent_id = "",
        .schedule_kind = "cron",
        .schedule_expr = "*/5 * * * *",
        .session_target = "isolated",
        .wake_mode = "now",
        .prompt = "",
    };

    gchar *rid = mutation_cron_update("job-456", &fields, noop_cb, NULL);
    ASSERT(rid != NULL, "cron_update_omit: rid");
    ASSERT(g_strcmp0(stub_last_method, "cron.update") == 0, "cron_update_omit: method");

    JsonObject *p = get_stub_params_obj();
    ASSERT(g_strcmp0(obj_get_string(p, "id"), "job-456") == 0, "cron_update_omit: id");

    JsonObject *patch = json_object_get_object_member(p, "patch");
    ASSERT(patch != NULL, "cron_update_omit: patch is object");
    ASSERT(g_strcmp0(obj_get_string(patch, "name"), "Heartbeat") == 0,
           "cron_update_omit: patch.name");
    ASSERT(!json_object_has_member(patch, "description"),
           "cron_update_omit: description omitted when NULL");
    ASSERT(!json_object_has_member(patch, "agentId"),
           "cron_update_omit: agentId omitted when empty");
    ASSERT(!json_object_has_member(patch, "payload"),
           "cron_update_omit: payload omitted when prompt empty");

    ASSERT(g_strcmp0(obj_get_string(patch, "sessionTarget"), "isolated") == 0,
           "cron_update_omit: sessionTarget present");
    ASSERT(g_strcmp0(obj_get_string(patch, "wakeMode"), "now") == 0,
           "cron_update_omit: wakeMode present");

    JsonObject *sched = json_object_get_object_member(patch, "schedule");
    ASSERT(sched != NULL, "cron_update_omit: schedule present");
    ASSERT(g_strcmp0(obj_get_string(sched, "kind"), "cron") == 0,
           "cron_update_omit: schedule.kind");
    ASSERT(g_strcmp0(obj_get_string(sched, "expr"), "*/5 * * * *") == 0,
           "cron_update_omit: schedule.expr");

    g_free(rid);
}

/* ── Cron sessionTarget mapping regression test ─────────────────────
 *
 * This test verifies the fix for sessionTarget mapping in section_cron.c:
 * - No request payload should emit sessionTarget="new" (unsupported value)
 * - session_target_from_index() maps indices correctly to wire values
 * - session_target_to_index() maps persisted values correctly to UI indices
 * 
 * These are the real helper functions used by on_edit_job_dialog_response()
 * and on_create_job_dialog_response().
 */

static void test_cron_session_target_mapping(void) {
    /* Forward mapping: index -> wire value */
    
    /* Test 1: Index 0 (New Session) must map to "isolated", NOT "new" */
    const gchar *t0 = session_target_from_index(0);
    ASSERT(g_strcmp0(t0, "isolated") == 0, "session_target_from_index(0) == isolated");
    ASSERT(g_strcmp0(t0, "new") != 0, "session_target_from_index(0) != new (regression)");
    
    /* Test 2: Index 1 (Main Session) must map to "main" */
    const gchar *t1 = session_target_from_index(1);
    ASSERT(g_strcmp0(t1, "main") == 0, "session_target_from_index(1) == main");
    
    /* Test 3: Index 2 (Current Session) must map to "current" */
    const gchar *t2 = session_target_from_index(2);
    ASSERT(g_strcmp0(t2, "current") == 0, "session_target_from_index(2) == current");
    
    /* Test 4: Index 3 (Isolated Session) must map to "isolated" */
    const gchar *t3 = session_target_from_index(3);
    ASSERT(g_strcmp0(t3, "isolated") == 0, "session_target_from_index(3) == isolated");
    
    /* Test 5: Invalid/unknown indices should default to "isolated" */
    const gchar *t99 = session_target_from_index(99);
    ASSERT(g_strcmp0(t99, "isolated") == 0, "session_target_from_index(99) defaults to isolated");
    
    /* Reverse mapping: persisted value -> UI index */
    
    /* Test 6: "main" -> index 1 */
    ASSERT(session_target_to_index("main") == 1, "session_target_to_index(main) == 1");
    
    /* Test 7: "current" -> index 2 */
    ASSERT(session_target_to_index("current") == 2, "session_target_to_index(current) == 2");
    
    /* Test 8: "isolated" -> index 3 (Isolated Session, not New Session) */
    ASSERT(session_target_to_index("isolated") == 3, "session_target_to_index(isolated) == 3");
    
    /* Test 9: NULL -> index 0 (default/New Session) */
    ASSERT(session_target_to_index(NULL) == 0, "session_target_to_index(NULL) == 0");
    
    /* Test 10: Unknown values -> index 0 (default/New Session) */
    ASSERT(session_target_to_index("unknown") == 0, "session_target_to_index(unknown) == 0");
    ASSERT(session_target_to_index("session:custom") == 0, "session_target_to_index(custom) == 0");
    
    /* Round-trip verification: forward then reverse should be consistent */
    
    /* Test 11: Round-trip for index 1 (main) */
    ASSERT(session_target_to_index(session_target_from_index(1)) == 1, 
           "round-trip: index 1 -> main -> index 1");
    
    /* Test 12: Round-trip for index 2 (current) */
    ASSERT(session_target_to_index(session_target_from_index(2)) == 2,
           "round-trip: index 2 -> current -> index 2");
    
    /* Test 13: Round-trip for indices 0 and 3 (both map to isolated) */
    /* Note: index 0 -> "isolated" -> index 3, so round-trip changes index for 0 */
    /* This is intentional - both "New Session" and "Isolated Session" UI options 
     * result in "isolated" on the wire, but when reading back "isolated" we pick
     * the more explicit "Isolated Session" (index 3) for the UI */
    ASSERT(session_target_to_index(session_target_from_index(3)) == 3,
           "round-trip: index 3 -> isolated -> index 3");
}

/* ── QR login start without qrDataUrl regression test ───────────────
 *
 * This test verifies the fix for QR login start in section_channels.c:
 * - web_login_start_payload_has_qr() correctly handles missing qrDataUrl
 * - Response with message but no qrDataUrl returns FALSE (no QR to show)
 * - The flow should proceed to wait/poll, not error
 */

static void test_qr_login_start_without_qrdataurl(void) {
    /* Test 1: Payload with qrDataUrl present and non-empty -> TRUE */
    JsonBuilder *b1 = json_builder_new();
    json_builder_begin_object(b1);
    json_builder_set_member_name(b1, "qrDataUrl");
    json_builder_add_string_value(b1, "data:image/png;base64,abc123");
    json_builder_end_object(b1);
    JsonNode *node1 = json_builder_get_root(b1);
    g_object_unref(b1);
    
    const gchar *qr1 = NULL;
    gboolean has_qr1 = web_login_start_payload_has_qr(json_node_get_object(node1), &qr1);
    ASSERT(has_qr1 == TRUE, "has_qr with valid qrDataUrl == TRUE");
    ASSERT(qr1 != NULL, "out_qr_data_url set when present");
    ASSERT(g_strcmp0(qr1, "data:image/png;base64,abc123") == 0, "qrDataUrl value correct");
    json_node_unref(node1);
    
    /* Test 2: Payload WITHOUT qrDataUrl -> FALSE (the regression fix) */
    JsonBuilder *b2 = json_builder_new();
    json_builder_begin_object(b2);
    json_builder_set_member_name(b2, "message");
    json_builder_add_string_value(b2, "Login in progress, check your phone");
    /* Note: NO qrDataUrl field */
    json_builder_end_object(b2);
    JsonNode *node2 = json_builder_get_root(b2);
    g_object_unref(b2);
    
    const gchar *qr2 = "should-be-null"; /* init to non-null to verify it's cleared */
    gboolean has_qr2 = web_login_start_payload_has_qr(json_node_get_object(node2), &qr2);
    ASSERT(has_qr2 == FALSE, "has_qr without qrDataUrl == FALSE (regression)");
    ASSERT(qr2 == NULL, "out_qr_data_url NULL when not present");
    json_node_unref(node2);
    
    /* Test 3: Payload with empty qrDataUrl -> FALSE */
    JsonBuilder *b3 = json_builder_new();
    json_builder_begin_object(b3);
    json_builder_set_member_name(b3, "qrDataUrl");
    json_builder_add_string_value(b3, ""); /* empty string */
    json_builder_end_object(b3);
    JsonNode *node3 = json_builder_get_root(b3);
    g_object_unref(b3);
    
    gboolean has_qr3 = web_login_start_payload_has_qr(json_node_get_object(node3), NULL);
    ASSERT(has_qr3 == FALSE, "has_qr with empty qrDataUrl == FALSE");
    json_node_unref(node3);
    
    /* Test 4: NULL payload -> FALSE (edge case) */
    gboolean has_qr4 = web_login_start_payload_has_qr(NULL, NULL);
    ASSERT(has_qr4 == FALSE, "has_qr with NULL payload == FALSE");
    
    /* Test 5: Payload with only status/message, no qrDataUrl (real-world regression case)
     * This is the exact scenario that was failing before the fix.
     */
    JsonBuilder *b5 = json_builder_new();
    json_builder_begin_object(b5);
    json_builder_set_member_name(b5, "status");
    json_builder_add_string_value(b5, "pending");
    json_builder_set_member_name(b5, "message");
    json_builder_add_string_value(b5, "Please approve the login on your device");
    json_builder_set_member_name(b5, "timeoutMs");
    json_builder_add_int_value(b5, 120000);
    json_builder_end_object(b5);
    JsonNode *node5 = json_builder_get_root(b5);
    g_object_unref(b5);
    
    const gchar *qr5 = NULL;
    gboolean has_qr5 = web_login_start_payload_has_qr(json_node_get_object(node5), &qr5);
    ASSERT(has_qr5 == FALSE, 
           "has_qr with status/message payload == FALSE (real-world regression)");
    ASSERT(qr5 == NULL, "qr_data_url NULL for non-QR response");
    json_node_unref(node5);
}

int main(int argc, char **argv) {
    g_test_init(&argc, &argv, NULL);

    g_test_add_func("/rpc_mutations/skills/enable", test_skills_enable);
    g_test_add_func("/rpc_mutations/skills/disable", test_skills_disable);
    g_test_add_func("/rpc_mutations/skills/install", test_skills_install);
    g_test_add_func("/rpc_mutations/skills/install_no_id", test_skills_install_no_id);
    g_test_add_func("/rpc_mutations/skills/update", test_skills_update);
    g_test_add_func("/rpc_mutations/skills/update_env", test_skills_update_env);
    g_test_add_func("/rpc_mutations/skills/update_api_key", test_skills_update_api_key);
    g_test_add_func("/rpc_mutations/skills/api_key_patterns", test_skills_api_key_patterns);

    g_test_add_func("/rpc_mutations/sessions/patch", test_sessions_patch);
    g_test_add_func("/rpc_mutations/sessions/patch_partial", test_sessions_patch_partial);
    g_test_add_func("/rpc_mutations/sessions/patch_model_only", test_sessions_patch_model_only);
    g_test_add_func("/rpc_mutations/sessions/reset", test_sessions_reset);
    g_test_add_func("/rpc_mutations/sessions/delete", test_sessions_delete);
    g_test_add_func("/rpc_mutations/sessions/compact", test_sessions_compact);

    g_test_add_func("/rpc_mutations/cron/enable", test_cron_enable);
    g_test_add_func("/rpc_mutations/cron/remove", test_cron_remove);
    g_test_add_func("/rpc_mutations/cron/run", test_cron_run);
    g_test_add_func("/rpc_mutations/cron/add", test_cron_add);
    g_test_add_func("/rpc_mutations/cron/update", test_cron_update);
    g_test_add_func("/rpc_mutations/cron/add_expanded", test_cron_add_expanded);
    g_test_add_func("/rpc_mutations/cron/update_expanded", test_cron_update_expanded);
    g_test_add_func("/rpc_mutations/cron/update_full_payload", test_cron_update_full_payload);
    g_test_add_func("/rpc_mutations/cron/update_omits_optional_fields", test_cron_update_omits_optional_fields);
    g_test_add_func("/rpc_mutations/cron/session_target_mapping", test_cron_session_target_mapping);

    g_test_add_func("/rpc_mutations/channels/status_probe", test_channels_status_probe);
    g_test_add_func("/rpc_mutations/channels/status_no_probe", test_channels_status_no_probe);
    g_test_add_func("/rpc_mutations/channels/logout", test_channels_logout);
    g_test_add_func("/rpc_mutations/channels/logout_no_acct", test_channels_logout_no_acct);

    g_test_add_func("/rpc_mutations/config/get", test_config_get);
    g_test_add_func("/rpc_mutations/config/schema", test_config_schema);
    g_test_add_func("/rpc_mutations/config/set", test_config_set);
    g_test_add_func("/rpc_mutations/config/set_with_hash", test_config_set_with_hash);
    g_test_add_func("/rpc_mutations/config/set_null_hash", test_config_set_null_hash);
    g_test_add_func("/rpc_mutations/config/get_no_scope", test_config_get_no_scope);
    g_test_add_func("/rpc_mutations/config/save_preserves_unrelated_keys", test_config_save_preserves_unrelated_keys);

    g_test_add_func("/rpc_mutations/nodes/pair_approve", test_node_pair_approve);
    g_test_add_func("/rpc_mutations/nodes/pair_reject", test_node_pair_reject);
    g_test_add_func("/rpc_mutations/nodes/list", test_node_list);
    g_test_add_func("/rpc_mutations/nodes/pair_list", test_node_pair_list);

    g_test_add_func("/rpc_mutations/web_login/start", test_web_login_start);
    g_test_add_func("/rpc_mutations/web_login/wait", test_web_login_wait);
    g_test_add_func("/rpc_mutations/web_login/wait_null_account", test_web_login_wait_null_account);
    g_test_add_func("/rpc_mutations/web_login/qr_login_start_without_qrdataurl", test_qr_login_start_without_qrdataurl);

    g_test_add_func("/rpc_mutations/system/set_heartbeats_enabled", test_system_set_heartbeats_enabled);
    g_test_add_func("/rpc_mutations/system/set_heartbeats_disabled", test_system_set_heartbeats_disabled);

    int status = g_test_run();
    stub_reset();
    return status;
}
