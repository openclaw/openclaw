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
#include "../src/state.h"
#include "../src/test_seams.h"

/* Test stubs for state.c dependencies */
void notify_on_transition(AppState old_state, AppState new_state) {
    (void)old_state;
    (void)new_state;
}

void notify_on_gateway_connection_transition(gboolean connected) {
    (void)connected;
}

void tray_update_from_state(AppState state) {
    (void)state;
}

void onboarding_refresh(void) {
    /* No-op in tests */
}

void state_on_gateway_refresh_requested(void) {
}

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

static gboolean is_bind_mode_token_for_test(const gchar *value) {
    return g_strcmp0(value, "auto") == 0 ||
           g_strcmp0(value, "lan") == 0 ||
           g_strcmp0(value, "loopback") == 0 ||
           g_strcmp0(value, "tailnet") == 0 ||
           g_strcmp0(value, "custom") == 0;
}

static void assert_host_not_bind_mode_token(const gchar *host) {
    g_assert_nonnull(host);
    g_assert_false(is_bind_mode_token_for_test(host));
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

static void test_config_host_from_config_wins_over_bind_mode(void) {
    g_autofree gchar *tmpdir = g_dir_make_tmp("openclaw-test-XXXXXX", NULL);
    g_assert_nonnull(tmpdir);
    g_autofree gchar *config_path = g_build_filename(tmpdir, "openclaw.json", NULL);
    g_file_set_contents(config_path,
        "{\"gateway\":{\"auth\":{\"token\":\"tok\"},\"host\":\"192.168.1.100\",\"bind\":\"lan\"}}", -1, NULL);

    clear_env();
    g_setenv("OPENCLAW_CONFIG_PATH", config_path, TRUE);

    GatewayConfig *config = gateway_config_load(NULL);
    g_assert_nonnull(config);
    g_assert_true(config->valid);
    g_assert_cmpstr(config->host, ==, "192.168.1.100");

    gateway_config_free(config);
    g_unlink(config_path);
    g_rmdir(tmpdir);
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

    GatewayConfig *cfg = gateway_config_load(NULL);
    g_assert_nonnull(cfg);
    g_assert_true(cfg->valid);
    g_assert_cmpint(cfg->error_code, ==, GW_CFG_OK);
    g_assert_cmpint(cfg->port, ==, 12345);
    g_assert_cmpstr(cfg->auth_mode, ==, "token");
    g_assert_cmpstr(cfg->token, ==, "my-token");
    g_assert_null(cfg->password);
    g_assert_true(gateway_config_is_local(cfg));
    g_assert_false(cfg->has_wizard_onboard_marker);
    gateway_config_free(cfg);

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

static void test_protocol_parse_type_non_string_rejected(void) {
    const gchar *json = "{\"type\":123,\"id\":\"x\"}";
    GatewayFrame *frame = gateway_protocol_parse_frame(json);
    g_assert_null(frame);
}

static void test_protocol_parse_optional_strings_invalid_ignored(void) {
    const gchar *json = "{\"type\":\"req\",\"id\":123,\"method\":456,\"params\":{}}";
    GatewayFrame *frame = gateway_protocol_parse_frame(json);
    g_assert_nonnull(frame);
    g_assert_cmpint(frame->type, ==, GATEWAY_FRAME_REQ);
    g_assert_null(frame->id);
    g_assert_null(frame->method);
    g_assert_nonnull(frame->payload);
    gateway_frame_free(frame);
}

static void test_protocol_parse_event_name_invalid_ignored(void) {
    const gchar *json = "{\"type\":\"event\",\"event\":123,\"payload\":{\"nonce\":\"abc123\"}}";
    GatewayFrame *frame = gateway_protocol_parse_frame(json);
    g_assert_nonnull(frame);
    g_assert_cmpint(frame->type, ==, GATEWAY_FRAME_EVENT);
    g_assert_null(frame->event_type);

    gchar *nonce = gateway_protocol_extract_challenge_nonce(frame);
    g_assert_null(nonce);

    gateway_frame_free(frame);
}

static void test_protocol_parse_response_error_strings_invalid_ignored(void) {
    const gchar *json = "{\"type\":\"res\",\"id\":\"req-5\",\"error\":{\"code\":123,\"message\":456}}";
    GatewayFrame *frame = gateway_protocol_parse_frame(json);
    g_assert_nonnull(frame);
    g_assert_cmpint(frame->type, ==, GATEWAY_FRAME_RES);
    g_assert_cmpstr(frame->id, ==, "req-5");
    g_assert_null(frame->code);
    g_assert_null(frame->error);
    gateway_frame_free(frame);
}

static void test_protocol_parse_challenge_nonce_non_string_ignored(void) {
    const gchar *json = "{\"type\":\"event\",\"event\":\"connect.challenge\",\"payload\":{\"nonce\":123}}";
    GatewayFrame *frame = gateway_protocol_parse_frame(json);
    g_assert_nonnull(frame);
    g_assert_cmpint(frame->type, ==, GATEWAY_FRAME_EVENT);
    g_assert_cmpstr(frame->event_type, ==, "connect.challenge");

    gchar *nonce = gateway_protocol_extract_challenge_nonce(frame);
    g_assert_null(nonce);

    gateway_frame_free(frame);
}

static void test_protocol_parse_response_ok(void) {
    /* Valid hello-ok response per HelloOkSchema */
    const gchar *json = "{"
        "\"type\":\"res\","
        "\"id\":\"req-1\","
        "\"payload\":{"
            "\"type\":\"hello-ok\","
            "\"protocol\":1,"
            "\"server\":{\"version\":\"1.0.0\",\"connId\":\"abc123\"},"
            "\"features\":{\"methods\":[],\"events\":[]},"
            "\"snapshot\":{},"
            "\"auth\":{\"source\":\"token\"},"
            "\"policy\":{\"maxPayload\":1000000,\"maxBufferedBytes\":5000000,\"tickIntervalMs\":25000}"
        "}"
        "}";
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
    /* Valid hello-ok but missing auth block entirely - auth is optional per schema */
    const gchar *json = "{"
        "\"type\":\"res\","
        "\"id\":\"req-1\","
        "\"payload\":{"
            "\"type\":\"hello-ok\","
            "\"protocol\":1,"
            "\"server\":{\"version\":\"1.0.0\",\"connId\":\"abc123\"},"
            "\"features\":{\"methods\":[],\"events\":[]},"
            "\"snapshot\":{},"
            "\"policy\":{\"maxPayload\":1000000,\"maxBufferedBytes\":5000000,\"tickIntervalMs\":25000}"
        "}"
        "}";
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

static void test_protocol_parse_response_ok_auth_source_wrong_type(void) {
    /* Valid hello-ok with malformed auth.source should still parse and return NULL auth_source */
    const gchar *json = "{"
        "\"type\":\"res\","
        "\"id\":\"req-1\","
        "\"payload\":{"
            "\"type\":\"hello-ok\","
            "\"protocol\":1,"
            "\"server\":{\"version\":\"1.0.0\",\"connId\":\"abc123\"},"
            "\"features\":{\"methods\":[],\"events\":[]},"
            "\"snapshot\":{},"
            "\"auth\":{\"source\":123},"
            "\"policy\":{\"maxPayload\":1000000,\"maxBufferedBytes\":5000000,\"tickIntervalMs\":25000}"
        "}"
        "}";
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
    /* Valid JSON frame, but policy is not an object - missing required schema fields too */
    const gchar *json = "{"
        "\"type\":\"res\","
        "\"id\":\"req-1\","
        "\"payload\":{"
            "\"type\":\"hello-ok\","
            "\"protocol\":1,"
            "\"server\":{\"version\":\"1.0.0\",\"connId\":\"abc123\"},"
            "\"features\":{\"methods\":[],\"events\":[]},"
            "\"snapshot\":{},"
            "\"policy\":\"invalid\""
        "}"
        "}";
    GatewayFrame *frame = gateway_protocol_parse_frame(json);
    g_assert_nonnull(frame);
    
    gboolean ok = gateway_protocol_parse_hello_ok(frame, NULL, NULL);
    g_assert_false(ok);
    
    gateway_frame_free(frame);
}

static void test_protocol_parse_response_malformed_auth(void) {
    /* Valid JSON frame, but auth is not an object */
    const gchar *json = "{"
        "\"type\":\"res\","
        "\"id\":\"req-1\","
        "\"payload\":{"
            "\"type\":\"hello-ok\","
            "\"protocol\":1,"
            "\"server\":{\"version\":\"1.0.0\",\"connId\":\"abc123\"},"
            "\"features\":{\"methods\":[],\"events\":[]},"
            "\"snapshot\":{},"
            "\"auth\":\"invalid\","
            "\"policy\":{\"maxPayload\":1000000,\"maxBufferedBytes\":5000000,\"tickIntervalMs\":25000}"
        "}"
        "}";
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

/* ── Regression tests for L6: TLS and host correctness ── */

static void test_config_tls_disabled_uses_http_ws(void) {
    g_autofree gchar *tmpdir = g_dir_make_tmp("openclaw-test-XXXXXX", NULL);
    g_assert_nonnull(tmpdir);
    g_autofree gchar *config_path = g_build_filename(tmpdir, "openclaw.json", NULL);
    g_file_set_contents(config_path,
        "{\"gateway\":{\"auth\":{\"token\":\"tok\"},\"tls\":false}}", -1, NULL);

    clear_env();
    g_setenv("OPENCLAW_CONFIG_PATH", config_path, TRUE);

    GatewayConfig *config = gateway_config_load(NULL);
    g_assert_nonnull(config);
    g_assert_true(config->valid);
    g_assert_false(config->tls_enabled);
    
    g_autofree gchar *http_url = gateway_config_http_url(config);
    g_autofree gchar *ws_url = gateway_config_ws_url(config);
    g_assert_cmpstr(http_url, ==, "http://127.0.0.1:18789");
    g_assert_cmpstr(ws_url, ==, "ws://127.0.0.1:18789");
    
    gateway_config_free(config);

    g_unlink(config_path);
    g_rmdir(tmpdir);
    clear_env();
}

static void test_config_tls_enabled_uses_https_wss(void) {
    g_autofree gchar *tmpdir = g_dir_make_tmp("openclaw-test-XXXXXX", NULL);
    g_assert_nonnull(tmpdir);
    g_autofree gchar *config_path = g_build_filename(tmpdir, "openclaw.json", NULL);
    g_file_set_contents(config_path,
        "{\"gateway\":{\"auth\":{\"token\":\"tok\"},\"tls\":true}}", -1, NULL);

    clear_env();
    g_setenv("OPENCLAW_CONFIG_PATH", config_path, TRUE);

    GatewayConfig *config = gateway_config_load(NULL);
    g_assert_nonnull(config);
    g_assert_true(config->valid);
    g_assert_true(config->tls_enabled);
    
    g_autofree gchar *http_url = gateway_config_http_url(config);
    g_autofree gchar *ws_url = gateway_config_ws_url(config);
    g_autofree gchar *dash_url = gateway_config_dashboard_url(config);
    g_assert_cmpstr(http_url, ==, "https://127.0.0.1:18789");
    g_assert_cmpstr(ws_url, ==, "wss://127.0.0.1:18789");
    g_assert_cmpstr(dash_url, ==, "https://127.0.0.1:18789/#token=tok");
    
    gateway_config_free(config);

    g_unlink(config_path);
    g_rmdir(tmpdir);
    clear_env();
}

static void test_config_host_from_config(void) {
    g_autofree gchar *tmpdir = g_dir_make_tmp("openclaw-test-XXXXXX", NULL);
    g_assert_nonnull(tmpdir);
    g_autofree gchar *config_path = g_build_filename(tmpdir, "openclaw.json", NULL);
    g_file_set_contents(config_path,
        "{\"gateway\":{\"auth\":{\"token\":\"tok\"},\"host\":\"192.168.1.100\"}}", -1, NULL);

    clear_env();
    g_setenv("OPENCLAW_CONFIG_PATH", config_path, TRUE);

    GatewayConfig *config = gateway_config_load(NULL);
    g_assert_nonnull(config);
    g_assert_true(config->valid);
    g_assert_cmpstr(config->host, ==, "192.168.1.100");
    
    g_autofree gchar *http_url = gateway_config_http_url(config);
    g_assert_cmpstr(http_url, ==, "http://192.168.1.100:18789");
    
    gateway_config_free(config);

    g_unlink(config_path);
    g_rmdir(tmpdir);
    clear_env();
}

static void test_config_bind_fallback_ignores_0_0_0_0(void) {
    g_autofree gchar *tmpdir = g_dir_make_tmp("openclaw-test-XXXXXX", NULL);
    g_assert_nonnull(tmpdir);
    g_autofree gchar *config_path = g_build_filename(tmpdir, "openclaw.json", NULL);
    /* 0.0.0.0 should be ignored and fall back to loopback */
    g_file_set_contents(config_path,
        "{\"gateway\":{\"auth\":{\"token\":\"tok\"},\"bind\":\"0.0.0.0\"}}", -1, NULL);

    clear_env();
    g_setenv("OPENCLAW_CONFIG_PATH", config_path, TRUE);

    GatewayConfig *config = gateway_config_load(NULL);
    g_assert_nonnull(config);
    g_assert_true(config->valid);
    /* 0.0.0.0 should fall back to default loopback */
    g_assert_cmpstr(config->host, ==, "127.0.0.1");
    assert_host_not_bind_mode_token(config->host);
    
    gateway_config_free(config);

    g_unlink(config_path);
    g_rmdir(tmpdir);
    clear_env();
}

static void test_config_bind_normalizes_loopback(void) {
    g_autofree gchar *tmpdir = g_dir_make_tmp("openclaw-test-XXXXXX", NULL);
    g_assert_nonnull(tmpdir);
    g_autofree gchar *config_path = g_build_filename(tmpdir, "openclaw.json", NULL);
    /* loopback should be normalized to 127.0.0.1 */
    g_file_set_contents(config_path,
        "{\"gateway\":{\"auth\":{\"token\":\"tok\"},\"bind\":\"loopback\"}}", -1, NULL);

    clear_env();
    g_setenv("OPENCLAW_CONFIG_PATH", config_path, TRUE);

    GatewayConfig *config = gateway_config_load(NULL);
    g_assert_nonnull(config);
    g_assert_true(config->valid);
    g_assert_cmpstr(config->host, ==, "127.0.0.1");
    assert_host_not_bind_mode_token(config->host);
    
    gateway_config_free(config);

    g_unlink(config_path);
    g_rmdir(tmpdir);
    clear_env();
}

static void test_config_bind_mode_auto_maps_to_loopback_host(void) {
    g_autofree gchar *tmpdir = g_dir_make_tmp("openclaw-test-XXXXXX", NULL);
    g_assert_nonnull(tmpdir);
    g_autofree gchar *config_path = g_build_filename(tmpdir, "openclaw.json", NULL);
    g_file_set_contents(config_path,
        "{\"gateway\":{\"auth\":{\"token\":\"tok\"},\"bind\":\"auto\"}}", -1, NULL);

    clear_env();
    g_setenv("OPENCLAW_CONFIG_PATH", config_path, TRUE);

    GatewayConfig *config = gateway_config_load(NULL);
    g_assert_nonnull(config);
    g_assert_true(config->valid);
    g_assert_cmpstr(config->host, ==, "127.0.0.1");
    assert_host_not_bind_mode_token(config->host);

    gateway_config_free(config);
    g_unlink(config_path);
    g_rmdir(tmpdir);
    clear_env();
}

static void test_config_bind_mode_lan_maps_to_loopback_host(void) {
    g_autofree gchar *tmpdir = g_dir_make_tmp("openclaw-test-XXXXXX", NULL);
    g_assert_nonnull(tmpdir);
    g_autofree gchar *config_path = g_build_filename(tmpdir, "openclaw.json", NULL);
    g_file_set_contents(config_path,
        "{\"gateway\":{\"auth\":{\"token\":\"tok\"},\"bind\":\"lan\"}}", -1, NULL);

    clear_env();
    g_setenv("OPENCLAW_CONFIG_PATH", config_path, TRUE);

    GatewayConfig *config = gateway_config_load(NULL);
    g_assert_nonnull(config);
    g_assert_true(config->valid);
    g_assert_cmpstr(config->host, ==, "127.0.0.1");
    assert_host_not_bind_mode_token(config->host);

    gateway_config_free(config);
    g_unlink(config_path);
    g_rmdir(tmpdir);
    clear_env();
}

static void test_config_bind_mode_tailnet_maps_to_loopback_host(void) {
    g_autofree gchar *tmpdir = g_dir_make_tmp("openclaw-test-XXXXXX", NULL);
    g_assert_nonnull(tmpdir);
    g_autofree gchar *config_path = g_build_filename(tmpdir, "openclaw.json", NULL);
    g_file_set_contents(config_path,
        "{\"gateway\":{\"auth\":{\"token\":\"tok\"},\"bind\":\"tailnet\"}}", -1, NULL);

    clear_env();
    g_setenv("OPENCLAW_CONFIG_PATH", config_path, TRUE);

    GatewayConfig *config = gateway_config_load(NULL);
    g_assert_nonnull(config);
    g_assert_true(config->valid);
    g_assert_cmpstr(config->host, ==, "127.0.0.1");
    assert_host_not_bind_mode_token(config->host);

    gateway_config_free(config);
    g_unlink(config_path);
    g_rmdir(tmpdir);
    clear_env();
}

static void test_config_bind_mode_custom_uses_custom_bind_host(void) {
    g_autofree gchar *tmpdir = g_dir_make_tmp("openclaw-test-XXXXXX", NULL);
    g_assert_nonnull(tmpdir);
    g_autofree gchar *config_path = g_build_filename(tmpdir, "openclaw.json", NULL);
    g_file_set_contents(config_path,
        "{\"gateway\":{\"auth\":{\"token\":\"tok\"},\"bind\":\"custom\",\"customBindHost\":\"100.64.0.10\"}}", -1, NULL);

    clear_env();
    g_setenv("OPENCLAW_CONFIG_PATH", config_path, TRUE);

    GatewayConfig *config = gateway_config_load(NULL);
    g_assert_nonnull(config);
    g_assert_true(config->valid);
    g_assert_cmpstr(config->host, ==, "100.64.0.10");
    assert_host_not_bind_mode_token(config->host);

    gateway_config_free(config);
    g_unlink(config_path);
    g_rmdir(tmpdir);
    clear_env();
}

static void test_config_bind_mode_custom_without_custom_bind_host_is_invalid(void) {
    g_autofree gchar *tmpdir = g_dir_make_tmp("openclaw-test-XXXXXX", NULL);
    g_assert_nonnull(tmpdir);
    g_autofree gchar *config_path = g_build_filename(tmpdir, "openclaw.json", NULL);
    g_file_set_contents(config_path,
        "{\"gateway\":{\"auth\":{\"token\":\"tok\"},\"bind\":\"custom\"}}", -1, NULL);

    clear_env();
    g_setenv("OPENCLAW_CONFIG_PATH", config_path, TRUE);

    GatewayConfig *config = gateway_config_load(NULL);
    g_assert_nonnull(config);
    g_assert_false(config->valid);
    g_assert_cmpint(config->error_code, ==, GW_CFG_ERR_BIND_INVALID);

    gateway_config_free(config);
    g_unlink(config_path);
    g_rmdir(tmpdir);
    clear_env();
}

static void test_config_bind_invalid_literal_is_rejected(void) {
    g_autofree gchar *tmpdir = g_dir_make_tmp("openclaw-test-XXXXXX", NULL);
    g_assert_nonnull(tmpdir);
    g_autofree gchar *config_path = g_build_filename(tmpdir, "openclaw.json", NULL);
    g_file_set_contents(config_path,
        "{\"gateway\":{\"auth\":{\"token\":\"tok\"},\"bind\":\"not a host value\"}}", -1, NULL);

    clear_env();
    g_setenv("OPENCLAW_CONFIG_PATH", config_path, TRUE);

    GatewayConfig *config = gateway_config_load(NULL);
    g_assert_nonnull(config);
    g_assert_false(config->valid);
    g_assert_cmpint(config->error_code, ==, GW_CFG_ERR_BIND_INVALID);

    gateway_config_free(config);
    g_unlink(config_path);
    g_rmdir(tmpdir);
    clear_env();
}

static void test_config_tls_object_form(void) {
    g_autofree gchar *tmpdir = g_dir_make_tmp("openclaw-test-XXXXXX", NULL);
    g_assert_nonnull(tmpdir);
    g_autofree gchar *config_path = g_build_filename(tmpdir, "openclaw.json", NULL);
    /* gateway.tls = { enabled: true } */
    g_file_set_contents(config_path,
        "{\"gateway\":{\"auth\":{\"token\":\"tok\"},\"tls\":{\"enabled\":true}}}", -1, NULL);

    clear_env();
    g_setenv("OPENCLAW_CONFIG_PATH", config_path, TRUE);

    GatewayConfig *config = gateway_config_load(NULL);
    g_assert_nonnull(config);
    g_assert_true(config->valid);
    g_assert_true(config->tls_enabled);
    
    gateway_config_free(config);

    g_unlink(config_path);
    g_rmdir(tmpdir);
    clear_env();
}

static void test_config_tls_from_security_block(void) {
    g_autofree gchar *tmpdir = g_dir_make_tmp("openclaw-test-XXXXXX", NULL);
    g_assert_nonnull(tmpdir);
    g_autofree gchar *config_path = g_build_filename(tmpdir, "openclaw.json", NULL);
    /* gateway.security.tls = true */
    g_file_set_contents(config_path,
        "{\"gateway\":{\"auth\":{\"token\":\"tok\"},\"security\":{\"tls\":true}}}", -1, NULL);

    clear_env();
    g_setenv("OPENCLAW_CONFIG_PATH", config_path, TRUE);

    GatewayConfig *config = gateway_config_load(NULL);
    g_assert_nonnull(config);
    g_assert_true(config->valid);
    g_assert_true(config->tls_enabled);
    
    gateway_config_free(config);

    g_unlink(config_path);
    g_rmdir(tmpdir);
    clear_env();
}

/* ── Regression tests for hello-ok validation (BLOCKER B) ── */

static void test_protocol_parse_hello_ok_valid(void) {
    /* Valid hello-ok response per HelloOkSchema - wrapped in res frame */
    const gchar *json = "{"
        "\"type\":\"res\","
        "\"id\":\"req-1\","
        "\"payload\":{"
            "\"type\":\"hello-ok\","
            "\"protocol\":1,"
            "\"server\":{\"version\":\"1.0.0\",\"connId\":\"abc123\"},"
            "\"features\":{\"methods\":[],\"events\":[]},"
            "\"snapshot\":{},"
            "\"policy\":{\"maxPayload\":1000000,\"maxBufferedBytes\":5000000,\"tickIntervalMs\":30000}"
        "}"
        "}";
    
    GatewayFrame *frame = gateway_protocol_parse_frame(json);
    g_assert_nonnull(frame);
    g_assert_cmpint(frame->type, ==, GATEWAY_FRAME_RES);
    g_assert_null(frame->error);

    gchar *auth_source = NULL;
    gdouble tick_interval_ms = 0;
    g_assert_true(gateway_protocol_parse_hello_ok(frame, &auth_source, &tick_interval_ms));
    g_assert_cmpfloat(tick_interval_ms, ==, 30000.0);
    
    gateway_frame_free(frame);
}

static void test_protocol_parse_hello_ok_missing_type(void) {
    /* hello-ok without type field should fail - wrapped in res frame */
    const gchar *json = "{"
        "\"type\":\"res\","
        "\"id\":\"req-1\","
        "\"payload\":{"
            "\"protocol\":1,"
            "\"server\":{\"version\":\"1.0.0\",\"connId\":\"abc123\"},"
            "\"features\":{\"methods\":[],\"events\":[]},"
            "\"snapshot\":{},"
            "\"policy\":{\"maxPayload\":1000000,\"maxBufferedBytes\":5000000,\"tickIntervalMs\":30000}"
        "}"
        "}";
    
    GatewayFrame *frame = gateway_protocol_parse_frame(json);
    g_assert_nonnull(frame);
    g_assert_cmpint(frame->type, ==, GATEWAY_FRAME_RES);
    g_assert_null(frame->error);

    g_assert_false(gateway_protocol_parse_hello_ok(frame, NULL, NULL));
    
    gateway_frame_free(frame);
}

static void test_protocol_parse_hello_ok_wrong_type(void) {
    /* hello-ok with wrong type value should fail - wrapped in res frame */
    const gchar *json = "{"
        "\"type\":\"res\","
        "\"id\":\"req-1\","
        "\"payload\":{"
            "\"type\":\"goodbye\","
            "\"protocol\":1,"
            "\"server\":{\"version\":\"1.0.0\",\"connId\":\"abc123\"},"
            "\"features\":{\"methods\":[],\"events\":[]},"
            "\"snapshot\":{},"
            "\"policy\":{\"maxPayload\":1000000,\"maxBufferedBytes\":5000000,\"tickIntervalMs\":30000}"
        "}"
        "}";
    
    GatewayFrame *frame = gateway_protocol_parse_frame(json);
    g_assert_nonnull(frame);
    g_assert_cmpint(frame->type, ==, GATEWAY_FRAME_RES);
    g_assert_null(frame->error);

    g_assert_false(gateway_protocol_parse_hello_ok(frame, NULL, NULL));
    
    gateway_frame_free(frame);
}

static void test_protocol_parse_hello_ok_zero_tick_interval(void) {
    /* hello-ok with tickIntervalMs=0 should fail - wrapped in res frame */
    const gchar *json = "{"
        "\"type\":\"res\","
        "\"id\":\"req-1\","
        "\"payload\":{"
            "\"type\":\"hello-ok\","
            "\"protocol\":1,"
            "\"server\":{\"version\":\"1.0.0\",\"connId\":\"abc123\"},"
            "\"features\":{\"methods\":[],\"events\":[]},"
            "\"snapshot\":{},"
            "\"policy\":{\"maxPayload\":1000000,\"maxBufferedBytes\":5000000,\"tickIntervalMs\":0}"
        "}"
        "}";
    
    GatewayFrame *frame = gateway_protocol_parse_frame(json);
    g_assert_nonnull(frame);
    g_assert_cmpint(frame->type, ==, GATEWAY_FRAME_RES);
    g_assert_null(frame->error);

    g_assert_false(gateway_protocol_parse_hello_ok(frame, NULL, NULL));
    
    gateway_frame_free(frame);
}

static void test_protocol_parse_hello_ok_negative_tick_interval(void) {
    /* hello-ok with negative tickIntervalMs should fail - wrapped in res frame */
    const gchar *json = "{"
        "\"type\":\"res\","
        "\"id\":\"req-1\","
        "\"payload\":{"
            "\"type\":\"hello-ok\","
            "\"protocol\":1,"
            "\"server\":{\"version\":\"1.0.0\",\"connId\":\"abc123\"},"
            "\"features\":{\"methods\":[],\"events\":[]},"
            "\"snapshot\":{},"
            "\"policy\":{\"maxPayload\":1000000,\"maxBufferedBytes\":5000000,\"tickIntervalMs\":-1000}"
        "}"
        "}";
    
    GatewayFrame *frame = gateway_protocol_parse_frame(json);
    g_assert_nonnull(frame);
    g_assert_cmpint(frame->type, ==, GATEWAY_FRAME_RES);
    g_assert_null(frame->error);

    g_assert_false(gateway_protocol_parse_hello_ok(frame, NULL, NULL));
    
    gateway_frame_free(frame);
}

static void test_protocol_parse_hello_ok_missing_tick_interval(void) {
    /* hello-ok without tickIntervalMs should fail - wrapped in res frame */
    const gchar *json = "{"
        "\"type\":\"res\","
        "\"id\":\"req-1\","
        "\"payload\":{"
            "\"type\":\"hello-ok\","
            "\"protocol\":1,"
            "\"server\":{\"version\":\"1.0.0\",\"connId\":\"abc123\"},"
            "\"features\":{\"methods\":[],\"events\":[]},"
            "\"snapshot\":{},"
            "\"policy\":{\"maxPayload\":1000000,\"maxBufferedBytes\":5000000}"
        "}"
        "}";
    
    GatewayFrame *frame = gateway_protocol_parse_frame(json);
    g_assert_nonnull(frame);
    g_assert_cmpint(frame->type, ==, GATEWAY_FRAME_RES);
    g_assert_null(frame->error);

    g_assert_false(gateway_protocol_parse_hello_ok(frame, NULL, NULL));
    
    gateway_frame_free(frame);
}

static void test_protocol_parse_hello_ok_missing_server_version(void) {
    /* hello-ok missing server.version should fail - wrapped in res frame */
    const gchar *json = "{"
        "\"type\":\"res\","
        "\"id\":\"req-1\","
        "\"payload\":{"
            "\"type\":\"hello-ok\","
            "\"protocol\":1,"
            "\"server\":{\"connId\":\"abc123\"},"
            "\"features\":{\"methods\":[],\"events\":[]},"
            "\"snapshot\":{},"
            "\"policy\":{\"maxPayload\":1000000,\"maxBufferedBytes\":5000000,\"tickIntervalMs\":25000}"
        "}"
        "}";
    
    GatewayFrame *frame = gateway_protocol_parse_frame(json);
    g_assert_nonnull(frame);
    g_assert_cmpint(frame->type, ==, GATEWAY_FRAME_RES);
    g_assert_null(frame->error);

    g_assert_false(gateway_protocol_parse_hello_ok(frame, NULL, NULL));
    
    gateway_frame_free(frame);
}

static void test_protocol_parse_hello_ok_missing_server_conn_id(void) {
    /* hello-ok missing server.connId should fail - wrapped in res frame */
    const gchar *json = "{"
        "\"type\":\"res\","
        "\"id\":\"req-1\","
        "\"payload\":{"
            "\"type\":\"hello-ok\","
            "\"protocol\":1,"
            "\"server\":{\"version\":\"1.0.0\"},"
            "\"features\":{\"methods\":[],\"events\":[]},"
            "\"snapshot\":{},"
            "\"policy\":{\"maxPayload\":1000000,\"maxBufferedBytes\":5000000,\"tickIntervalMs\":25000}"
        "}"
        "}";
    
    GatewayFrame *frame = gateway_protocol_parse_frame(json);
    g_assert_nonnull(frame);
    g_assert_cmpint(frame->type, ==, GATEWAY_FRAME_RES);
    g_assert_null(frame->error);

    g_assert_false(gateway_protocol_parse_hello_ok(frame, NULL, NULL));
    
    gateway_frame_free(frame);
}

static void test_protocol_parse_hello_ok_features_methods_not_array(void) {
    /* hello-ok with features.methods not an array should fail - wrapped in res frame */
    const gchar *json = "{"
        "\"type\":\"res\","
        "\"id\":\"req-1\","
        "\"payload\":{"
            "\"type\":\"hello-ok\","
            "\"protocol\":1,"
            "\"server\":{\"version\":\"1.0.0\",\"connId\":\"abc123\"},"
            "\"features\":{\"methods\":\"bad\",\"events\":[]},"
            "\"snapshot\":{},"
            "\"policy\":{\"maxPayload\":1000000,\"maxBufferedBytes\":5000000,\"tickIntervalMs\":25000}"
        "}"
        "}";
    
    GatewayFrame *frame = gateway_protocol_parse_frame(json);
    g_assert_nonnull(frame);
    g_assert_cmpint(frame->type, ==, GATEWAY_FRAME_RES);
    g_assert_null(frame->error);

    g_assert_false(gateway_protocol_parse_hello_ok(frame, NULL, NULL));
    
    gateway_frame_free(frame);
}

static void test_protocol_parse_hello_ok_features_events_not_array(void) {
    /* hello-ok with features.events not an array should fail - wrapped in res frame */
    const gchar *json = "{"
        "\"type\":\"res\","
        "\"id\":\"req-1\","
        "\"payload\":{"
            "\"type\":\"hello-ok\","
            "\"protocol\":1,"
            "\"server\":{\"version\":\"1.0.0\",\"connId\":\"abc123\"},"
            "\"features\":{\"methods\":[],\"events\":{}},"
            "\"snapshot\":{},"
            "\"policy\":{\"maxPayload\":1000000,\"maxBufferedBytes\":5000000,\"tickIntervalMs\":25000}"
        "}"
        "}";
    
    GatewayFrame *frame = gateway_protocol_parse_frame(json);
    g_assert_nonnull(frame);
    g_assert_cmpint(frame->type, ==, GATEWAY_FRAME_RES);
    g_assert_null(frame->error);

    g_assert_false(gateway_protocol_parse_hello_ok(frame, NULL, NULL));
    
    gateway_frame_free(frame);
}

static void test_protocol_parse_hello_ok_tick_interval_wrong_type(void) {
    /* hello-ok with tickIntervalMs as string should fail - wrapped in res frame */
    const gchar *json = "{"
        "\"type\":\"res\","
        "\"id\":\"req-1\","
        "\"payload\":{"
            "\"type\":\"hello-ok\","
            "\"protocol\":1,"
            "\"server\":{\"version\":\"1.0.0\",\"connId\":\"abc123\"},"
            "\"features\":{\"methods\":[],\"events\":[]},"
            "\"snapshot\":{},"
            "\"policy\":{\"maxPayload\":1000000,\"maxBufferedBytes\":5000000,\"tickIntervalMs\":\"30000\"}"
        "}"
        "}";
    
    GatewayFrame *frame = gateway_protocol_parse_frame(json);
    g_assert_nonnull(frame);
    g_assert_cmpint(frame->type, ==, GATEWAY_FRAME_RES);
    g_assert_null(frame->error);

    g_assert_false(gateway_protocol_parse_hello_ok(frame, NULL, NULL));
    
    gateway_frame_free(frame);
}

static void test_protocol_parse_hello_ok_max_payload_wrong_type(void) {
    /* hello-ok with maxPayload as string should fail - wrapped in res frame */
    const gchar *json = "{"
        "\"type\":\"res\","
        "\"id\":\"req-1\","
        "\"payload\":{"
            "\"type\":\"hello-ok\","
            "\"protocol\":1,"
            "\"server\":{\"version\":\"1.0.0\",\"connId\":\"abc123\"},"
            "\"features\":{\"methods\":[],\"events\":[]},"
            "\"snapshot\":{},"
            "\"policy\":{\"maxPayload\":\"1000000\",\"maxBufferedBytes\":5000000,\"tickIntervalMs\":25000}"
        "}"
        "}";
    
    GatewayFrame *frame = gateway_protocol_parse_frame(json);
    g_assert_nonnull(frame);
    g_assert_cmpint(frame->type, ==, GATEWAY_FRAME_RES);
    g_assert_null(frame->error);

    g_assert_false(gateway_protocol_parse_hello_ok(frame, NULL, NULL));
    
    gateway_frame_free(frame);
}

static void test_protocol_parse_hello_ok_max_buffered_wrong_type(void) {
    /* hello-ok with maxBufferedBytes as string should fail - wrapped in res frame */
    const gchar *json = "{"
        "\"type\":\"res\","
        "\"id\":\"req-1\","
        "\"payload\":{"
            "\"type\":\"hello-ok\","
            "\"protocol\":1,"
            "\"server\":{\"version\":\"1.0.0\",\"connId\":\"abc123\"},"
            "\"features\":{\"methods\":[],\"events\":[]},"
            "\"snapshot\":{},"
            "\"policy\":{\"maxPayload\":1000000,\"maxBufferedBytes\":\"5000000\",\"tickIntervalMs\":25000}"
        "}"
        "}";
    
    GatewayFrame *frame = gateway_protocol_parse_frame(json);
    g_assert_nonnull(frame);
    g_assert_cmpint(frame->type, ==, GATEWAY_FRAME_RES);
    g_assert_null(frame->error);

    g_assert_false(gateway_protocol_parse_hello_ok(frame, NULL, NULL));
    
    gateway_frame_free(frame);
}

static void test_protocol_parse_hello_ok_protocol_string_rejected(void) {
    /* hello-ok with protocol as string should fail - wrapped in res frame */
    const gchar *json = "{"
        "\"type\":\"res\","
        "\"id\":\"req-1\","
        "\"payload\":{"
            "\"type\":\"hello-ok\","
            "\"protocol\":\"1\","
            "\"server\":{\"version\":\"1.0.0\",\"connId\":\"abc123\"},"
            "\"features\":{\"methods\":[],\"events\":[]},"
            "\"snapshot\":{},"
            "\"policy\":{\"maxPayload\":1000000,\"maxBufferedBytes\":5000000,\"tickIntervalMs\":25000}"
        "}"
        "}";
    
    GatewayFrame *frame = gateway_protocol_parse_frame(json);
    g_assert_nonnull(frame);
    g_assert_cmpint(frame->type, ==, GATEWAY_FRAME_RES);
    g_assert_null(frame->error);

    g_assert_false(gateway_protocol_parse_hello_ok(frame, NULL, NULL));
    
    gateway_frame_free(frame);
}

static void test_protocol_parse_hello_ok_protocol_double_rejected(void) {
    /* hello-ok with protocol as double should fail - wrapped in res frame */
    const gchar *json = "{"
        "\"type\":\"res\","
        "\"id\":\"req-1\","
        "\"payload\":{"
            "\"type\":\"hello-ok\","
            "\"protocol\":1.5,"
            "\"server\":{\"version\":\"1.0.0\",\"connId\":\"abc123\"},"
            "\"features\":{\"methods\":[],\"events\":[]},"
            "\"snapshot\":{},"
            "\"policy\":{\"maxPayload\":1000000,\"maxBufferedBytes\":5000000,\"tickIntervalMs\":25000}"
        "}"
        "}";
    
    GatewayFrame *frame = gateway_protocol_parse_frame(json);
    g_assert_nonnull(frame);
    g_assert_cmpint(frame->type, ==, GATEWAY_FRAME_RES);
    g_assert_null(frame->error);

    g_assert_false(gateway_protocol_parse_hello_ok(frame, NULL, NULL));
    
    gateway_frame_free(frame);
}

static void test_protocol_parse_hello_ok_max_payload_double_rejected(void) {
    /* hello-ok with maxPayload as double should fail - wrapped in res frame */
    const gchar *json = "{"
        "\"type\":\"res\","
        "\"id\":\"req-1\","
        "\"payload\":{"
            "\"type\":\"hello-ok\","
            "\"protocol\":1,"
            "\"server\":{\"version\":\"1.0.0\",\"connId\":\"abc123\"},"
            "\"features\":{\"methods\":[],\"events\":[]},"
            "\"snapshot\":{},"
            "\"policy\":{\"maxPayload\":1000000.5,\"maxBufferedBytes\":5000000,\"tickIntervalMs\":25000}"
        "}"
        "}";
    
    GatewayFrame *frame = gateway_protocol_parse_frame(json);
    g_assert_nonnull(frame);
    g_assert_cmpint(frame->type, ==, GATEWAY_FRAME_RES);
    g_assert_null(frame->error);

    g_assert_false(gateway_protocol_parse_hello_ok(frame, NULL, NULL));
    
    gateway_frame_free(frame);
}

static void test_protocol_parse_hello_ok_max_buffered_double_rejected(void) {
    /* hello-ok with maxBufferedBytes as double should fail - wrapped in res frame */
    const gchar *json = "{"
        "\"type\":\"res\","
        "\"id\":\"req-1\","
        "\"payload\":{"
            "\"type\":\"hello-ok\","
            "\"protocol\":1,"
            "\"server\":{\"version\":\"1.0.0\",\"connId\":\"abc123\"},"
            "\"features\":{\"methods\":[],\"events\":[]},"
            "\"snapshot\":{},"
            "\"policy\":{\"maxPayload\":1000000,\"maxBufferedBytes\":5000000.5,\"tickIntervalMs\":25000}"
        "}"
        "}";
    
    GatewayFrame *frame = gateway_protocol_parse_frame(json);
    g_assert_nonnull(frame);
    g_assert_cmpint(frame->type, ==, GATEWAY_FRAME_RES);
    g_assert_null(frame->error);

    g_assert_false(gateway_protocol_parse_hello_ok(frame, NULL, NULL));
    
    gateway_frame_free(frame);
}

static void test_protocol_parse_hello_ok_tick_interval_double_accepted(void) {
    /* hello-ok with tickIntervalMs as double should succeed and preserve value - wrapped in res frame */
    const gchar *json = "{"
        "\"type\":\"res\","
        "\"id\":\"req-1\","
        "\"payload\":{"
            "\"type\":\"hello-ok\","
            "\"protocol\":1,"
            "\"server\":{\"version\":\"1.0.0\",\"connId\":\"abc123\"},"
            "\"features\":{\"methods\":[],\"events\":[]},"
            "\"snapshot\":{},"
            "\"policy\":{\"maxPayload\":1000000,\"maxBufferedBytes\":5000000,\"tickIntervalMs\":25000.5}"
        "}"
        "}";
    
    GatewayFrame *frame = gateway_protocol_parse_frame(json);
    g_assert_nonnull(frame);
    g_assert_cmpint(frame->type, ==, GATEWAY_FRAME_RES);
    g_assert_null(frame->error);

    gdouble tick_interval_ms = 0;
    g_assert_true(gateway_protocol_parse_hello_ok(frame, NULL, &tick_interval_ms));
    g_assert_cmpfloat(tick_interval_ms, ==, 25000.5);
    
    gateway_frame_free(frame);
}

/* ── Regression tests for URL route fragment preservation ── */

static void test_dashboard_url_with_route_preserves_fragment(void) {
    /* Base URL with token fragment */
    g_autofree gchar *url1 = gateway_config_dashboard_url_with_route(
        "http://127.0.0.1:18789/#token=abc123", "chat/session-1");
    g_assert_cmpstr(url1, ==, "http://127.0.0.1:18789/chat/session-1#token=abc123");
    
    /* Base URL with path and fragment */
    g_autofree gchar *url2 = gateway_config_dashboard_url_with_route(
        "http://127.0.0.1:18789/ui/#token=xyz789", "chat/session-2");
    g_assert_cmpstr(url2, ==, "http://127.0.0.1:18789/ui/chat/session-2#token=xyz789");
}

static void test_dashboard_url_with_route_without_fragment(void) {
    /* Base URL with trailing slash, no fragment */
    g_autofree gchar *url1 = gateway_config_dashboard_url_with_route(
        "http://127.0.0.1:18789/", "chat/session-1");
    g_assert_cmpstr(url1, ==, "http://127.0.0.1:18789/chat/session-1");
    
    /* Base URL without trailing slash, no fragment */
    g_autofree gchar *url2 = gateway_config_dashboard_url_with_route(
        "http://127.0.0.1:18789", "chat/session-1");
    g_assert_cmpstr(url2, ==, "http://127.0.0.1:18789/chat/session-1");
}

/* ── Regression tests for config equivalence with TLS ── */

static void test_config_equivalent_tls_differs(void) {
    /* Two configs identical except TLS setting should NOT be equivalent */
    g_autofree gchar *tmpdir = g_dir_make_tmp("openclaw-test-XXXXXX", NULL);
    g_assert_nonnull(tmpdir);
    g_autofree gchar *config_path1 = g_build_filename(tmpdir, "config1.json", NULL);
    g_autofree gchar *config_path2 = g_build_filename(tmpdir, "config2.json", NULL);
    
    g_file_set_contents(config_path1,
        "{\"gateway\":{\"auth\":{\"token\":\"tok\"},\"host\":\"127.0.0.1\",\"port\":18789,\"tls\":false}}", -1, NULL);
    g_file_set_contents(config_path2,
        "{\"gateway\":{\"auth\":{\"token\":\"tok\"},\"host\":\"127.0.0.1\",\"port\":18789,\"tls\":true}}", -1, NULL);
    
    clear_env();
    g_setenv("OPENCLAW_CONFIG_PATH", config_path1, TRUE);
    GatewayConfig *cfg1 = gateway_config_load(NULL);
    g_assert_nonnull(cfg1);
    g_assert_true(cfg1->valid);
    g_assert_false(cfg1->tls_enabled);
    
    clear_env();
    g_setenv("OPENCLAW_CONFIG_PATH", config_path2, TRUE);
    GatewayConfig *cfg2 = gateway_config_load(NULL);
    g_assert_nonnull(cfg2);
    g_assert_true(cfg2->valid);
    g_assert_true(cfg2->tls_enabled);
    
    /* TLS differs, should NOT be equivalent */
    g_assert_false(gateway_config_equivalent(cfg1, cfg2));
    
    gateway_config_free(cfg1);
    gateway_config_free(cfg2);
    g_unlink(config_path1);
    g_unlink(config_path2);
    g_rmdir(tmpdir);
    clear_env();
}

static void test_config_equivalent_tls_same(void) {
    /* Two identical configs including TLS should be equivalent */
    g_autofree gchar *tmpdir = g_dir_make_tmp("openclaw-test-XXXXXX", NULL);
    g_assert_nonnull(tmpdir);
    g_autofree gchar *config_path1 = g_build_filename(tmpdir, "config1.json", NULL);
    g_autofree gchar *config_path2 = g_build_filename(tmpdir, "config2.json", NULL);
    
    g_file_set_contents(config_path1,
        "{\"gateway\":{\"auth\":{\"token\":\"tok\"},\"host\":\"127.0.0.1\",\"port\":18789,\"tls\":true}}", -1, NULL);
    g_file_set_contents(config_path2,
        "{\"gateway\":{\"auth\":{\"token\":\"tok\"},\"host\":\"127.0.0.1\",\"port\":18789,\"tls\":true}}", -1, NULL);
    
    clear_env();
    g_setenv("OPENCLAW_CONFIG_PATH", config_path1, TRUE);
    GatewayConfig *cfg1 = gateway_config_load(NULL);
    g_assert_nonnull(cfg1);
    g_assert_true(cfg1->valid);
    
    clear_env();
    g_setenv("OPENCLAW_CONFIG_PATH", config_path2, TRUE);
    GatewayConfig *cfg2 = gateway_config_load(NULL);
    g_assert_nonnull(cfg2);
    g_assert_true(cfg2->valid);
    
    /* Identical configs should be equivalent */
    g_assert_true(gateway_config_equivalent(cfg1, cfg2));
    
    gateway_config_free(cfg1);
    gateway_config_free(cfg2);
    g_unlink(config_path1);
    g_unlink(config_path2);
    g_rmdir(tmpdir);
    clear_env();
}

/* ── Regression tests for gateway.bind safety ── */

static void test_config_bind_ipv4_literal_used(void) {
    /* A specific IPv4 bind address should be usable as host fallback */
    g_autofree gchar *tmpdir = g_dir_make_tmp("openclaw-test-XXXXXX", NULL);
    g_assert_nonnull(tmpdir);
    g_autofree gchar *config_path = g_build_filename(tmpdir, "openclaw.json", NULL);
    g_file_set_contents(config_path,
        "{\"gateway\":{\"auth\":{\"token\":\"tok\"},\"bind\":\"192.168.1.50\"}}", -1, NULL);
    
    clear_env();
    g_setenv("OPENCLAW_CONFIG_PATH", config_path, TRUE);
    
    GatewayConfig *config = gateway_config_load(NULL);
    g_assert_nonnull(config);
    g_assert_true(config->valid);
    /* bind = specific IPv4 should be used as host */
    g_assert_cmpstr(config->host, ==, "192.168.1.50");
    assert_host_not_bind_mode_token(config->host);
    
    gateway_config_free(config);
    g_unlink(config_path);
    g_rmdir(tmpdir);
    clear_env();
}

static void test_config_bind_hostname_literal_used(void) {
    /* A valid hostname literal bind should be usable as host fallback */
    g_autofree gchar *tmpdir = g_dir_make_tmp("openclaw-test-XXXXXX", NULL);
    g_assert_nonnull(tmpdir);
    g_autofree gchar *config_path = g_build_filename(tmpdir, "openclaw.json", NULL);
    g_file_set_contents(config_path,
        "{\"gateway\":{\"auth\":{\"token\":\"tok\"},\"bind\":\"gateway.internal\"}}", -1, NULL);

    clear_env();
    g_setenv("OPENCLAW_CONFIG_PATH", config_path, TRUE);

    GatewayConfig *config = gateway_config_load(NULL);
    g_assert_nonnull(config);
    g_assert_true(config->valid);
    g_assert_cmpstr(config->host, ==, "gateway.internal");
    assert_host_not_bind_mode_token(config->host);

    gateway_config_free(config);
    g_unlink(config_path);
    g_rmdir(tmpdir);
    clear_env();
}

static void test_config_bind_mode_custom_with_mode_token_custom_bind_host_is_invalid(void) {
    /* bind=custom with customBindHost as a bind mode token must be rejected */
    g_autofree gchar *tmpdir = g_dir_make_tmp("openclaw-test-XXXXXX", NULL);
    g_assert_nonnull(tmpdir);
    g_autofree gchar *config_path = g_build_filename(tmpdir, "openclaw.json", NULL);
    g_file_set_contents(config_path,
        "{\"gateway\":{\"auth\":{\"token\":\"tok\"},\"bind\":\"custom\",\"customBindHost\":\"lan\"}}", -1, NULL);

    clear_env();
    g_setenv("OPENCLAW_CONFIG_PATH", config_path, TRUE);

    GatewayConfig *config = gateway_config_load(NULL);
    g_assert_nonnull(config);
    g_assert_false(config->valid);
    g_assert_cmpint(config->error_code, ==, GW_CFG_ERR_BIND_INVALID);

    gateway_config_free(config);
    g_unlink(config_path);
    g_rmdir(tmpdir);
    clear_env();
}

static void test_config_bind_invalid_hostname_literal_is_rejected(void) {
    /* Invalid hostname label (leading '-') must be rejected */
    g_autofree gchar *tmpdir = g_dir_make_tmp("openclaw-test-XXXXXX", NULL);
    g_assert_nonnull(tmpdir);
    g_autofree gchar *config_path = g_build_filename(tmpdir, "openclaw.json", NULL);
    g_file_set_contents(config_path,
        "{\"gateway\":{\"auth\":{\"token\":\"tok\"},\"bind\":\"-bad.host\"}}", -1, NULL);

    clear_env();
    g_setenv("OPENCLAW_CONFIG_PATH", config_path, TRUE);

    GatewayConfig *config = gateway_config_load(NULL);
    g_assert_nonnull(config);
    g_assert_false(config->valid);
    g_assert_cmpint(config->error_code, ==, GW_CFG_ERR_BIND_INVALID);

    gateway_config_free(config);
    g_unlink(config_path);
    g_rmdir(tmpdir);
    clear_env();
}

static void test_config_bind_ipv6_unspecified_rejected(void) {
    /* IPv6 unspecified address :: should be rejected and fall back to loopback */
    g_autofree gchar *tmpdir = g_dir_make_tmp("openclaw-test-XXXXXX", NULL);
    g_assert_nonnull(tmpdir);
    g_autofree gchar *config_path = g_build_filename(tmpdir, "openclaw.json", NULL);
    g_file_set_contents(config_path,
        "{\"gateway\":{\"auth\":{\"token\":\"tok\"},\"bind\":\"::\"}}", -1, NULL);
    
    clear_env();
    g_setenv("OPENCLAW_CONFIG_PATH", config_path, TRUE);
    
    GatewayConfig *config = gateway_config_load(NULL);
    g_assert_nonnull(config);
    g_assert_true(config->valid);
    /* :: should fall back to default loopback */
    g_assert_cmpstr(config->host, ==, "127.0.0.1");
    assert_host_not_bind_mode_token(config->host);
    
    gateway_config_free(config);
    g_unlink(config_path);
    g_rmdir(tmpdir);
    clear_env();
}

/* ── Feature A: Config path resolution helper tests ── */

static void test_config_resolve_path_env_override(void) {
    /* OPENCLAW_CONFIG_PATH env should be returned directly */
    g_autofree gchar *tmpdir = g_dir_make_tmp("openclaw-test-XXXXXX", NULL);
    g_autofree gchar *custom_path = g_build_filename(tmpdir, "custom.json", NULL);
    
    clear_env();
    g_setenv("OPENCLAW_CONFIG_PATH", custom_path, TRUE);
    
    gchar *resolved = gateway_config_resolve_path(NULL);
    g_assert_cmpstr(resolved, ==, custom_path);
    
    gateway_config_free_resolved_path(resolved);
    g_rmdir(tmpdir);
    clear_env();
}

static void test_config_resolve_path_default(void) {
    /* Without env override, should return default ~/.openclaw/openclaw.json path */
    clear_env();
    g_setenv("OPENCLAW_HOME", "/test/home", TRUE);
    
    gchar *resolved = gateway_config_resolve_path(NULL);
    g_assert_cmpstr(resolved, ==, "/test/home/.openclaw/openclaw.json");
    
    gateway_config_free_resolved_path(resolved);
    clear_env();
}

static void test_config_resolve_path_with_context(void) {
    /* Context explicit_config_path should be respected */
    g_autofree gchar *tmpdir = g_dir_make_tmp("openclaw-test-XXXXXX", NULL);
    g_autofree gchar *explicit = g_build_filename(tmpdir, "explicit.json", NULL);
    
    clear_env();
    GatewayConfigContext ctx = { .explicit_config_path = explicit };
    
    gchar *resolved = gateway_config_resolve_path(&ctx);
    g_assert_cmpstr(resolved, ==, explicit);
    
    gateway_config_free_resolved_path(resolved);
    g_rmdir(tmpdir);
    clear_env();
}

/* ── Feature B: Model config detection tests ── */

static void test_config_has_model_config_with_model(void) {
    /* Config with agents.default.model should have has_model_config=TRUE */
    g_autofree gchar *tmpdir = g_dir_make_tmp("openclaw-test-XXXXXX", NULL);
    g_assert_nonnull(tmpdir);
    g_autofree gchar *config_path = g_build_filename(tmpdir, "openclaw.json", NULL);
    g_file_set_contents(config_path,
        "{\"gateway\":{\"auth\":{\"token\":\"tok\"}},"
        "\"agents\":{\"default\":{\"model\":\"claude-3-sonnet\"}}}", -1, NULL);
    
    clear_env();
    g_setenv("OPENCLAW_CONFIG_PATH", config_path, TRUE);
    
    GatewayConfig *config = gateway_config_load(NULL);
    g_assert_nonnull(config);
    g_assert_true(config->valid);
    g_assert_true(config->has_model_config);
    
    gateway_config_free(config);
    g_unlink(config_path);
    g_rmdir(tmpdir);
    clear_env();
}

static void test_config_has_model_config_with_provider(void) {
    /* Config with agents.default.modelProvider should have has_model_config=TRUE */
    g_autofree gchar *tmpdir = g_dir_make_tmp("openclaw-test-XXXXXX", NULL);
    g_assert_nonnull(tmpdir);
    g_autofree gchar *config_path = g_build_filename(tmpdir, "openclaw.json", NULL);
    g_file_set_contents(config_path,
        "{\"gateway\":{\"auth\":{\"token\":\"tok\"}},"
        "\"agents\":{\"default\":{\"modelProvider\":\"anthropic\"}}}", -1, NULL);
    
    clear_env();
    g_setenv("OPENCLAW_CONFIG_PATH", config_path, TRUE);
    
    GatewayConfig *config = gateway_config_load(NULL);
    g_assert_nonnull(config);
    g_assert_true(config->valid);
    g_assert_true(config->has_model_config);
    
    gateway_config_free(config);
    g_unlink(config_path);
    g_rmdir(tmpdir);
    clear_env();
}

static void test_config_has_model_config_missing(void) {
    /* Config without agents.default.model/modelProvider should have has_model_config=FALSE */
    g_autofree gchar *tmpdir = g_dir_make_tmp("openclaw-test-XXXXXX", NULL);
    g_assert_nonnull(tmpdir);
    g_autofree gchar *config_path = g_build_filename(tmpdir, "openclaw.json", NULL);
    g_file_set_contents(config_path,
        "{\"gateway\":{\"auth\":{\"token\":\"tok\"}},"
        "\"agents\":{\"default\":{\"workspace\":\"/tmp\"}}}", -1, NULL);
    
    clear_env();
    g_setenv("OPENCLAW_CONFIG_PATH", config_path, TRUE);
    
    GatewayConfig *config = gateway_config_load(NULL);
    g_assert_nonnull(config);
    g_assert_true(config->valid);
    g_assert_false(config->has_model_config);
    
    gateway_config_free(config);
    g_unlink(config_path);
    g_rmdir(tmpdir);
    clear_env();
}

static void test_config_has_model_config_no_agents(void) {
    /* Config without agents section should have has_model_config=FALSE */
    g_autofree gchar *tmpdir = g_dir_make_tmp("openclaw-test-XXXXXX", NULL);
    g_assert_nonnull(tmpdir);
    g_autofree gchar *config_path = g_build_filename(tmpdir, "openclaw.json", NULL);
    g_file_set_contents(config_path,
        "{\"gateway\":{\"auth\":{\"token\":\"tok\"}}}", -1, NULL);
    
    clear_env();
    g_setenv("OPENCLAW_CONFIG_PATH", config_path, TRUE);
    
    GatewayConfig *config = gateway_config_load(NULL);
    g_assert_nonnull(config);
    g_assert_true(config->valid);
    g_assert_false(config->has_model_config);
    
    gateway_config_free(config);
    g_unlink(config_path);
    g_rmdir(tmpdir);
    clear_env();
}

/* ── Feature A: Config monitor rearm decision tests ── */

static void test_rearm_skip_file_created_needs_rearm(void) {
    /* Scenario: same paths, no file before, file now exists
     * Must NOT skip - need to arm file monitor
     */
    gboolean skip = config_monitor_can_skip_rearm(
        "/home/user/.openclaw", "/home/user/.openclaw",
        "/home/user/.openclaw/openclaw.json", "/home/user/.openclaw/openclaw.json",
        TRUE,    /* have_dir_monitor */
        TRUE,    /* need_file_monitor (file now exists) */
        FALSE);  /* have_file_monitor (didn't have one before) */
    g_assert_false(skip);
}

static void test_rearm_skip_file_still_exists_may_skip(void) {
    /* Scenario: same paths, file existed before, still exists
     * May skip - file monitor state matches need
     */
    gboolean skip = config_monitor_can_skip_rearm(
        "/home/user/.openclaw", "/home/user/.openclaw",
        "/home/user/.openclaw/openclaw.json", "/home/user/.openclaw/openclaw.json",
        TRUE,   /* have_dir_monitor */
        TRUE,   /* need_file_monitor (file exists) */
        TRUE);  /* have_file_monitor (already have one) */
    g_assert_true(skip);
}

static void test_rearm_skip_file_deleted_needs_rearm(void) {
    /* Scenario: same paths, file existed before, now deleted
     * Must NOT skip - need to tear down file monitor
     */
    gboolean skip = config_monitor_can_skip_rearm(
        "/home/user/.openclaw", "/home/user/.openclaw",
        "/home/user/.openclaw/openclaw.json", "/home/user/.openclaw/openclaw.json",
        TRUE,    /* have_dir_monitor */
        FALSE,   /* need_file_monitor (file no longer exists) */
        TRUE);   /* have_file_monitor (still have one) */
    g_assert_false(skip);
}

static void test_rearm_skip_no_file_still_none_may_skip(void) {
    /* Scenario: same paths, no file before, still no file
     * May skip - dir monitor already exists, no file monitor needed
     */
    gboolean skip = config_monitor_can_skip_rearm(
        "/home/user/.openclaw", "/home/user/.openclaw",
        "/home/user/.openclaw/openclaw.json", "/home/user/.openclaw/openclaw.json",
        TRUE,    /* have_dir_monitor */
        FALSE,   /* need_file_monitor (file doesn't exist) */
        FALSE);  /* have_file_monitor (don't have one) */
    g_assert_true(skip);
}

static void test_rearm_skip_dir_changed_needs_rearm(void) {
    /* Scenario: dir path changed - must rearm regardless of file state */
    gboolean skip = config_monitor_can_skip_rearm(
        "/new/path", "/old/path",
        "/new/path/openclaw.json", "/old/path/openclaw.json",
        TRUE,   /* have_dir_monitor */
        TRUE,   /* need_file_monitor */
        TRUE);  /* have_file_monitor */
    g_assert_false(skip);
}

static void test_rearm_skip_path_changed_needs_rearm(void) {
    /* Scenario: file path changed (different filename) - must rearm */
    gboolean skip = config_monitor_can_skip_rearm(
        "/home/user/.openclaw", "/home/user/.openclaw",
        "/home/user/.openclaw/new.json", "/home/user/.openclaw/old.json",
        TRUE,   /* have_dir_monitor */
        TRUE,   /* need_file_monitor */
        TRUE);  /* have_file_monitor */
    g_assert_false(skip);
}

static void test_rearm_skip_no_dir_monitor_needs_rearm(void) {
    /* Scenario: no dir monitor yet - must rearm even if paths match */
    gboolean skip = config_monitor_can_skip_rearm(
        "/home/user/.openclaw", "/home/user/.openclaw",
        "/home/user/.openclaw/openclaw.json", "/home/user/.openclaw/openclaw.json",
        FALSE,  /* have_dir_monitor - no dir monitor yet! */
        TRUE,   /* need_file_monitor */
        FALSE); /* have_file_monitor */
    g_assert_false(skip);
}

/* ── Feature B: Onboarding state priority tests ── */

/* Helper to set up minimal state for testing compute_state logic
 * Since compute_state is static, we need to test via state_update_health()
 * which is the public entry point that populates the HealthState.
 */
extern void state_update_health(const HealthState *health_state);
extern AppState state_get_current(void);

static void test_state_priority_no_setup_needs_setup(void) {
    /* No setup detected + no config valid -> STATE_NEEDS_SETUP */
    clear_env();
    
    state_init();
    SystemdState sys = {0};
    sys.installed = FALSE;
    state_update_systemd(&sys);
    
    HealthState hs = {0};
    hs.last_updated = g_get_real_time();
    hs.config_valid = FALSE;
    hs.setup_detected = FALSE;
    hs.has_model_config = FALSE;
    
    state_update_health(&hs);
    
    g_assert_cmpint(state_get_current(), ==, STATE_NEEDS_SETUP);
    
    clear_env();
}

static void test_state_priority_setup_no_model_needs_onboarding(void) {
    /* Setup present + config valid + no wizard marker -> STATE_NEEDS_ONBOARDING */
    clear_env();
    
    state_init();
    SystemdState sys = {0};
    sys.installed = TRUE;
    state_update_systemd(&sys);
    
    HealthState hs = {0};
    hs.last_updated = g_get_real_time();
    hs.config_valid = TRUE;
    hs.setup_detected = TRUE;
    hs.has_wizard_onboard_marker = FALSE;
    
    state_update_health(&hs);
    
    g_assert_cmpint(state_get_current(), ==, STATE_NEEDS_ONBOARDING);
    
    clear_env();
}

static void test_state_priority_setup_with_model_not_onboarding(void) {
    /* Setup present + config valid + wizard marker -> NOT STATE_NEEDS_ONBOARDING */
    clear_env();
    
    state_init();
    SystemdState sys = {0};
    sys.installed = TRUE;
    state_update_systemd(&sys);
    
    HealthState hs = {0};
    hs.last_updated = g_get_real_time();
    hs.config_valid = TRUE;
    hs.setup_detected = TRUE;
    hs.has_wizard_onboard_marker = TRUE;
    /* No HTTP connectivity, so we won't be READY, but shouldn't be ONBOARDING */
    hs.http_ok = FALSE;
    
    state_update_health(&hs);
    
    AppState current = state_get_current();
    g_assert_cmpint(current, !=, STATE_NEEDS_ONBOARDING);
    /* With valid config + setup but no connectivity, we expect AUTH_NEEDED or similar */
    
    clear_env();
}

static void test_state_priority_setup_gateway_not_installed(void) {
    /* Setup detected but gateway not installed takes priority over onboarding
     * (This tests the existing priority order)
     */
    clear_env();
    
    state_init();
    SystemdState sys = {0};
    sys.installed = FALSE;
    state_update_systemd(&sys);
    
    HealthState hs = {0};
    hs.last_updated = g_get_real_time();
    hs.config_valid = TRUE;
    hs.setup_detected = TRUE;
    /* Note: has_wizard_onboard_marker irrelevant if gateway not installed - 
     * STATE_NEEDS_GATEWAY_INSTALL should win */
    hs.has_wizard_onboard_marker = FALSE;
    
    state_update_health(&hs);
    
    AppState current = state_get_current();
    /* When gateway is not installed, that takes priority over onboarding */
    g_assert_cmpint(current, ==, STATE_NEEDS_GATEWAY_INSTALL);
    
    clear_env();
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
    g_test_add_func("/gateway/protocol/parse_response_ok_auth_source_wrong_type", test_protocol_parse_response_ok_auth_source_wrong_type);
    g_test_add_func("/gateway/protocol/parse_response_malformed_policy", test_protocol_parse_response_malformed_policy);
    g_test_add_func("/gateway/protocol/parse_response_malformed_auth", test_protocol_parse_response_malformed_auth);
    g_test_add_func("/gateway/protocol/parse_response_error", test_protocol_parse_response_error);
    g_test_add_func("/gateway/protocol/parse_response_error_string_code_preserved", test_protocol_parse_response_error_string_code_preserved);
    g_test_add_func("/gateway/protocol/parse_response_error_no_code", test_protocol_parse_response_error_no_code);
    g_test_add_func("/gateway/protocol/parse_request", test_protocol_parse_request);
    g_test_add_func("/gateway/protocol/parse_invalid", test_protocol_parse_invalid);
    g_test_add_func("/gateway/protocol/parse_tick_event", test_protocol_parse_tick_event);
    g_test_add_func("/gateway/protocol/parse_type_non_string_rejected", test_protocol_parse_type_non_string_rejected);
    g_test_add_func("/gateway/protocol/parse_optional_strings_invalid_ignored", test_protocol_parse_optional_strings_invalid_ignored);
    g_test_add_func("/gateway/protocol/parse_event_name_invalid_ignored", test_protocol_parse_event_name_invalid_ignored);
    g_test_add_func("/gateway/protocol/parse_response_error_strings_invalid_ignored", test_protocol_parse_response_error_strings_invalid_ignored);
    g_test_add_func("/gateway/protocol/parse_challenge_nonce_non_string_ignored", test_protocol_parse_challenge_nonce_non_string_ignored);
    g_test_add_func("/gateway/protocol/build_connect_token_mode", test_protocol_build_connect_token_mode);
    g_test_add_func("/gateway/protocol/build_connect_password_mode", test_protocol_build_connect_password_mode);
    g_test_add_func("/gateway/protocol/build_connect_none_mode", test_protocol_build_connect_none_mode);
    g_test_add_func("/gateway/protocol/build_connect_version_platform_always_present", test_protocol_build_connect_version_platform_always_present);

    /* hello-ok validation tests (BLOCKER B) */
    g_test_add_func("/gateway/protocol/parse_hello_ok_valid", test_protocol_parse_hello_ok_valid);
    g_test_add_func("/gateway/protocol/parse_hello_ok_missing_type", test_protocol_parse_hello_ok_missing_type);
    g_test_add_func("/gateway/protocol/parse_hello_ok_wrong_type", test_protocol_parse_hello_ok_wrong_type);
    g_test_add_func("/gateway/protocol/parse_hello_ok_zero_tick_interval", test_protocol_parse_hello_ok_zero_tick_interval);
    g_test_add_func("/gateway/protocol/parse_hello_ok_negative_tick_interval", test_protocol_parse_hello_ok_negative_tick_interval);
    g_test_add_func("/gateway/protocol/parse_hello_ok_missing_tick_interval", test_protocol_parse_hello_ok_missing_tick_interval);

    /* hello-ok strict type validation tests (BLOCKER 2) */
    g_test_add_func("/gateway/protocol/parse_hello_ok_missing_server_version", test_protocol_parse_hello_ok_missing_server_version);
    g_test_add_func("/gateway/protocol/parse_hello_ok_missing_server_conn_id", test_protocol_parse_hello_ok_missing_server_conn_id);
    g_test_add_func("/gateway/protocol/parse_hello_ok_features_methods_not_array", test_protocol_parse_hello_ok_features_methods_not_array);
    g_test_add_func("/gateway/protocol/parse_hello_ok_features_events_not_array", test_protocol_parse_hello_ok_features_events_not_array);
    g_test_add_func("/gateway/protocol/parse_hello_ok_tick_interval_wrong_type", test_protocol_parse_hello_ok_tick_interval_wrong_type);
    g_test_add_func("/gateway/protocol/parse_hello_ok_max_payload_wrong_type", test_protocol_parse_hello_ok_max_payload_wrong_type);
    g_test_add_func("/gateway/protocol/parse_hello_ok_max_buffered_wrong_type", test_protocol_parse_hello_ok_max_buffered_wrong_type);

    /* hello-ok integer-only validation tests */
    g_test_add_func("/gateway/protocol/parse_hello_ok_protocol_string_rejected", test_protocol_parse_hello_ok_protocol_string_rejected);
    g_test_add_func("/gateway/protocol/parse_hello_ok_protocol_double_rejected", test_protocol_parse_hello_ok_protocol_double_rejected);
    g_test_add_func("/gateway/protocol/parse_hello_ok_max_payload_double_rejected", test_protocol_parse_hello_ok_max_payload_double_rejected);
    g_test_add_func("/gateway/protocol/parse_hello_ok_max_buffered_double_rejected", test_protocol_parse_hello_ok_max_buffered_double_rejected);
    g_test_add_func("/gateway/protocol/parse_hello_ok_tick_interval_double_accepted", test_protocol_parse_hello_ok_tick_interval_double_accepted);

    /* L6: TLS and host correctness regression tests */
    g_test_add_func("/gateway/config/tls_disabled_uses_http_ws", test_config_tls_disabled_uses_http_ws);
    g_test_add_func("/gateway/config/tls_enabled_uses_https_wss", test_config_tls_enabled_uses_https_wss);
    g_test_add_func("/gateway/config/host_from_config", test_config_host_from_config);
    g_test_add_func("/gateway/config/host_from_config_wins_over_bind_mode", test_config_host_from_config_wins_over_bind_mode);
    g_test_add_func("/gateway/config/bind_fallback_ignores_0_0_0_0", test_config_bind_fallback_ignores_0_0_0_0);
    g_test_add_func("/gateway/config/bind_normalizes_loopback", test_config_bind_normalizes_loopback);
    g_test_add_func("/gateway/config/bind_mode_auto_maps_to_loopback_host", test_config_bind_mode_auto_maps_to_loopback_host);
    g_test_add_func("/gateway/config/bind_mode_lan_maps_to_loopback_host", test_config_bind_mode_lan_maps_to_loopback_host);
    g_test_add_func("/gateway/config/bind_mode_tailnet_maps_to_loopback_host", test_config_bind_mode_tailnet_maps_to_loopback_host);
    g_test_add_func("/gateway/config/bind_mode_custom_uses_custom_bind_host", test_config_bind_mode_custom_uses_custom_bind_host);
    g_test_add_func("/gateway/config/bind_mode_custom_without_custom_bind_host_is_invalid", test_config_bind_mode_custom_without_custom_bind_host_is_invalid);
    g_test_add_func("/gateway/config/bind_invalid_literal_is_rejected", test_config_bind_invalid_literal_is_rejected);
    g_test_add_func("/gateway/config/tls_object_form", test_config_tls_object_form);
    g_test_add_func("/gateway/config/tls_from_security_block", test_config_tls_from_security_block);

    /* URL route fragment preservation tests */
    g_test_add_func("/gateway/url_route/preserves_fragment", test_dashboard_url_with_route_preserves_fragment);
    g_test_add_func("/gateway/url_route/without_fragment", test_dashboard_url_with_route_without_fragment);

    /* Config equivalence TLS tests */
    g_test_add_func("/gateway/config/equiv_tls_differs", test_config_equivalent_tls_differs);
    g_test_add_func("/gateway/config/equiv_tls_same", test_config_equivalent_tls_same);

    /* gateway.bind safety tests */
    g_test_add_func("/gateway/config/bind_ipv4_literal_used", test_config_bind_ipv4_literal_used);
    g_test_add_func("/gateway/config/bind_hostname_literal_used", test_config_bind_hostname_literal_used);
    g_test_add_func("/gateway/config/bind_mode_custom_with_mode_token_custom_bind_host_is_invalid", test_config_bind_mode_custom_with_mode_token_custom_bind_host_is_invalid);
    g_test_add_func("/gateway/config/bind_invalid_hostname_literal_is_rejected", test_config_bind_invalid_hostname_literal_is_rejected);
    g_test_add_func("/gateway/config/bind_ipv6_unspecified_rejected", test_config_bind_ipv6_unspecified_rejected);

    /* Feature A: Config path resolution tests */
    g_test_add_func("/gateway/config/resolve_path_env_override", test_config_resolve_path_env_override);
    g_test_add_func("/gateway/config/resolve_path_default", test_config_resolve_path_default);
    g_test_add_func("/gateway/config/resolve_path_with_context", test_config_resolve_path_with_context);

    /* Feature B: Model config detection tests */
    g_test_add_func("/gateway/config/has_model_config_with_model", test_config_has_model_config_with_model);
    g_test_add_func("/gateway/config/has_model_config_with_provider", test_config_has_model_config_with_provider);
    g_test_add_func("/gateway/config/has_model_config_missing", test_config_has_model_config_missing);
    g_test_add_func("/gateway/config/has_model_config_no_agents", test_config_has_model_config_no_agents);

    /* Feature A: Config monitor rearm decision tests */
    g_test_add_func("/gateway/monitor/rearm_file_created_needs_rearm", test_rearm_skip_file_created_needs_rearm);
    g_test_add_func("/gateway/monitor/rearm_file_still_exists_may_skip", test_rearm_skip_file_still_exists_may_skip);
    g_test_add_func("/gateway/monitor/rearm_file_deleted_needs_rearm", test_rearm_skip_file_deleted_needs_rearm);
    g_test_add_func("/gateway/monitor/rearm_no_file_still_none_may_skip", test_rearm_skip_no_file_still_none_may_skip);
    g_test_add_func("/gateway/monitor/rearm_dir_changed_needs_rearm", test_rearm_skip_dir_changed_needs_rearm);
    g_test_add_func("/gateway/monitor/rearm_path_changed_needs_rearm", test_rearm_skip_path_changed_needs_rearm);
    g_test_add_func("/gateway/monitor/rearm_no_dir_monitor_needs_rearm", test_rearm_skip_no_dir_monitor_needs_rearm);

    /* Feature B: Onboarding state priority tests */
    g_test_add_func("/gateway/state/priority_no_setup_needs_setup", test_state_priority_no_setup_needs_setup);
    g_test_add_func("/gateway/state/priority_setup_no_model_needs_onboarding", test_state_priority_setup_no_model_needs_onboarding);
    g_test_add_func("/gateway/state/priority_setup_with_model_not_onboarding", test_state_priority_setup_with_model_not_onboarding);
    g_test_add_func("/gateway/state/priority_setup_gateway_not_installed", test_state_priority_setup_gateway_not_installed);

    return g_test_run();
}
