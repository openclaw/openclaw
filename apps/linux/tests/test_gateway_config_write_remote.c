/*
 * test_gateway_config_write_remote.c
 *
 * Pure-function test for gateway_config_write_remote_settings(). Exercises:
 *   - merging into an empty (non-existent) file,
 *   - preserving unrelated keys in an existing config,
 *   - rejecting invalid mode and transport strings,
 *   - removing remote.* keys when callers pass empty values.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include <glib.h>
#include <glib/gstdio.h>
#include <json-glib/json-glib.h>

#include "../src/gateway_config.h"
#include "../src/gateway_remote_config.h"

/* Build a unique temp file path under g_get_tmp_dir() and return the
 * heap-owned path. Caller frees and unlinks. */
static gchar* tmp_config_path(void) {
    g_autofree gchar *base = g_strdup_printf("openclaw-test-config-%d-%u.json",
                                             (int)g_get_real_time(),
                                             g_random_int());
    return g_build_filename(g_get_tmp_dir(), base, NULL);
}

static gchar* read_file(const gchar *path) {
    gchar *contents = NULL;
    gsize len = 0;
    g_assert_true(g_file_get_contents(path, &contents, &len, NULL));
    return contents;
}

static JsonObject* parse_root(const gchar *path) {
    g_autoptr(JsonParser) parser = json_parser_new();
    g_autoptr(GError) err = NULL;
    g_assert_true(json_parser_load_from_file(parser, path, &err));
    JsonNode *root = json_parser_get_root(parser);
    g_assert_true(JSON_NODE_HOLDS_OBJECT(root));
    return json_object_ref(json_node_get_object(root));
}

static void test_writes_fresh_file(void) {
    g_autofree gchar *path = tmp_config_path();
    g_autofree gchar *err = NULL;

    g_assert_true(gateway_config_write_remote_settings(
        path, "remote", "ssh",
        NULL,                    /* url unused for ssh */
        "alice@host:2222",
        "/home/alice/.ssh/id_ed25519",
        NULL, NULL,              /* no token / password */
        &err));
    g_assert_null(err);

    g_autoptr(JsonObject) root = parse_root(path);
    g_assert_true(json_object_has_member(root, "gateway"));
    JsonObject *gw = json_node_get_object(json_object_get_member(root, "gateway"));
    g_assert_cmpstr(json_object_get_string_member(gw, "mode"), ==, "remote");

    JsonObject *rc = json_node_get_object(json_object_get_member(gw, "remote"));
    g_assert_cmpstr(json_object_get_string_member(rc, "transport"), ==, "ssh");
    g_assert_cmpstr(json_object_get_string_member(rc, "sshTarget"), ==, "alice@host:2222");
    g_assert_cmpstr(json_object_get_string_member(rc, "sshIdentity"),
                    ==, "/home/alice/.ssh/id_ed25519");
    /* Direct URL was NULL → must not appear. */
    g_assert_false(json_object_has_member(rc, "url"));

    g_unlink(path);
}

static void test_preserves_unrelated_keys(void) {
    g_autofree gchar *path = tmp_config_path();
    /*
     * Pre-seed the file with a top-level "models" object and an unrelated
     * gateway field. The remote-settings writer must not touch them.
     */
    const gchar *seed =
        "{\n"
        "  \"models\": {\"providers\": {\"openai\": {\"apiKey\": \"sk-x\"}}},\n"
        "  \"gateway\": {\n"
        "    \"port\": 18789,\n"
        "    \"token\": \"keep-me\"\n"
        "  }\n"
        "}\n";
    g_assert_true(g_file_set_contents(path, seed, -1, NULL));

    g_autofree gchar *err = NULL;
    g_assert_true(gateway_config_write_remote_settings(
        path, "remote", "direct",
        "wss://gw.example.com:8443",
        NULL, NULL,
        NULL, NULL,
        &err));
    g_assert_null(err);

    g_autoptr(JsonObject) root = parse_root(path);

    /* Top-level models survived. */
    g_assert_true(json_object_has_member(root, "models"));
    JsonObject *models = json_node_get_object(json_object_get_member(root, "models"));
    JsonObject *providers = json_node_get_object(json_object_get_member(models, "providers"));
    JsonObject *openai = json_node_get_object(json_object_get_member(providers, "openai"));
    g_assert_cmpstr(json_object_get_string_member(openai, "apiKey"), ==, "sk-x");

    /* gateway.token and gateway.port survived. */
    JsonObject *gw = json_node_get_object(json_object_get_member(root, "gateway"));
    g_assert_cmpint((gint)json_object_get_int_member(gw, "port"), ==, 18789);
    g_assert_cmpstr(json_object_get_string_member(gw, "token"), ==, "keep-me");

    /* gateway.mode = remote was applied. */
    g_assert_cmpstr(json_object_get_string_member(gw, "mode"), ==, "remote");

    /* gateway.remote was created with the new keys. */
    JsonObject *rc = json_node_get_object(json_object_get_member(gw, "remote"));
    g_assert_cmpstr(json_object_get_string_member(rc, "transport"), ==, "direct");
    g_assert_cmpstr(json_object_get_string_member(rc, "url"),
                    ==, "wss://gw.example.com:8443");

    g_unlink(path);
}

static void test_rejects_invalid_mode(void) {
    g_autofree gchar *path = tmp_config_path();
    g_autofree gchar *err = NULL;
    g_assert_false(gateway_config_write_remote_settings(
        path, "garbage", "ssh", NULL, "a@b", NULL, NULL, NULL, &err));
    g_assert_nonnull(err);
    /* No file should have been created — failure path must not write. */
    g_assert_false(g_file_test(path, G_FILE_TEST_EXISTS));
}

static void test_rejects_invalid_transport(void) {
    g_autofree gchar *path = tmp_config_path();
    g_autofree gchar *err = NULL;
    g_assert_false(gateway_config_write_remote_settings(
        path, "remote", "magic", NULL, "a@b", NULL, NULL, NULL, &err));
    g_assert_nonnull(err);
    g_assert_false(g_file_test(path, G_FILE_TEST_EXISTS));
}

static void test_empty_values_remove_keys(void) {
    g_autofree gchar *path = tmp_config_path();
    /* First write — populate everything. */
    g_autofree gchar *err1 = NULL;
    g_assert_true(gateway_config_write_remote_settings(
        path, "remote", "ssh",
        "wss://gw.example.com:8443",
        "alice@host",
        "/some/key",
        NULL, NULL,
        &err1));

    /* Second write — clear sshTarget and sshIdentity by passing empty
     * strings. Existing transport/url remain. */
    g_autofree gchar *err2 = NULL;
    g_assert_true(gateway_config_write_remote_settings(
        path, NULL /* leave mode */, "ssh",
        "wss://gw.example.com:8443",
        "" /* clear */,
        "" /* clear */,
        NULL, NULL,
        &err2));

    g_autoptr(JsonObject) root = parse_root(path);
    JsonObject *gw = json_node_get_object(json_object_get_member(root, "gateway"));
    JsonObject *rc = json_node_get_object(json_object_get_member(gw, "remote"));
    g_assert_false(json_object_has_member(rc, "sshTarget"));
    g_assert_false(json_object_has_member(rc, "sshIdentity"));
    g_assert_true(json_object_has_member(rc, "url"));
    g_assert_cmpstr(json_object_get_string_member(rc, "transport"), ==, "ssh");

    g_unlink(path);
}

static void test_rejects_when_gateway_not_object(void) {
    g_autofree gchar *path = tmp_config_path();
    /*
     * If the existing file has gateway as something other than an
     * object, we must refuse rather than clobber it. This protects
     * hand-edited configs from silent damage.
     */
    g_assert_true(g_file_set_contents(path, "{\"gateway\":\"oops\"}\n", -1, NULL));

    g_autofree gchar *err = NULL;
    g_assert_false(gateway_config_write_remote_settings(
        path, "remote", "ssh", NULL, "a@b", NULL, NULL, NULL, &err));
    g_assert_nonnull(err);

    /* Original content must be intact. */
    g_autofree gchar *contents = read_file(path);
    g_assert_cmpstr(g_strstrip(contents), ==, "{\"gateway\":\"oops\"}");

    g_unlink(path);
}

static void test_direct_wss_url_roundtrips(void) {
    /*
     * Write a direct remote config with a wss:// URL, reload it via
     * gateway_config_load, and assert cfg->remote_url comes back as
     * the same wss:// URL. This is the end-to-end guarantee behind the
     * UI behaviour "a saved direct URL remains ws/wss".
     */
    g_autofree gchar *path = tmp_config_path();

    /* Seed minimal auth fields so gateway_config_load validates. The
     * focus of this round-trip test is the remote URL, not auth. */
    const gchar *seed =
        "{\n"
        "  \"gateway\": {\n"
        "    \"auth\": {\"mode\": \"token\", \"token\": \"test-token\"}\n"
        "  }\n"
        "}\n";
    g_assert_true(g_file_set_contents(path, seed, -1, NULL));

    g_autofree gchar *err = NULL;
    g_assert_true(gateway_config_write_remote_settings(
        path, "remote", "direct",
        "wss://gw.example.com:8443",
        NULL, NULL,
        NULL, NULL,
        &err));

    GatewayConfigContext ctx = { .explicit_config_path = path,
                                 .effective_state_dir = NULL,
                                 .profile = NULL };
    GatewayConfig *cfg = gateway_config_load(&ctx);
    g_assert_nonnull(cfg);
    g_assert_true(cfg->valid);
    g_assert_true(cfg->remote_present);
    g_assert_cmpint(cfg->remote_transport, ==, REMOTE_TRANSPORT_DIRECT);
    g_assert_cmpstr(cfg->remote_url, ==, "wss://gw.example.com:8443");
    gateway_config_free(cfg);
    g_unlink(path);
}

static void test_ui_validator_rejects_http_https(void) {
    /*
     * The General section and Onboarding flow both validate direct
     * URLs via gateway_remote_config_normalize_url() before persisting.
     * This test asserts the helper contract the UI depends on: http
     * and https are rejected — only ws and wss are accepted for the
     * Remote Connection Mode contract. Paired with the writer tests
     * above, this locks in the UI guarantee "https/http is rejected
     * at the validation seam".
     */
    g_assert_null(gateway_remote_config_normalize_url(
        "http://gw.example.com", NULL, NULL, NULL));
    g_assert_null(gateway_remote_config_normalize_url(
        "https://gw.example.com:8443", NULL, NULL, NULL));

    /* wss:// is accepted and returned normalized. */
    gchar *host = NULL; gint port = 0; gboolean tls = FALSE;
    g_autofree gchar *normalized = gateway_remote_config_normalize_url(
        "wss://gw.example.com:8443", &host, &port, &tls);
    g_assert_cmpstr(normalized, ==, "wss://gw.example.com:8443");
    g_assert_cmpstr(host, ==, "gw.example.com");
    g_assert_cmpint(port, ==, 8443);
    g_assert_true(tls);
    g_free(host);
}

static void test_ssh_clears_direct_url(void) {
    /*
     * Regression: when the operator switches the form from Direct to
     * SSH and clicks Save & Apply, the General/Onboarding paths now
     * pass an empty string for the URL so the writer REMOVES
     * gateway.remote.url. Without this, a hidden stale/bad URL would
     * remain in the JSON and gateway_remote_config_parse would reject
     * the otherwise-valid SSH config on reload.
     */
    g_autofree gchar *path = tmp_config_path();
    g_autofree gchar *err1 = NULL;

    /* 1. Write direct config with a wss URL. */
    g_assert_true(gateway_config_write_remote_settings(
        path, "remote", "direct",
        "wss://gw.example.com:8443",
        NULL, NULL,
        NULL, NULL,
        &err1));

    /* 2. Switch to ssh — pass "" for URL so the writer drops the key. */
    g_autofree gchar *err2 = NULL;
    g_assert_true(gateway_config_write_remote_settings(
        path, "remote", "ssh",
        "" /* url cleared */,
        "alice@host:2222",
        NULL,
        NULL, NULL,
        &err2));

    /* 3. Inspect the resulting JSON. */
    g_autoptr(JsonObject) root = parse_root(path);
    JsonObject *gw = json_node_get_object(json_object_get_member(root, "gateway"));
    JsonObject *rc = json_node_get_object(json_object_get_member(gw, "remote"));

    g_assert_cmpstr(json_object_get_string_member(rc, "transport"), ==, "ssh");
    g_assert_true(json_object_has_member(rc, "sshTarget"));
    g_assert_cmpstr(json_object_get_string_member(rc, "sshTarget"),
                    ==, "alice@host:2222");
    g_assert_false(json_object_has_member(rc, "url"));

    g_unlink(path);
}

static void test_token_password_persist_and_overlay(void) {
    /*
     * Persist gateway.remote.token and gateway.remote.password through
     * the writer, then verify:
     *   1. Both keys land under gateway.remote.
     *   2. gateway_config_load applies the remote-mode overlay so
     *      cfg->remote_token / cfg->remote_password are populated AND
     *      gateway_config_remote_effective_token/password return them.
     *   3. A subsequent writer call with empty strings REMOVES the keys.
     */
    g_autofree gchar *path = tmp_config_path();
    g_autofree gchar *err = NULL;

    g_assert_true(gateway_config_write_remote_settings(
        path, "remote", "direct",
        "wss://gw.example.com:8443",
        NULL, NULL,
        "remote-tok", "remote-pw",
        &err));
    g_assert_null(err);

    /* Inspect raw JSON. */
    {
        g_autoptr(JsonObject) root = parse_root(path);
        JsonObject *gw = json_node_get_object(json_object_get_member(root, "gateway"));
        JsonObject *rc = json_node_get_object(json_object_get_member(gw, "remote"));
        g_assert_cmpstr(json_object_get_string_member(rc, "token"), ==, "remote-tok");
        g_assert_cmpstr(json_object_get_string_member(rc, "password"), ==, "remote-pw");
    }

    /* Load via gateway_config_load to exercise the overlay. */
    {
        GatewayConfigContext ctx = { .explicit_config_path = path,
                                     .effective_state_dir = NULL,
                                     .profile = NULL };
        GatewayConfig *cfg = gateway_config_load(&ctx);
        g_assert_nonnull(cfg);
        g_assert_true(cfg->valid);
        g_assert_cmpstr(cfg->remote_token, ==, "remote-tok");
        g_assert_cmpstr(cfg->remote_password, ==, "remote-pw");
        g_assert_cmpstr(
            gateway_config_remote_effective_token(cfg), ==, "remote-tok");
        g_assert_cmpstr(
            gateway_config_remote_effective_password(cfg), ==, "remote-pw");
        gateway_config_free(cfg);
    }

    /* Now clear them by passing empty strings. */
    g_autofree gchar *err2 = NULL;
    g_assert_true(gateway_config_write_remote_settings(
        path, "remote", "direct",
        "wss://gw.example.com:8443",
        NULL, NULL,
        "", "",
        &err2));
    g_assert_null(err2);

    {
        g_autoptr(JsonObject) root = parse_root(path);
        JsonObject *gw = json_node_get_object(json_object_get_member(root, "gateway"));
        JsonObject *rc = json_node_get_object(json_object_get_member(gw, "remote"));
        g_assert_false(json_object_has_member(rc, "token"));
        g_assert_false(json_object_has_member(rc, "password"));
    }

    g_unlink(path);
}

static void test_effective_helpers_local_mode_use_local(void) {
    /*
     * In local mode, even if gateway.remote.token is set, the effective
     * helpers must return the local gateway.auth.token. This locks in
     * the precedence rule that remote-overlay only fires when
     * gateway.mode == "remote".
     */
    g_autofree gchar *path = tmp_config_path();
    const gchar *seed =
        "{\n"
        "  \"gateway\": {\n"
        "    \"mode\": \"local\",\n"
        "    \"auth\": {\"mode\": \"token\", \"token\": \"local-tok\"},\n"
        "    \"remote\": {\"transport\": \"ssh\", \"sshTarget\": \"a@h\",\n"
        "                  \"token\": \"remote-tok\"}\n"
        "  }\n"
        "}\n";
    g_assert_true(g_file_set_contents(path, seed, -1, NULL));

    GatewayConfigContext ctx = { .explicit_config_path = path,
                                 .effective_state_dir = NULL,
                                 .profile = NULL };
    GatewayConfig *cfg = gateway_config_load(&ctx);
    g_assert_nonnull(cfg);
    g_assert_true(cfg->valid);
    g_assert_cmpstr(
        gateway_config_remote_effective_token(cfg), ==, "local-tok");
    gateway_config_free(cfg);
    g_unlink(path);
}

int main(int argc, char **argv) {
    g_test_init(&argc, &argv, NULL);
    g_test_add_func("/cfg_write_remote/writes_fresh_file", test_writes_fresh_file);
    g_test_add_func("/cfg_write_remote/preserves_unrelated_keys", test_preserves_unrelated_keys);
    g_test_add_func("/cfg_write_remote/rejects_invalid_mode", test_rejects_invalid_mode);
    g_test_add_func("/cfg_write_remote/rejects_invalid_transport", test_rejects_invalid_transport);
    g_test_add_func("/cfg_write_remote/empty_values_remove_keys", test_empty_values_remove_keys);
    g_test_add_func("/cfg_write_remote/rejects_when_gateway_not_object", test_rejects_when_gateway_not_object);
    g_test_add_func("/cfg_write_remote/direct_wss_url_roundtrips", test_direct_wss_url_roundtrips);
    g_test_add_func("/cfg_write_remote/ui_validator_rejects_http_https", test_ui_validator_rejects_http_https);
    g_test_add_func("/cfg_write_remote/ssh_clears_direct_url", test_ssh_clears_direct_url);
    g_test_add_func("/cfg_write_remote/token_password_persist_and_overlay",
                    test_token_password_persist_and_overlay);
    g_test_add_func("/cfg_write_remote/effective_helpers_local_mode",
                    test_effective_helpers_local_mode_use_local);
    return g_test_run();
}
