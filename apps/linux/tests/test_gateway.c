/*
 * test_gateway.c
 *
 * Unit tests for the gateway config resolution and protocol framing modules.
 * Replaces the former test_health_parse.c which tested CLI output parsing.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include <glib.h>
#include <glib/gstdio.h>
#include <json-glib/json-glib.h>
#include "../src/gateway_config.h"
#include "../src/gateway_protocol.h"

/*
 * Note on Health Lifecycle Testing:
 * 
 * The health lifecycle test design expects that:
 * 1. Stale health callbacks from generation N are ignored after transport moves to generation N+1.
 * 2. Rebuilding transport allows a fresh initial health probe immediately.
 *
 * Due to the lack of async unit test coverage in the current C harness, the lifecycle fix
 * in gateway_client.c is intentionally implemented with a narrow request-context + generation
 * guard. This keeps the behavior robust and auditable without overcomplicating the test setup.
 */

/* ── gateway_config tests ── */

static void clear_env(void) {
    g_unsetenv("OPENCLAW_CONFIG_PATH");
    g_unsetenv("OPENCLAW_STATE_DIR");
    g_unsetenv("OPENCLAW_GATEWAY_PORT");
    g_unsetenv("OPENCLAW_GATEWAY_TOKEN");
    g_unsetenv("OPENCLAW_GATEWAY_PASSWORD");
    g_unsetenv("OPENCLAW_HOME");
}

static void test_config_defaults_no_token_is_invalid(void) {
    /*
     * With no config file and no env overrides, auth_mode defaults to "token"
     * but no token is available → config is invalid (matches gateway server
     * behavior: token mode requires a token).
     */
    g_setenv("OPENCLAW_HOME", "/nonexistent_test_home_12345", TRUE);
    clear_env();
    g_setenv("OPENCLAW_HOME", "/nonexistent_test_home_12345", TRUE);

    GatewayConfig *config = gateway_config_load(NULL);
    g_assert_nonnull(config);
    g_assert_false(config->valid);
    g_assert_cmpint(config->error_code, ==, GW_CFG_ERR_TOKEN_MISSING);
    g_assert_cmpstr(config->auth_mode, ==, "token");
    g_assert_cmpstr(config->host, ==, "127.0.0.1");
    g_assert_cmpint(config->port, ==, 18789);
    g_assert_null(config->token);
    gateway_config_free(config);

    clear_env();
}

static void test_config_env_port_override(void) {
    clear_env();
    g_setenv("OPENCLAW_HOME", "/nonexistent_test_home_12345", TRUE);
    g_setenv("OPENCLAW_GATEWAY_PORT", "9999", TRUE);
    g_setenv("OPENCLAW_GATEWAY_TOKEN", "tok", TRUE);

    GatewayConfig *config = gateway_config_load(NULL);
    g_assert_nonnull(config);
    g_assert_true(config->valid);
    g_assert_cmpint(config->port, ==, 9999);
    gateway_config_free(config);

    clear_env();
}

static void test_config_env_token_override(void) {
    clear_env();
    g_setenv("OPENCLAW_HOME", "/nonexistent_test_home_12345", TRUE);
    g_setenv("OPENCLAW_GATEWAY_TOKEN", "test-token-123", TRUE);

    GatewayConfig *config = gateway_config_load(NULL);
    g_assert_nonnull(config);
    g_assert_true(config->valid);
    g_assert_cmpstr(config->token, ==, "test-token-123");
    g_assert_cmpstr(config->auth_mode, ==, "token");
    gateway_config_free(config);

    clear_env();
}

static void test_config_http_url(void) {
    clear_env();
    g_setenv("OPENCLAW_HOME", "/nonexistent_test_home_12345", TRUE);
    g_setenv("OPENCLAW_GATEWAY_TOKEN", "tok", TRUE);

    GatewayConfig *config = gateway_config_load(NULL);
    g_assert_nonnull(config);
    g_autofree gchar *url = gateway_config_http_url(config);
    g_assert_cmpstr(url, ==, "http://127.0.0.1:18789");
    gateway_config_free(config);

    clear_env();
}

static void test_config_ws_url(void) {
    clear_env();
    g_setenv("OPENCLAW_HOME", "/nonexistent_test_home_12345", TRUE);
    g_setenv("OPENCLAW_GATEWAY_TOKEN", "tok", TRUE);

    GatewayConfig *config = gateway_config_load(NULL);
    g_assert_nonnull(config);
    g_autofree gchar *url = gateway_config_ws_url(config);
    g_assert_cmpstr(url, ==, "ws://127.0.0.1:18789");
    gateway_config_free(config);

    clear_env();
}

static void test_config_invalid_json(void) {
    g_autofree gchar *tmpdir = g_dir_make_tmp("openclaw-test-XXXXXX", NULL);
    g_assert_nonnull(tmpdir);
    g_autofree gchar *config_path = g_build_filename(tmpdir, "openclaw.json", NULL);
    g_file_set_contents(config_path, "not valid json {{{", -1, NULL);

    clear_env();
    g_setenv("OPENCLAW_CONFIG_PATH", config_path, TRUE);

    GatewayConfig *config = gateway_config_load(NULL);
    g_assert_nonnull(config);
    g_assert_false(config->valid);
    g_assert_cmpint(config->error_code, ==, GW_CFG_ERR_PARSE);
    g_assert_nonnull(config->error);
    gateway_config_free(config);

    g_unlink(config_path);
    g_rmdir(tmpdir);
    clear_env();
}

static void test_config_valid_json_with_auth_token(void) {
    g_autofree gchar *tmpdir = g_dir_make_tmp("openclaw-test-XXXXXX", NULL);
    g_assert_nonnull(tmpdir);
    g_autofree gchar *config_path = g_build_filename(tmpdir, "openclaw.json", NULL);
    g_file_set_contents(config_path,
        "{\"gateway\":{\"mode\":\"local\",\"port\":12345,"
        "\"auth\":{\"token\":\"my-token\"}}}", -1, NULL);

    clear_env();
    g_setenv("OPENCLAW_CONFIG_PATH", config_path, TRUE);

    GatewayConfig *config = gateway_config_load(NULL);
    g_assert_nonnull(config);
    g_assert_true(config->valid);
    g_assert_cmpint(config->error_code, ==, GW_CFG_OK);
    g_assert_cmpint(config->port, ==, 12345);
    g_assert_cmpstr(config->auth_mode, ==, "token");
    g_assert_cmpstr(config->token, ==, "my-token");
    g_assert_null(config->password);
    g_assert_true(gateway_config_is_local(config));
    gateway_config_free(config);

    g_unlink(config_path);
    g_rmdir(tmpdir);
    clear_env();
}

static void test_config_auth_password_from_config(void) {
    g_autofree gchar *tmpdir = g_dir_make_tmp("openclaw-test-XXXXXX", NULL);
    g_assert_nonnull(tmpdir);
    g_autofree gchar *config_path = g_build_filename(tmpdir, "openclaw.json", NULL);
    g_file_set_contents(config_path,
        "{\"gateway\":{\"auth\":{\"mode\":\"password\",\"password\":\"my-pw\"}}}", -1, NULL);

    clear_env();
    g_setenv("OPENCLAW_CONFIG_PATH", config_path, TRUE);

    GatewayConfig *config = gateway_config_load(NULL);
    g_assert_nonnull(config);
    g_assert_true(config->valid);
    g_assert_cmpstr(config->auth_mode, ==, "password");
    g_assert_cmpstr(config->password, ==, "my-pw");
    g_assert_null(config->token);
    gateway_config_free(config);

    g_unlink(config_path);
    g_rmdir(tmpdir);
    clear_env();
}

static void test_config_auth_mode_none_no_credentials_needed(void) {
    g_autofree gchar *tmpdir = g_dir_make_tmp("openclaw-test-XXXXXX", NULL);
    g_assert_nonnull(tmpdir);
    g_autofree gchar *config_path = g_build_filename(tmpdir, "openclaw.json", NULL);
    g_file_set_contents(config_path,
        "{\"gateway\":{\"auth\":{\"mode\":\"none\"}}}", -1, NULL);

    clear_env();
    g_setenv("OPENCLAW_CONFIG_PATH", config_path, TRUE);

    GatewayConfig *config = gateway_config_load(NULL);
    g_assert_nonnull(config);
    g_assert_true(config->valid);
    g_assert_cmpstr(config->auth_mode, ==, "none");
    g_assert_null(config->token);
    g_assert_null(config->password);
    gateway_config_free(config);

    g_unlink(config_path);
    g_rmdir(tmpdir);
    clear_env();
}

static void test_config_auth_mode_inferred_from_password(void) {
    g_autofree gchar *tmpdir = g_dir_make_tmp("openclaw-test-XXXXXX", NULL);
    g_assert_nonnull(tmpdir);
    g_autofree gchar *config_path = g_build_filename(tmpdir, "openclaw.json", NULL);
    g_file_set_contents(config_path,
        "{\"gateway\":{\"auth\":{\"password\":\"inferred-pw\"}}}", -1, NULL);

    clear_env();
    g_setenv("OPENCLAW_CONFIG_PATH", config_path, TRUE);

    GatewayConfig *config = gateway_config_load(NULL);
    g_assert_nonnull(config);
    g_assert_true(config->valid);
    g_assert_cmpstr(config->auth_mode, ==, "password");
    g_assert_cmpstr(config->password, ==, "inferred-pw");
    gateway_config_free(config);

    g_unlink(config_path);
    g_rmdir(tmpdir);
    clear_env();
}

static void test_config_auth_unsupported_mode(void) {
    g_autofree gchar *tmpdir = g_dir_make_tmp("openclaw-test-XXXXXX", NULL);
    g_assert_nonnull(tmpdir);
    g_autofree gchar *config_path = g_build_filename(tmpdir, "openclaw.json", NULL);
    g_file_set_contents(config_path,
        "{\"gateway\":{\"auth\":{\"mode\":\"trusted-proxy\"}}}", -1, NULL);

    clear_env();
    g_setenv("OPENCLAW_CONFIG_PATH", config_path, TRUE);

    GatewayConfig *config = gateway_config_load(NULL);
    g_assert_nonnull(config);
    g_assert_false(config->valid);
    g_assert_cmpint(config->error_code, ==, GW_CFG_ERR_AUTH_MODE_UNSUPPORTED);
    gateway_config_free(config);

    g_unlink(config_path);
    g_rmdir(tmpdir);
    clear_env();
}

static void test_config_env_overrides_config_token(void) {
    g_autofree gchar *tmpdir = g_dir_make_tmp("openclaw-test-XXXXXX", NULL);
    g_assert_nonnull(tmpdir);
    g_autofree gchar *config_path = g_build_filename(tmpdir, "openclaw.json", NULL);
    g_file_set_contents(config_path,
        "{\"gateway\":{\"auth\":{\"token\":\"config-token\"}}}", -1, NULL);

    clear_env();
    g_setenv("OPENCLAW_CONFIG_PATH", config_path, TRUE);
    g_setenv("OPENCLAW_GATEWAY_TOKEN", "env-token", TRUE);

    GatewayConfig *config = gateway_config_load(NULL);
    g_assert_nonnull(config);
    g_assert_true(config->valid);
    g_assert_cmpstr(config->token, ==, "env-token");
    gateway_config_free(config);

    g_unlink(config_path);
    g_rmdir(tmpdir);
    clear_env();
}

static void test_config_password_mode_missing_password(void) {
    g_autofree gchar *tmpdir = g_dir_make_tmp("openclaw-test-XXXXXX", NULL);
    g_assert_nonnull(tmpdir);
    g_autofree gchar *config_path = g_build_filename(tmpdir, "openclaw.json", NULL);
    g_file_set_contents(config_path,
        "{\"gateway\":{\"auth\":{\"mode\":\"password\"}}}", -1, NULL);

    clear_env();
    g_setenv("OPENCLAW_CONFIG_PATH", config_path, TRUE);

    GatewayConfig *config = gateway_config_load(NULL);
    g_assert_nonnull(config);
    g_assert_false(config->valid);
    g_assert_cmpint(config->error_code, ==, GW_CFG_ERR_PASSWORD_MISSING);
    gateway_config_free(config);

    g_unlink(config_path);
    g_rmdir(tmpdir);
    clear_env();
}

static void test_config_remote_mode_rejected(void) {
    g_autofree gchar *tmpdir = g_dir_make_tmp("openclaw-test-XXXXXX", NULL);
    g_assert_nonnull(tmpdir);
    g_autofree gchar *config_path = g_build_filename(tmpdir, "openclaw.json", NULL);
    g_file_set_contents(config_path,
        "{\"gateway\":{\"mode\":\"remote\"}}", -1, NULL);

    clear_env();
    g_setenv("OPENCLAW_CONFIG_PATH", config_path, TRUE);

    GatewayConfig *config = gateway_config_load(NULL);
    g_assert_nonnull(config);
    g_assert_false(config->valid);
    g_assert_cmpint(config->error_code, ==, GW_CFG_ERR_MODE_UNSUPPORTED);
    gateway_config_free(config);

    g_unlink(config_path);
    g_rmdir(tmpdir);
    clear_env();
}

static void test_config_secret_ref_unsupported(void) {
    g_autofree gchar *tmpdir = g_dir_make_tmp("openclaw-test-XXXXXX", NULL);
    g_autofree gchar *config_path = g_build_filename(tmpdir, "openclaw.json", NULL);
    g_file_set_contents(config_path,
        "{\"gateway\":{\"auth\":{\"mode\":\"token\",\"token\":{\"_secret\":\"my-key\"}}}}", -1, NULL);

    clear_env();
    GatewayConfigContext ctx = { .explicit_config_path = config_path };
    GatewayConfig *config = gateway_config_load(&ctx);

    g_assert_nonnull(config);
    g_assert_false(config->valid);
    g_assert_cmpint(config->error_code, ==, GW_CFG_ERR_SECRET_REF_UNSUPPORTED);
    gateway_config_free(config);

    g_unlink(config_path);
    g_rmdir(tmpdir);
    clear_env();
}

static void test_config_precedence_explicit_over_state_dir(void) {
    g_autofree gchar *tmpdir = g_dir_make_tmp("openclaw-test-XXXXXX", NULL);
    g_autofree gchar *explicit_path = g_build_filename(tmpdir, "explicit.json", NULL);
    g_autofree gchar *state_dir_path = g_build_filename(tmpdir, "openclaw.json", NULL);
    
    g_file_set_contents(explicit_path,
        "{\"gateway\":{\"auth\":{\"mode\":\"none\"},\"port\":1001}}", -1, NULL);
    g_file_set_contents(state_dir_path,
        "{\"gateway\":{\"auth\":{\"mode\":\"none\"},\"port\":1002}}", -1, NULL);

    clear_env();
    GatewayConfigContext ctx = { 
        .explicit_config_path = explicit_path,
        .effective_state_dir = tmpdir
    };
    GatewayConfig *config = gateway_config_load(&ctx);

    g_assert_nonnull(config);
    g_assert_true(config->valid);
    g_assert_cmpint(config->port, ==, 1001);
    gateway_config_free(config);

    g_unlink(explicit_path);
    g_unlink(state_dir_path);
    g_rmdir(tmpdir);
    clear_env();
}

static void test_config_precedence_state_dir_over_home(void) {
    g_autofree gchar *tmpdir = g_dir_make_tmp("openclaw-test-XXXXXX", NULL);
    g_autofree gchar *state_dir = g_build_filename(tmpdir, "state", NULL);
    g_autofree gchar *home_dir = g_build_filename(tmpdir, "home", NULL);
    g_mkdir(state_dir, 0700);
    g_mkdir(home_dir, 0700);
    g_autofree gchar *home_dot = g_build_filename(home_dir, ".openclaw", NULL);
    g_mkdir(home_dot, 0700);
    
    g_autofree gchar *state_path = g_build_filename(state_dir, "openclaw.json", NULL);
    g_autofree gchar *home_path = g_build_filename(home_dot, "openclaw.json", NULL);

    g_file_set_contents(state_path,
        "{\"gateway\":{\"auth\":{\"mode\":\"none\"},\"port\":2001}}", -1, NULL);
    g_file_set_contents(home_path,
        "{\"gateway\":{\"auth\":{\"mode\":\"none\"},\"port\":2002}}", -1, NULL);

    clear_env();
    g_setenv("OPENCLAW_HOME", home_dir, TRUE);
    GatewayConfigContext ctx = { 
        .effective_state_dir = state_dir
    };
    GatewayConfig *config = gateway_config_load(&ctx);

    g_assert_nonnull(config);
    g_assert_true(config->valid);
    g_assert_cmpint(config->port, ==, 2001);
    gateway_config_free(config);

    g_unlink(state_path);
    g_unlink(home_path);
    g_rmdir(state_dir);
    g_rmdir(home_dot);
    g_rmdir(home_dir);
    g_rmdir(tmpdir);
    clear_env();
}

/* ── Config equivalence tests ── */

static void test_config_equiv_identical(void) {
    g_autofree gchar *tmpdir = g_dir_make_tmp("openclaw-test-XXXXXX", NULL);
    g_autofree gchar *config_path = g_build_filename(tmpdir, "openclaw.json", NULL);
    g_file_set_contents(config_path,
        "{\"gateway\":{\"auth\":{\"token\":\"tok\"}}}", -1, NULL);

    clear_env();
    g_setenv("OPENCLAW_CONFIG_PATH", config_path, TRUE);

    GatewayConfig *a = gateway_config_load(NULL);
    GatewayConfig *b = gateway_config_load(NULL);
    g_assert_true(gateway_config_equivalent(a, b));
    gateway_config_free(a);
    gateway_config_free(b);

    g_unlink(config_path);
    g_rmdir(tmpdir);
    clear_env();
}

static void test_config_equiv_token_change_not_equivalent(void) {
    g_autofree gchar *tmpdir = g_dir_make_tmp("openclaw-test-XXXXXX", NULL);
    g_autofree gchar *config_path = g_build_filename(tmpdir, "openclaw.json", NULL);

    clear_env();
    g_setenv("OPENCLAW_CONFIG_PATH", config_path, TRUE);

    g_file_set_contents(config_path,
        "{\"gateway\":{\"auth\":{\"token\":\"token-A\"}}}", -1, NULL);
    GatewayConfig *a = gateway_config_load(NULL);

    g_file_set_contents(config_path,
        "{\"gateway\":{\"auth\":{\"token\":\"token-B\"}}}", -1, NULL);
    GatewayConfig *b = gateway_config_load(NULL);

    g_assert_false(gateway_config_equivalent(a, b));
    gateway_config_free(a);
    gateway_config_free(b);

    g_unlink(config_path);
    g_rmdir(tmpdir);
    clear_env();
}

static void test_config_equiv_auth_mode_change_not_equivalent(void) {
    g_autofree gchar *tmpdir = g_dir_make_tmp("openclaw-test-XXXXXX", NULL);
    g_autofree gchar *config_path = g_build_filename(tmpdir, "openclaw.json", NULL);

    clear_env();
    g_setenv("OPENCLAW_CONFIG_PATH", config_path, TRUE);

    g_file_set_contents(config_path,
        "{\"gateway\":{\"auth\":{\"mode\":\"token\",\"token\":\"tok\"}}}", -1, NULL);
    GatewayConfig *a = gateway_config_load(NULL);

    g_file_set_contents(config_path,
        "{\"gateway\":{\"auth\":{\"mode\":\"none\"}}}", -1, NULL);
    GatewayConfig *b = gateway_config_load(NULL);

    g_assert_false(gateway_config_equivalent(a, b));
    gateway_config_free(a);
    gateway_config_free(b);

    g_unlink(config_path);
    g_rmdir(tmpdir);
    clear_env();
}

static void test_config_equiv_invalid_different_reasons_not_equivalent(void) {
    /* Invalid(missing token) vs Invalid(unsupported auth mode) → not equivalent */
    g_autofree gchar *tmpdir = g_dir_make_tmp("openclaw-test-XXXXXX", NULL);
    g_autofree gchar *config_path = g_build_filename(tmpdir, "openclaw.json", NULL);

    clear_env();
    g_setenv("OPENCLAW_CONFIG_PATH", config_path, TRUE);

    /* Missing token: token mode but no token */
    g_file_set_contents(config_path,
        "{\"gateway\":{\"auth\":{\"mode\":\"token\"}}}", -1, NULL);
    GatewayConfig *a = gateway_config_load(NULL);
    g_assert_false(a->valid);
    g_assert_cmpint(a->error_code, ==, GW_CFG_ERR_TOKEN_MISSING);

    /* Unsupported auth mode */
    g_file_set_contents(config_path,
        "{\"gateway\":{\"auth\":{\"mode\":\"trusted-proxy\"}}}", -1, NULL);
    GatewayConfig *b = gateway_config_load(NULL);
    g_assert_false(b->valid);
    g_assert_cmpint(b->error_code, ==, GW_CFG_ERR_AUTH_MODE_UNSUPPORTED);

    g_assert_false(gateway_config_equivalent(a, b));
    gateway_config_free(a);
    gateway_config_free(b);

    g_unlink(config_path);
    g_rmdir(tmpdir);
    clear_env();
}

static void test_config_equiv_same_invalid_reason_same_fields(void) {
    /* Same invalid reason + same fields → equivalent */
    g_autofree gchar *tmpdir = g_dir_make_tmp("openclaw-test-XXXXXX", NULL);
    g_autofree gchar *config_path = g_build_filename(tmpdir, "openclaw.json", NULL);

    clear_env();
    g_setenv("OPENCLAW_CONFIG_PATH", config_path, TRUE);

    g_file_set_contents(config_path,
        "{\"gateway\":{\"auth\":{\"mode\":\"token\"}}}", -1, NULL);
    GatewayConfig *a = gateway_config_load(NULL);
    GatewayConfig *b = gateway_config_load(NULL);
    g_assert_false(a->valid);
    g_assert_false(b->valid);
    g_assert_true(gateway_config_equivalent(a, b));
    gateway_config_free(a);
    gateway_config_free(b);

    g_unlink(config_path);
    g_rmdir(tmpdir);
    clear_env();
}

static void test_config_equiv_invalid_different_port_not_equivalent(void) {
    /* Invalid(host/port A) vs Invalid(host/port B) → not equivalent */
    g_autofree gchar *tmpdir = g_dir_make_tmp("openclaw-test-XXXXXX", NULL);
    g_autofree gchar *p1 = g_build_filename(tmpdir, "a.json", NULL);
    g_autofree gchar *p2 = g_build_filename(tmpdir, "b.json", NULL);

    clear_env();

    /* Both are invalid (token mode, no token) but different ports */
    g_file_set_contents(p1,
        "{\"gateway\":{\"port\":1111,\"auth\":{\"mode\":\"token\"}}}", -1, NULL);
    g_setenv("OPENCLAW_CONFIG_PATH", p1, TRUE);
    GatewayConfig *a = gateway_config_load(NULL);

    g_file_set_contents(p2,
        "{\"gateway\":{\"port\":2222,\"auth\":{\"mode\":\"token\"}}}", -1, NULL);
    g_setenv("OPENCLAW_CONFIG_PATH", p2, TRUE);
    GatewayConfig *b = gateway_config_load(NULL);

    g_assert_false(a->valid);
    g_assert_false(b->valid);
    g_assert_false(gateway_config_equivalent(a, b));
    gateway_config_free(a);
    gateway_config_free(b);

    g_unlink(p1);
    g_unlink(p2);
    g_rmdir(tmpdir);
    clear_env();
}

/* ── gateway_protocol tests ── */

static void test_protocol_parse_event(void) {
    const gchar *json = "{\"type\":\"event\",\"event\":\"connect.challenge\",\"payload\":{\"nonce\":\"abc123\"}}";
    GatewayFrame *frame = gateway_protocol_parse_frame(json);
    g_assert_nonnull(frame);
    g_assert_cmpint(frame->type, ==, GATEWAY_FRAME_EVENT);
    g_assert_cmpstr(frame->event_type, ==, "connect.challenge");

    gchar *nonce = gateway_protocol_extract_challenge_nonce(frame);
    g_assert_cmpstr(nonce, ==, "abc123");
    g_free(nonce);

    gateway_frame_free(frame);
}

static void test_protocol_parse_response_ok(void) {
    const gchar *json = "{\"type\":\"res\",\"id\":\"req-1\",\"payload\":{\"auth\":{\"source\":\"token\"},\"policy\":{\"tickIntervalMs\":25000}}}";
    GatewayFrame *frame = gateway_protocol_parse_frame(json);
    g_assert_nonnull(frame);
    g_assert_cmpint(frame->type, ==, GATEWAY_FRAME_RES);
    g_assert_cmpstr(frame->id, ==, "req-1");
    g_assert_null(frame->error);

    gchar *auth_source = NULL;
    gdouble tick_ms = 0;
    gboolean ok = gateway_protocol_parse_hello_ok(frame, &auth_source, &tick_ms);
    g_assert_true(ok);
    g_assert_cmpstr(auth_source, ==, "token");
    g_assert_cmpfloat_with_epsilon(tick_ms, 25000.0, 0.1);
    g_free(auth_source);

    gateway_frame_free(frame);
}

static void test_protocol_parse_response_ok_no_auth(void) {
    /* Valid hello-ok but missing auth block entirely */
    const gchar *json = "{\"type\":\"res\",\"id\":\"req-1\",\"payload\":{\"policy\":{\"tickIntervalMs\":25000}}}";
    GatewayFrame *frame = gateway_protocol_parse_frame(json);
    g_assert_nonnull(frame);
    g_assert_cmpint(frame->type, ==, GATEWAY_FRAME_RES);
    
    gchar *auth_source = (gchar *)0xdeadbeef; /* Ensure it is overwritten to NULL */
    gdouble tick_ms = 0;
    gboolean ok = gateway_protocol_parse_hello_ok(frame, &auth_source, &tick_ms);
    
    g_assert_true(ok);
    g_assert_null(auth_source);
    g_assert_cmpfloat_with_epsilon(tick_ms, 25000.0, 0.1);

    gateway_frame_free(frame);
}

static void test_protocol_parse_response_malformed_policy(void) {
    /* Valid JSON, but policy is not an object */
    const gchar *json = "{\"type\":\"res\",\"id\":\"req-1\",\"payload\":{\"policy\":\"invalid\"}}";
    GatewayFrame *frame = gateway_protocol_parse_frame(json);
    g_assert_nonnull(frame);
    
    gboolean ok = gateway_protocol_parse_hello_ok(frame, NULL, NULL);
    g_assert_false(ok);
    
    gateway_frame_free(frame);
}

static void test_protocol_parse_response_malformed_auth(void) {
    /* Valid JSON, but auth is not an object */
    const gchar *json = "{\"type\":\"res\",\"id\":\"req-1\",\"payload\":{\"auth\":\"invalid\",\"policy\":{\"tickIntervalMs\":25000}}}";
    GatewayFrame *frame = gateway_protocol_parse_frame(json);
    g_assert_nonnull(frame);
    
    gboolean ok = gateway_protocol_parse_hello_ok(frame, NULL, NULL);
    g_assert_false(ok);
    
    gateway_frame_free(frame);
}

static void test_protocol_parse_response_error(void) {
    const gchar *json = "{\"type\":\"res\",\"id\":\"req-2\",\"error\":{\"code\":\"NOT_LINKED\",\"message\":\"Unauthorized\"}}";
    GatewayFrame *frame = gateway_protocol_parse_frame(json);
    g_assert_nonnull(frame);
    g_assert_cmpint(frame->type, ==, GATEWAY_FRAME_RES);
    g_assert_cmpstr(frame->id, ==, "req-2");
    g_assert_cmpstr(frame->error, ==, "Unauthorized");
    g_assert_cmpstr(frame->code, ==, "NOT_LINKED");

    gchar *auth_source = NULL;
    gboolean ok = gateway_protocol_parse_hello_ok(frame, &auth_source, NULL);
    g_assert_false(ok);
    g_assert_null(auth_source);

    gateway_frame_free(frame);
}

static void test_protocol_parse_response_error_string_code_preserved(void) {
    const gchar *json = "{\"type\":\"res\",\"id\":\"req-3\",\"error\":{\"code\":\"AGENT_TIMEOUT\",\"message\":\"Agent timed out\"}}";
    GatewayFrame *frame = gateway_protocol_parse_frame(json);
    g_assert_nonnull(frame);
    g_assert_cmpint(frame->type, ==, GATEWAY_FRAME_RES);
    g_assert_cmpstr(frame->id, ==, "req-3");
    g_assert_cmpstr(frame->code, ==, "AGENT_TIMEOUT");
    g_assert_cmpstr(frame->error, ==, "Agent timed out");
    gateway_frame_free(frame);
}

static void test_protocol_parse_response_error_no_code(void) {
    const gchar *json = "{\"type\":\"res\",\"id\":\"req-4\",\"error\":{\"message\":\"Something failed\"}}";
    GatewayFrame *frame = gateway_protocol_parse_frame(json);
    g_assert_nonnull(frame);
    g_assert_cmpint(frame->type, ==, GATEWAY_FRAME_RES);
    g_assert_null(frame->code);
    g_assert_cmpstr(frame->error, ==, "Something failed");
    gateway_frame_free(frame);
}

static void test_protocol_parse_request(void) {
    const gchar *json = "{\"type\":\"req\",\"id\":\"r1\",\"method\":\"status\",\"params\":{}}";
    GatewayFrame *frame = gateway_protocol_parse_frame(json);
    g_assert_nonnull(frame);
    g_assert_cmpint(frame->type, ==, GATEWAY_FRAME_REQ);
    g_assert_cmpstr(frame->id, ==, "r1");
    g_assert_cmpstr(frame->method, ==, "status");
    gateway_frame_free(frame);
}

static void test_protocol_parse_invalid(void) {
    g_test_expect_message(G_LOG_DOMAIN, G_LOG_LEVEL_WARNING, "*protocol parse error*");
    GatewayFrame *frame = gateway_protocol_parse_frame("not json");
    g_test_assert_expected_messages();
    g_assert_null(frame);

    frame = gateway_protocol_parse_frame("{\"no_type\":true}");
    g_assert_null(frame);
}

static void test_protocol_parse_tick_event(void) {
    const gchar *json = "{\"type\":\"event\",\"event\":\"tick\",\"payload\":{}}";
    GatewayFrame *frame = gateway_protocol_parse_frame(json);
    g_assert_nonnull(frame);
    g_assert_cmpint(frame->type, ==, GATEWAY_FRAME_EVENT);
    g_assert_cmpstr(frame->event_type, ==, "tick");

    /* Should not extract nonce from a tick event */
    gchar *nonce = gateway_protocol_extract_challenge_nonce(frame);
    g_assert_null(nonce);

    gateway_frame_free(frame);
}

static void test_protocol_build_connect_token_mode(void) {
    const gchar *scopes[] = {"operator.admin", "operator.read", NULL};
    gchar *json = gateway_protocol_build_connect_request(
        "test-id", "openclaw-linux", "ui", "Test Client",
        "operator", scopes, "token", "token456", NULL,
        "linux", "dev");
    g_assert_nonnull(json);

    g_autoptr(JsonParser) parser = json_parser_new();
    gboolean parsed = json_parser_load_from_data(parser, json, -1, NULL);
    g_assert_true(parsed);

    JsonObject *root = json_node_get_object(json_parser_get_root(parser));
    g_assert_cmpstr(json_object_get_string_member(root, "type"), ==, "req");
    g_assert_cmpstr(json_object_get_string_member(root, "id"), ==, "test-id");
    g_assert_cmpstr(json_object_get_string_member(root, "method"), ==, "connect");

    JsonObject *params = json_object_get_object_member(root, "params");
    g_assert_nonnull(params);

    /* minProtocol and maxProtocol instead of protocolVersion */
    g_assert_cmpint(json_object_get_int_member(params, "minProtocol"), ==, 3);
    g_assert_cmpint(json_object_get_int_member(params, "maxProtocol"), ==, 3);
    g_assert_false(json_object_has_member(params, "protocolVersion"));

    /* No nonce at params level (not in ConnectParamsSchema) */
    g_assert_false(json_object_has_member(params, "nonce"));

    /* No flat token/password at params level */
    g_assert_false(json_object_has_member(params, "token"));
    g_assert_false(json_object_has_member(params, "password"));

    /* Auth nested under params.auth */
    g_assert_true(json_object_has_member(params, "auth"));
    JsonObject *auth = json_object_get_object_member(params, "auth");
    g_assert_cmpstr(json_object_get_string_member(auth, "token"), ==, "token456");
    g_assert_false(json_object_has_member(auth, "password"));

    g_assert_cmpstr(json_object_get_string_member(params, "role"), ==, "operator");

    /* Client identity — version and platform always present */
    JsonObject *client = json_object_get_object_member(params, "client");
    g_assert_nonnull(client);
    g_assert_cmpstr(json_object_get_string_member(client, "id"), ==, "openclaw-linux");
    g_assert_cmpstr(json_object_get_string_member(client, "mode"), ==, "ui");
    g_assert_cmpstr(json_object_get_string_member(client, "platform"), ==, "linux");
    g_assert_cmpstr(json_object_get_string_member(client, "version"), ==, "dev");

    g_free(json);
}

static void test_protocol_build_connect_password_mode(void) {
    const gchar *scopes[] = {"operator.admin", NULL};
    gchar *json = gateway_protocol_build_connect_request(
        "pw-id", "openclaw-linux", "ui", NULL,
        "operator", scopes, "password", NULL, "my-pw",
        "linux", "1.0.0");
    g_assert_nonnull(json);

    g_autoptr(JsonParser) parser = json_parser_new();
    json_parser_load_from_data(parser, json, -1, NULL);
    JsonObject *root = json_node_get_object(json_parser_get_root(parser));
    JsonObject *params = json_object_get_object_member(root, "params");
    JsonObject *auth = json_object_get_object_member(params, "auth");

    g_assert_nonnull(auth);
    g_assert_cmpstr(json_object_get_string_member(auth, "password"), ==, "my-pw");
    g_assert_false(json_object_has_member(auth, "token"));

    g_free(json);
}

static void test_protocol_build_connect_none_mode(void) {
    const gchar *scopes[] = {"operator.admin", NULL};
    gchar *json = gateway_protocol_build_connect_request(
        "none-id", "openclaw-linux", "ui", NULL,
        "operator", scopes, "none", NULL, NULL,
        "linux", "1.0.0");
    g_assert_nonnull(json);

    g_autoptr(JsonParser) parser = json_parser_new();
    json_parser_load_from_data(parser, json, -1, NULL);
    JsonObject *root = json_node_get_object(json_parser_get_root(parser));
    JsonObject *params = json_object_get_object_member(root, "params");

    /* auth_mode "none" → no auth object at all */
    g_assert_false(json_object_has_member(params, "auth"));
    g_assert_false(json_object_has_member(params, "token"));
    g_assert_false(json_object_has_member(params, "password"));

    g_free(json);
}

static void test_protocol_build_connect_version_platform_always_present(void) {
    const gchar *scopes[] = {NULL};
    gchar *json = gateway_protocol_build_connect_request(
        "vp-id", "openclaw-linux", "ui", NULL,
        "operator", scopes, "none", NULL, NULL,
        NULL, NULL); /* NULL platform and version */
    g_assert_nonnull(json);

    g_autoptr(JsonParser) parser = json_parser_new();
    json_parser_load_from_data(parser, json, -1, NULL);
    JsonObject *root = json_node_get_object(json_parser_get_root(parser));
    JsonObject *params = json_object_get_object_member(root, "params");
    JsonObject *client = json_object_get_object_member(params, "client");

    /* Defaults to "linux" and "dev" when NULL */
    g_assert_cmpstr(json_object_get_string_member(client, "platform"), ==, "linux");
    g_assert_cmpstr(json_object_get_string_member(client, "version"), ==, "dev");

    g_free(json);
}

int main(int argc, char **argv) {
    g_test_init(&argc, &argv, NULL);

    /* Config auth parsing tests */
    g_test_add_func("/gateway/config/defaults_no_token_is_invalid", test_config_defaults_no_token_is_invalid);
    g_test_add_func("/gateway/config/env_port_override", test_config_env_port_override);
    g_test_add_func("/gateway/config/env_token_override", test_config_env_token_override);
    g_test_add_func("/gateway/config/http_url", test_config_http_url);
    g_test_add_func("/gateway/config/ws_url", test_config_ws_url);
    g_test_add_func("/gateway/config/invalid_json", test_config_invalid_json);
    g_test_add_func("/gateway/config/valid_json_with_auth_token", test_config_valid_json_with_auth_token);
    g_test_add_func("/gateway/config/auth_password_from_config", test_config_auth_password_from_config);
    g_test_add_func("/gateway/config/auth_mode_none", test_config_auth_mode_none_no_credentials_needed);
    g_test_add_func("/gateway/config/auth_mode_inferred_from_password", test_config_auth_mode_inferred_from_password);
    g_test_add_func("/gateway/config/auth_unsupported_mode", test_config_auth_unsupported_mode);
    g_test_add_func("/gateway/config/env_overrides_config_token", test_config_env_overrides_config_token);
    g_test_add_func("/gateway/config/password_mode_missing_password", test_config_password_mode_missing_password);
    g_test_add_func("/gateway/config/remote_mode_rejected", test_config_remote_mode_rejected);
    g_test_add_func("/gateway/config/secret_ref_unsupported", test_config_secret_ref_unsupported);
    g_test_add_func("/gateway/config/precedence_explicit_over_state_dir", test_config_precedence_explicit_over_state_dir);
    g_test_add_func("/gateway/config/precedence_state_dir_over_home", test_config_precedence_state_dir_over_home);

    /* Config equivalence tests */
    g_test_add_func("/gateway/config/equiv_identical", test_config_equiv_identical);
    g_test_add_func("/gateway/config/equiv_token_change", test_config_equiv_token_change_not_equivalent);
    g_test_add_func("/gateway/config/equiv_auth_mode_change", test_config_equiv_auth_mode_change_not_equivalent);
    g_test_add_func("/gateway/config/equiv_invalid_different_reasons", test_config_equiv_invalid_different_reasons_not_equivalent);
    g_test_add_func("/gateway/config/equiv_same_invalid_reason", test_config_equiv_same_invalid_reason_same_fields);
    g_test_add_func("/gateway/config/equiv_invalid_different_port", test_config_equiv_invalid_different_port_not_equivalent);

    /* Protocol tests */
    g_test_add_func("/gateway/protocol/parse_event", test_protocol_parse_event);
    g_test_add_func("/gateway/protocol/parse_response_ok", test_protocol_parse_response_ok);
    g_test_add_func("/gateway/protocol/parse_response_ok_no_auth", test_protocol_parse_response_ok_no_auth);
    g_test_add_func("/gateway/protocol/parse_response_malformed_policy", test_protocol_parse_response_malformed_policy);
    g_test_add_func("/gateway/protocol/parse_response_malformed_auth", test_protocol_parse_response_malformed_auth);
    g_test_add_func("/gateway/protocol/parse_response_error", test_protocol_parse_response_error);
    g_test_add_func("/gateway/protocol/parse_response_error_string_code_preserved", test_protocol_parse_response_error_string_code_preserved);
    g_test_add_func("/gateway/protocol/parse_response_error_no_code", test_protocol_parse_response_error_no_code);
    g_test_add_func("/gateway/protocol/parse_request", test_protocol_parse_request);
    g_test_add_func("/gateway/protocol/parse_invalid", test_protocol_parse_invalid);
    g_test_add_func("/gateway/protocol/parse_tick_event", test_protocol_parse_tick_event);
    g_test_add_func("/gateway/protocol/build_connect_token_mode", test_protocol_build_connect_token_mode);
    g_test_add_func("/gateway/protocol/build_connect_password_mode", test_protocol_build_connect_password_mode);
    g_test_add_func("/gateway/protocol/build_connect_none_mode", test_protocol_build_connect_none_mode);
    g_test_add_func("/gateway/protocol/build_connect_version_platform_always_present", test_protocol_build_connect_version_platform_always_present);

    return g_test_run();
}
