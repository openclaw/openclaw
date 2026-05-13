/*
 * test_exec_approval_request.c
 *
 * Headless coverage for the exec-approval request parser. Pure-C /
 * json-glib; no GTK linkage required.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "../src/exec_approval_request.h"

#include <glib.h>
#include <json-glib/json-glib.h>
#include <string.h>

static JsonNode* build_full_payload(void) {
    JsonBuilder *b = json_builder_new();
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "id");
    json_builder_add_string_value(b, "req-1");

    json_builder_set_member_name(b, "request");
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "command");
    json_builder_add_string_value(b, "rm -rf /");
    json_builder_set_member_name(b, "cwd");
    json_builder_add_string_value(b, "/tmp");
    json_builder_set_member_name(b, "host");
    json_builder_add_string_value(b, "node");
    json_builder_set_member_name(b, "nodeId");
    json_builder_add_string_value(b, "node-7");
    json_builder_set_member_name(b, "agentId");
    json_builder_add_string_value(b, "agent-007");
    json_builder_set_member_name(b, "resolvedPath");
    json_builder_add_string_value(b, "/usr/bin/rm");
    json_builder_set_member_name(b, "security");
    json_builder_add_string_value(b, "allowlist");
    json_builder_set_member_name(b, "ask");
    json_builder_add_string_value(b, "always");
    json_builder_set_member_name(b, "sessionKey");
    json_builder_add_string_value(b, "sess-9");
    json_builder_set_member_name(b, "allowedDecisions");
    json_builder_begin_array(b);
    json_builder_add_string_value(b, "allow-once");
    json_builder_add_string_value(b, "deny");
    json_builder_end_array(b);
    json_builder_end_object(b);

    json_builder_set_member_name(b, "createdAtMs");
    json_builder_add_int_value(b, 1000);
    json_builder_set_member_name(b, "expiresAtMs");
    json_builder_add_int_value(b, 60000);
    json_builder_end_object(b);

    JsonNode *root = json_builder_get_root(b);
    g_object_unref(b);
    return root;
}

static void test_parse_full_payload(void) {
    g_autoptr(JsonNode) payload = build_full_payload();
    OcExecApprovalRequest *req = oc_exec_approval_request_new_from_event(payload);
    g_assert_nonnull(req);

    g_assert_cmpstr(req->id, ==, "req-1");
    g_assert_cmpstr(req->command, ==, "rm -rf /");
    g_assert_cmpstr(req->cwd, ==, "/tmp");
    g_assert_cmpstr(req->host, ==, "node");
    g_assert_cmpstr(req->node_id, ==, "node-7");
    g_assert_cmpstr(req->agent_id, ==, "agent-007");
    g_assert_cmpstr(req->resolved_path, ==, "/usr/bin/rm");
    g_assert_cmpstr(req->security, ==, "allowlist");
    g_assert_cmpstr(req->ask, ==, "always");
    g_assert_cmpstr(req->session_key, ==, "sess-9");
    g_assert_cmpint(req->created_at_ms, ==, 1000);
    g_assert_cmpint(req->expires_at_ms, ==, 60000);

    g_assert_nonnull(req->allowed_decisions);
    g_assert_cmpstr(req->allowed_decisions[0], ==, "allow-once");
    g_assert_cmpstr(req->allowed_decisions[1], ==, "deny");
    g_assert_null(req->allowed_decisions[2]);

    g_assert_true(oc_exec_approval_request_allows_decision(req, "allow-once"));
    g_assert_true(oc_exec_approval_request_allows_decision(req, "deny"));
    g_assert_false(oc_exec_approval_request_allows_decision(req, "allow-always"));

    oc_exec_approval_request_free(req);
}

static void test_parse_minimal_payload(void) {
    JsonBuilder *b = json_builder_new();
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "id");
    json_builder_add_string_value(b, "req-min");
    json_builder_set_member_name(b, "request");
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "command");
    json_builder_add_string_value(b, "ls");
    json_builder_end_object(b);
    json_builder_set_member_name(b, "createdAtMs");
    json_builder_add_int_value(b, 1);
    json_builder_set_member_name(b, "expiresAtMs");
    json_builder_add_int_value(b, 100);
    json_builder_end_object(b);
    g_autoptr(JsonNode) payload = json_builder_get_root(b);
    g_object_unref(b);

    OcExecApprovalRequest *req = oc_exec_approval_request_new_from_event(payload);
    g_assert_nonnull(req);
    g_assert_cmpstr(req->id, ==, "req-min");
    g_assert_cmpstr(req->command, ==, "ls");
    g_assert_null(req->cwd);
    g_assert_null(req->agent_id);
    g_assert_null(req->allowed_decisions);
    /* Omitted constraint = all decisions allowed. */
    g_assert_true(oc_exec_approval_request_allows_decision(req, "allow-once"));
    g_assert_true(oc_exec_approval_request_allows_decision(req, "allow-always"));
    g_assert_true(oc_exec_approval_request_allows_decision(req, "deny"));
    oc_exec_approval_request_free(req);
}

static void test_reject_missing_id(void) {
    JsonBuilder *b = json_builder_new();
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "request");
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "command");
    json_builder_add_string_value(b, "ls");
    json_builder_end_object(b);
    json_builder_set_member_name(b, "createdAtMs");
    json_builder_add_int_value(b, 1);
    json_builder_set_member_name(b, "expiresAtMs");
    json_builder_add_int_value(b, 100);
    json_builder_end_object(b);
    g_autoptr(JsonNode) payload = json_builder_get_root(b);
    g_object_unref(b);

    OcExecApprovalRequest *req = oc_exec_approval_request_new_from_event(payload);
    g_assert_null(req);
}

static void test_reject_missing_command(void) {
    JsonBuilder *b = json_builder_new();
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "id");
    json_builder_add_string_value(b, "req-x");
    json_builder_set_member_name(b, "request");
    json_builder_begin_object(b);
    json_builder_end_object(b);
    json_builder_set_member_name(b, "createdAtMs");
    json_builder_add_int_value(b, 1);
    json_builder_set_member_name(b, "expiresAtMs");
    json_builder_add_int_value(b, 100);
    json_builder_end_object(b);
    g_autoptr(JsonNode) payload = json_builder_get_root(b);
    g_object_unref(b);

    OcExecApprovalRequest *req = oc_exec_approval_request_new_from_event(payload);
    g_assert_null(req);
}

static void test_reject_missing_timestamps(void) {
    JsonBuilder *b = json_builder_new();
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "id");
    json_builder_add_string_value(b, "req-x");
    json_builder_set_member_name(b, "request");
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "command");
    json_builder_add_string_value(b, "ls");
    json_builder_end_object(b);
    json_builder_end_object(b);
    g_autoptr(JsonNode) payload = json_builder_get_root(b);
    g_object_unref(b);

    OcExecApprovalRequest *req = oc_exec_approval_request_new_from_event(payload);
    g_assert_null(req);
}

static void test_expired_helper(void) {
    g_autoptr(JsonNode) payload = build_full_payload();
    OcExecApprovalRequest *req = oc_exec_approval_request_new_from_event(payload);
    g_assert_nonnull(req);
    g_assert_false(oc_exec_approval_request_is_expired(req, 0));
    g_assert_false(oc_exec_approval_request_is_expired(req, 59999));
    g_assert_true(oc_exec_approval_request_is_expired(req, 60000));
    g_assert_true(oc_exec_approval_request_is_expired(req, 70000));
    oc_exec_approval_request_free(req);
}

static void test_copy_round_trip(void) {
    g_autoptr(JsonNode) payload = build_full_payload();
    OcExecApprovalRequest *src = oc_exec_approval_request_new_from_event(payload);
    g_assert_nonnull(src);

    OcExecApprovalRequest *dup = oc_exec_approval_request_copy(src);
    g_assert_nonnull(dup);
    g_assert_cmpstr(dup->id, ==, src->id);
    g_assert_cmpstr(dup->command, ==, src->command);
    g_assert_cmpstr(dup->agent_id, ==, src->agent_id);
    g_assert_cmpint(dup->expires_at_ms, ==, src->expires_at_ms);
    g_assert_nonnull(dup->allowed_decisions);
    g_assert_cmpstr(dup->allowed_decisions[0], ==, "allow-once");
    /* Distinct allocations. */
    g_assert_true(dup->id != src->id);
    g_assert_true(dup->command != src->command);

    oc_exec_approval_request_free(src);
    oc_exec_approval_request_free(dup);
}

int main(int argc, char **argv) {
    g_test_init(&argc, &argv, NULL);
    g_test_add_func("/exec_approval_request/parse_full",       test_parse_full_payload);
    g_test_add_func("/exec_approval_request/parse_minimal",    test_parse_minimal_payload);
    g_test_add_func("/exec_approval_request/reject_no_id",     test_reject_missing_id);
    g_test_add_func("/exec_approval_request/reject_no_cmd",    test_reject_missing_command);
    g_test_add_func("/exec_approval_request/reject_no_times",  test_reject_missing_timestamps);
    g_test_add_func("/exec_approval_request/expired_helper",   test_expired_helper);
    g_test_add_func("/exec_approval_request/copy_round_trip",  test_copy_round_trip);
    return g_test_run();
}
