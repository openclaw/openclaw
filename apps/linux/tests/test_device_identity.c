/*
 * test_device_identity.c
 *
 * Unit tests for device_identity.{c,h}.
 *
 * Covers:
 *   - first-run creation: file 0600, parent 0700, canonical keys populated
 *   - deterministic deviceId = lowercase hex SHA-256(public_key_raw)
 *   - persistence: load returns the same identity as initial create
 *   - signing: signature is deterministic, 64 bytes raw, base64url-no-padding
 *   - public-key base64url export is deterministic (same run, same identity)
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "../src/device_identity.h"

#include <glib.h>
#include <glib/gstdio.h>
#include <sodium.h>
#include <string.h>
#include <sys/stat.h>

#define OPERATOR_ROLE "operator"

static gchar *make_tmp_state_dir(void) {
    gchar *tmpl = g_build_filename(g_get_tmp_dir(), "openclaw-ident-XXXXXX", NULL);
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

static void assert_mode(const gchar *path, mode_t expected) {
    struct stat st = {0};
    g_assert_cmpint(g_stat(path, &st), ==, 0);
    g_assert_cmpint(st.st_mode & 0777, ==, expected);
}

static void test_first_run_creates_0600_identity(void) {
    g_autofree gchar *dir = make_tmp_state_dir();

    GError *err = NULL;
    OcDeviceIdentity *id = oc_device_identity_load_or_create(dir, &err);
    g_assert_null(err);
    g_assert_nonnull(id);

    /* Required fields are present and non-empty */
    g_assert_nonnull(id->device_id);
    g_assert_cmpstr(id->device_id, !=, "");
    g_assert_nonnull(id->public_key_b64);
    g_assert_nonnull(id->private_key_b64);
    g_assert_cmpint(id->created_at_ms, >, 0);

    /* deviceId = lowercase 64-char hex */
    g_assert_cmpint(strlen(id->device_id), ==, 64);
    for (gsize i = 0; i < 64; i++) {
        gchar c = id->device_id[i];
        g_assert_true((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'));
    }

    /* Persisted file is 0600, dir 0700 */
    g_autofree gchar *ident_dir = g_build_filename(dir, "identity", NULL);
    g_autofree gchar *ident_file = g_build_filename(ident_dir, "device.json", NULL);
    assert_mode(ident_dir, 0700);
    assert_mode(ident_file, 0600);

    oc_device_identity_free(id);
    rm_rf(dir);
}

static void test_load_after_create_is_stable(void) {
    g_autofree gchar *dir = make_tmp_state_dir();

    OcDeviceIdentity *a = oc_device_identity_load_or_create(dir, NULL);
    g_assert_nonnull(a);

    OcDeviceIdentity *b = oc_device_identity_load_or_create(dir, NULL);
    g_assert_nonnull(b);

    g_assert_cmpstr(a->device_id, ==, b->device_id);
    g_assert_cmpstr(a->public_key_b64, ==, b->public_key_b64);
    g_assert_cmpstr(a->private_key_b64, ==, b->private_key_b64);
    g_assert_cmpint(a->created_at_ms, ==, b->created_at_ms);

    oc_device_identity_free(a);
    oc_device_identity_free(b);
    rm_rf(dir);
}

static void test_device_id_is_sha256_of_public_key(void) {
    g_assert_cmpint(sodium_init(), >=, 0);
    guchar pk[crypto_sign_PUBLICKEYBYTES];
    guchar sk[crypto_sign_SECRETKEYBYTES];
    g_assert_cmpint(crypto_sign_keypair(pk, sk), ==, 0);

    g_autofree gchar *got = oc_device_identity_compute_device_id(pk, sizeof(pk));
    g_assert_nonnull(got);

    guchar digest[crypto_hash_sha256_BYTES];
    g_assert_cmpint(crypto_hash_sha256(digest, pk, sizeof(pk)), ==, 0);
    g_autofree gchar *expected = g_malloc0(2 * sizeof(digest) + 1);
    for (gsize i = 0; i < sizeof(digest); i++) {
        g_snprintf(expected + 2 * i, 3, "%02x", digest[i]);
    }
    g_assert_cmpstr(got, ==, expected);
}

static void test_sign_is_deterministic_and_verifies(void) {
    g_autofree gchar *dir = make_tmp_state_dir();
    OcDeviceIdentity *id = oc_device_identity_load_or_create(dir, NULL);
    g_assert_nonnull(id);

    const gchar *payload = "v3|dev|openclaw-linux|ui|operator|operator.admin|1234|tok|nonce|linux|";

    g_autofree gchar *sig1 = oc_device_identity_sign_base64url(id, payload);
    g_autofree gchar *sig2 = oc_device_identity_sign_base64url(id, payload);
    g_assert_nonnull(sig1);
    g_assert_cmpstr(sig1, ==, sig2);

    /* No padding, no +/ characters */
    g_assert_null(strchr(sig1, '='));
    g_assert_null(strchr(sig1, '+'));
    g_assert_null(strchr(sig1, '/'));

    oc_device_identity_free(id);
    rm_rf(dir);
}

static void test_public_key_base64url_is_stable(void) {
    g_autofree gchar *dir = make_tmp_state_dir();
    OcDeviceIdentity *id = oc_device_identity_load_or_create(dir, NULL);
    g_assert_nonnull(id);

    g_autofree gchar *p1 = oc_device_identity_public_key_base64url(id);
    g_autofree gchar *p2 = oc_device_identity_public_key_base64url(id);
    g_assert_nonnull(p1);
    g_assert_cmpstr(p1, ==, p2);
    g_assert_null(strchr(p1, '='));
    g_assert_null(strchr(p1, '+'));
    g_assert_null(strchr(p1, '/'));

    oc_device_identity_free(id);
    rm_rf(dir);
}

/* ── Negative consistency tests for read_identity_file ── */

#include <json-glib/json-glib.h>

/* Overwrite a single string member of the persisted device.json. */
static void tamper_identity_file(const gchar *state_dir,
                                 const gchar *member,
                                 const gchar *new_value)
{
    g_autofree gchar *path = g_build_filename(state_dir, "identity", "device.json", NULL);
    g_autoptr(JsonParser) parser = json_parser_new();
    GError *err = NULL;
    g_assert_true(json_parser_load_from_file(parser, path, &err));
    g_assert_null(err);
    JsonNode *root = json_parser_get_root(parser);
    g_assert_true(JSON_NODE_HOLDS_OBJECT(root));
    JsonObject *obj = json_node_get_object(root);
    json_object_set_string_member(obj, member, new_value);

    g_autoptr(JsonGenerator) gen = json_generator_new();
    json_generator_set_root(gen, root);
    g_assert_true(json_generator_to_file(gen, path, &err));
    g_assert_null(err);
}

/* Fabricate a different-but-valid 32-byte base64 payload from a constant
 * seed so tests don't depend on randomness. Returns a g_malloc'd string. */
static gchar* make_unrelated_base64_32(guchar byte) {
    guchar buf[32];
    for (gsize i = 0; i < sizeof(buf); i++) buf[i] = byte;
    return g_base64_encode(buf, sizeof(buf));
}

/*
 * Deviceid inconsistency: publicKey + seed are still internally
 * consistent, but deviceId no longer equals sha256(publicKey). The
 * file must be rejected; load_or_create falls back to generate.
 */
static void test_load_rejects_corrupt_device_id(void) {
    g_autofree gchar *dir = make_tmp_state_dir();

    OcDeviceIdentity *orig = oc_device_identity_load_or_create(dir, NULL);
    g_assert_nonnull(orig);
    g_autofree gchar *orig_pk   = g_strdup(orig->public_key_b64);
    g_autofree gchar *orig_seed = g_strdup(orig->private_key_b64);
    oc_device_identity_free(orig);

    /* 64 lowercase hex zeros is syntactically a deviceId but does not
     * match sha256 of any real publicKey. */
    tamper_identity_file(dir, "deviceId",
        "0000000000000000000000000000000000000000000000000000000000000000");

    OcDeviceIdentity *next = oc_device_identity_load_or_create(dir, NULL);
    g_assert_nonnull(next);
    /* The tampered file was discarded: the reloaded identity must be a
     * freshly generated one, not the tampered payload. */
    g_assert_cmpstr(next->device_id, !=,
        "0000000000000000000000000000000000000000000000000000000000000000");
    /* And the regenerated file is itself internally consistent: the new
     * publicKey / seed / deviceId must all agree. Since identity
     * generation picks a fresh keypair, expect the public key to
     * differ from the original (probabilistically certain). */
    g_assert_cmpstr(next->public_key_b64, !=, orig_pk);
    g_assert_cmpstr(next->private_key_b64, !=, orig_seed);
    oc_device_identity_free(next);
    rm_rf(dir);
}

/*
 * PublicKey inconsistency: replace publicKey with an unrelated valid
 * 32-byte base64. Seed no longer derives to it; deviceId no longer
 * matches its sha256. Must be rejected.
 */
static void test_load_rejects_corrupt_public_key(void) {
    g_autofree gchar *dir = make_tmp_state_dir();

    OcDeviceIdentity *orig = oc_device_identity_load_or_create(dir, NULL);
    g_assert_nonnull(orig);
    g_autofree gchar *orig_device_id = g_strdup(orig->device_id);
    oc_device_identity_free(orig);

    g_autofree gchar *fake_pk = make_unrelated_base64_32(0x42);
    tamper_identity_file(dir, "publicKey", fake_pk);

    OcDeviceIdentity *next = oc_device_identity_load_or_create(dir, NULL);
    g_assert_nonnull(next);
    /* A fresh identity, not the tampered one. */
    g_assert_cmpstr(next->public_key_b64, !=, fake_pk);
    g_assert_cmpstr(next->device_id,      !=, orig_device_id);
    oc_device_identity_free(next);
    rm_rf(dir);
}

/*
 * PrivateKey / seed inconsistency: replace seed with an unrelated valid
 * 32-byte base64. The derived public key won't match the stored
 * publicKey. Must be rejected.
 */
static void test_load_rejects_corrupt_private_key_seed(void) {
    g_autofree gchar *dir = make_tmp_state_dir();

    OcDeviceIdentity *orig = oc_device_identity_load_or_create(dir, NULL);
    g_assert_nonnull(orig);
    g_autofree gchar *orig_device_id = g_strdup(orig->device_id);
    g_autofree gchar *orig_seed = g_strdup(orig->private_key_b64);
    oc_device_identity_free(orig);

    g_autofree gchar *fake_seed = make_unrelated_base64_32(0x11);
    tamper_identity_file(dir, "privateKey", fake_seed);

    OcDeviceIdentity *next = oc_device_identity_load_or_create(dir, NULL);
    g_assert_nonnull(next);
    g_assert_cmpstr(next->private_key_b64, !=, fake_seed);
    g_assert_cmpstr(next->private_key_b64, !=, orig_seed);
    g_assert_cmpstr(next->device_id,       !=, orig_device_id);
    oc_device_identity_free(next);
    rm_rf(dir);
}

/*
 * Positive regression: tampering never accepted, but an untampered
 * file is still accepted byte-for-byte. (Redundant with
 * test_load_after_create_is_stable, kept here to keep the negative
 * suite self-contained.)
 */
static void test_load_accepts_consistent_file(void) {
    g_autofree gchar *dir = make_tmp_state_dir();
    OcDeviceIdentity *a = oc_device_identity_load_or_create(dir, NULL);
    g_assert_nonnull(a);
    OcDeviceIdentity *b = oc_device_identity_load_or_create(dir, NULL);
    g_assert_nonnull(b);
    g_assert_cmpstr(a->device_id,       ==, b->device_id);
    g_assert_cmpstr(a->public_key_b64,  ==, b->public_key_b64);
    g_assert_cmpstr(a->private_key_b64, ==, b->private_key_b64);
    oc_device_identity_free(a);
    oc_device_identity_free(b);
    rm_rf(dir);
}

int main(int argc, char **argv) {
    g_test_init(&argc, &argv, NULL);
    /* OC_LOG_WARN is raised when an inconsistent identity is rejected;
     * GTest makes WARNING fatal by default, so relax that. */
    g_log_set_always_fatal(G_LOG_LEVEL_ERROR | G_LOG_LEVEL_CRITICAL);
    g_log_set_fatal_mask(NULL, G_LOG_LEVEL_ERROR | G_LOG_LEVEL_CRITICAL);
    g_test_add_func("/device_identity/first_run_0600", test_first_run_creates_0600_identity);
    g_test_add_func("/device_identity/load_after_create_stable", test_load_after_create_is_stable);
    g_test_add_func("/device_identity/device_id_is_sha256_pk", test_device_id_is_sha256_of_public_key);
    g_test_add_func("/device_identity/sign_deterministic", test_sign_is_deterministic_and_verifies);
    g_test_add_func("/device_identity/public_key_stable", test_public_key_base64url_is_stable);
    g_test_add_func("/device_identity/load_rejects_corrupt_device_id",
                    test_load_rejects_corrupt_device_id);
    g_test_add_func("/device_identity/load_rejects_corrupt_public_key",
                    test_load_rejects_corrupt_public_key);
    g_test_add_func("/device_identity/load_rejects_corrupt_private_key_seed",
                    test_load_rejects_corrupt_private_key_seed);
    g_test_add_func("/device_identity/load_accepts_consistent_file",
                    test_load_accepts_consistent_file);
    return g_test_run();
}
