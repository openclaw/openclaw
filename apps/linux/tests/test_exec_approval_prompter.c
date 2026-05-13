/*
 * test_exec_approval_prompter.c
 *
 * Headless coverage for the exec-approval prompter state machine. Uses
 * the test seam present hook plus stubs for gateway_ws / gateway_rpc /
 * exec_approval_window so the translation unit links without GTK or a
 * live gateway.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "../src/exec_approval_prompter.h"
#include "../src/exec_approval_request.h"
#include "../src/exec_approval_store.h"
#include "../src/exec_approval_window.h"

#include "../src/gateway_rpc.h"
#include "../src/gateway_ws.h"

#include <glib.h>
#include <glib/gstdio.h>
#include <json-glib/json-glib.h>
#include <string.h>

/* ── gateway_ws stubs ── */

static GatewayWsEventCallback g_ws_event_cb = NULL;
static gpointer               g_ws_event_user = NULL;
static guint                  g_ws_event_id_counter = 0;

guint gateway_ws_event_subscribe(GatewayWsEventCallback callback, gpointer user_data) {
    g_ws_event_cb = callback;
    g_ws_event_user = user_data;
    return ++g_ws_event_id_counter;
}

void gateway_ws_event_unsubscribe(guint listener_id) {
    (void)listener_id;
    g_ws_event_cb = NULL;
    g_ws_event_user = NULL;
}

/* ── gateway_rpc stub ── */

typedef struct {
    gchar *method;
    gchar *id;
    gchar *decision;
} RecordedRpc;

static GPtrArray *g_rpc_calls = NULL;

static void recorded_rpc_free(gpointer data) {
    RecordedRpc *r = data;
    if (!r) return;
    g_free(r->method);
    g_free(r->id);
    g_free(r->decision);
    g_free(r);
}

gchar* gateway_rpc_request(const gchar *method,
                           JsonNode *params_json,
                           guint timeout_ms,
                           GatewayRpcCallback callback,
                           gpointer user_data) {
    (void)timeout_ms;
    (void)callback;
    /* The prompter passes a heap-owned id copy as user_data; if we never
     * invoke the callback the prompter never frees it, so we free it
     * here to keep tests leak-clean. */
    g_free(user_data);

    if (!g_rpc_calls) g_rpc_calls = g_ptr_array_new_with_free_func(recorded_rpc_free);
    RecordedRpc *rec = g_new0(RecordedRpc, 1);
    rec->method = g_strdup(method);
    if (params_json && JSON_NODE_HOLDS_OBJECT(params_json)) {
        JsonObject *obj = json_node_get_object(params_json);
        if (json_object_has_member(obj, "id")) {
            rec->id = g_strdup(json_object_get_string_member(obj, "id"));
        }
        if (json_object_has_member(obj, "decision")) {
            rec->decision = g_strdup(json_object_get_string_member(obj, "decision"));
        }
    }
    g_ptr_array_add(g_rpc_calls, rec);
    return g_strdup("rpc-test-0001");
}

/* ── exec_approval_window stubs ── */

static int    g_dismiss_calls = 0;
static gchar *g_dismiss_last_id = NULL;
static int    g_raise_calls = 0;

void exec_approval_window_present(GtkWindow *parent,
                                  const OcExecApprovalRequest *req,
                                  OcExecDecisionCallback cb,
                                  gpointer user_data) {
    (void)parent; (void)req; (void)cb; (void)user_data;
    g_error("exec_approval_window_present stub invoked — test hook not installed");
}

gboolean exec_approval_window_dismiss_if(const gchar *request_id) {
    g_dismiss_calls++;
    g_clear_pointer(&g_dismiss_last_id, g_free);
    if (request_id) g_dismiss_last_id = g_strdup(request_id);
    return TRUE;
}

void exec_approval_window_raise_active(void) {
    g_raise_calls++;
}

const gchar* oc_exec_decision_to_string(OcExecDecision d) {
    switch (d) {
    case OC_EXEC_DECISION_ALLOW_ONCE:   return "allow-once";
    case OC_EXEC_DECISION_ALLOW_ALWAYS: return "allow-always";
    case OC_EXEC_DECISION_DENY:
    default:                            return "deny";
    }
}

gboolean oc_exec_decision_from_string(const gchar *value, OcExecDecision *out) {
    if (!value || !out) return FALSE;
    if (g_strcmp0(value, "allow-once") == 0)   { *out = OC_EXEC_DECISION_ALLOW_ONCE;   return TRUE; }
    if (g_strcmp0(value, "allow-always") == 0) { *out = OC_EXEC_DECISION_ALLOW_ALWAYS; return TRUE; }
    if (g_strcmp0(value, "deny") == 0)         { *out = OC_EXEC_DECISION_DENY;         return TRUE; }
    return FALSE;
}

gchar* oc_exec_approval_build_body_markup(const OcExecApprovalRequest *req) {
    (void)req;
    return g_strdup("");
}

/* ── Test seam: scripted recorder hook ── */

typedef struct {
    OcExecDecision *scripted_decisions;
    gsize           count;
    gsize           index;
    GPtrArray      *seen_ids;
} ScriptedHook;

static void scripted_present(const OcExecApprovalRequest *req,
                             OcExecDecisionCallback record_decision,
                             gpointer record_user_data,
                             gpointer hook_user_data) {
    ScriptedHook *s = hook_user_data;
    g_ptr_array_add(s->seen_ids, g_strdup(req->id));
    OcExecDecision d = OC_EXEC_DECISION_ALLOW_ONCE;
    if (s->index < s->count) d = s->scripted_decisions[s->index++];
    record_decision(req, d, record_user_data);
}

typedef struct {
    GPtrArray *seen_ids;
} PendingHook;

static void pending_present(const OcExecApprovalRequest *req,
                            OcExecDecisionCallback record_decision,
                            gpointer record_user_data,
                            gpointer hook_user_data) {
    (void)record_decision; (void)record_user_data;
    PendingHook *p = hook_user_data;
    g_ptr_array_add(p->seen_ids, g_strdup(req->id));
    /* Intentionally do not call record_decision; prompter stays presenting. */
}

/* ── Helpers ── */

static void reset_globals(void) {
    if (g_rpc_calls) {
        g_ptr_array_free(g_rpc_calls, TRUE);
        g_rpc_calls = NULL;
    }
    g_dismiss_calls = 0;
    g_clear_pointer(&g_dismiss_last_id, g_free);
    g_raise_calls = 0;
    g_ws_event_cb = NULL;
    g_ws_event_user = NULL;
    g_ws_event_id_counter = 0;
    /* Reset the policy store and pin to ASK so we exercise the
     * prompt-presenting path by default. Individual tests that need
     * Deny/Allow override via exec_approval_store_set_quick_mode. */
    exec_approval_store_test_reset();
    exec_approval_store_test_set_storage_path(NULL);
}

static JsonNode* make_requested_payload_full(const gchar *id,
                                             const gchar *command,
                                             gint64 created_ms,
                                             gint64 expires_ms,
                                             const gchar * const *allowed_decisions) {
    JsonBuilder *b = json_builder_new();
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "id");
    json_builder_add_string_value(b, id);
    json_builder_set_member_name(b, "request");
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "command");
    json_builder_add_string_value(b, command ? command : "ls");
    if (allowed_decisions) {
        json_builder_set_member_name(b, "allowedDecisions");
        json_builder_begin_array(b);
        for (gsize i = 0; allowed_decisions[i]; i++) {
            json_builder_add_string_value(b, allowed_decisions[i]);
        }
        json_builder_end_array(b);
    }
    json_builder_end_object(b);
    json_builder_set_member_name(b, "createdAtMs");
    json_builder_add_int_value(b, created_ms);
    json_builder_set_member_name(b, "expiresAtMs");
    json_builder_add_int_value(b, expires_ms);
    json_builder_end_object(b);
    JsonNode *root = json_builder_get_root(b);
    g_object_unref(b);
    return root;
}

static JsonNode* make_requested_payload(const gchar *id) {
    /* Default: not-yet-expired window from now+1s..now+60s. */
    gint64 now = oc_exec_approval_now_ms();
    return make_requested_payload_full(id, "echo hi",
                                       now + 1000, now + 60000, NULL);
}

static JsonNode* make_resolved_payload(const gchar *id, const gchar *decision) {
    JsonBuilder *b = json_builder_new();
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "id");
    json_builder_add_string_value(b, id);
    if (decision) {
        json_builder_set_member_name(b, "decision");
        json_builder_add_string_value(b, decision);
    }
    json_builder_end_object(b);
    JsonNode *root = json_builder_get_root(b);
    g_object_unref(b);
    return root;
}

/* ── Tests ── */

static void test_single_request_allowed_once(void) {
    reset_globals();
    exec_approval_prompter_init(NULL);

    OcExecDecision decisions[] = { OC_EXEC_DECISION_ALLOW_ONCE };
    ScriptedHook s = {
        .scripted_decisions = decisions,
        .count = 1,
        .seen_ids = g_ptr_array_new_with_free_func(g_free),
    };
    exec_approval_prompter_test_set_present_hook(scripted_present, &s);

    g_autoptr(JsonNode) payload = make_requested_payload("req-1");
    exec_approval_prompter_test_inject_event(payload);

    g_assert_cmpuint(s.seen_ids->len, ==, 1);
    g_assert_cmpstr(g_ptr_array_index(s.seen_ids, 0), ==, "req-1");
    g_assert_cmpuint(exec_approval_prompter_test_queue_len(), ==, 0);
    g_assert_false(exec_approval_prompter_test_is_presenting());

    g_assert_nonnull(g_rpc_calls);
    g_assert_cmpuint(g_rpc_calls->len, ==, 1);
    RecordedRpc *r = g_ptr_array_index(g_rpc_calls, 0);
    g_assert_cmpstr(r->method, ==, "exec.approval.resolve");
    g_assert_cmpstr(r->id, ==, "req-1");
    g_assert_cmpstr(r->decision, ==, "allow-once");

    exec_approval_prompter_test_set_present_hook(NULL, NULL);
    exec_approval_prompter_shutdown();
    g_ptr_array_free(s.seen_ids, TRUE);
}

static void test_concurrent_requests_serialized(void) {
    reset_globals();
    exec_approval_prompter_init(NULL);

    OcExecDecision decisions[] = {
        OC_EXEC_DECISION_ALLOW_ONCE,
        OC_EXEC_DECISION_DENY,
        OC_EXEC_DECISION_ALLOW_ONCE,
    };
    ScriptedHook s = {
        .scripted_decisions = decisions,
        .count = 3,
        .seen_ids = g_ptr_array_new_with_free_func(g_free),
    };
    exec_approval_prompter_test_set_present_hook(scripted_present, &s);

    g_autoptr(JsonNode) p1 = make_requested_payload("req-A");
    g_autoptr(JsonNode) p2 = make_requested_payload("req-B");
    g_autoptr(JsonNode) p3 = make_requested_payload("req-C");
    exec_approval_prompter_test_inject_event(p1);
    exec_approval_prompter_test_inject_event(p2);
    exec_approval_prompter_test_inject_event(p3);

    g_assert_cmpuint(s.seen_ids->len, ==, 3);
    g_assert_cmpstr(g_ptr_array_index(s.seen_ids, 0), ==, "req-A");
    g_assert_cmpstr(g_ptr_array_index(s.seen_ids, 1), ==, "req-B");
    g_assert_cmpstr(g_ptr_array_index(s.seen_ids, 2), ==, "req-C");
    g_assert_cmpuint(g_rpc_calls->len, ==, 3);
    g_assert_cmpstr(((RecordedRpc *)g_ptr_array_index(g_rpc_calls, 1))->decision,
                    ==, "deny");

    exec_approval_prompter_test_set_present_hook(NULL, NULL);
    exec_approval_prompter_shutdown();
    g_ptr_array_free(s.seen_ids, TRUE);
}

static void test_invalid_payload_dropped(void) {
    reset_globals();
    exec_approval_prompter_init(NULL);

    PendingHook p = { .seen_ids = g_ptr_array_new_with_free_func(g_free) };
    exec_approval_prompter_test_set_present_hook(pending_present, &p);

    /* Missing id. */
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
    g_autoptr(JsonNode) bad = json_builder_get_root(b);
    g_object_unref(b);

    exec_approval_prompter_test_inject_event(bad);
    g_assert_cmpuint(p.seen_ids->len, ==, 0);
    g_assert_cmpuint(exec_approval_prompter_test_queue_len(), ==, 0);
    g_assert_null(g_rpc_calls);

    exec_approval_prompter_test_set_present_hook(NULL, NULL);
    exec_approval_prompter_shutdown();
    g_ptr_array_free(p.seen_ids, TRUE);
}

static void test_expired_request_dropped_silently(void) {
    reset_globals();
    exec_approval_prompter_init(NULL);

    PendingHook p = { .seen_ids = g_ptr_array_new_with_free_func(g_free) };
    exec_approval_prompter_test_set_present_hook(pending_present, &p);

    /* Expires in the distant past. */
    g_autoptr(JsonNode) payload = make_requested_payload_full(
        "req-old", "ls", 100, 200, NULL);
    exec_approval_prompter_test_inject_event(payload);

    g_assert_cmpuint(p.seen_ids->len, ==, 0);
    g_assert_false(exec_approval_prompter_test_is_presenting());
    g_assert_cmpuint(exec_approval_prompter_test_queue_len(), ==, 0);
    g_assert_null(g_rpc_calls);

    exec_approval_prompter_test_set_present_hook(NULL, NULL);
    exec_approval_prompter_shutdown();
    g_ptr_array_free(p.seen_ids, TRUE);
}

static void test_resolved_while_active_silences_dialog(void) {
    reset_globals();
    exec_approval_prompter_init(NULL);

    PendingHook p = { .seen_ids = g_ptr_array_new_with_free_func(g_free) };
    exec_approval_prompter_test_set_present_hook(pending_present, &p);

    g_autoptr(JsonNode) payload = make_requested_payload("req-XYZ");
    exec_approval_prompter_test_inject_event(payload);
    g_assert_true(exec_approval_prompter_test_is_presenting());
    g_assert_cmpuint(exec_approval_prompter_pending_count(), ==, 1);

    g_autoptr(JsonNode) resolved = make_resolved_payload("req-XYZ", "allow-once");
    exec_approval_prompter_test_inject_resolved(resolved);

    g_assert_cmpint(g_dismiss_calls, ==, 1);
    g_assert_cmpstr(g_dismiss_last_id, ==, "req-XYZ");
    g_assert_false(exec_approval_prompter_test_is_presenting());
    g_assert_cmpuint(exec_approval_prompter_pending_count(), ==, 0);
    g_assert_null(g_rpc_calls); /* No RPC issued by us. */

    exec_approval_prompter_test_set_present_hook(NULL, NULL);
    exec_approval_prompter_shutdown();
    g_ptr_array_free(p.seen_ids, TRUE);
}

static void test_resolved_while_queued_drops_silently(void) {
    reset_globals();
    exec_approval_prompter_init(NULL);

    PendingHook p = { .seen_ids = g_ptr_array_new_with_free_func(g_free) };
    exec_approval_prompter_test_set_present_hook(pending_present, &p);

    g_autoptr(JsonNode) first  = make_requested_payload("req-1");
    g_autoptr(JsonNode) queued = make_requested_payload("req-2");
    exec_approval_prompter_test_inject_event(first);
    exec_approval_prompter_test_inject_event(queued);
    g_assert_cmpuint(exec_approval_prompter_test_queue_len(), ==, 1);

    g_autoptr(JsonNode) resolved = make_resolved_payload("req-2", "deny");
    exec_approval_prompter_test_inject_resolved(resolved);

    g_assert_cmpint(g_dismiss_calls, ==, 0);
    g_assert_cmpuint(exec_approval_prompter_test_queue_len(), ==, 0);
    g_assert_true(exec_approval_prompter_test_is_presenting());
    g_assert_cmpuint(exec_approval_prompter_pending_count(), ==, 1);

    exec_approval_prompter_test_set_present_hook(NULL, NULL);
    exec_approval_prompter_shutdown();
    g_ptr_array_free(p.seen_ids, TRUE);
}

static void test_duplicate_request_id_dedups(void) {
    reset_globals();
    exec_approval_prompter_init(NULL);

    PendingHook p = { .seen_ids = g_ptr_array_new_with_free_func(g_free) };
    exec_approval_prompter_test_set_present_hook(pending_present, &p);

    g_autoptr(JsonNode) first = make_requested_payload("req-1");
    g_autoptr(JsonNode) dup   = make_requested_payload("req-1");
    exec_approval_prompter_test_inject_event(first);
    exec_approval_prompter_test_inject_event(dup);

    g_assert_cmpuint(p.seen_ids->len, ==, 1);
    g_assert_cmpuint(exec_approval_prompter_test_queue_len(), ==, 0);
    g_assert_cmpuint(exec_approval_prompter_pending_count(), ==, 1);

    exec_approval_prompter_test_set_present_hook(NULL, NULL);
    exec_approval_prompter_shutdown();
    g_ptr_array_free(p.seen_ids, TRUE);
}

static void test_quick_mode_deny_auto_resolves_without_prompting(void) {
    reset_globals();
    exec_approval_prompter_init(NULL);

    PendingHook p = { .seen_ids = g_ptr_array_new_with_free_func(g_free) };
    exec_approval_prompter_test_set_present_hook(pending_present, &p);

    /* Force the policy to Deny without touching disk. */
    g_autofree gchar *tmpfile = g_build_filename(g_get_tmp_dir(),
                                                 "openclaw-exec-approval-test-deny.json",
                                                 NULL);
    g_unlink(tmpfile);
    exec_approval_store_test_set_storage_path(tmpfile);
    g_assert_false(exec_approval_store_set_quick_mode(OC_EXEC_QUICK_MODE_DENY) == FALSE
                   && exec_approval_store_get_quick_mode() != OC_EXEC_QUICK_MODE_DENY);

    g_autoptr(JsonNode) payload = make_requested_payload("req-deny");
    exec_approval_prompter_test_inject_event(payload);

    g_assert_cmpuint(p.seen_ids->len, ==, 0);
    g_assert_false(exec_approval_prompter_test_is_presenting());
    g_assert_nonnull(g_rpc_calls);
    g_assert_cmpuint(g_rpc_calls->len, ==, 1);
    RecordedRpc *r = g_ptr_array_index(g_rpc_calls, 0);
    g_assert_cmpstr(r->decision, ==, "deny");

    g_unlink(tmpfile);
    exec_approval_prompter_test_set_present_hook(NULL, NULL);
    exec_approval_prompter_shutdown();
    g_ptr_array_free(p.seen_ids, TRUE);
}

static void test_quick_mode_allow_auto_resolves_as_allow_once(void) {
    reset_globals();
    exec_approval_prompter_init(NULL);

    PendingHook p = { .seen_ids = g_ptr_array_new_with_free_func(g_free) };
    exec_approval_prompter_test_set_present_hook(pending_present, &p);

    g_autofree gchar *tmpfile = g_build_filename(g_get_tmp_dir(),
                                                 "openclaw-exec-approval-test-allow.json",
                                                 NULL);
    g_unlink(tmpfile);
    exec_approval_store_test_set_storage_path(tmpfile);
    (void)exec_approval_store_set_quick_mode(OC_EXEC_QUICK_MODE_ALLOW);

    /* Constrain allowedDecisions to allow-once + deny only — confirms we
     * never request allow-always when the gateway forbade it. */
    const gchar *allowed[] = { "allow-once", "deny", NULL };
    g_autoptr(JsonNode) payload = make_requested_payload_full(
        "req-allow", "ls",
        oc_exec_approval_now_ms() + 1000,
        oc_exec_approval_now_ms() + 60000,
        allowed);
    exec_approval_prompter_test_inject_event(payload);

    g_assert_cmpuint(p.seen_ids->len, ==, 0);
    g_assert_nonnull(g_rpc_calls);
    g_assert_cmpuint(g_rpc_calls->len, ==, 1);
    RecordedRpc *r = g_ptr_array_index(g_rpc_calls, 0);
    g_assert_cmpstr(r->decision, ==, "allow-once");

    g_unlink(tmpfile);
    exec_approval_prompter_test_set_present_hook(NULL, NULL);
    exec_approval_prompter_shutdown();
    g_ptr_array_free(p.seen_ids, TRUE);
}

static void test_allow_always_downgraded_when_not_permitted(void) {
    reset_globals();
    exec_approval_prompter_init(NULL);

    OcExecDecision decisions[] = { OC_EXEC_DECISION_ALLOW_ALWAYS };
    ScriptedHook s = {
        .scripted_decisions = decisions,
        .count = 1,
        .seen_ids = g_ptr_array_new_with_free_func(g_free),
    };
    exec_approval_prompter_test_set_present_hook(scripted_present, &s);

    /* Quick mode = ASK so we present. allowedDecisions excludes
     * allow-always; the prompter must downgrade to allow-once. */
    const gchar *allowed[] = { "allow-once", "deny", NULL };
    g_autoptr(JsonNode) payload = make_requested_payload_full(
        "req-downgrade", "ls",
        oc_exec_approval_now_ms() + 1000,
        oc_exec_approval_now_ms() + 60000,
        allowed);
    exec_approval_prompter_test_inject_event(payload);

    g_assert_nonnull(g_rpc_calls);
    g_assert_cmpuint(g_rpc_calls->len, ==, 1);
    RecordedRpc *r = g_ptr_array_index(g_rpc_calls, 0);
    g_assert_cmpstr(r->id, ==, "req-downgrade");
    g_assert_cmpstr(r->decision, ==, "allow-once");

    exec_approval_prompter_test_set_present_hook(NULL, NULL);
    exec_approval_prompter_shutdown();
    g_ptr_array_free(s.seen_ids, TRUE);
}

static void test_parent_weak_ref_cleared_on_destroy(void) {
    reset_globals();
    exec_approval_prompter_init(NULL);

    GObject *fake_window = g_object_new(G_TYPE_OBJECT, NULL);
    exec_approval_prompter_set_parent((GtkWindow *)fake_window);
    g_assert_true(exec_approval_prompter_test_get_parent() == fake_window);

    g_object_unref(fake_window);
    g_assert_null(exec_approval_prompter_test_get_parent());

    exec_approval_prompter_shutdown();
}

static void test_shutdown_detaches_weak_ref(void) {
    reset_globals();
    GObject *fake_window = g_object_new(G_TYPE_OBJECT, NULL);
    exec_approval_prompter_init((GtkWindow *)fake_window);
    g_assert_true(exec_approval_prompter_test_get_parent() == fake_window);

    exec_approval_prompter_shutdown();
    g_assert_null(exec_approval_prompter_test_get_parent());

    g_object_unref(fake_window);
    g_assert_null(exec_approval_prompter_test_get_parent());
}

int main(int argc, char **argv) {
    g_test_init(&argc, &argv, NULL);
    /* The prompter intentionally emits g_warning for negative-path
     * scenarios (invalid payload, RPC dispatch failure). Don't abort
     * the test process on those — only on hard errors / criticals. */
    g_log_set_always_fatal((GLogLevelFlags)(G_LOG_LEVEL_ERROR | G_LOG_LEVEL_CRITICAL));
    g_test_add_func("/exec_approval_prompter/single_request",        test_single_request_allowed_once);
    g_test_add_func("/exec_approval_prompter/concurrent_serialized", test_concurrent_requests_serialized);
    g_test_add_func("/exec_approval_prompter/invalid_payload",       test_invalid_payload_dropped);
    g_test_add_func("/exec_approval_prompter/expired_dropped",       test_expired_request_dropped_silently);
    g_test_add_func("/exec_approval_prompter/resolved_active",       test_resolved_while_active_silences_dialog);
    g_test_add_func("/exec_approval_prompter/resolved_queued",       test_resolved_while_queued_drops_silently);
    g_test_add_func("/exec_approval_prompter/dedupe_request_id",     test_duplicate_request_id_dedups);
    g_test_add_func("/exec_approval_prompter/auto_deny",             test_quick_mode_deny_auto_resolves_without_prompting);
    g_test_add_func("/exec_approval_prompter/auto_allow_once",       test_quick_mode_allow_auto_resolves_as_allow_once);
    g_test_add_func("/exec_approval_prompter/allow_always_downgrade", test_allow_always_downgraded_when_not_permitted);
    g_test_add_func("/exec_approval_prompter/parent_weak_ref",       test_parent_weak_ref_cleared_on_destroy);
    g_test_add_func("/exec_approval_prompter/shutdown_weak_ref",     test_shutdown_detaches_weak_ref);
    return g_test_run();
}
