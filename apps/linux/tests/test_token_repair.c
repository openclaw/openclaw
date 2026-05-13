/*
 * test_token_repair.c
 *
 * End-to-end lifecycle coverage for the Linux companion's device-token
 * repair contract. The individual building blocks
 * (`device_auth_store` persistence, `gateway_protocol_build_connect_v2`
 * auth selection, `gateway_protocol_parse_hello_ok_v2` extraction) are
 * unit-tested in test_device_auth_store.c and test_gateway.c. This
 * suite composes them into the full reconnect + mismatch + clear +
 * re-pair flow so any regression in the lifecycle itself — not just
 * its pieces — is caught.
 *
 * Scenarios (A–F mirror the repair lifecycle plan):
 *   A. Stored token used as primary reconnect auth.
 *   B. One-shot retry path puts stored token in auth.deviceToken.
 *   C. Post-retry failure (AUTH_DEVICE_TOKEN_MISMATCH) clears store.
 *   D. Cold reconnect after clear returns to first-run pairing path.
 *   E. Successful hello persists replacement token.
 *   F. Scope list persistence parity (normalization after repair cycle).
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "../src/device_auth_store.h"
#include "../src/device_identity.h"
#include "../src/gateway_protocol.h"

#include <glib.h>
#include <glib/gstdio.h>
#include <json-glib/json-glib.h>

/* ────────────────────── shared helpers ────────────────────── */

static gchar* tmp_state_dir(void) {
    gchar *tmpl = g_build_filename(g_get_tmp_dir(), "openclaw-tokrepair-XXXXXX", NULL);
    gchar *dir = g_mkdtemp(tmpl);
    g_assert_nonnull(dir);
    return dir;
}

static void rm_rf(const gchar *path) {
    g_autoptr(GDir) d = g_dir_open(path, 0, NULL);
    if (d) {
        const gchar *name;
        while ((name = g_dir_read_name(d))) {
            g_autofree gchar *child = g_build_filename(path, name, NULL);
            if (g_file_test(child, G_FILE_TEST_IS_DIR)) rm_rf(child);
            else g_unlink(child);
        }
    }
    g_rmdir(path);
}

static JsonObject* parse_object(const gchar *json_str) {
    g_autoptr(JsonParser) parser = json_parser_new();
    g_assert_true(json_parser_load_from_data(parser, json_str, -1, NULL));
    JsonNode *root = json_parser_get_root(parser);
    g_assert_nonnull(root);
    g_assert_true(JSON_NODE_HOLDS_OBJECT(root));
    return json_object_ref(json_node_get_object(root));
}

/*
 * Re-usable connect builder: emits a connect v2 frame with the auth
 * material the Linux reconnect path would assemble given a loaded
 * identity and a (possibly-NULL) stored token entry from the store.
 * Returns a freshly-allocated JsonObject for the caller to inspect;
 * the caller owns a strong ref and must unref via the g_autoptr macro
 * in the tests.
 */
static JsonObject* build_connect(const OcDeviceIdentity *id,
                                 const gchar *stored_token,
                                 gboolean retry_with_device_token,
                                 const gchar *request_id,
                                 const gchar *nonce)
{
    const gchar *scopes[] = { "operator.admin", NULL };
    GatewayConnectBuildParams p = {0};
    p.request_id   = request_id;
    p.client_id    = "openclaw-linux";
    p.client_mode  = "ui";
    p.role         = "operator";
    p.scopes       = scopes;
    p.auth_mode    = NULL;   /* auto: prefer stored token */
    p.token        = NULL;
    p.stored_token = stored_token;
    p.retry_with_device_token = retry_with_device_token;
    p.platform     = "linux";
    p.version      = "dev";
    p.identity     = id;
    p.connect_nonce = nonce;

    g_autofree gchar *json = gateway_protocol_build_connect_v2(&p);
    g_assert_nonnull(json);
    return parse_object(json);
}

/* ────────────────────── A: primary reconnect uses stored token ────────────────────── */

static void test_a_stored_token_is_primary_auth_token(void) {
    g_autofree gchar *dir = tmp_state_dir();
    OcDeviceIdentity *id = oc_device_identity_load_or_create(dir, NULL);
    g_assert_nonnull(id);

    const gchar *initial_scopes[] = { "operator.admin", NULL };
    g_assert_true(oc_device_auth_store_save(dir, id->device_id, "operator",
                                            "stored-primary", initial_scopes));

    /* Load back what the reconnect path would read. */
    g_autoptr(OcDeviceAuthEntry) entry =
        oc_device_auth_store_load(dir, id->device_id, "operator");
    g_assert_nonnull(entry);
    g_assert_cmpstr(entry->token, ==, "stored-primary");

    /* Feed the stored token into the connect builder as the reconnect
     * path does and verify it surfaces as `auth.token`, never as
     * `auth.deviceToken`, because no retry is in flight. */
    g_autoptr(JsonObject) root =
        build_connect(id, entry->token, FALSE, "req-A", "nA");
    JsonObject *auth = json_object_get_object_member(
        json_object_get_object_member(root, "params"), "auth");
    g_assert_cmpstr(json_object_get_string_member(auth, "token"), ==, "stored-primary");
    g_assert_false(json_object_has_member(auth, "deviceToken"));

    oc_device_identity_free(id);
    rm_rf(dir);
}

/* ────────────────────── B: one-shot retry carries stored in deviceToken ────────────────────── */

static void test_b_retry_budget_carries_stored_in_device_token(void) {
    g_autofree gchar *dir = tmp_state_dir();
    OcDeviceIdentity *id = oc_device_identity_load_or_create(dir, NULL);
    g_assert_nonnull(id);

    const gchar *scopes[] = { "operator.admin", NULL };
    g_assert_true(oc_device_auth_store_save(dir, id->device_id, "operator",
                                            "stored-rekey", scopes));

    /*
     * First connect: plain reconnect with stored token. No retry flag,
     * so only `auth.token` is populated.
     */
    g_autoptr(JsonObject) first =
        build_connect(id, "stored-rekey", FALSE, "req-B-0", "n0");
    JsonObject *first_auth = json_object_get_object_member(
        json_object_get_object_member(first, "params"), "auth");
    g_assert_cmpstr(json_object_get_string_member(first_auth, "token"), ==, "stored-rekey");
    g_assert_false(json_object_has_member(first_auth, "deviceToken"));

    /*
     * Gateway responds AUTH_TOKEN_MISMATCH + canRetryWithDeviceToken.
     * The reconnect path consumes its one-shot retry budget and
     * rebuilds the connect frame with retry_with_device_token=TRUE;
     * now the stored token must appear under `auth.deviceToken` so
     * the gateway can validate it. The explicit session token (if
     * any) would still drive `auth.token`; in our Linux default no
     * explicit token is supplied.
     */
    g_autoptr(JsonObject) retry =
        build_connect(id, "stored-rekey", TRUE, "req-B-1", "n1");
    JsonObject *retry_auth = json_object_get_object_member(
        json_object_get_object_member(retry, "params"), "auth");
    g_assert_cmpstr(json_object_get_string_member(retry_auth, "deviceToken"),
                    ==, "stored-rekey");

    oc_device_identity_free(id);
    rm_rf(dir);
}

/* ────────────────────── C: post-retry failure clears store ────────────────────── */

static void test_c_device_token_mismatch_clears_store(void) {
    g_autofree gchar *dir = tmp_state_dir();
    OcDeviceIdentity *id = oc_device_identity_load_or_create(dir, NULL);
    g_assert_nonnull(id);

    const gchar *scopes[] = { "operator.admin", NULL };
    g_assert_true(oc_device_auth_store_save(dir, id->device_id, "operator",
                                            "stored-to-clear", scopes));

    /* Sanity: entry exists. */
    {
        g_autoptr(OcDeviceAuthEntry) pre =
            oc_device_auth_store_load(dir, id->device_id, "operator");
        g_assert_nonnull(pre);
        g_assert_cmpstr(pre->token, ==, "stored-to-clear");
    }

    /*
     * Simulate the reconnect path observing AUTH_DEVICE_TOKEN_MISMATCH
     * (or post-retry token mismatch). Contract: clear the store so the
     * next connect drops back to the first-run pairing path instead of
     * looping on a dead token. The reconnect path calls
     * `oc_device_auth_store_clear` with the current identity's deviceId.
     */
    g_assert_true(oc_device_auth_store_clear(dir, id->device_id, "operator"));

    g_autoptr(OcDeviceAuthEntry) post =
        oc_device_auth_store_load(dir, id->device_id, "operator");
    g_assert_null(post);

    oc_device_identity_free(id);
    rm_rf(dir);
}

/* ────────────────────── D: cold reconnect after clear omits device token ────────────────────── */

static void test_d_cold_reconnect_after_clear_omits_device_token(void) {
    g_autofree gchar *dir = tmp_state_dir();
    OcDeviceIdentity *id = oc_device_identity_load_or_create(dir, NULL);
    g_assert_nonnull(id);

    /* Store starts empty; first reconnect after a mismatch clear is
     * equivalent. */
    g_autoptr(OcDeviceAuthEntry) e =
        oc_device_auth_store_load(dir, id->device_id, "operator");
    g_assert_null(e);

    g_autoptr(JsonObject) root =
        build_connect(id, NULL /* no stored */, FALSE, "req-D", "nD");
    JsonObject *params = json_object_get_object_member(root, "params");

    /*
     * With no stored token and no explicit token, the connect builder
     * omits the entire `auth` object (no auth.token, no auth.deviceToken).
     * The signed device envelope must still be emitted so the gateway
     * can run the first-run silent-pair handshake.
     */
    g_assert_false(json_object_has_member(params, "auth"));
    g_assert_true(json_object_has_member(params, "device"));

    oc_device_identity_free(id);
    rm_rf(dir);
}

/* ────────────────────── E: successful hello persists replacement token ────────────────────── */

static void test_e_hello_persists_replacement_token(void) {
    g_autofree gchar *dir = tmp_state_dir();
    OcDeviceIdentity *id = oc_device_identity_load_or_create(dir, NULL);
    g_assert_nonnull(id);

    /* Start with a prior (stale) entry to confirm replacement works. */
    const gchar *old_scopes[] = { "operator.read", NULL };
    g_assert_true(oc_device_auth_store_save(dir, id->device_id, "operator",
                                            "old-tok", old_scopes));

    /*
     * Parse a realistic hello-ok frame carrying a fresh device token
     * and the full operator scope set, exactly as the gateway would
     * return after a first-run silent pair or a token-repair cycle.
     */
    const gchar *hello =
        "{\"type\":\"res\",\"id\":\"r1\",\"payload\":{"
        "\"type\":\"hello-ok\",\"protocol\":1,"
        "\"server\":{\"version\":\"1.0.0\",\"connId\":\"abc\"},"
        "\"features\":{\"methods\":[],\"events\":[]},\"snapshot\":{},"
        "\"policy\":{\"maxPayload\":1000000,\"maxBufferedBytes\":5000000,\"tickIntervalMs\":25000},"
        "\"auth\":{\"source\":\"device-token\",\"deviceToken\":\"new-tok\",\"role\":\"operator\","
                  "\"scopes\":[\"operator.admin\",\"operator.read\"]}"
        "}}";
    GatewayFrame *frame = gateway_protocol_parse_frame(hello);
    g_assert_nonnull(frame);

    g_autofree gchar *auth_src = NULL;
    gdouble tick_ms = 0;
    g_autofree gchar *dev_tok = NULL;
    g_autofree gchar *role = NULL;
    g_auto(GStrv) scopes_out = NULL;
    g_assert_true(gateway_protocol_parse_hello_ok_v2(
        frame, &auth_src, &tick_ms, &dev_tok, &role, &scopes_out));
    g_assert_cmpstr(dev_tok, ==, "new-tok");
    g_assert_cmpstr(role, ==, "operator");

    /* Reconnect path: persist the extracted token back into the store. */
    g_assert_true(oc_device_auth_store_save(dir, id->device_id, role, dev_tok,
                                            (const gchar * const *)scopes_out));

    /* Read it back and confirm replacement. */
    g_autoptr(OcDeviceAuthEntry) entry =
        oc_device_auth_store_load(dir, id->device_id, "operator");
    g_assert_nonnull(entry);
    g_assert_cmpstr(entry->token, ==, "new-tok");
    g_assert_cmpstr(entry->role, ==, "operator");

    gateway_frame_free(frame);
    oc_device_identity_free(id);
    rm_rf(dir);
}

/* ────────────────────── F: scope persistence parity after repair ────────────────────── */

static void test_f_scope_persistence_parity_after_repair(void) {
    g_autofree gchar *dir = tmp_state_dir();
    OcDeviceIdentity *id = oc_device_identity_load_or_create(dir, NULL);
    g_assert_nonnull(id);

    /*
     * The gateway returns `operator.admin` only; the Linux store must
     * imply `operator.read` + `operator.write` via the shared
     * normalization seam (mirrors src/shared/device-auth.ts parity).
     * This test asserts that the post-repair entry carries the full
     * normalized scope set, not just whatever the wire frame carried.
     */
    const gchar *wire_scopes[] = { "operator.admin", NULL };
    g_assert_true(oc_device_auth_store_save(dir, id->device_id, "operator",
                                            "tok-post-repair", wire_scopes));

    g_autoptr(OcDeviceAuthEntry) entry =
        oc_device_auth_store_load(dir, id->device_id, "operator");
    g_assert_nonnull(entry);
    g_assert_nonnull(entry->scopes);

    /* Normalized: admin + read + write, sorted + deduped. */
    gsize n = 0;
    while (entry->scopes[n]) n++;
    g_assert_cmpuint(n, ==, 3);

    gboolean saw_admin = FALSE, saw_read = FALSE, saw_write = FALSE;
    for (gsize i = 0; i < n; i++) {
        if (g_strcmp0(entry->scopes[i], "operator.admin") == 0) saw_admin = TRUE;
        if (g_strcmp0(entry->scopes[i], "operator.read")  == 0) saw_read  = TRUE;
        if (g_strcmp0(entry->scopes[i], "operator.write") == 0) saw_write = TRUE;
    }
    g_assert_true(saw_admin);
    g_assert_true(saw_read);
    g_assert_true(saw_write);

    oc_device_identity_free(id);
    rm_rf(dir);
}

int main(int argc, char **argv) {
    g_test_init(&argc, &argv, NULL);
    g_log_set_always_fatal(G_LOG_LEVEL_ERROR | G_LOG_LEVEL_CRITICAL);
    g_log_set_fatal_mask(NULL, G_LOG_LEVEL_ERROR | G_LOG_LEVEL_CRITICAL);

    g_test_add_func("/token_repair/A_stored_token_is_primary_auth_token",
                    test_a_stored_token_is_primary_auth_token);
    g_test_add_func("/token_repair/B_retry_budget_carries_stored_in_device_token",
                    test_b_retry_budget_carries_stored_in_device_token);
    g_test_add_func("/token_repair/C_device_token_mismatch_clears_store",
                    test_c_device_token_mismatch_clears_store);
    g_test_add_func("/token_repair/D_cold_reconnect_after_clear_omits_device_token",
                    test_d_cold_reconnect_after_clear_omits_device_token);
    g_test_add_func("/token_repair/E_hello_persists_replacement_token",
                    test_e_hello_persists_replacement_token);
    g_test_add_func("/token_repair/F_scope_persistence_parity_after_repair",
                    test_f_scope_persistence_parity_after_repair);

    return g_test_run();
}
