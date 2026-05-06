/*
 * test_gateway_remote_config.c
 *
 * Pure-function tests for gateway_remote_config.c: URL normalization,
 * SSH target parsing, and remote-subtree JSON parsing.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include <glib.h>
#include <json-glib/json-glib.h>

#include "../src/gateway_remote_config.h"

/* ── URL normalization ── */

static void test_url_accepts_wss_with_port(void) {
    gchar *host = NULL; gint port = 0; gboolean tls = FALSE;
    g_autofree gchar *n = gateway_remote_config_normalize_url(
        "wss://gw.example.com:8443", &host, &port, &tls);
    g_assert_cmpstr(n, ==, "wss://gw.example.com:8443");
    g_assert_cmpstr(host, ==, "gw.example.com");
    g_assert_cmpint(port, ==, 8443);
    g_assert_true(tls);
    g_free(host);
}

static void test_url_wss_default_port(void) {
    gchar *host = NULL; gint port = 0; gboolean tls = FALSE;
    g_autofree gchar *n = gateway_remote_config_normalize_url(
        "wss://gw.example.com", &host, &port, &tls);
    g_assert_cmpstr(n, ==, "wss://gw.example.com:443");
    g_assert_cmpint(port, ==, 443);
    g_assert_true(tls);
    g_free(host);
}

static void test_url_ws_loopback_default_port(void) {
    gchar *host = NULL; gint port = 0; gboolean tls = FALSE;
    g_autofree gchar *n = gateway_remote_config_normalize_url(
        "ws://127.0.0.1", &host, &port, &tls);
    g_assert_cmpstr(n, ==, "ws://127.0.0.1:18789");
    g_assert_cmpint(port, ==, 18789);
    g_assert_false(tls);
    g_free(host);
}

static void test_url_ws_rejects_non_loopback(void) {
    gchar *host = NULL; gint port = 0; gboolean tls = FALSE;
    g_autofree gchar *n = gateway_remote_config_normalize_url(
        "ws://gw.example.com", &host, &port, &tls);
    g_assert_null(n);
    g_free(host);
}

static void test_url_rejects_http_scheme(void) {
    gchar *host = NULL; gint port = 0; gboolean tls = FALSE;
    g_autofree gchar *n = gateway_remote_config_normalize_url(
        "http://gw.example.com", &host, &port, &tls);
    g_assert_null(n);
    g_free(host);
}

static void test_url_rejects_empty(void) {
    g_assert_null(gateway_remote_config_normalize_url("", NULL, NULL, NULL));
    g_assert_null(gateway_remote_config_normalize_url("   ", NULL, NULL, NULL));
    g_assert_null(gateway_remote_config_normalize_url(NULL, NULL, NULL, NULL));
}

/* ── SSH target parsing ── */

static void test_ssh_target_user_host(void) {
    gchar *user = NULL, *host = NULL; gint port = 0;
    g_assert_true(gateway_remote_config_parse_ssh_target(
        "alice@example.com", &user, &host, &port));
    g_assert_cmpstr(user, ==, "alice");
    g_assert_cmpstr(host, ==, "example.com");
    g_assert_cmpint(port, ==, 22);
    g_free(user); g_free(host);
}

static void test_ssh_target_host_only(void) {
    gchar *user = NULL, *host = NULL; gint port = 0;
    g_assert_true(gateway_remote_config_parse_ssh_target(
        "example.com", &user, &host, &port));
    g_assert_null(user);
    g_assert_cmpstr(host, ==, "example.com");
    g_assert_cmpint(port, ==, 22);
    g_free(host);
}

static void test_ssh_target_user_host_port(void) {
    gchar *user = NULL, *host = NULL; gint port = 0;
    g_assert_true(gateway_remote_config_parse_ssh_target(
        "alice@example.com:2222", &user, &host, &port));
    g_assert_cmpstr(user, ==, "alice");
    g_assert_cmpstr(host, ==, "example.com");
    g_assert_cmpint(port, ==, 2222);
    g_free(user); g_free(host);
}

static void test_ssh_target_strips_ssh_prefix(void) {
    gchar *user = NULL, *host = NULL; gint port = 0;
    g_assert_true(gateway_remote_config_parse_ssh_target(
        "ssh alice@example.com", &user, &host, &port));
    g_assert_cmpstr(user, ==, "alice");
    g_assert_cmpstr(host, ==, "example.com");
    g_free(user); g_free(host);
}

static void test_ssh_target_rejects_empty_user(void) {
    gchar *user = NULL, *host = NULL; gint port = 0;
    g_assert_false(gateway_remote_config_parse_ssh_target(
        "@example.com", &user, &host, &port));
    g_assert_null(user);
    g_assert_null(host);
}

static void test_ssh_target_rejects_leading_dash(void) {
    gchar *user = NULL, *host = NULL; gint port = 0;
    g_assert_false(gateway_remote_config_parse_ssh_target(
        "-oProxyJump=evil@host", &user, &host, &port));
    g_assert_null(user);
    g_assert_null(host);
}

/*
 * Regression: the optional "ssh " prefix must not allow an argv-
 * smuggling payload through. After stripping the prefix the parser
 * must re-validate that the functional head of the target does not
 * begin with '-'; otherwise OpenSSH would parse the trailing
 * "[user@]host" positional as another option flag.
 */
static void test_ssh_target_rejects_leading_dash_after_ssh_prefix(void) {
    gchar *user = NULL, *host = NULL; gint port = 0;
    g_assert_false(gateway_remote_config_parse_ssh_target(
        "ssh -oProxyCommand=evil@host", &user, &host, &port));
    g_assert_null(user);
    g_assert_null(host);
}

/*
 * Same shape as above but with extra whitespace/tabs after the "ssh "
 * prefix — the parser already skips those, so the argv-smuggling
 * guard must run on the post-skip head, not the immediate post-prefix
 * head.
 */
static void test_ssh_target_rejects_leading_dash_after_ssh_prefix_with_extra_whitespace(void) {
    gchar *user = NULL, *host = NULL; gint port = 0;
    g_assert_false(gateway_remote_config_parse_ssh_target(
        "ssh    \t-oProxyJump=evil@host", &user, &host, &port));
    g_assert_null(user);
    g_assert_null(host);
}

/*
 * Regression: dash-leading user with a clean host (no "ssh " prefix)
 * must also be rejected. The pre-fix parser only checked the host
 * component, leaving the user free to carry "-oProxyCommand=…" into
 * argv via the user@host concatenation.
 */
static void test_ssh_target_rejects_leading_dash_user(void) {
    gchar *user = NULL, *host = NULL; gint port = 0;
    g_assert_false(gateway_remote_config_parse_ssh_target(
        "-bad@host", &user, &host, &port));
    g_assert_null(user);
    g_assert_null(host);
}

static void test_ssh_target_rejects_whitespace(void) {
    gchar *user = NULL, *host = NULL; gint port = 0;
    g_assert_false(gateway_remote_config_parse_ssh_target(
        "alice@exa mple.com", &user, &host, &port));
    g_free(user); g_free(host);
}

static void test_ssh_target_rejects_invalid_port(void) {
    gchar *user = NULL, *host = NULL; gint port = 0;
    g_assert_false(gateway_remote_config_parse_ssh_target(
        "alice@host:99999", &user, &host, &port));
    g_free(user); g_free(host);
    g_assert_false(gateway_remote_config_parse_ssh_target(
        "alice@host:0", &user, &host, &port));
    g_free(user); g_free(host);
}

static void test_ssh_target_rejects_empty_port_suffix(void) {
    /*
     * "alice@host:" is malformed. Pre-fix g_ascii_strtoll returned 0
     * which we already rejected, so the fix had to add an explicit
     * empty-suffix guard for clarity. Keep this regression locked.
     */
    gchar *user = NULL, *host = NULL; gint port = 0;
    g_assert_false(gateway_remote_config_parse_ssh_target(
        "alice@host:", &user, &host, &port));
    g_free(user); g_free(host);
}

static void test_ssh_target_rejects_trailing_garbage_port(void) {
    /*
     * "alice@host:22abc" — g_ascii_strtoll happily returns 22 and stops
     * at 'a'. Without the digit-only guard we would silently accept a
     * corrupted port. Fix locks this in.
     */
    gchar *user = NULL, *host = NULL; gint port = 0;
    g_assert_false(gateway_remote_config_parse_ssh_target(
        "alice@host:22abc", &user, &host, &port));
    g_free(user); g_free(host);
}

/* ── Strict transport string parsing ── */

static void test_transport_strict_accepts_known(void) {
    RemoteTransport t = (RemoteTransport)-1;
    g_assert_true(gateway_remote_config_transport_parse("direct", &t));
    g_assert_cmpint(t, ==, REMOTE_TRANSPORT_DIRECT);
    g_assert_true(gateway_remote_config_transport_parse("ssh", &t));
    g_assert_cmpint(t, ==, REMOTE_TRANSPORT_SSH);
    /* NULL is the documented default and maps to SSH. */
    g_assert_true(gateway_remote_config_transport_parse(NULL, &t));
    g_assert_cmpint(t, ==, REMOTE_TRANSPORT_SSH);
}

static void test_transport_strict_rejects_unknown(void) {
    RemoteTransport t = REMOTE_TRANSPORT_SSH;
    g_assert_false(gateway_remote_config_transport_parse("garbage", &t));
    g_assert_false(gateway_remote_config_transport_parse("", &t));
    /* Out-param remains untouched on rejection — caller decides what to do. */
    g_assert_cmpint(t, ==, REMOTE_TRANSPORT_SSH);
}

/* ── Subtree JSON parsing ── */

static JsonObject* parse_gateway_obj(const gchar *json_text) {
    g_autoptr(JsonParser) parser = json_parser_new();
    g_assert_true(json_parser_load_from_data(parser, json_text, -1, NULL));
    JsonNode *root = json_parser_get_root(parser);
    g_assert_true(JSON_NODE_HOLDS_OBJECT(root));
    JsonObject *root_obj = json_node_get_object(root);
    if (!json_object_has_member(root_obj, "gateway")) return NULL;
    JsonNode *gw_node = json_object_get_member(root_obj, "gateway");
    if (!JSON_NODE_HOLDS_OBJECT(gw_node)) return NULL;
    return json_object_ref(json_node_get_object(gw_node));
}

static void test_parse_absent(void) {
    g_autoptr(JsonObject) gw = parse_gateway_obj("{\"gateway\":{}}");
    GatewayRemoteConfig out = {0};
    g_assert_true(gateway_remote_config_parse(gw, &out));
    g_assert_false(out.present);
    g_assert_cmpint(out.transport, ==, REMOTE_TRANSPORT_SSH);
    gateway_remote_config_clear(&out);
}

static void test_parse_defaults_to_ssh(void) {
    g_autoptr(JsonObject) gw = parse_gateway_obj(
        "{\"gateway\":{\"remote\":{\"sshTarget\":\"a@b\"}}}");
    GatewayRemoteConfig out = {0};
    g_assert_true(gateway_remote_config_parse(gw, &out));
    g_assert_true(out.present);
    g_assert_cmpint(out.transport, ==, REMOTE_TRANSPORT_SSH);
    g_assert_cmpstr(out.ssh_target_host, ==, "b");
    gateway_remote_config_clear(&out);
}

static void test_parse_direct_with_url(void) {
    g_autoptr(JsonObject) gw = parse_gateway_obj(
        "{\"gateway\":{\"remote\":{\"transport\":\"direct\",\"url\":\"wss://gw.example.com:8443\","
        "\"token\":\"tok\",\"password\":\"pw\"}}}");
    GatewayRemoteConfig out = {0};
    g_assert_true(gateway_remote_config_parse(gw, &out));
    g_assert_cmpint(out.transport, ==, REMOTE_TRANSPORT_DIRECT);
    g_assert_cmpstr(out.url, ==, "wss://gw.example.com:8443");
    g_assert_cmpint(out.url_port, ==, 8443);
    g_assert_true(out.url_tls);
    g_assert_cmpstr(out.token, ==, "tok");
    g_assert_cmpstr(out.password, ==, "pw");
    gateway_remote_config_clear(&out);
}

static void test_parse_invalid_transport_string(void) {
    g_autoptr(JsonObject) gw = parse_gateway_obj(
        "{\"gateway\":{\"remote\":{\"transport\":42}}}");
    GatewayRemoteConfig out = {0};
    g_assert_false(gateway_remote_config_parse(gw, &out));
    g_assert_cmpint(out.error_code, ==, REMOTE_CFG_ERR_TRANSPORT_INVALID);
    gateway_remote_config_clear(&out);
}

static void test_parse_invalid_url(void) {
    g_autoptr(JsonObject) gw = parse_gateway_obj(
        "{\"gateway\":{\"remote\":{\"url\":\"http://bad\"}}}");
    GatewayRemoteConfig out = {0};
    g_assert_false(gateway_remote_config_parse(gw, &out));
    g_assert_cmpint(out.error_code, ==, REMOTE_CFG_ERR_URL_INVALID);
    gateway_remote_config_clear(&out);
}

static void test_parse_invalid_target(void) {
    g_autoptr(JsonObject) gw = parse_gateway_obj(
        "{\"gateway\":{\"remote\":{\"sshTarget\":\"alice@host with space\"}}}");
    GatewayRemoteConfig out = {0};
    g_assert_false(gateway_remote_config_parse(gw, &out));
    g_assert_cmpint(out.error_code, ==, REMOTE_CFG_ERR_TARGET_INVALID);
    gateway_remote_config_clear(&out);
}

static void test_parse_token_nonstring_flag(void) {
    g_autoptr(JsonObject) gw = parse_gateway_obj(
        "{\"gateway\":{\"remote\":{\"token\":{\"_secret\":\"x\"}}}}");
    GatewayRemoteConfig out = {0};
    g_assert_true(gateway_remote_config_parse(gw, &out));
    g_assert_true(out.token_unsupported_nonstring);
    g_assert_null(out.token);
    gateway_remote_config_clear(&out);
}

static void test_parse_url_nonstring_is_rejected(void) {
    /*
     * Strict validation: gateway.remote.url must be a string when
     * present. A non-string (number, object, array) is a config error,
     * not silently ignored. This locks in the regression introduced
     * alongside the remote /health probe path.
     */
    g_autoptr(JsonObject) gw1 = parse_gateway_obj(
        "{\"gateway\":{\"remote\":{\"url\":42}}}");
    GatewayRemoteConfig out1 = {0};
    g_assert_false(gateway_remote_config_parse(gw1, &out1));
    g_assert_cmpint(out1.error_code, ==, REMOTE_CFG_ERR_URL_INVALID);
    gateway_remote_config_clear(&out1);

    g_autoptr(JsonObject) gw2 = parse_gateway_obj(
        "{\"gateway\":{\"remote\":{\"url\":{\"_secret\":\"x\"}}}}");
    GatewayRemoteConfig out2 = {0};
    g_assert_false(gateway_remote_config_parse(gw2, &out2));
    g_assert_cmpint(out2.error_code, ==, REMOTE_CFG_ERR_URL_INVALID);
    gateway_remote_config_clear(&out2);

    /* Explicit JSON null is treated as absent — backwards compatible. */
    g_autoptr(JsonObject) gw3 = parse_gateway_obj(
        "{\"gateway\":{\"remote\":{\"url\":null,\"sshTarget\":\"a@b\"}}}");
    GatewayRemoteConfig out3 = {0};
    g_assert_true(gateway_remote_config_parse(gw3, &out3));
    g_assert_null(out3.url);
    gateway_remote_config_clear(&out3);
}

static void test_parse_ssh_target_nonstring_is_rejected(void) {
    /*
     * Same strict guarantee for gateway.remote.sshTarget. A non-string
     * value must abort the parse with REMOTE_CFG_ERR_TARGET_INVALID
     * rather than silently leave the SSH target NULL.
     */
    g_autoptr(JsonObject) gw1 = parse_gateway_obj(
        "{\"gateway\":{\"remote\":{\"sshTarget\":42}}}");
    GatewayRemoteConfig out1 = {0};
    g_assert_false(gateway_remote_config_parse(gw1, &out1));
    g_assert_cmpint(out1.error_code, ==, REMOTE_CFG_ERR_TARGET_INVALID);
    gateway_remote_config_clear(&out1);

    g_autoptr(JsonObject) gw2 = parse_gateway_obj(
        "{\"gateway\":{\"remote\":{\"sshTarget\":[\"a\",\"b\"]}}}");
    GatewayRemoteConfig out2 = {0};
    g_assert_false(gateway_remote_config_parse(gw2, &out2));
    g_assert_cmpint(out2.error_code, ==, REMOTE_CFG_ERR_TARGET_INVALID);
    gateway_remote_config_clear(&out2);

    /* Explicit JSON null is absent — the parse should succeed. */
    g_autoptr(JsonObject) gw3 = parse_gateway_obj(
        "{\"gateway\":{\"remote\":{\"sshTarget\":null}}}");
    GatewayRemoteConfig out3 = {0};
    g_assert_true(gateway_remote_config_parse(gw3, &out3));
    g_assert_null(out3.ssh_target);
    gateway_remote_config_clear(&out3);
}

/* ── Loopback predicate ── */

static void test_loopback_predicate(void) {
    g_assert_true(gateway_remote_config_host_is_loopback("127.0.0.1"));
    g_assert_true(gateway_remote_config_host_is_loopback("::1"));
    g_assert_true(gateway_remote_config_host_is_loopback("localhost"));
    g_assert_true(gateway_remote_config_host_is_loopback("LocalHost"));
    g_assert_true(gateway_remote_config_host_is_loopback("svc.localhost"));
    g_assert_false(gateway_remote_config_host_is_loopback("example.com"));
    g_assert_false(gateway_remote_config_host_is_loopback(""));
    g_assert_false(gateway_remote_config_host_is_loopback(NULL));
}

int main(int argc, char **argv) {
    g_test_init(&argc, &argv, NULL);
    g_test_add_func("/remote_cfg/url/accepts_wss_with_port", test_url_accepts_wss_with_port);
    g_test_add_func("/remote_cfg/url/wss_default_port", test_url_wss_default_port);
    g_test_add_func("/remote_cfg/url/ws_loopback_default_port", test_url_ws_loopback_default_port);
    g_test_add_func("/remote_cfg/url/rejects_non_loopback_ws", test_url_ws_rejects_non_loopback);
    g_test_add_func("/remote_cfg/url/rejects_http_scheme", test_url_rejects_http_scheme);
    g_test_add_func("/remote_cfg/url/rejects_empty", test_url_rejects_empty);

    g_test_add_func("/remote_cfg/ssh/user_host", test_ssh_target_user_host);
    g_test_add_func("/remote_cfg/ssh/host_only", test_ssh_target_host_only);
    g_test_add_func("/remote_cfg/ssh/user_host_port", test_ssh_target_user_host_port);
    g_test_add_func("/remote_cfg/ssh/strips_ssh_prefix", test_ssh_target_strips_ssh_prefix);
    g_test_add_func("/remote_cfg/ssh/rejects_empty_user", test_ssh_target_rejects_empty_user);
    g_test_add_func("/remote_cfg/ssh/rejects_leading_dash", test_ssh_target_rejects_leading_dash);
    g_test_add_func("/remote_cfg/ssh/rejects_leading_dash_after_ssh_prefix",
                    test_ssh_target_rejects_leading_dash_after_ssh_prefix);
    g_test_add_func("/remote_cfg/ssh/rejects_leading_dash_after_ssh_prefix_with_extra_whitespace",
                    test_ssh_target_rejects_leading_dash_after_ssh_prefix_with_extra_whitespace);
    g_test_add_func("/remote_cfg/ssh/rejects_leading_dash_user",
                    test_ssh_target_rejects_leading_dash_user);
    g_test_add_func("/remote_cfg/ssh/rejects_whitespace", test_ssh_target_rejects_whitespace);
    g_test_add_func("/remote_cfg/ssh/rejects_invalid_port", test_ssh_target_rejects_invalid_port);
    g_test_add_func("/remote_cfg/ssh/rejects_empty_port_suffix", test_ssh_target_rejects_empty_port_suffix);
    g_test_add_func("/remote_cfg/ssh/rejects_trailing_garbage_port", test_ssh_target_rejects_trailing_garbage_port);

    g_test_add_func("/remote_cfg/transport/strict_accepts_known", test_transport_strict_accepts_known);
    g_test_add_func("/remote_cfg/transport/strict_rejects_unknown", test_transport_strict_rejects_unknown);

    g_test_add_func("/remote_cfg/parse/absent", test_parse_absent);
    g_test_add_func("/remote_cfg/parse/defaults_to_ssh", test_parse_defaults_to_ssh);
    g_test_add_func("/remote_cfg/parse/direct_with_url", test_parse_direct_with_url);
    g_test_add_func("/remote_cfg/parse/invalid_transport_string", test_parse_invalid_transport_string);
    g_test_add_func("/remote_cfg/parse/invalid_url", test_parse_invalid_url);
    g_test_add_func("/remote_cfg/parse/invalid_target", test_parse_invalid_target);
    g_test_add_func("/remote_cfg/parse/token_nonstring_flag", test_parse_token_nonstring_flag);
    g_test_add_func("/remote_cfg/parse/url_nonstring_is_rejected",
                    test_parse_url_nonstring_is_rejected);
    g_test_add_func("/remote_cfg/parse/ssh_target_nonstring_is_rejected",
                    test_parse_ssh_target_nonstring_is_rejected);

    g_test_add_func("/remote_cfg/host/loopback_predicate", test_loopback_predicate);
    return g_test_run();
}
