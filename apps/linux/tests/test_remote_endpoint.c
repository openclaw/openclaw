/*
 * test_remote_endpoint.c
 *
 * Exercises the remote-endpoint state machine transitions and
 * subscribe-notify contract.
 *
 * The module does not spawn any process; these tests are purely
 * state-machine assertions and can run headless.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include <glib.h>
#include <string.h>

#include "../src/remote_endpoint.h"

typedef struct {
    guint calls;
    RemoteEndpointStateKind last_kind;
    gchar *last_host;
    gint last_port;
    gboolean last_tls;
    gchar *last_token;
    gchar *last_detail;
} Observer;

static void reset_observer(Observer *o) {
    o->calls = 0;
    o->last_kind = REMOTE_ENDPOINT_IDLE;
    g_clear_pointer(&o->last_host, g_free);
    g_clear_pointer(&o->last_token, g_free);
    g_clear_pointer(&o->last_detail, g_free);
    o->last_port = 0;
    o->last_tls = FALSE;
}

static void on_change(gpointer ud) {
    Observer *o = (Observer *)ud;
    const RemoteEndpointSnapshot *s = remote_endpoint_get();
    o->calls++;
    o->last_kind = s->kind;
    g_clear_pointer(&o->last_host, g_free);
    g_clear_pointer(&o->last_token, g_free);
    g_clear_pointer(&o->last_detail, g_free);
    if (s->host) o->last_host = g_strdup(s->host);
    if (s->token) o->last_token = g_strdup(s->token);
    if (s->detail) o->last_detail = g_strdup(s->detail);
    o->last_port = s->port;
    o->last_tls = s->tls;
}

static void test_initial_state_is_idle(void) {
    remote_endpoint_init();
    const RemoteEndpointSnapshot *s = remote_endpoint_get();
    g_assert_cmpint(s->kind, ==, REMOTE_ENDPOINT_IDLE);
    g_assert_null(s->host);
    g_assert_cmpint(s->port, ==, 0);
    remote_endpoint_shutdown();
}

static void test_direct_ready_publishes_fields(void) {
    remote_endpoint_init();
    Observer o = {0};
    guint sub = remote_endpoint_subscribe(on_change, &o);

    remote_endpoint_set_remote_direct_ready("gw.example.com", 443, TRUE,
                                            "tok-123", NULL);

    g_assert_cmpint(o.calls, ==, 1);
    g_assert_cmpint(o.last_kind, ==, REMOTE_ENDPOINT_READY);
    g_assert_cmpstr(o.last_host, ==, "gw.example.com");
    g_assert_cmpint(o.last_port, ==, 443);
    g_assert_true(o.last_tls);
    g_assert_cmpstr(o.last_token, ==, "tok-123");

    remote_endpoint_unsubscribe(sub);
    reset_observer(&o);
    remote_endpoint_shutdown();
}

static void test_ssh_ready_uses_loopback(void) {
    remote_endpoint_init();
    Observer o = {0};
    guint sub = remote_endpoint_subscribe(on_change, &o);

    remote_endpoint_set_remote_ssh_ready(18789, "tok", NULL);

    g_assert_cmpint(o.last_kind, ==, REMOTE_ENDPOINT_READY);
    g_assert_cmpstr(o.last_host, ==, "127.0.0.1");
    g_assert_cmpint(o.last_port, ==, 18789);
    g_assert_false(o.last_tls);

    remote_endpoint_unsubscribe(sub);
    reset_observer(&o);
    remote_endpoint_shutdown();
}

static void test_connecting_and_unavailable_carry_detail(void) {
    remote_endpoint_init();
    Observer o = {0};
    guint sub = remote_endpoint_subscribe(on_change, &o);

    remote_endpoint_set_connecting("Starting SSH tunnel…");
    g_assert_cmpint(o.last_kind, ==, REMOTE_ENDPOINT_CONNECTING);
    g_assert_cmpstr(o.last_detail, ==, "Starting SSH tunnel…");

    remote_endpoint_set_unavailable("ssh exit 255");
    g_assert_cmpint(o.last_kind, ==, REMOTE_ENDPOINT_UNAVAILABLE);
    g_assert_cmpstr(o.last_detail, ==, "ssh exit 255");

    remote_endpoint_unsubscribe(sub);
    reset_observer(&o);
    remote_endpoint_shutdown();
}

static void test_local_clears_all_fields(void) {
    remote_endpoint_init();
    remote_endpoint_set_remote_direct_ready("gw.example.com", 443, TRUE,
                                            "tok", NULL);

    Observer o = {0};
    guint sub = remote_endpoint_subscribe(on_change, &o);
    remote_endpoint_set_local();

    g_assert_cmpint(o.last_kind, ==, REMOTE_ENDPOINT_IDLE);
    g_assert_null(o.last_host);
    g_assert_null(o.last_token);
    g_assert_cmpint(o.last_port, ==, 0);
    g_assert_false(o.last_tls);

    remote_endpoint_unsubscribe(sub);
    reset_observer(&o);
    remote_endpoint_shutdown();
}

static void test_state_to_string(void) {
    g_assert_cmpstr(remote_endpoint_state_to_string(REMOTE_ENDPOINT_IDLE), ==, "idle");
    g_assert_cmpstr(remote_endpoint_state_to_string(REMOTE_ENDPOINT_CONNECTING), ==, "connecting");
    g_assert_cmpstr(remote_endpoint_state_to_string(REMOTE_ENDPOINT_READY), ==, "ready");
    g_assert_cmpstr(remote_endpoint_state_to_string(REMOTE_ENDPOINT_UNAVAILABLE), ==, "unavailable");
}

int main(int argc, char **argv) {
    g_test_init(&argc, &argv, NULL);
    g_test_add_func("/remote_endpoint/initial_state_is_idle", test_initial_state_is_idle);
    g_test_add_func("/remote_endpoint/direct_ready_publishes_fields", test_direct_ready_publishes_fields);
    g_test_add_func("/remote_endpoint/ssh_ready_uses_loopback", test_ssh_ready_uses_loopback);
    g_test_add_func("/remote_endpoint/connecting_and_unavailable_carry_detail", test_connecting_and_unavailable_carry_detail);
    g_test_add_func("/remote_endpoint/local_clears_all_fields", test_local_clears_all_fields);
    g_test_add_func("/remote_endpoint/state_to_string", test_state_to_string);
    return g_test_run();
}
