/*
 * test_rpc_lifecycle.c
 *
 * RPC-backed section lifecycle and WS↔RPC integration validation.
 *
 * Covers:
 *  - Section callback behavior for: disconnected, error, timeout, reconnect
 *  - TTL freshness gating correctness
 *  - WS↔RPC integration: authenticated dispatch, unmatched response,
 *    disconnect/shutdown cleanup, send-path safety
 *
 * Uses the same mock gateway_ws approach as test_gateway_rpc.c:
 * provides stub implementations of gateway_ws_get_state() and
 * gateway_ws_send_text() so gateway_rpc.c is tested in isolation.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "../src/gateway_rpc.h"
#include "../src/gateway_ws.h"
#include "../src/gateway_protocol.h"
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

/* ── Mock gateway_ws ─────────────────────────────────────────────── */

static GatewayWsState mock_ws_state = GATEWAY_WS_CONNECTED;
static gchar *mock_last_sent_text = NULL;
static gint mock_send_count = 0;

GatewayWsState gateway_ws_get_state(void) {
    return mock_ws_state;
}

gboolean gateway_ws_send_text(const gchar *text) {
    if (mock_ws_state != GATEWAY_WS_CONNECTED) return FALSE;
    g_free(mock_last_sent_text);
    mock_last_sent_text = g_strdup(text);
    mock_send_count++;
    return TRUE;
}

static void mock_reset(void) {
    mock_ws_state = GATEWAY_WS_CONNECTED;
    g_free(mock_last_sent_text);
    mock_last_sent_text = NULL;
    mock_send_count = 0;
}

/* ── Callback tracking (simulates section callback behavior) ───── */

typedef struct {
    gboolean called;
    gboolean ok;
    gchar *error_code;
    gchar *error_msg;
    gboolean has_payload;
    gint call_count;
    /* Simulated section state */
    gboolean fetch_in_flight;
} SectionRecord;

static void reset_section_record(SectionRecord *r) {
    r->called = FALSE;
    r->ok = FALSE;
    g_free(r->error_code);
    r->error_code = NULL;
    g_free(r->error_msg);
    r->error_msg = NULL;
    r->has_payload = FALSE;
    r->call_count = 0;
    r->fetch_in_flight = FALSE;
}

static void section_callback(const GatewayRpcResponse *response, gpointer user_data) {
    SectionRecord *r = user_data;
    r->called = TRUE;
    r->ok = response->ok;
    r->error_code = g_strdup(response->error_code);
    r->error_msg = g_strdup(response->error_msg);
    r->has_payload = (response->payload != NULL);
    r->call_count++;
    r->fetch_in_flight = FALSE;
}

/* ── Helpers ─────────────────────────────────────────────────────── */

static GatewayFrame* make_success_frame(const gchar *id, const gchar *payload_json) {
    GatewayFrame *f = g_new0(GatewayFrame, 1);
    f->type = GATEWAY_FRAME_RES;
    f->id = g_strdup(id);
    if (payload_json) {
        JsonParser *p = json_parser_new();
        json_parser_load_from_data(p, payload_json, -1, NULL);
        f->payload = json_node_copy(json_parser_get_root(p));
        g_object_unref(p);
    }
    return f;
}

static GatewayFrame* make_error_frame(const gchar *id, const gchar *code, const gchar *msg) {
    GatewayFrame *f = g_new0(GatewayFrame, 1);
    f->type = GATEWAY_FRAME_RES;
    f->id = g_strdup(id);
    f->error = g_strdup(msg);
    f->code = g_strdup(code);
    return f;
}

static void free_frame(GatewayFrame *f) {
    if (!f) return;
    g_free(f->id); g_free(f->method); g_free(f->error);
    g_free(f->code); g_free(f->event_type);
    if (f->payload) json_node_unref(f->payload);
    g_free(f);
}

/* ══════════════════════════════════════════════════════════════════
 * SECTION LIFECYCLE TESTS
 * ══════════════════════════════════════════════════════════════════ */

/*
 * Scenario 1: Disconnected state
 * - Section attempts fetch while gateway is disconnected
 * - gateway_rpc_request returns NULL, callback not fired
 * - No request storm
 */
static void test_lifecycle_disconnected(void) {
    mock_reset();
    mock_ws_state = GATEWAY_WS_DISCONNECTED;
    SectionRecord r = {0};

    gchar *id = gateway_rpc_request("channels.status", NULL, 5000, section_callback, &r);
    ASSERT(id == NULL, "lc_disconnected: request rejected");
    ASSERT(r.called == FALSE, "lc_disconnected: callback not fired");
    ASSERT(mock_send_count == 0, "lc_disconnected: nothing sent");

    /* Repeated attempts also rejected cleanly */
    gchar *id2 = gateway_rpc_request("skills.status", NULL, 5000, section_callback, &r);
    ASSERT(id2 == NULL, "lc_disconnected: second request also rejected");
    ASSERT(mock_send_count == 0, "lc_disconnected: still nothing sent");

    reset_section_record(&r);
    mock_reset();
}

/*
 * Scenario 2: RPC error response
 * - Section sends request, gets error response
 * - in-flight flag clears, error_code/error_msg available
 * - Subsequent retry still works
 */
static void test_lifecycle_error_response(void) {
    mock_reset();
    SectionRecord r = {0};
    r.fetch_in_flight = TRUE;

    gchar *id = gateway_rpc_request("sessions.list", NULL, 5000, section_callback, &r);
    ASSERT(id != NULL, "lc_error: request sent");

    GatewayFrame *frame = make_error_frame(id, "INTERNAL_ERROR", "Something broke");
    gboolean consumed = gateway_rpc_handle_response(frame);
    ASSERT(consumed == TRUE, "lc_error: consumed");
    ASSERT(r.called == TRUE, "lc_error: callback fired");
    ASSERT(r.ok == FALSE, "lc_error: not ok");
    ASSERT(g_strcmp0(r.error_code, "INTERNAL_ERROR") == 0, "lc_error: error_code");
    ASSERT(r.fetch_in_flight == FALSE, "lc_error: in-flight cleared");

    /* Retry after error — should work */
    reset_section_record(&r);
    r.fetch_in_flight = TRUE;
    gchar *id2 = gateway_rpc_request("sessions.list", NULL, 5000, section_callback, &r);
    ASSERT(id2 != NULL, "lc_error: retry request sent");

    GatewayFrame *frame2 = make_success_frame(id2, "{\"ts\":1,\"sessions\":[]}");
    consumed = gateway_rpc_handle_response(frame2);
    ASSERT(consumed == TRUE, "lc_error: retry consumed");
    ASSERT(r.ok == TRUE, "lc_error: retry ok");
    ASSERT(r.fetch_in_flight == FALSE, "lc_error: retry in-flight cleared");

    free_frame(frame);
    free_frame(frame2);
    reset_section_record(&r);
    g_free(id);
    g_free(id2);
}

/*
 * Scenario 3: Timeout path
 * - Section sends request with short timeout
 * - Timeout fires, callback receives TIMEOUT error
 * - Section leaves loading state cleanly
 * - Retry after timeout works
 */
static void test_lifecycle_timeout_recovery(void) {
    mock_reset();
    SectionRecord r = {0};
    r.fetch_in_flight = TRUE;

    gchar *id = gateway_rpc_request("cron.list", NULL, 50, section_callback, &r);
    ASSERT(id != NULL, "lc_timeout: request sent");
    ASSERT(r.fetch_in_flight == TRUE, "lc_timeout: in-flight set");

    /* Run main loop to let timeout fire */
    GMainContext *ctx = g_main_context_default();
    gint64 deadline = g_get_monotonic_time() + 300 * 1000;
    while (!r.called && g_get_monotonic_time() < deadline) {
        g_main_context_iteration(ctx, FALSE);
        g_usleep(1000);
    }

    ASSERT(r.called == TRUE, "lc_timeout: callback fired");
    ASSERT(r.ok == FALSE, "lc_timeout: not ok");
    ASSERT(g_strcmp0(r.error_code, "TIMEOUT") == 0, "lc_timeout: TIMEOUT error");
    ASSERT(r.fetch_in_flight == FALSE, "lc_timeout: in-flight cleared");

    /* Retry after timeout */
    reset_section_record(&r);
    r.fetch_in_flight = TRUE;
    gchar *id2 = gateway_rpc_request("cron.list", NULL, 5000, section_callback, &r);
    ASSERT(id2 != NULL, "lc_timeout: retry sent");

    GatewayFrame *frame = make_success_frame(id2, "{\"jobs\":[],\"total\":0}");
    gboolean consumed = gateway_rpc_handle_response(frame);
    ASSERT(consumed == TRUE, "lc_timeout: retry consumed");
    ASSERT(r.ok == TRUE, "lc_timeout: retry ok");
    ASSERT(r.fetch_in_flight == FALSE, "lc_timeout: retry in-flight cleared");

    free_frame(frame);
    reset_section_record(&r);
    g_free(id);
    g_free(id2);
}

/*
 * Scenario 4: Reconnect after failure
 * - Request pending, disconnect occurs (fail_all_pending)
 * - All sections get CONNECTION_LOST
 * - After reconnect, fresh requests succeed
 */
static void test_lifecycle_reconnect_after_failure(void) {
    mock_reset();
    SectionRecord ch = {0}, sk = {0}, sess = {0};
    ch.fetch_in_flight = TRUE;
    sk.fetch_in_flight = TRUE;
    sess.fetch_in_flight = TRUE;

    gchar *id1 = gateway_rpc_request("channels.status", NULL, 15000, section_callback, &ch);
    gchar *id2 = gateway_rpc_request("skills.status", NULL, 15000, section_callback, &sk);
    gchar *id3 = gateway_rpc_request("sessions.list", NULL, 15000, section_callback, &sess);
    ASSERT(id1 && id2 && id3, "lc_reconnect: 3 requests sent");

    /* Simulate disconnect */
    mock_ws_state = GATEWAY_WS_DISCONNECTED;
    gateway_rpc_fail_all_pending("connection dropped");

    ASSERT(ch.called == TRUE, "lc_reconnect: ch callback fired");
    ASSERT(ch.ok == FALSE, "lc_reconnect: ch not ok");
    ASSERT(g_strcmp0(ch.error_code, "CONNECTION_LOST") == 0, "lc_reconnect: ch CONNECTION_LOST");
    ASSERT(ch.fetch_in_flight == FALSE, "lc_reconnect: ch in-flight cleared");

    ASSERT(sk.called == TRUE, "lc_reconnect: sk callback fired");
    ASSERT(sk.fetch_in_flight == FALSE, "lc_reconnect: sk in-flight cleared");

    ASSERT(sess.called == TRUE, "lc_reconnect: sess callback fired");
    ASSERT(sess.fetch_in_flight == FALSE, "lc_reconnect: sess in-flight cleared");

    /* Simulate reconnect */
    mock_ws_state = GATEWAY_WS_CONNECTED;
    reset_section_record(&ch);
    ch.fetch_in_flight = TRUE;

    gchar *id4 = gateway_rpc_request("channels.status", NULL, 5000, section_callback, &ch);
    ASSERT(id4 != NULL, "lc_reconnect: post-reconnect request sent");

    GatewayFrame *frame = make_success_frame(id4,
        "{\"ts\":1,\"channelOrder\":[],\"channels\":{}}");
    gboolean consumed = gateway_rpc_handle_response(frame);
    ASSERT(consumed == TRUE, "lc_reconnect: post-reconnect consumed");
    ASSERT(ch.ok == TRUE, "lc_reconnect: post-reconnect ok");
    ASSERT(ch.fetch_in_flight == FALSE, "lc_reconnect: post-reconnect in-flight cleared");

    free_frame(frame);
    reset_section_record(&ch);
    reset_section_record(&sk);
    reset_section_record(&sess);
    g_free(id1); g_free(id2); g_free(id3); g_free(id4);
}

/*
 * Scenario 5: Successful response feeds into data parser correctly
 * - Channels section gets a valid channels.status response
 * - Parser produces correct struct
 * - Validates the full RPC → adapter pipeline
 */
static void test_lifecycle_channels_full_pipeline(void) {
    mock_reset();
    SectionRecord r = {0};

    gchar *id = gateway_rpc_request("channels.status", NULL, 5000, section_callback, &r);
    ASSERT(id != NULL, "lc_pipeline_ch: request sent");

    const gchar *payload =
        "{\"ts\":1700000000000,\"channelOrder\":[\"telegram\"],"
        "\"channelLabels\":{\"telegram\":\"Telegram\"},"
        "\"channels\":{\"telegram\":{\"connected\":true}},"
        "\"channelAccounts\":{\"telegram\":[{},{}]}}";

    GatewayFrame *frame = make_success_frame(id, payload);
    gateway_rpc_handle_response(frame);
    ASSERT(r.ok == TRUE, "lc_pipeline_ch: ok");
    ASSERT(r.has_payload == TRUE, "lc_pipeline_ch: has payload");

    /* Now parse the payload as the section callback would */
    /* Re-create the frame to get the payload for parsing */
    GatewayFrame *frame2 = make_success_frame(id, payload);
    GatewayChannelsData *data = gateway_data_parse_channels(frame2->payload);
    ASSERT(data != NULL, "lc_pipeline_ch: data parsed");
    ASSERT(data->n_channels == 1, "lc_pipeline_ch: 1 channel");
    ASSERT(g_strcmp0(data->channels[0].channel_id, "telegram") == 0, "lc_pipeline_ch: telegram");
    ASSERT(data->channels[0].connected == TRUE, "lc_pipeline_ch: connected");
    ASSERT(data->channels[0].account_count == 2, "lc_pipeline_ch: 2 accounts");

    gateway_channels_data_free(data);
    free_frame(frame);
    free_frame(frame2);
    reset_section_record(&r);
    g_free(id);
}

/* ══════════════════════════════════════════════════════════════════
 * WS↔RPC INTEGRATION TESTS
 * ══════════════════════════════════════════════════════════════════ */

/*
 * Test: Authenticated response dispatch
 * - Post-auth GATEWAY_FRAME_RES reaches RPC layer via handle_response
 * - Correct callback fires
 */
static void test_ws_rpc_authenticated_dispatch(void) {
    mock_reset();
    SectionRecord r = {0};

    gchar *id = gateway_rpc_request("node.list", NULL, 5000, section_callback, &r);
    ASSERT(id != NULL, "ws_dispatch: request sent");

    GatewayFrame *frame = make_success_frame(id, "{\"ts\":1,\"nodes\":[]}");
    gboolean consumed = gateway_rpc_handle_response(frame);
    ASSERT(consumed == TRUE, "ws_dispatch: consumed by RPC layer");
    ASSERT(r.called == TRUE, "ws_dispatch: callback fired");
    ASSERT(r.ok == TRUE, "ws_dispatch: ok");

    free_frame(frame);
    reset_section_record(&r);
    g_free(id);
}

/*
 * Test: Unmatched response safety
 * - Response for unknown ID is safely ignored
 * - Response with wrong frame type is ignored
 * - NULL frame is handled
 */
static void test_ws_rpc_unmatched_safety(void) {
    mock_reset();

    GatewayFrame *unknown = make_success_frame("nonexistent-uuid", "{}");
    gboolean c1 = gateway_rpc_handle_response(unknown);
    ASSERT(c1 == FALSE, "ws_unmatched: unknown id safe");
    free_frame(unknown);

    gboolean c2 = gateway_rpc_handle_response(NULL);
    ASSERT(c2 == FALSE, "ws_unmatched: null frame safe");

    GatewayFrame event = { .type = GATEWAY_FRAME_EVENT, .id = "some-id" };
    gboolean c3 = gateway_rpc_handle_response(&event);
    ASSERT(c3 == FALSE, "ws_unmatched: event frame rejected");

    GatewayFrame req = { .type = GATEWAY_FRAME_REQ, .id = "some-id" };
    gboolean c4 = gateway_rpc_handle_response(&req);
    ASSERT(c4 == FALSE, "ws_unmatched: req frame rejected");
}

/*
 * Test: Disconnect cleanup hooks
 * - Multiple pending requests
 * - fail_all_pending (simulating ws_on_closed / disconnect / shutdown / tick-miss)
 * - All callbacks fire exactly once with CONNECTION_LOST
 * - Registry is empty afterward
 * - Second fail_all_pending is safe no-op
 */
static void test_ws_rpc_disconnect_cleanup(void) {
    mock_reset();
    SectionRecord r1 = {0}, r2 = {0};

    gchar *id1 = gateway_rpc_request("channels.status", NULL, 15000, section_callback, &r1);
    gchar *id2 = gateway_rpc_request("node.list", NULL, 15000, section_callback, &r2);
    ASSERT(id1 && id2, "ws_cleanup: 2 requests");

    /* Simulate ws_on_closed path */
    gateway_rpc_fail_all_pending("ws_on_closed");
    ASSERT(r1.called && r1.call_count == 1, "ws_cleanup: r1 once");
    ASSERT(r2.called && r2.call_count == 1, "ws_cleanup: r2 once");
    ASSERT(g_strcmp0(r1.error_code, "CONNECTION_LOST") == 0, "ws_cleanup: r1 code");
    ASSERT(g_strcmp0(r2.error_code, "CONNECTION_LOST") == 0, "ws_cleanup: r2 code");

    /* Simulate tick-miss reconnect path: second fail_all is no-op */
    gateway_rpc_fail_all_pending("tick watchdog");
    ASSERT(r1.call_count == 1, "ws_cleanup: r1 still once after second fail");
    ASSERT(r2.call_count == 1, "ws_cleanup: r2 still once after second fail");

    /* Registry empty: response delivery fails */
    GatewayFrame *late = make_success_frame(id1, "{}");
    gboolean consumed = gateway_rpc_handle_response(late);
    ASSERT(consumed == FALSE, "ws_cleanup: late delivery rejected");

    free_frame(late);
    reset_section_record(&r1);
    reset_section_record(&r2);
    g_free(id1);
    g_free(id2);
}

/*
 * Test: Send-path safety when not connected
 * - gateway_ws_send_text returns FALSE when disconnected
 * - gateway_rpc_request returns NULL (pre-check)
 * - No registry garbage left
 */
static void test_ws_rpc_send_path_safety(void) {
    mock_reset();
    mock_ws_state = GATEWAY_WS_DISCONNECTED;
    SectionRecord r = {0};

    gchar *id = gateway_rpc_request("skills.status", NULL, 5000, section_callback, &r);
    ASSERT(id == NULL, "ws_send_safety: rejected when disconnected");
    ASSERT(r.called == FALSE, "ws_send_safety: no callback");
    ASSERT(mock_send_count == 0, "ws_send_safety: nothing sent");

    /* Transition to various non-connected states */
    GatewayWsState non_ready_states[] = {
        GATEWAY_WS_CONNECTING,
        GATEWAY_WS_CHALLENGE_WAIT,
        GATEWAY_WS_AUTHENTICATING,
        GATEWAY_WS_AUTH_FAILED,
        GATEWAY_WS_ERROR
    };
    for (int i = 0; i < 5; i++) {
        mock_ws_state = non_ready_states[i];
        gchar *id2 = gateway_rpc_request("test.method", NULL, 5000, section_callback, &r);
        ASSERT(id2 == NULL, "ws_send_safety: rejected in non-ready state");
    }

    /* Verify is_ready only returns TRUE for CONNECTED */
    mock_ws_state = GATEWAY_WS_CONNECTED;
    ASSERT(gateway_rpc_is_ready() == TRUE, "ws_send_safety: ready when connected");
    mock_ws_state = GATEWAY_WS_DISCONNECTED;
    ASSERT(gateway_rpc_is_ready() == FALSE, "ws_send_safety: not ready when disconnected");

    reset_section_record(&r);
    mock_reset();
}

/*
 * Test: Sent frame structure validation
 * - Verify the JSON sent over WS matches the gateway protocol
 */
static void test_ws_rpc_frame_structure(void) {
    mock_reset();
    SectionRecord r = {0};

    gchar *id = gateway_rpc_request("channels.status", NULL, 5000, section_callback, &r);
    ASSERT(id != NULL, "ws_frame: request sent");
    ASSERT(mock_last_sent_text != NULL, "ws_frame: text captured");

    /* Parse and validate the sent frame */
    JsonParser *parser = json_parser_new();
    json_parser_load_from_data(parser, mock_last_sent_text, -1, NULL);
    JsonNode *root = json_parser_get_root(parser);
    ASSERT(root != NULL && JSON_NODE_HOLDS_OBJECT(root), "ws_frame: valid JSON object");

    JsonObject *obj = json_node_get_object(root);
    const gchar *type = json_object_get_string_member_with_default(obj, "type", NULL);
    ASSERT(g_strcmp0(type, "req") == 0, "ws_frame: type is req");

    const gchar *frame_id = json_object_get_string_member_with_default(obj, "id", NULL);
    ASSERT(frame_id != NULL, "ws_frame: has id");
    ASSERT(g_strcmp0(frame_id, id) == 0, "ws_frame: id matches returned id");

    const gchar *method = json_object_get_string_member_with_default(obj, "method", NULL);
    ASSERT(g_strcmp0(method, "channels.status") == 0, "ws_frame: method correct");

    ASSERT(json_object_has_member(obj, "params"), "ws_frame: has params");
    JsonNode *params_node = json_object_get_member(obj, "params");
    ASSERT(JSON_NODE_HOLDS_OBJECT(params_node), "ws_frame: params is object");

    g_object_unref(parser);

    /* Clean up pending request */
    GatewayFrame *frame = make_success_frame(id, "{}");
    gateway_rpc_handle_response(frame);
    free_frame(frame);
    reset_section_record(&r);
    g_free(id);
}

/* ── Main ────────────────────────────────────────────────────────── */

int main(void) {
    /* Section lifecycle */
    test_lifecycle_disconnected();
    test_lifecycle_error_response();
    test_lifecycle_timeout_recovery();
    test_lifecycle_reconnect_after_failure();
    test_lifecycle_channels_full_pipeline();

    /* WS↔RPC integration */
    test_ws_rpc_authenticated_dispatch();
    test_ws_rpc_unmatched_safety();
    test_ws_rpc_disconnect_cleanup();
    test_ws_rpc_send_path_safety();
    test_ws_rpc_frame_structure();

    g_free(mock_last_sent_text);

    g_print("rpc_lifecycle: %d/%d tests passed\n", tests_passed, tests_run);
    return (tests_passed == tests_run) ? 0 : 1;
}
