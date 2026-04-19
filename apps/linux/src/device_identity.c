/*
 * device_identity.c
 *
 * Ed25519 device identity implementation using libsodium, byte-compatible
 * with apps/macos DeviceIdentityStore and src/infra/device-identity.ts.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "device_identity.h"
#include "json_access.h"
#include "log.h"

#include <errno.h>
#include <fcntl.h>
#include <glib/gstdio.h>
#include <json-glib/json-glib.h>
#include <sodium.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#define OC_IDENTITY_DIR_NAME   "identity"
#define OC_IDENTITY_FILE_NAME  "device.json"

#define OC_ED25519_SEED_BYTES  32
#define OC_ED25519_PK_BYTES    32
#define OC_ED25519_SK_BYTES    64
#define OC_ED25519_SIG_BYTES   64

#define OC_DEVICE_IDENTITY_ERROR oc_device_identity_error_quark()

typedef enum {
    OC_DEVICE_IDENTITY_ERROR_SODIUM_INIT,
    OC_DEVICE_IDENTITY_ERROR_IO,
    OC_DEVICE_IDENTITY_ERROR_PARSE,
    OC_DEVICE_IDENTITY_ERROR_CRYPTO
} OcDeviceIdentityErrorKind;

static GQuark oc_device_identity_error_quark(void) {
    return g_quark_from_static_string("oc-device-identity-error");
}

static gboolean ensure_sodium_initialized(GError **error) {
    static gsize once = 0;
    static gboolean init_ok = FALSE;
    if (g_once_init_enter(&once)) {
        init_ok = sodium_init() >= 0;
        g_once_init_leave(&once, 1);
    }
    if (!init_ok) {
        g_set_error(error, OC_DEVICE_IDENTITY_ERROR,
                    OC_DEVICE_IDENTITY_ERROR_SODIUM_INIT,
                    "libsodium initialization failed");
        return FALSE;
    }
    return TRUE;
}

static gchar* base64url_encode_nopad(const guchar *data, gsize len) {
    g_autofree gchar *std_b64 = g_base64_encode(data, len);
    if (!std_b64) return NULL;
    gsize out_len = strlen(std_b64);
    gchar *out = g_malloc(out_len + 1);
    gsize j = 0;
    for (gsize i = 0; i < out_len; i++) {
        gchar c = std_b64[i];
        if (c == '=') break;
        if (c == '+') c = '-';
        else if (c == '/') c = '_';
        out[j++] = c;
    }
    out[j] = '\0';
    return out;
}

static gchar* hex_lower_of_bytes(const guchar *data, gsize len) {
    static const char hex[] = "0123456789abcdef";
    gchar *out = g_malloc(len * 2 + 1);
    for (gsize i = 0; i < len; i++) {
        out[i * 2]     = hex[(data[i] >> 4) & 0x0f];
        out[i * 2 + 1] = hex[data[i] & 0x0f];
    }
    out[len * 2] = '\0';
    return out;
}

gchar* oc_device_identity_compute_device_id(const guchar *public_key_raw,
                                            gsize public_key_len) {
    if (!public_key_raw || public_key_len == 0) return NULL;
    if (!ensure_sodium_initialized(NULL)) return NULL;
    guchar hash[crypto_hash_sha256_BYTES];
    if (crypto_hash_sha256(hash, public_key_raw, public_key_len) != 0) return NULL;
    return hex_lower_of_bytes(hash, sizeof(hash));
}

static gboolean decode_standard_base64(const gchar *input, guchar *out, gsize expected_len) {
    if (!input) return FALSE;
    gsize decoded_len = 0;
    g_autofree guchar *decoded = g_base64_decode(input, &decoded_len);
    if (!decoded || decoded_len != expected_len) return FALSE;
    memcpy(out, decoded, expected_len);
    sodium_memzero(decoded, decoded_len);
    return TRUE;
}

static gchar* resolve_identity_file_path(const gchar *state_dir) {
    if (!state_dir || state_dir[0] == '\0') return NULL;
    return g_build_filename(state_dir, OC_IDENTITY_DIR_NAME, OC_IDENTITY_FILE_NAME, NULL);
}

static gboolean ensure_parent_dirs(const gchar *file_path, GError **error) {
    g_autofree gchar *dir = g_path_get_dirname(file_path);
    if (!dir) return FALSE;
    if (g_mkdir_with_parents(dir, 0700) != 0) {
        g_set_error(error, OC_DEVICE_IDENTITY_ERROR, OC_DEVICE_IDENTITY_ERROR_IO,
                    "mkdir %s: %s", dir, g_strerror(errno));
        return FALSE;
    }
    /* Best-effort tighten perms if dir already existed with looser mode. */
    (void)g_chmod(dir, 0700);
    return TRUE;
}

static gboolean write_identity_file(const gchar *path,
                                    const OcDeviceIdentity *id,
                                    GError **error) {
    g_autoptr(JsonBuilder) builder = json_builder_new();
    json_builder_begin_object(builder);
    json_builder_set_member_name(builder, "deviceId");
    json_builder_add_string_value(builder, id->device_id);
    json_builder_set_member_name(builder, "publicKey");
    json_builder_add_string_value(builder, id->public_key_b64);
    json_builder_set_member_name(builder, "privateKey");
    json_builder_add_string_value(builder, id->private_key_b64);
    json_builder_set_member_name(builder, "createdAtMs");
    json_builder_add_int_value(builder, id->created_at_ms);
    json_builder_end_object(builder);

    g_autoptr(JsonGenerator) gen = json_generator_new();
    JsonNode *root = json_builder_get_root(builder);
    json_generator_set_root(gen, root);
    g_autofree gchar *data = json_generator_to_data(gen, NULL);
    json_node_unref(root);
    if (!data) {
        g_set_error(error, OC_DEVICE_IDENTITY_ERROR, OC_DEVICE_IDENTITY_ERROR_IO,
                    "json serialize failed");
        return FALSE;
    }

    /* Write atomically with 0600 perms: tmp file + rename, then chmod. */
    g_autofree gchar *tmp = g_strdup_printf("%s.tmp.%u", path, g_random_int());
    int fd = g_open(tmp, O_WRONLY | O_CREAT | O_TRUNC, 0600);
    if (fd < 0) {
        g_set_error(error, OC_DEVICE_IDENTITY_ERROR, OC_DEVICE_IDENTITY_ERROR_IO,
                    "open %s: %s", tmp, g_strerror(errno));
        return FALSE;
    }
    gsize data_len = strlen(data);
    gssize written = 0;
    while ((gsize)written < data_len) {
        gssize n = write(fd, data + written, data_len - (gsize)written);
        if (n < 0) {
            if (errno == EINTR) continue;
            g_close(fd, NULL);
            (void)g_unlink(tmp);
            g_set_error(error, OC_DEVICE_IDENTITY_ERROR, OC_DEVICE_IDENTITY_ERROR_IO,
                        "write %s: %s", tmp, g_strerror(errno));
            return FALSE;
        }
        written += n;
    }
    (void)fsync(fd);
    g_close(fd, NULL);
    (void)g_chmod(tmp, 0600);

    if (g_rename(tmp, path) != 0) {
        (void)g_unlink(tmp);
        g_set_error(error, OC_DEVICE_IDENTITY_ERROR, OC_DEVICE_IDENTITY_ERROR_IO,
                    "rename %s -> %s: %s", tmp, path, g_strerror(errno));
        return FALSE;
    }
    (void)g_chmod(path, 0600);
    return TRUE;
}

static OcDeviceIdentity* read_identity_file(const gchar *path) {
    if (!g_file_test(path, G_FILE_TEST_EXISTS)) return NULL;
    g_autofree gchar *contents = NULL;
    gsize length = 0;
    if (!g_file_get_contents(path, &contents, &length, NULL)) return NULL;

    g_autoptr(JsonParser) parser = json_parser_new();
    if (!json_parser_load_from_data(parser, contents, (gssize)length, NULL)) return NULL;
    JsonNode *root = json_parser_get_root(parser);
    if (!root || !JSON_NODE_HOLDS_OBJECT(root)) return NULL;
    JsonObject *obj = json_node_get_object(root);

    const gchar *device_id = oc_json_string_member(obj, "deviceId");
    const gchar *public_key = oc_json_string_member(obj, "publicKey");
    const gchar *private_key = oc_json_string_member(obj, "privateKey");
    if (!device_id || !public_key || !private_key) return NULL;
    if (device_id[0] == '\0' || public_key[0] == '\0' || private_key[0] == '\0') return NULL;

    /*
     * Syntactic validation: base64 payloads decode to the expected byte
     * counts. Anything short-circuits through the same scrub-and-reject
     * tail at the bottom of this function.
     */
    guchar pk_raw[OC_ED25519_PK_BYTES];
    guchar seed_raw[OC_ED25519_SEED_BYTES];
    guchar derived_pk[OC_ED25519_PK_BYTES];
    guchar derived_sk[OC_ED25519_SK_BYTES];
    gboolean have_pk = FALSE, have_seed = FALSE, have_derived = FALSE;
    g_autofree gchar *recomputed_device_id = NULL;

    const gchar *reject_reason = NULL;
    if (!decode_standard_base64(public_key, pk_raw, sizeof(pk_raw))) {
        reject_reason = "publicKey did not decode to 32 bytes";
        goto reject;
    }
    have_pk = TRUE;
    if (!decode_standard_base64(private_key, seed_raw, sizeof(seed_raw))) {
        reject_reason = "privateKey (seed) did not decode to 32 bytes";
        goto reject;
    }
    have_seed = TRUE;

    /*
     * Cryptographic consistency: the public key derived from the stored
     * Ed25519 seed must byte-exactly match the stored public key, and
     * the stored deviceId must be the SHA-256 of the public key in
     * lowercase hex. Either mismatch means the file was tampered with,
     * partially rewritten, or merged from an inconsistent backup — in
     * any case it's unsafe to load, since signing with one seed while
     * presenting a different public key + deviceId would violate the
     * shared DeviceIdentity contract.
     */
    if (!ensure_sodium_initialized(NULL)) {
        reject_reason = "libsodium init failed";
        goto reject;
    }
    if (crypto_sign_seed_keypair(derived_pk, derived_sk, seed_raw) != 0) {
        reject_reason = "crypto_sign_seed_keypair failed";
        goto reject;
    }
    have_derived = TRUE;
    if (sodium_memcmp(derived_pk, pk_raw, sizeof(pk_raw)) != 0) {
        reject_reason = "derived public key != stored publicKey";
        goto reject;
    }

    recomputed_device_id = oc_device_identity_compute_device_id(pk_raw, sizeof(pk_raw));
    if (!recomputed_device_id) {
        reject_reason = "recompute deviceId failed";
        goto reject;
    }
    if (g_strcmp0(recomputed_device_id, device_id) != 0) {
        reject_reason = "recomputed deviceId != stored deviceId";
        goto reject;
    }

    gint64 created_ms = 0;
    if (json_object_has_member(obj, "createdAtMs")) {
        JsonNode *n = json_object_get_member(obj, "createdAtMs");
        if (JSON_NODE_HOLDS_VALUE(n)) {
            created_ms = json_node_get_int(n);
        }
    }

    OcDeviceIdentity *id = g_new0(OcDeviceIdentity, 1);
    id->device_id = g_strdup(device_id);
    id->public_key_b64 = g_strdup(public_key);
    id->private_key_b64 = g_strdup(private_key);
    id->created_at_ms = created_ms;

    sodium_memzero(pk_raw, sizeof(pk_raw));
    sodium_memzero(seed_raw, sizeof(seed_raw));
    sodium_memzero(derived_pk, sizeof(derived_pk));
    sodium_memzero(derived_sk, sizeof(derived_sk));
    return id;

reject:
    if (have_pk)      sodium_memzero(pk_raw, sizeof(pk_raw));
    if (have_seed)    sodium_memzero(seed_raw, sizeof(seed_raw));
    if (have_derived) {
        sodium_memzero(derived_pk, sizeof(derived_pk));
        sodium_memzero(derived_sk, sizeof(derived_sk));
    }
    if (reject_reason) {
        OC_LOG_WARN(OPENCLAW_LOG_CAT_GATEWAY,
                    "device identity file %s rejected: %s; a fresh identity "
                    "will be generated",
                    path, reject_reason);
    }
    return NULL;
}

static OcDeviceIdentity* generate_identity(GError **error) {
    if (!ensure_sodium_initialized(error)) return NULL;
    guchar pk[OC_ED25519_PK_BYTES];
    guchar sk[OC_ED25519_SK_BYTES];
    if (crypto_sign_keypair(pk, sk) != 0) {
        g_set_error(error, OC_DEVICE_IDENTITY_ERROR, OC_DEVICE_IDENTITY_ERROR_CRYPTO,
                    "crypto_sign_keypair failed");
        return NULL;
    }
    guchar seed[OC_ED25519_SEED_BYTES];
    if (crypto_sign_ed25519_sk_to_seed(seed, sk) != 0) {
        sodium_memzero(sk, sizeof(sk));
        g_set_error(error, OC_DEVICE_IDENTITY_ERROR, OC_DEVICE_IDENTITY_ERROR_CRYPTO,
                    "crypto_sign_ed25519_sk_to_seed failed");
        return NULL;
    }

    OcDeviceIdentity *id = g_new0(OcDeviceIdentity, 1);
    id->device_id = oc_device_identity_compute_device_id(pk, sizeof(pk));
    id->public_key_b64 = g_base64_encode(pk, sizeof(pk));
    id->private_key_b64 = g_base64_encode(seed, sizeof(seed));
    id->created_at_ms = (gint64)(g_get_real_time() / 1000);

    sodium_memzero(sk, sizeof(sk));
    sodium_memzero(seed, sizeof(seed));
    if (!id->device_id || !id->public_key_b64 || !id->private_key_b64) {
        g_set_error(error, OC_DEVICE_IDENTITY_ERROR, OC_DEVICE_IDENTITY_ERROR_CRYPTO,
                    "identity encoding failed");
        oc_device_identity_free(id);
        return NULL;
    }
    return id;
}

OcDeviceIdentity* oc_device_identity_load_or_create(const gchar *state_dir,
                                                    GError **error) {
    if (!ensure_sodium_initialized(error)) return NULL;
    g_autofree gchar *path = resolve_identity_file_path(state_dir);
    if (!path) {
        g_set_error(error, OC_DEVICE_IDENTITY_ERROR, OC_DEVICE_IDENTITY_ERROR_IO,
                    "state_dir is empty");
        return NULL;
    }
    OcDeviceIdentity *existing = read_identity_file(path);
    if (existing) return existing;

    if (!ensure_parent_dirs(path, error)) return NULL;
    OcDeviceIdentity *fresh = generate_identity(error);
    if (!fresh) return NULL;
    if (!write_identity_file(path, fresh, error)) {
        oc_device_identity_free(fresh);
        return NULL;
    }
    OC_LOG_INFO(OPENCLAW_LOG_CAT_GATEWAY,
                "device identity generated device_id=%.16s...", fresh->device_id);
    return fresh;
}

gchar* oc_device_identity_sign_base64url(const OcDeviceIdentity *identity,
                                         const gchar *payload) {
    if (!identity || !identity->private_key_b64 || !payload) return NULL;
    if (!ensure_sodium_initialized(NULL)) return NULL;

    guchar seed[OC_ED25519_SEED_BYTES];
    if (!decode_standard_base64(identity->private_key_b64, seed, sizeof(seed))) return NULL;
    guchar pk[OC_ED25519_PK_BYTES];
    guchar sk[OC_ED25519_SK_BYTES];
    if (crypto_sign_seed_keypair(pk, sk, seed) != 0) {
        sodium_memzero(seed, sizeof(seed));
        return NULL;
    }
    sodium_memzero(seed, sizeof(seed));

    guchar sig[OC_ED25519_SIG_BYTES];
    unsigned long long siglen = 0;
    int rc = crypto_sign_detached(sig, &siglen, (const unsigned char *)payload,
                                  (unsigned long long)strlen(payload), sk);
    sodium_memzero(sk, sizeof(sk));
    sodium_memzero(pk, sizeof(pk));
    if (rc != 0 || siglen != OC_ED25519_SIG_BYTES) return NULL;
    return base64url_encode_nopad(sig, siglen);
}

gchar* oc_device_identity_public_key_base64url(const OcDeviceIdentity *identity) {
    if (!identity || !identity->public_key_b64) return NULL;
    guchar pk[OC_ED25519_PK_BYTES];
    if (!decode_standard_base64(identity->public_key_b64, pk, sizeof(pk))) return NULL;
    gchar *out = base64url_encode_nopad(pk, sizeof(pk));
    sodium_memzero(pk, sizeof(pk));
    return out;
}

void oc_device_identity_free(OcDeviceIdentity *identity) {
    if (!identity) return;
    g_free(identity->device_id);
    if (identity->public_key_b64) {
        sodium_memzero(identity->public_key_b64, strlen(identity->public_key_b64));
        g_free(identity->public_key_b64);
    }
    if (identity->private_key_b64) {
        sodium_memzero(identity->private_key_b64, strlen(identity->private_key_b64));
        g_free(identity->private_key_b64);
    }
    g_free(identity);
}
