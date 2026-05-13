/*
 * test_device_pair_prompter.c
 *
 * Headless unit tests for the pairing-approval queue state machine in
 * device_pair_prompter.c. Uses the test seam to replace the default
 * Adwaita window presenter with a synchronous recorder, plus stubs for
 * gateway_ws / gateway_rpc / pairing_bootstrap_window symbols so the
 * translation unit links without GTK.
 *
 * Covers:
 *   - single request: approve records the decision, clears queue
 *   - concurrent requests: serialized, presented one-at-a-time
 *   - "Later" re-queues the request at the tail
 *   - reject path records the reject decision
 *   - missing request id: dropped, queue stays empty
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "../src/device_pair_prompter.h"

#include <glib.h>
#include <json-glib/json-glib.h>
#include <string.h>

/* ── Stubs for gateway_ws.c, gateway_rpc.c, pairing_bootstrap_window.c ── */

#include "../src/gateway_ws.h"
#include "../src/gateway_rpc.h"
#include "../src/pairing_bootstrap_window.h"

static GatewayWsEventCallback g_ws_event_cb = NULL;
static gpointer               g_ws_event_user = NULL;
static guint                  g_ws_event_listener_id_counter = 0;

guint gateway_ws_event_subscribe(GatewayWsEventCallback callback, gpointer user_data) {
    g_ws_event_cb = callback;
    g_ws_event_user = user_data;
    return ++g_ws_event_listener_id_counter;
}

void gateway_ws_event_unsubscribe(guint listener_id) {
    (void)listener_id;
    g_ws_event_cb = NULL;
    g_ws_event_user = NULL;
}

/* Stub: no identity loaded in headless tests. Tests that want to assert
 * the deviceId propagation path set g_ws_device_id to a sentinel value
 * before injecting an event. */
static const gchar *g_ws_device_id = NULL;
static gboolean g_ws_pairing_required = FALSE;

const gchar* gateway_ws_get_device_id(void) {
    return g_ws_device_id;
}

gboolean gateway_ws_is_pairing_required(void) {
    return g_ws_pairing_required;
}

G_GNUC_UNUSED static void set_ws_device_id_for_test(const gchar *value) {
    g_ws_device_id = value;
}

G_GNUC_UNUSED static void set_ws_pairing_required_for_test(gboolean value) {
    g_ws_pairing_required = value;
}

static GPtrArray *g_rpc_calls = NULL; /* array of "method|requestId" strings */

gchar* gateway_rpc_request(const gchar *method,
                           JsonNode *params_json,
                           guint timeout_ms,
                           GatewayRpcCallback callback,
                           gpointer user_data)
{
    (void)timeout_ms;
    (void)callback;
    (void)user_data;

    if (!g_rpc_calls) g_rpc_calls = g_ptr_array_new_with_free_func(g_free);
    const gchar *req_id = NULL;
    if (params_json && JSON_NODE_HOLDS_OBJECT(params_json)) {
        JsonObject *obj = json_node_get_object(params_json);
        if (json_object_has_member(obj, "requestId")) {
            req_id = json_object_get_string_member(obj, "requestId");
        }
    }
    g_ptr_array_add(g_rpc_calls,
        g_strdup_printf("%s|%s", method, req_id ? req_id : ""));
    return g_strdup("rpc-0001");
}

static int   g_bootstrap_shows  = 0;
static int   g_bootstrap_raises = 0;
/*
 * Test-controllable visibility flag. Default FALSE so existing tests
 * (which don't care about bootstrap) see the "no bootstrap on screen"
 * path. The raise-when-blocked test flips this to TRUE.
 */
static gboolean g_bootstrap_visible = FALSE;
G_GNUC_UNUSED static gchar *g_bootstrap_last_request_id = NULL;
G_GNUC_UNUSED static gchar *g_bootstrap_last_device_id  = NULL;
G_GNUC_UNUSED static gchar *g_bootstrap_last_detail     = NULL;

void pairing_bootstrap_window_show(GtkWindow   *parent,
                                   const gchar *request_id,
                                   const gchar *device_id,
                                   const gchar *detail_message)
{
    (void)parent;
    g_bootstrap_shows++;
    g_bootstrap_visible = TRUE;
    g_clear_pointer(&g_bootstrap_last_request_id, g_free);
    g_clear_pointer(&g_bootstrap_last_device_id, g_free);
    g_clear_pointer(&g_bootstrap_last_detail, g_free);
    if (request_id) g_bootstrap_last_request_id = g_strdup(request_id);
    if (device_id)  g_bootstrap_last_device_id  = g_strdup(device_id);
    if (detail_message) g_bootstrap_last_detail = g_strdup(detail_message);
}

void pairing_bootstrap_window_raise(void) {
    /*
     * The production contract for `pairing_bootstrap_window_raise()` is
     * "present the existing window without touching any cached state".
     * The stub models exactly that: increment a counter; never mutate
     * g_bootstrap_last_*. Tests that want to assert the tray "Pairing…"
     * path chose raise (and not show) can compare the two counters.
     */
    g_bootstrap_raises++;
}

static int g_bootstrap_hides = 0;

void pairing_bootstrap_window_hide(void) {
    g_bootstrap_hides++;
    g_bootstrap_visible = FALSE;
}

gboolean pairing_bootstrap_window_is_visible(void) {
    return g_bootstrap_visible;
}

gchar* pairing_bootstrap_cli_command_for_request(const gchar *request_id) {
    /* Mirror the production implementation so tests that link this stub
     * still get the canonical Linux CLI fallback string. */
    if (request_id && request_id[0]) {
        return g_strdup_printf("openclaw devices pair approve %s", request_id);
    }
    return g_strdup("openclaw devices pair list");
}

/* Stub for the Adw-based approval window so the prompter translation unit
 * links without pulling in Adwaita. Tests always install a present_hook
 * via the test seam, so this stub should never be invoked. */
void device_pair_approval_window_present(GtkWindow *parent,
                                         const OcPairRequestInfo *info,
                                         OcPairDecisionCallback cb,
                                         gpointer user_data)
{
    (void)parent; (void)info; (void)cb; (void)user_data;
    g_error("device_pair_approval_window_present stub invoked — test hook not installed");
}

/*
 * Dismiss / raise stubs. The prompter's resolved handler routes into
 * dismiss_if when the active request id matches; tests that want to
 * assert the dismiss path can read g_dismiss_calls / g_raise_calls.
 *
 * The stub treats every request id as a match so tests exercising the
 * "active request resolved remotely" code path observe the dismiss call
 * without needing a real Adw dialog on screen.
 */
G_GNUC_UNUSED static int    g_dismiss_calls = 0;
G_GNUC_UNUSED static gchar *g_dismiss_last_request_id = NULL;
G_GNUC_UNUSED static int    g_raise_calls = 0;

gboolean device_pair_approval_window_dismiss_if(const gchar *request_id) {
    g_dismiss_calls++;
    g_clear_pointer(&g_dismiss_last_request_id, g_free);
    if (request_id) g_dismiss_last_request_id = g_strdup(request_id);
    return TRUE;
}

void device_pair_approval_window_raise_active(void) {
    g_raise_calls++;
}

/* ── Test seam: synchronous recorder hook ── */

typedef struct {
    OcPairDecision *scripted_decisions;  /* array of decisions, size=count */
    gsize            count;
    gsize            index;
    GPtrArray       *seen_request_ids;   /* strings, owned */
} ScriptedHook;

static void scripted_present(const OcPairRequestInfo *info,
                             OcPairDecisionCallback   record_decision,
                             gpointer                 record_user_data,
                             gpointer                 hook_user_data)
{
    ScriptedHook *s = hook_user_data;
    g_ptr_array_add(s->seen_request_ids, g_strdup(info->request_id));
    OcPairDecision d = OC_PAIR_DECISION_APPROVE;
    if (s->index < s->count) d = s->scripted_decisions[s->index++];
    record_decision(info, d, record_user_data);
}

/* ── Helpers ── */

static void reset_globals(void) {
    if (g_rpc_calls) {
        g_ptr_array_free(g_rpc_calls, TRUE);
        g_rpc_calls = NULL;
    }
    g_bootstrap_shows  = 0;
    g_bootstrap_raises = 0;
    g_bootstrap_hides  = 0;
    g_bootstrap_visible = FALSE;
    g_clear_pointer(&g_bootstrap_last_request_id, g_free);
    g_clear_pointer(&g_bootstrap_last_device_id, g_free);
    g_clear_pointer(&g_bootstrap_last_detail, g_free);
    g_dismiss_calls = 0;
    g_clear_pointer(&g_dismiss_last_request_id, g_free);
    g_raise_calls = 0;
    g_ws_device_id = NULL;
    g_ws_pairing_required = FALSE;
    g_ws_event_cb = NULL;
    g_ws_event_user = NULL;
    g_ws_event_listener_id_counter = 0;
}

static JsonNode* make_pair_requested_payload(const gchar *request_id,
                                              const gchar *client_id)
{
    JsonBuilder *b = json_builder_new();
    json_builder_begin_object(b);
    if (request_id) {
        json_builder_set_member_name(b, "requestId");
        json_builder_add_string_value(b, request_id);
    }
    if (client_id) {
        json_builder_set_member_name(b, "client");
        json_builder_begin_object(b);
        json_builder_set_member_name(b, "id");
        json_builder_add_string_value(b, client_id);
        json_builder_set_member_name(b, "platform");
        json_builder_add_string_value(b, "darwin");
        json_builder_set_member_name(b, "displayName");
        json_builder_add_string_value(b, "Alice's MacBook");
        json_builder_end_object(b);
    }
    json_builder_set_member_name(b, "scopes");
    json_builder_begin_array(b);
    json_builder_add_string_value(b, "operator.read");
    json_builder_add_string_value(b, "operator.write");
    json_builder_end_array(b);
    json_builder_end_object(b);
    JsonNode *root = json_builder_get_root(b);
    g_object_unref(b);
    return root;
}

/* ── Tests ── */

static void test_single_request_approved(void) {
    reset_globals();
    device_pair_prompter_init(NULL);

    OcPairDecision decisions[] = { OC_PAIR_DECISION_APPROVE };
    ScriptedHook s = {
        .scripted_decisions = decisions,
        .count = 1,
        .index = 0,
        .seen_request_ids = g_ptr_array_new_with_free_func(g_free),
    };
    device_pair_prompter_test_set_present_hook(scripted_present, &s);

    g_autoptr(JsonNode) payload = make_pair_requested_payload("req-1", "openclaw-macos");
    device_pair_prompter_test_inject_event(payload);

    g_assert_cmpuint(s.seen_request_ids->len, ==, 1);
    g_assert_cmpstr(g_ptr_array_index(s.seen_request_ids, 0), ==, "req-1");
    g_assert_cmpuint(device_pair_prompter_test_queue_len(), ==, 0);
    g_assert_false(device_pair_prompter_test_is_presenting());

    /* RPC must be device.pair.approve with matching request id */
    g_assert_nonnull(g_rpc_calls);
    g_assert_cmpuint(g_rpc_calls->len, ==, 1);
    g_assert_cmpstr(g_ptr_array_index(g_rpc_calls, 0), ==, "device.pair.approve|req-1");

    device_pair_prompter_test_set_present_hook(NULL, NULL);
    device_pair_prompter_shutdown();
    g_ptr_array_free(s.seen_request_ids, TRUE);
}

static void test_concurrent_serialized(void) {
    reset_globals();
    device_pair_prompter_init(NULL);

    OcPairDecision decisions[] = {
        OC_PAIR_DECISION_APPROVE,
        OC_PAIR_DECISION_REJECT,
        OC_PAIR_DECISION_APPROVE,
    };
    ScriptedHook s = {
        .scripted_decisions = decisions,
        .count = 3,
        .index = 0,
        .seen_request_ids = g_ptr_array_new_with_free_func(g_free),
    };
    device_pair_prompter_test_set_present_hook(scripted_present, &s);

    g_autoptr(JsonNode) p1 = make_pair_requested_payload("req-A", "openclaw-macos");
    g_autoptr(JsonNode) p2 = make_pair_requested_payload("req-B", "openclaw-web");
    g_autoptr(JsonNode) p3 = make_pair_requested_payload("req-C", "openclaw-web");

    device_pair_prompter_test_inject_event(p1);
    device_pair_prompter_test_inject_event(p2);
    device_pair_prompter_test_inject_event(p3);

    g_assert_cmpuint(s.seen_request_ids->len, ==, 3);
    g_assert_cmpstr(g_ptr_array_index(s.seen_request_ids, 0), ==, "req-A");
    g_assert_cmpstr(g_ptr_array_index(s.seen_request_ids, 1), ==, "req-B");
    g_assert_cmpstr(g_ptr_array_index(s.seen_request_ids, 2), ==, "req-C");
    g_assert_cmpuint(device_pair_prompter_test_queue_len(), ==, 0);

    g_assert_cmpuint(g_rpc_calls->len, ==, 3);
    g_assert_cmpstr(g_ptr_array_index(g_rpc_calls, 0), ==, "device.pair.approve|req-A");
    g_assert_cmpstr(g_ptr_array_index(g_rpc_calls, 1), ==, "device.pair.reject|req-B");
    g_assert_cmpstr(g_ptr_array_index(g_rpc_calls, 2), ==, "device.pair.approve|req-C");

    device_pair_prompter_test_set_present_hook(NULL, NULL);
    device_pair_prompter_shutdown();
    g_ptr_array_free(s.seen_request_ids, TRUE);
}

static void test_later_requeues_to_tail(void) {
    reset_globals();
    device_pair_prompter_init(NULL);

    /* Plan:
     * - inject req-A (will be Later'ed)
     * - inject req-B (will be Approved)
     * - then req-A comes back around and is Approved
     * Hook scripts 3 decisions: Later, Approve, Approve. Because the hook
     * records synchronously, we must not inject req-B until req-A's Later
     * has been processed; but test_inject_event is also synchronous, so
     * req-A will end up back in the queue and pop_and_present_next will
     * immediately re-present req-A before we ever call inject for req-B.
     *
     * To break that self-replay loop, we use a 4-decision script where the
     * first two Laters push A to the tail twice (no-op when queue is [A]),
     * and after we inject B, A is presented again (decision 3 = Later)
     * re-queues A, then B is presented (decision 4 = Approve), then A is
     * presented (decision 5 = Approve).
     *
     * Simpler: inject A, expect it presented and Later'ed, re-queued.
     * Then inject B before the prompter pops A again — but since Later's
     * re-queue synchronously pops next, we can't easily interleave.
     *
     * Make it testable: script says Later Later Approve. Inject A; the
     * hook sees A three times (Later, Later, Approve), and A is finally
     * resolved. Assert seen==[A,A,A], RPC==[approve|A].
     */
    OcPairDecision decisions[] = {
        OC_PAIR_DECISION_LATER,
        OC_PAIR_DECISION_LATER,
        OC_PAIR_DECISION_APPROVE,
    };
    ScriptedHook s = {
        .scripted_decisions = decisions,
        .count = 3,
        .index = 0,
        .seen_request_ids = g_ptr_array_new_with_free_func(g_free),
    };
    device_pair_prompter_test_set_present_hook(scripted_present, &s);

    g_autoptr(JsonNode) p1 = make_pair_requested_payload("req-A", "openclaw-macos");
    device_pair_prompter_test_inject_event(p1);

    g_assert_cmpuint(s.seen_request_ids->len, ==, 3);
    for (guint i = 0; i < 3; i++) {
        g_assert_cmpstr(g_ptr_array_index(s.seen_request_ids, i), ==, "req-A");
    }
    g_assert_cmpuint(device_pair_prompter_test_queue_len(), ==, 0);
    g_assert_false(device_pair_prompter_test_is_presenting());
    g_assert_cmpuint(g_rpc_calls->len, ==, 1);
    g_assert_cmpstr(g_ptr_array_index(g_rpc_calls, 0), ==, "device.pair.approve|req-A");

    device_pair_prompter_test_set_present_hook(NULL, NULL);
    device_pair_prompter_shutdown();
    g_ptr_array_free(s.seen_request_ids, TRUE);
}

static void test_missing_request_id_dropped(void) {
    reset_globals();
    device_pair_prompter_init(NULL);

    OcPairDecision decisions[] = { OC_PAIR_DECISION_APPROVE };
    ScriptedHook s = {
        .scripted_decisions = decisions,
        .count = 1,
        .index = 0,
        .seen_request_ids = g_ptr_array_new_with_free_func(g_free),
    };
    device_pair_prompter_test_set_present_hook(scripted_present, &s);

    g_autoptr(JsonNode) payload = make_pair_requested_payload(NULL, "openclaw-macos");
    device_pair_prompter_test_inject_event(payload);

    g_assert_cmpuint(s.seen_request_ids->len, ==, 0);
    g_assert_cmpuint(device_pair_prompter_test_queue_len(), ==, 0);
    g_assert_null(g_rpc_calls); /* no RPC issued */

    device_pair_prompter_test_set_present_hook(NULL, NULL);
    device_pair_prompter_shutdown();
    g_ptr_array_free(s.seen_request_ids, TRUE);
}

/*
 * Pending-hook variant: records the request id that was presented and
 * returns *without* calling record_decision, leaving the prompter in the
 * presenting state. Lets the resolved-while-active test exercise the
 * "gateway resolved the request under us" path.
 */
typedef struct {
    GPtrArray *seen_request_ids;
} PendingHook;

static void pending_present(const OcPairRequestInfo *info,
                            OcPairDecisionCallback   record_decision,
                            gpointer                 record_user_data,
                            gpointer                 hook_user_data)
{
    (void)record_decision; (void)record_user_data;
    PendingHook *p = hook_user_data;
    g_ptr_array_add(p->seen_request_ids, g_strdup(info->request_id));
    /* Intentionally do not call record_decision; prompter stays pending. */
}

static JsonNode* make_resolved_payload(const gchar *request_id,
                                       const gchar *decision)
{
    JsonBuilder *b = json_builder_new();
    json_builder_begin_object(b);
    if (request_id) {
        json_builder_set_member_name(b, "requestId");
        json_builder_add_string_value(b, request_id);
    }
    if (decision) {
        json_builder_set_member_name(b, "decision");
        json_builder_add_string_value(b, decision);
    }
    json_builder_end_object(b);
    JsonNode *root = json_builder_get_root(b);
    g_object_unref(b);
    return root;
}

static JsonNode* make_list_payload(const gchar * const *request_ids)
{
    JsonBuilder *b = json_builder_new();
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "requests");
    json_builder_begin_array(b);
    for (gsize i = 0; request_ids && request_ids[i]; i++) {
        json_builder_begin_object(b);
        json_builder_set_member_name(b, "requestId");
        json_builder_add_string_value(b, request_ids[i]);
        json_builder_set_member_name(b, "client");
        json_builder_begin_object(b);
        json_builder_set_member_name(b, "id");
        json_builder_add_string_value(b, "openclaw-web");
        json_builder_end_object(b);
        json_builder_end_object(b);
    }
    json_builder_end_array(b);
    json_builder_end_object(b);
    JsonNode *root = json_builder_get_root(b);
    g_object_unref(b);
    return root;
}

static void test_resolved_while_active_dismisses_dialog(void) {
    reset_globals();
    device_pair_prompter_init(NULL);

    PendingHook p = { .seen_request_ids = g_ptr_array_new_with_free_func(g_free) };
    device_pair_prompter_test_set_present_hook(pending_present, &p);

    /* Inject a request and let pending_present leave it presenting. */
    g_autoptr(JsonNode) payload = make_pair_requested_payload("req-XYZ", "openclaw-web");
    device_pair_prompter_test_inject_event(payload);

    g_assert_cmpuint(p.seen_request_ids->len, ==, 1);
    g_assert_true(device_pair_prompter_test_is_presenting());
    g_assert_cmpuint(device_pair_prompter_pending_count(), ==, 1);

    /* Gateway reports the request was resolved elsewhere; the prompter
     * must silently dismiss the active dialog and stop presenting. No
     * decision RPC should have been issued for this request from us. */
    g_autoptr(JsonNode) resolved = make_resolved_payload("req-XYZ", "approve");
    device_pair_prompter_test_inject_resolved(resolved);

    g_assert_cmpint(g_dismiss_calls, ==, 1);
    g_assert_cmpstr(g_dismiss_last_request_id, ==, "req-XYZ");
    g_assert_false(device_pair_prompter_test_is_presenting());
    g_assert_cmpuint(device_pair_prompter_pending_count(), ==, 0);
    g_assert_null(g_rpc_calls); /* no decision RPC sent by us */

    device_pair_prompter_test_set_present_hook(NULL, NULL);
    device_pair_prompter_shutdown();
    g_ptr_array_free(p.seen_request_ids, TRUE);
}

static void test_raise_reopens_pairing_required_bootstrap_after_dismiss(void) {
    reset_globals();
    set_ws_device_id_for_test("dev-reopen");
    set_ws_pairing_required_for_test(TRUE);
    device_pair_prompter_init(NULL);

    g_autoptr(JsonBuilder) b = json_builder_new();
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "requestId");
    json_builder_add_string_value(b, "req-reopen");
    json_builder_set_member_name(b, "detail");
    json_builder_add_string_value(b, "approval pending");
    json_builder_end_object(b);
    g_autoptr(JsonNode) payload = json_builder_get_root(b);

    g_assert_nonnull(g_ws_event_cb);
    g_ws_event_cb("device.pairing.required", payload, g_ws_event_user);

    g_assert_cmpint(g_bootstrap_shows, ==, 1);
    g_assert_true(g_bootstrap_visible);
    g_assert_cmpstr(g_bootstrap_last_request_id, ==, "req-reopen");
    g_assert_cmpstr(g_bootstrap_last_device_id, ==, "dev-reopen");
    g_assert_cmpstr(g_bootstrap_last_detail, ==, "approval pending");

    pairing_bootstrap_window_hide();
    g_assert_cmpint(g_bootstrap_hides, ==, 1);
    g_assert_false(g_bootstrap_visible);

    device_pair_prompter_raise();

    g_assert_cmpint(g_bootstrap_shows, ==, 2);
    g_assert_cmpint(g_bootstrap_raises, ==, 0);
    g_assert_true(g_bootstrap_visible);
    g_assert_cmpstr(g_bootstrap_last_request_id, ==, "req-reopen");
    g_assert_cmpstr(g_bootstrap_last_device_id, ==, "dev-reopen");
    g_assert_cmpstr(g_bootstrap_last_detail, ==, "approval pending");

    device_pair_prompter_shutdown();
}

static void test_resolved_while_queued_drops_silently(void) {
    reset_globals();
    device_pair_prompter_init(NULL);

    /* Pending hook keeps the first request presenting so subsequent ones
     * queue up behind it. */
    PendingHook p = { .seen_request_ids = g_ptr_array_new_with_free_func(g_free) };
    device_pair_prompter_test_set_present_hook(pending_present, &p);

    g_autoptr(JsonNode) first  = make_pair_requested_payload("req-1", "openclaw-web");
    g_autoptr(JsonNode) queued = make_pair_requested_payload("req-2", "openclaw-web");
    device_pair_prompter_test_inject_event(first);
    device_pair_prompter_test_inject_event(queued);

    g_assert_cmpuint(device_pair_prompter_test_queue_len(), ==, 1);
    g_assert_cmpuint(device_pair_prompter_pending_count(), ==, 2);

    /* Resolve the queued one (not the active one). Dialog must NOT be
     * dismissed; queue must shrink. */
    g_autoptr(JsonNode) resolved = make_resolved_payload("req-2", "reject");
    device_pair_prompter_test_inject_resolved(resolved);

    g_assert_cmpint(g_dismiss_calls, ==, 0);
    g_assert_cmpuint(device_pair_prompter_test_queue_len(), ==, 0);
    g_assert_true(device_pair_prompter_test_is_presenting()); /* req-1 still up */
    g_assert_cmpuint(device_pair_prompter_pending_count(), ==, 1);

    device_pair_prompter_test_set_present_hook(NULL, NULL);
    device_pair_prompter_shutdown();
    g_ptr_array_free(p.seen_request_ids, TRUE);
}

static void test_list_seed_enqueues_unknown_requests(void) {
    reset_globals();
    device_pair_prompter_init(NULL);

    PendingHook p = { .seen_request_ids = g_ptr_array_new_with_free_func(g_free) };
    device_pair_prompter_test_set_present_hook(pending_present, &p);

    const gchar *ids[] = { "req-a", "req-b", "req-c", NULL };
    g_autoptr(JsonNode) list = make_list_payload(ids);
    device_pair_prompter_test_seed_from_payload(list);

    /* First request goes straight to presenting; the rest queue up. */
    g_assert_cmpuint(p.seen_request_ids->len, ==, 1);
    g_assert_cmpstr(g_ptr_array_index(p.seen_request_ids, 0), ==, "req-a");
    g_assert_cmpuint(device_pair_prompter_test_queue_len(), ==, 2);
    g_assert_cmpuint(device_pair_prompter_pending_count(), ==, 3);

    device_pair_prompter_test_set_present_hook(NULL, NULL);
    device_pair_prompter_shutdown();
    g_ptr_array_free(p.seen_request_ids, TRUE);
}

static void test_seed_then_event_dedups_same_request(void) {
    reset_globals();
    device_pair_prompter_init(NULL);

    PendingHook p = { .seen_request_ids = g_ptr_array_new_with_free_func(g_free) };
    device_pair_prompter_test_set_present_hook(pending_present, &p);

    /*
     * Seed with req-1 (presented), then the same requestId arrives again
     * as a live device.pair.requested event (e.g. race between seed RPC
     * and server-push). The second arrival must not enqueue a duplicate.
     */
    const gchar *ids[] = { "req-1", NULL };
    g_autoptr(JsonNode) list = make_list_payload(ids);
    device_pair_prompter_test_seed_from_payload(list);

    g_assert_cmpuint(p.seen_request_ids->len, ==, 1);
    g_assert_true(device_pair_prompter_test_is_presenting());

    g_autoptr(JsonNode) dup = make_pair_requested_payload("req-1", "openclaw-web");
    device_pair_prompter_test_inject_event(dup);

    g_assert_cmpuint(p.seen_request_ids->len, ==, 1); /* not re-presented */
    g_assert_cmpuint(device_pair_prompter_test_queue_len(), ==, 0);
    g_assert_cmpuint(device_pair_prompter_pending_count(), ==, 1);

    device_pair_prompter_test_set_present_hook(NULL, NULL);
    device_pair_prompter_shutdown();
    g_ptr_array_free(p.seen_request_ids, TRUE);
}

static void test_raise_with_no_pending_is_noop(void) {
    reset_globals();
    device_pair_prompter_init(NULL);

    device_pair_prompter_raise();

    g_assert_cmpint(g_raise_calls, ==, 0);
    g_assert_cmpint(g_bootstrap_shows, ==, 0);

    device_pair_prompter_shutdown();
}

static void test_raise_when_bootstrap_visible_uses_raise_primitive(void) {
    /*
     * When the bootstrap window is on screen (WS blocked on
     * PAIRING_REQUIRED), the prompter's tray "Pairing…" handler must
     * use pairing_bootstrap_window_raise(), NOT _show() with NULL
     * arguments. The non-clobber contract is the whole point of raise.
     *
     * Invariants asserted:
     *   1. raise counter goes up by exactly 1;
     *   2. show counter does NOT go up (no re-entry to the updater);
     *   3. g_bootstrap_last_* stays pristine — no NULL-clobbering call
     *      ever made it through the stubs;
     *   4. the active-approval raise counter stays at 0 — bootstrap
     *      takes priority over any live dialog.
     */
    reset_globals();
    device_pair_prompter_init(NULL);
    g_bootstrap_visible = TRUE;

    /* Even if we have a presenting approval dialog, bootstrap wins. */
    PendingHook p = { .seen_request_ids = g_ptr_array_new_with_free_func(g_free) };
    device_pair_prompter_test_set_present_hook(pending_present, &p);
    g_autoptr(JsonNode) payload = make_pair_requested_payload("req-bg", "openclaw-web");
    device_pair_prompter_test_inject_event(payload);
    g_assert_true(device_pair_prompter_test_is_presenting());

    device_pair_prompter_raise();

    g_assert_cmpint(g_bootstrap_raises, ==, 1);
    g_assert_cmpint(g_bootstrap_shows,  ==, 0);
    g_assert_null(g_bootstrap_last_request_id);
    g_assert_null(g_bootstrap_last_device_id);
    g_assert_null(g_bootstrap_last_detail);
    g_assert_cmpint(g_raise_calls, ==, 0);

    device_pair_prompter_test_set_present_hook(NULL, NULL);
    device_pair_prompter_shutdown();
    g_ptr_array_free(p.seen_request_ids, TRUE);
}

static void test_raise_with_active_dialog_raises_it(void) {
    reset_globals();
    device_pair_prompter_init(NULL);

    PendingHook p = { .seen_request_ids = g_ptr_array_new_with_free_func(g_free) };
    device_pair_prompter_test_set_present_hook(pending_present, &p);

    g_autoptr(JsonNode) payload = make_pair_requested_payload("req-q", "openclaw-web");
    device_pair_prompter_test_inject_event(payload);

    device_pair_prompter_raise();
    g_assert_cmpint(g_raise_calls, ==, 1);

    device_pair_prompter_test_set_present_hook(NULL, NULL);
    device_pair_prompter_shutdown();
    g_ptr_array_free(p.seen_request_ids, TRUE);
}

/*
 * Parent-lifetime regression: the tray-first app can outlive its main
 * window, so the prompter must weak-ref-track the parent GtkWindow and
 * automatically fall back to NULL if the window gets finalized. Without
 * this, a later pairing event would present transient-for a dead
 * GObject and crash.
 *
 * We can't stand up a real GtkWindow in a headless unit test (no
 * display), but the prompter stores the parent as `GtkWindow *` purely
 * for typing; internally it only ever calls `G_OBJECT(parent)`. A plain
 * heap GObject is therefore a faithful stand-in — and lets us drive the
 * real weak-ref callback by calling `g_object_unref()`.
 */
static void test_parent_weak_ref_cleared_on_destroy(void) {
    reset_globals();
    device_pair_prompter_init(NULL);

    GObject *fake_window = g_object_new(G_TYPE_OBJECT, NULL);
    device_pair_prompter_set_parent((GtkWindow *)fake_window);
    g_assert_true(device_pair_prompter_test_get_parent() == fake_window);

    /* Finalize the "window" → GObject fires the weak-ref callback →
     * prompter must observe the destruction and drop the pointer. */
    g_object_unref(fake_window);
    g_assert_null(device_pair_prompter_test_get_parent());

    device_pair_prompter_shutdown();
}

static void test_parent_reassignment_detaches_old_weak_ref(void) {
    reset_globals();
    device_pair_prompter_init(NULL);

    GObject *first  = g_object_new(G_TYPE_OBJECT, NULL);
    GObject *second = g_object_new(G_TYPE_OBJECT, NULL);

    device_pair_prompter_set_parent((GtkWindow *)first);
    g_assert_true(device_pair_prompter_test_get_parent() == first);

    /* Swapping to a new parent must unref the old weak ref so that when
     * the first window is finalized later, its callback does not fire
     * and stomp over the new parent pointer. */
    device_pair_prompter_set_parent((GtkWindow *)second);
    g_assert_true(device_pair_prompter_test_get_parent() == second);

    g_object_unref(first);
    /* Old parent destruction must NOT clear the current parent pointer. */
    g_assert_true(device_pair_prompter_test_get_parent() == second);

    /* Now destroy the live one and confirm we observe that. */
    g_object_unref(second);
    g_assert_null(device_pair_prompter_test_get_parent());

    device_pair_prompter_shutdown();
}

static void test_parent_set_null_clears_pointer_and_detaches_ref(void) {
    reset_globals();
    device_pair_prompter_init(NULL);

    GObject *fake_window = g_object_new(G_TYPE_OBJECT, NULL);
    device_pair_prompter_set_parent((GtkWindow *)fake_window);
    g_assert_true(device_pair_prompter_test_get_parent() == fake_window);

    /* Explicit "main window closed by caller" path: the app
     * deliberately nulls the parent out. */
    device_pair_prompter_set_parent(NULL);
    g_assert_null(device_pair_prompter_test_get_parent());

    /* The prompter must have detached the weak ref — unreffing the
     * object now must not try to touch prompter state. If the weak ref
     * were still live, the callback would run and be a no-op (pointer
     * already NULL), but it should not be invoked at all. */
    g_object_unref(fake_window);
    g_assert_null(device_pair_prompter_test_get_parent());

    device_pair_prompter_shutdown();
}

static void test_shutdown_detaches_weak_ref(void) {
    reset_globals();
    GObject *fake_window = g_object_new(G_TYPE_OBJECT, NULL);
    device_pair_prompter_init((GtkWindow *)fake_window);
    g_assert_true(device_pair_prompter_test_get_parent() == fake_window);

    /* Shutdown must release the weak ref so that if the host app keeps
     * the GObject alive past shutdown (e.g. final cleanup order), the
     * GObject's finalize won't later try to reach into freed prompter
     * state. */
    device_pair_prompter_shutdown();
    g_assert_null(device_pair_prompter_test_get_parent());

    /* Destroying the parent post-shutdown must be a complete no-op. */
    g_object_unref(fake_window);
    g_assert_null(device_pair_prompter_test_get_parent());
}

/*
 * Single-ownership regression for Issue 4.
 *
 * The bootstrap window is now owned end-to-end by `device_pair_prompter`.
 * Specifically:
 *   - gateway_ws emits the synthetic "device.pairing.required" event
 *     whenever an auth reject carries the PAIRING_REQUIRED detail;
 *   - the prompter subscribes to that event and calls the real
 *     `pairing_bootstrap_window_show()` with full actionable metadata;
 *   - gateway_client is NOT allowed to call `pairing_bootstrap_window_*`
 *     directly — the duplicate show path previously clobbered live
 *     cache state via a NULL-argument show.
 *
 * This test drives the event through the prompter's event injection seam
 * and asserts we get exactly one show with the expected payload — not
 * one from the prompter AND one from a second caller.
 */
static void test_pairing_required_event_drives_single_show(void) {
    reset_globals();
    set_ws_device_id_for_test("dev-abc");
    device_pair_prompter_init(NULL);

    /* Build the synthetic payload the prompter expects. The event seam
     * mirrors gateway_ws's emit signature for this event. */
    g_autoptr(JsonBuilder) b = json_builder_new();
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "requestId");
    json_builder_add_string_value(b, "req-owner");
    json_builder_set_member_name(b, "detail");
    json_builder_add_string_value(b, "device not yet approved");
    json_builder_end_object(b);
    g_autoptr(JsonNode) payload = json_builder_get_root(b);

    /* Route it through the same event dispatcher the WS subscriber uses. */
    g_assert_nonnull(g_ws_event_cb);
    g_ws_event_cb("device.pairing.required", payload, g_ws_event_user);

    /* Exactly one show from the prompter. No raises (we're not in the
     * tray "Pairing…" path), no hides (transport hasn't re-authed). */
    g_assert_cmpint(g_bootstrap_shows,  ==, 1);
    g_assert_cmpint(g_bootstrap_raises, ==, 0);
    g_assert_cmpint(g_bootstrap_hides,  ==, 0);

    /* And the show carried the actionable metadata, not NULLs — the
     * class of regression the old duplicate owner introduced. */
    g_assert_cmpstr(g_bootstrap_last_request_id, ==, "req-owner");
    g_assert_cmpstr(g_bootstrap_last_device_id,  ==, "dev-abc");
    g_assert_cmpstr(g_bootstrap_last_detail,     ==, "device not yet approved");

    device_pair_prompter_shutdown();
}

/*
 * The single-owner hide contract: `device_pair_prompter_notify_transport_
 * authenticated()` is the one sanctioned path that drives the bootstrap
 * window hide. gateway_client now calls this on WS CONNECTED instead of
 * calling pairing_bootstrap_window_hide() directly.
 */
static void test_notify_transport_authenticated_hides_bootstrap(void) {
    reset_globals();
    g_bootstrap_visible = TRUE;
    device_pair_prompter_init(NULL);

    device_pair_prompter_notify_transport_authenticated();

    g_assert_cmpint(g_bootstrap_hides, ==, 1);
    g_assert_false(g_bootstrap_visible);
    /* And no stray show/raise from the notifier. */
    g_assert_cmpint(g_bootstrap_shows,  ==, 0);
    g_assert_cmpint(g_bootstrap_raises, ==, 0);

    device_pair_prompter_shutdown();
}

/*
 * Idempotency: the WS status handler fires on every transition, so the
 * notifier may be called repeatedly with no bootstrap up. That must be
 * safe — hide() is a no-op against a closed window.
 */
static void test_notify_transport_authenticated_is_idempotent(void) {
    reset_globals();
    g_bootstrap_visible = FALSE;
    device_pair_prompter_init(NULL);

    device_pair_prompter_notify_transport_authenticated();
    device_pair_prompter_notify_transport_authenticated();
    device_pair_prompter_notify_transport_authenticated();
    /* Each call dispatches hide(); the stub just counts them. In
     * production, the bootstrap window's own singleton check suppresses
     * the GTK-level no-op. */
    g_assert_cmpint(g_bootstrap_hides, ==, 3);
    g_assert_false(g_bootstrap_visible);

    device_pair_prompter_shutdown();
}

/*
 * Regression for Issue 3: pair requests whose top-level `deviceId`
 * equals our own must be dropped at `handle_device_pair_requested()`.
 * Without this filter, each reconnect that triggers our OWN handshake
 * leaks a self-originated `device.pair.requested` event into the
 * approver queue — which the operator can never approve from this same
 * machine. Left in the queue, it keeps the tray "Pairing…" affordance
 * spuriously actionable after the real bootstrap flow has resolved.
 */
static JsonNode* make_pair_requested_payload_with_device_id(
    const gchar *request_id,
    const gchar *client_id,
    const gchar *requester_device_id)
{
    JsonBuilder *b = json_builder_new();
    json_builder_begin_object(b);
    if (request_id) {
        json_builder_set_member_name(b, "requestId");
        json_builder_add_string_value(b, request_id);
    }
    if (requester_device_id) {
        /* Gateway schema `DevicePairRequestedEventSchema` puts the
         * requester's deviceId at the top level. */
        json_builder_set_member_name(b, "deviceId");
        json_builder_add_string_value(b, requester_device_id);
    }
    if (client_id) {
        json_builder_set_member_name(b, "client");
        json_builder_begin_object(b);
        json_builder_set_member_name(b, "id");
        json_builder_add_string_value(b, client_id);
        json_builder_end_object(b);
    }
    json_builder_end_object(b);
    JsonNode *root = json_builder_get_root(b);
    g_object_unref(b);
    return root;
}

static void test_self_origin_pair_request_is_dropped(void) {
    reset_globals();
    /* Pretend the identity layer has loaded an Ed25519 key whose
     * deviceId is this hex string. The incoming pair event will be
     * tagged with the same deviceId, simulating "our own handshake
     * waiting for approval elsewhere" that echoes back through
     * `device.pair.list` / `device.pair.requested`. */
    set_ws_device_id_for_test("deadbeef");
    device_pair_prompter_init(NULL);

    PendingHook p = { .seen_request_ids = g_ptr_array_new_with_free_func(g_free) };
    device_pair_prompter_test_set_present_hook(pending_present, &p);

    g_autoptr(JsonNode) payload = make_pair_requested_payload_with_device_id(
        "req-self", "openclaw-linux", "deadbeef");
    device_pair_prompter_test_inject_event(payload);

    /* Self-originated request must NOT be presented and must NOT add
     * to the pending count (which is what drives the tray badge). */
    g_assert_cmpuint(p.seen_request_ids->len, ==, 0);
    g_assert_false(device_pair_prompter_test_is_presenting());
    g_assert_cmpuint(device_pair_prompter_pending_count(), ==, 0);

    device_pair_prompter_test_set_present_hook(NULL, NULL);
    device_pair_prompter_shutdown();
    set_ws_device_id_for_test(NULL);
    g_ptr_array_free(p.seen_request_ids, TRUE);
}

static void test_foreign_pair_request_still_enqueues_when_device_id_differs(void) {
    reset_globals();
    set_ws_device_id_for_test("deadbeef");
    device_pair_prompter_init(NULL);

    PendingHook p = { .seen_request_ids = g_ptr_array_new_with_free_func(g_free) };
    device_pair_prompter_test_set_present_hook(pending_present, &p);

    /* A different device's deviceId — the filter must NOT eat this one. */
    g_autoptr(JsonNode) payload = make_pair_requested_payload_with_device_id(
        "req-peer", "openclaw-macos", "cafef00d");
    device_pair_prompter_test_inject_event(payload);

    g_assert_cmpuint(p.seen_request_ids->len, ==, 1);
    g_assert_cmpstr(g_ptr_array_index(p.seen_request_ids, 0), ==, "req-peer");
    g_assert_true(device_pair_prompter_test_is_presenting());

    device_pair_prompter_test_set_present_hook(NULL, NULL);
    device_pair_prompter_shutdown();
    set_ws_device_id_for_test(NULL);
    g_ptr_array_free(p.seen_request_ids, TRUE);
}

/*
 * Regression: `device.pair.list` reconciles our local queue against the
 * server's truth. If the server no longer knows about req-stale, we
 * must drop it locally so the tray "Pairing…" affordance doesn't stay
 * spuriously actionable forever. Previously, the only way a stale
 * entry left the queue was via a live `device.pair.resolved` event,
 * so any resolution that happened while Linux was offline leaked into
 * the next session's queue.
 */
static void test_list_seed_prunes_stale_local_queue_entries(void) {
    reset_globals();
    device_pair_prompter_init(NULL);

    PendingHook p = { .seen_request_ids = g_ptr_array_new_with_free_func(g_free) };
    device_pair_prompter_test_set_present_hook(pending_present, &p);

    /* 1) Seed the queue with req-stale via an event. */
    g_autoptr(JsonNode) initial =
        make_pair_requested_payload("req-stale", "openclaw-web");
    device_pair_prompter_test_inject_event(initial);
    g_assert_cmpuint(device_pair_prompter_pending_count(), ==, 1);

    /* 2) Gateway reports a list that no longer contains req-stale.
     *    The presented dialog must be dismissed and the queue pruned. */
    const gchar *ids[] = { "req-fresh", NULL };
    g_autoptr(JsonNode) list = make_list_payload(ids);
    device_pair_prompter_test_seed_from_payload(list);

    /* req-fresh is what remains pending; req-stale is gone. */
    g_assert_cmpuint(device_pair_prompter_test_queue_len(), ==, 0);
    g_assert_true(device_pair_prompter_test_is_presenting()); /* req-fresh */
    g_assert_cmpuint(device_pair_prompter_pending_count(), ==, 1);

    device_pair_prompter_test_set_present_hook(NULL, NULL);
    device_pair_prompter_shutdown();
    g_ptr_array_free(p.seen_request_ids, TRUE);
}

static void test_list_seed_with_empty_server_list_drops_everything(void) {
    reset_globals();
    device_pair_prompter_init(NULL);

    PendingHook p = { .seen_request_ids = g_ptr_array_new_with_free_func(g_free) };
    device_pair_prompter_test_set_present_hook(pending_present, &p);

    /* Seed two queued requests. */
    g_autoptr(JsonNode) a = make_pair_requested_payload("req-1", "openclaw-web");
    g_autoptr(JsonNode) b = make_pair_requested_payload("req-2", "openclaw-web");
    device_pair_prompter_test_inject_event(a);
    device_pair_prompter_test_inject_event(b);
    g_assert_cmpuint(device_pair_prompter_pending_count(), ==, 2);

    /* Server's list is empty — every local entry is stale. */
    const gchar *ids[] = { NULL };
    g_autoptr(JsonNode) empty_list = make_list_payload(ids);
    device_pair_prompter_test_seed_from_payload(empty_list);

    g_assert_cmpuint(device_pair_prompter_pending_count(), ==, 0);
    g_assert_false(device_pair_prompter_test_is_presenting());

    device_pair_prompter_test_set_present_hook(NULL, NULL);
    device_pair_prompter_shutdown();
    g_ptr_array_free(p.seen_request_ids, TRUE);
}

static void test_bootstrap_cli_command_has_request_id(void) {
    /* Pure helper: no prompter/WS setup needed. Guards the Linux CLI
     * fallback contract against wording drift. */
    g_autofree gchar *cmd = pairing_bootstrap_cli_command_for_request("req-42");
    g_assert_cmpstr(cmd, ==, "openclaw devices pair approve req-42");
}

static void test_bootstrap_cli_command_no_request_id_is_list(void) {
    g_autofree gchar *cmd_null  = pairing_bootstrap_cli_command_for_request(NULL);
    g_autofree gchar *cmd_empty = pairing_bootstrap_cli_command_for_request("");
    g_assert_cmpstr(cmd_null,  ==, "openclaw devices pair list");
    g_assert_cmpstr(cmd_empty, ==, "openclaw devices pair list");
}

int main(int argc, char **argv) {
    g_test_init(&argc, &argv, NULL);
    /* OC_LOG_WARN uses GLib's logging; g_test_init makes WARNING fatal by
     * default. Some tests intentionally trigger warn-level paths. */
    g_log_set_always_fatal(G_LOG_LEVEL_ERROR | G_LOG_LEVEL_CRITICAL);
    g_log_set_fatal_mask(NULL, G_LOG_LEVEL_ERROR | G_LOG_LEVEL_CRITICAL);
    g_test_add_func("/device_pair_prompter/single_approved", test_single_request_approved);
    g_test_add_func("/device_pair_prompter/concurrent_serialized", test_concurrent_serialized);
    g_test_add_func("/device_pair_prompter/later_requeues_to_tail", test_later_requeues_to_tail);
    g_test_add_func("/device_pair_prompter/missing_request_id_dropped", test_missing_request_id_dropped);
    g_test_add_func("/device_pair_prompter/resolved_while_active_dismisses_dialog",
                    test_resolved_while_active_dismisses_dialog);
    g_test_add_func("/device_pair_prompter/resolved_while_queued_drops_silently",
                    test_resolved_while_queued_drops_silently);
    g_test_add_func("/device_pair_prompter/list_seed_enqueues_unknown_requests",
                    test_list_seed_enqueues_unknown_requests);
    g_test_add_func("/device_pair_prompter/seed_then_event_dedups_same_request",
                    test_seed_then_event_dedups_same_request);
    g_test_add_func("/device_pair_prompter/raise_noop_with_no_pending",
                    test_raise_with_no_pending_is_noop);
    g_test_add_func("/device_pair_prompter/raise_when_bootstrap_visible_uses_raise_primitive",
                    test_raise_when_bootstrap_visible_uses_raise_primitive);
    g_test_add_func("/device_pair_prompter/raise_reopens_pairing_required_bootstrap_after_dismiss",
                    test_raise_reopens_pairing_required_bootstrap_after_dismiss);
    g_test_add_func("/device_pair_prompter/raise_with_active_dialog",
                    test_raise_with_active_dialog_raises_it);
    g_test_add_func("/pairing_bootstrap/cli_command_has_request_id",
                    test_bootstrap_cli_command_has_request_id);
    g_test_add_func("/pairing_bootstrap/cli_command_no_request_id_is_list",
                    test_bootstrap_cli_command_no_request_id_is_list);
    g_test_add_func("/device_pair_prompter/parent_weak_ref_cleared_on_destroy",
                    test_parent_weak_ref_cleared_on_destroy);
    g_test_add_func("/device_pair_prompter/parent_reassignment_detaches_old_weak_ref",
                    test_parent_reassignment_detaches_old_weak_ref);
    g_test_add_func("/device_pair_prompter/parent_set_null_clears_pointer_and_detaches_ref",
                    test_parent_set_null_clears_pointer_and_detaches_ref);
    g_test_add_func("/device_pair_prompter/shutdown_detaches_weak_ref",
                    test_shutdown_detaches_weak_ref);
    g_test_add_func("/device_pair_prompter/pairing_required_event_drives_single_show",
                    test_pairing_required_event_drives_single_show);
    g_test_add_func("/device_pair_prompter/notify_transport_authenticated_hides_bootstrap",
                    test_notify_transport_authenticated_hides_bootstrap);
    g_test_add_func("/device_pair_prompter/notify_transport_authenticated_is_idempotent",
                    test_notify_transport_authenticated_is_idempotent);
    g_test_add_func("/device_pair_prompter/self_origin_pair_request_is_dropped",
                    test_self_origin_pair_request_is_dropped);
    g_test_add_func("/device_pair_prompter/foreign_pair_request_still_enqueues_when_device_id_differs",
                    test_foreign_pair_request_still_enqueues_when_device_id_differs);
    g_test_add_func("/device_pair_prompter/list_seed_prunes_stale_local_queue_entries",
                    test_list_seed_prunes_stale_local_queue_entries);
    g_test_add_func("/device_pair_prompter/list_seed_with_empty_server_list_drops_everything",
                    test_list_seed_with_empty_server_list_drops_everything);
    int rc = g_test_run();
    reset_globals();
    return rc;
}
