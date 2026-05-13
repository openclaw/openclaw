/*
 * test_browser_control_state.c
 *
 * Headless regression for the shared Browser Control state module.
 *
 * The module is GTK-free and dispatches RPC through a transport
 * struct, so each test installs a small stub transport that captures
 * the pending callback. The test then drives the callback directly to
 * exercise refresh and set completion paths without standing up the
 * gateway.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include <glib.h>
#include <string.h>

#include "../src/browser_control_state.h"

/* ── stub transport ───────────────────────────────────────────── */

typedef struct {
    /* Captured refresh callback (set when the module calls
     * `transport.refresh`). The test invokes it to "complete" the
     * pending fetch. */
    BrowserControlRefreshCb refresh_cb;
    gpointer refresh_ctx;
    int refresh_calls;

    /* Captured save callback. */
    BrowserControlSaveCb save_cb;
    gpointer save_ctx;
    gboolean save_arg_enabled;
    int save_calls;
} StubTransport;

static StubTransport stub;

static void stub_refresh(BrowserControlRefreshCb cb, gpointer ctx) {
    stub.refresh_cb = cb;
    stub.refresh_ctx = ctx;
    stub.refresh_calls++;
}

static void stub_save(gboolean enabled, BrowserControlSaveCb cb, gpointer ctx) {
    stub.save_cb = cb;
    stub.save_ctx = ctx;
    stub.save_arg_enabled = enabled;
    stub.save_calls++;
}

static const BrowserControlStateTransport stub_transport_template = {
    .refresh = stub_refresh,
    .save = stub_save,
};

static void install_stub(void) {
    memset(&stub, 0, sizeof(stub));
    browser_control_state_test_reset();
    browser_control_state_init();
    browser_control_state_set_transport(&stub_transport_template);
}

/* ── subscriber recorder ──────────────────────────────────────── */

typedef struct {
    int calls;
    /* The state observed at the time of each callback. */
    gboolean last_known;
    gboolean last_enabled;
} SubscriberRecorder;

static void on_state_changed(gpointer user_data) {
    SubscriberRecorder *rec = user_data;
    rec->calls++;
    browser_control_state_get(&rec->last_enabled, &rec->last_known);
}

/* ── set-completion recorder ──────────────────────────────────── */

typedef struct {
    int calls;
    BrowserControlStateStatus last_status;
    gboolean last_attempted;
} SetRecorder;

static void on_set_done(const BrowserControlStateSetResult *result, gpointer user_data) {
    SetRecorder *rec = user_data;
    rec->calls++;
    if (result) {
        rec->last_status = result->status;
        rec->last_attempted = result->attempted_enabled;
    }
}

/* ── tests ────────────────────────────────────────────────────── */

static void test_initial_state_is_unknown(void) {
    install_stub();

    gboolean enabled = TRUE; /* sentinel — should be cleared to FALSE */
    gboolean known = TRUE;
    browser_control_state_get(&enabled, &known);
    g_assert_false(known);
    g_assert_false(enabled);
    g_assert_false(browser_control_state_is_refreshing());
}

static void test_refresh_success_populates_known_value(void) {
    install_stub();

    SubscriberRecorder rec = {0};
    guint sub = browser_control_state_subscribe(on_state_changed, &rec);
    g_assert_cmpuint(sub, !=, 0);

    browser_control_state_refresh();
    g_assert_cmpint(stub.refresh_calls, ==, 1);
    g_assert_true(browser_control_state_is_refreshing());

    /* Complete the fetch with enabled=TRUE. */
    g_assert_nonnull(stub.refresh_cb);
    stub.refresh_cb(TRUE, TRUE, NULL, stub.refresh_ctx);

    gboolean enabled = FALSE, known = FALSE;
    browser_control_state_get(&enabled, &known);
    g_assert_true(known);
    g_assert_true(enabled);
    g_assert_false(browser_control_state_is_refreshing());

    /* Subscriber fires exactly once on the refresh completion. */
    g_assert_cmpint(rec.calls, ==, 1);
    g_assert_true(rec.last_known);
    g_assert_true(rec.last_enabled);

    browser_control_state_unsubscribe(sub);
}

static void test_refresh_failure_keeps_unknown(void) {
    install_stub();

    SubscriberRecorder rec = {0};
    browser_control_state_subscribe(on_state_changed, &rec);

    browser_control_state_refresh();
    stub.refresh_cb(FALSE, FALSE, "FETCH_FAILED", stub.refresh_ctx);

    gboolean known = TRUE;
    browser_control_state_get(NULL, &known);
    g_assert_false(known);
    g_assert_false(browser_control_state_is_refreshing());

    /* Subscriber still fires so a "Loading…" subtitle can clear. */
    g_assert_cmpint(rec.calls, ==, 1);
}

static void test_refresh_failure_after_known_preserves_value(void) {
    install_stub();

    /* First refresh — success with enabled=TRUE. */
    browser_control_state_refresh();
    stub.refresh_cb(TRUE, TRUE, NULL, stub.refresh_ctx);

    /* Second refresh — failure. Cached value should remain TRUE. */
    browser_control_state_refresh();
    g_assert_cmpint(stub.refresh_calls, ==, 2);
    stub.refresh_cb(FALSE, FALSE, "STALE", stub.refresh_ctx);

    gboolean enabled = FALSE, known = FALSE;
    browser_control_state_get(&enabled, &known);
    g_assert_true(known);
    g_assert_true(enabled);
}

static void test_concurrent_refresh_is_coalesced(void) {
    install_stub();

    browser_control_state_refresh();
    browser_control_state_refresh(); /* should be a no-op while in flight */

    g_assert_cmpint(stub.refresh_calls, ==, 1);
}

static void test_request_set_success_updates_cache(void) {
    install_stub();

    SubscriberRecorder rec = {0};
    browser_control_state_subscribe(on_state_changed, &rec);

    SetRecorder srec = {0};
    browser_control_state_request_set(TRUE, on_set_done, &srec);
    g_assert_cmpint(stub.save_calls, ==, 1);
    g_assert_true(stub.save_arg_enabled);

    /* Complete the save successfully. */
    stub.save_cb(TRUE, NULL, stub.save_ctx);

    gboolean enabled = FALSE, known = FALSE;
    browser_control_state_get(&enabled, &known);
    g_assert_true(known);
    g_assert_true(enabled);

    /* Subscriber + per-call callback both fire exactly once. */
    g_assert_cmpint(rec.calls, ==, 1);
    g_assert_cmpint(srec.calls, ==, 1);
    g_assert_cmpint((int)srec.last_status, ==, (int)BROWSER_CONTROL_STATE_OK);
    g_assert_true(srec.last_attempted);
}

static void test_request_set_failure_preserves_previous_known(void) {
    install_stub();

    /* Seed a known FALSE via refresh first. */
    browser_control_state_refresh();
    stub.refresh_cb(TRUE, FALSE, NULL, stub.refresh_ctx);

    SubscriberRecorder rec = {0};
    browser_control_state_subscribe(on_state_changed, &rec);

    SetRecorder srec = {0};
    browser_control_state_request_set(TRUE, on_set_done, &srec);
    /* Now fail the save. The cached value MUST stay at known=TRUE,
     * enabled=FALSE so the UI reverts to the last gateway truth. */
    stub.save_cb(FALSE, "SAVE_FAILED", stub.save_ctx);

    gboolean enabled = TRUE, known = FALSE;
    browser_control_state_get(&enabled, &known);
    g_assert_true(known);
    g_assert_false(enabled);

    /* Subscriber fires on save completion regardless of outcome. */
    g_assert_cmpint(rec.calls, ==, 1);
    g_assert_cmpint((int)srec.last_status, ==, (int)BROWSER_CONTROL_STATE_ERR_SAVE_FAILED);
    g_assert_true(srec.last_attempted);
}

static void test_subscriber_unsubscribe_stops_callbacks(void) {
    install_stub();

    SubscriberRecorder rec = {0};
    guint sub = browser_control_state_subscribe(on_state_changed, &rec);

    browser_control_state_refresh();
    stub.refresh_cb(TRUE, TRUE, NULL, stub.refresh_ctx);
    g_assert_cmpint(rec.calls, ==, 1);

    browser_control_state_unsubscribe(sub);

    /* Drive another refresh; the unsubscribed callback must NOT fire. */
    browser_control_state_refresh();
    stub.refresh_cb(TRUE, FALSE, NULL, stub.refresh_ctx);
    g_assert_cmpint(rec.calls, ==, 1);
}

static void test_subscribe_before_init_returns_valid_id(void) {
    /* Reset to fresh state without calling init(). A caller that
     * subscribes before init() — the tray today, in principle —
     * must still receive a non-zero id, and its callback must fire
     * normally once init/transport are wired and a refresh lands. */
    memset(&stub, 0, sizeof(stub));
    browser_control_state_test_reset();

    SubscriberRecorder rec = {0};
    guint sub = browser_control_state_subscribe(on_state_changed, &rec);
    g_assert_cmpuint(sub, !=, 0);

    browser_control_state_init();
    browser_control_state_set_transport(&stub_transport_template);

    browser_control_state_refresh();
    g_assert_nonnull(stub.refresh_cb);
    stub.refresh_cb(TRUE, TRUE, NULL, stub.refresh_ctx);

    g_assert_cmpint(rec.calls, ==, 1);
    g_assert_true(rec.last_known);
    g_assert_true(rec.last_enabled);

    browser_control_state_unsubscribe(sub);
}

static void test_request_set_without_transport_synthesises_failure(void) {
    /* Reset and intentionally leave the transport detached. */
    browser_control_state_test_reset();
    browser_control_state_init();

    SetRecorder srec = {0};
    browser_control_state_request_set(TRUE, on_set_done, &srec);

    g_assert_cmpint(srec.calls, ==, 1);
    g_assert_cmpint((int)srec.last_status, ==, (int)BROWSER_CONTROL_STATE_ERR_SAVE_FAILED);

    gboolean known = TRUE;
    browser_control_state_get(NULL, &known);
    g_assert_false(known);
}

int main(int argc, char **argv) {
    g_test_init(&argc, &argv, NULL);

    g_test_add_func("/browser_control_state/initial_state_is_unknown",
                    test_initial_state_is_unknown);
    g_test_add_func("/browser_control_state/refresh_success_populates_known",
                    test_refresh_success_populates_known_value);
    g_test_add_func("/browser_control_state/refresh_failure_keeps_unknown",
                    test_refresh_failure_keeps_unknown);
    g_test_add_func("/browser_control_state/refresh_failure_after_known_preserves",
                    test_refresh_failure_after_known_preserves_value);
    g_test_add_func("/browser_control_state/concurrent_refresh_coalesced",
                    test_concurrent_refresh_is_coalesced);
    g_test_add_func("/browser_control_state/request_set_success_updates_cache",
                    test_request_set_success_updates_cache);
    g_test_add_func("/browser_control_state/request_set_failure_preserves_previous",
                    test_request_set_failure_preserves_previous_known);
    g_test_add_func("/browser_control_state/subscriber_unsubscribe_stops",
                    test_subscriber_unsubscribe_stops_callbacks);
    g_test_add_func("/browser_control_state/subscribe_before_init_returns_valid_id",
                    test_subscribe_before_init_returns_valid_id);
    g_test_add_func("/browser_control_state/request_set_no_transport",
                    test_request_set_without_transport_synthesises_failure);

    return g_test_run();
}
