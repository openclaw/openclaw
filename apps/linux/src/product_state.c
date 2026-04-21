/*
 * product_state.c
 *
 * Persisted product intent storage for the OpenClaw Linux Companion App.
 *
 * Owns loading, migration, and persistence of user/product decisions that
 * outlive a single runtime session, such as connection mode selection and
 * onboarding completion version.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "product_state.h"

#include <errno.h>
#include <glib/gstdio.h>
#include <string.h>

#define PRODUCT_STATE_GROUP "product"
#define PRODUCT_STATE_KEY_CONNECTION_MODE "connection_mode"
#define PRODUCT_STATE_KEY_ONBOARDING_SEEN_VERSION "onboarding_seen_version"

typedef struct {
    ProductStateSnapshot snapshot;
    gboolean initialized;
    gchar *storage_path_override;
    gchar *legacy_marker_path_override;
} ProductStateStore;

static ProductStateStore g_store = {0};

static gchar* product_state_storage_path(void) {
    if (g_store.storage_path_override) return g_strdup(g_store.storage_path_override);
    return g_build_filename(g_get_user_state_dir(), "openclaw-companion", "product-state.ini", NULL);
}

static gchar* product_state_legacy_marker_path(void) {
    if (g_store.legacy_marker_path_override) return g_strdup(g_store.legacy_marker_path_override);
    return g_build_filename(g_get_user_state_dir(), "openclaw-companion", "onboarding_version", NULL);
}

static void product_state_apply_defaults(ProductStateSnapshot *state) {
    if (!state) return;
    state->connection_mode = PRODUCT_CONNECTION_MODE_LOCAL;
    state->onboarding_seen_version = 0;
}

static ProductConnectionMode product_state_normalize_connection_mode(ProductConnectionMode mode) {
    switch (mode) {
    case PRODUCT_CONNECTION_MODE_UNSPECIFIED:
    case PRODUCT_CONNECTION_MODE_LOCAL:
    case PRODUCT_CONNECTION_MODE_REMOTE:
        return mode;
    default:
        return PRODUCT_CONNECTION_MODE_UNSPECIFIED;
    }
}

static ProductConnectionMode product_state_effective_connection_mode(ProductConnectionMode mode) {
    ProductConnectionMode normalized = product_state_normalize_connection_mode(mode);
    if (normalized == PRODUCT_CONNECTION_MODE_REMOTE) return PRODUCT_CONNECTION_MODE_REMOTE;
    return PRODUCT_CONNECTION_MODE_LOCAL;
}

static void product_state_normalize(ProductStateSnapshot *state) {
    if (!state) return;
    state->connection_mode = product_state_normalize_connection_mode(state->connection_mode);
}

static const gchar* product_connection_mode_to_string(ProductConnectionMode mode) {
    switch (product_state_normalize_connection_mode(mode)) {
    case PRODUCT_CONNECTION_MODE_REMOTE:
        return "remote";
    case PRODUCT_CONNECTION_MODE_LOCAL:
        return "local";
    case PRODUCT_CONNECTION_MODE_UNSPECIFIED:
    default:
        return "unspecified";
    }
}

static ProductConnectionMode product_connection_mode_from_string(const gchar *value) {
    if (g_strcmp0(value, "unspecified") == 0) return PRODUCT_CONNECTION_MODE_UNSPECIFIED;
    if (g_strcmp0(value, "local") == 0) return PRODUCT_CONNECTION_MODE_LOCAL;
    if (g_strcmp0(value, "remote") == 0) return PRODUCT_CONNECTION_MODE_REMOTE;
    return PRODUCT_CONNECTION_MODE_UNSPECIFIED;
}

static gboolean product_state_load_legacy_onboarding_version(guint *out_version) {
    g_autofree gchar *path = product_state_legacy_marker_path();
    g_autofree gchar *contents = NULL;
    gint64 parsed = 0;

    if (!out_version || !path) return FALSE;
    if (!g_file_get_contents(path, &contents, NULL, NULL)) return FALSE;

    g_strstrip(contents);
    if (contents[0] == '\0') return FALSE;

    parsed = g_ascii_strtoll(contents, NULL, 10);
    if (parsed < 0 || parsed > G_MAXUINT) return FALSE;

    *out_version = (guint)parsed;
    return TRUE;
}

static gboolean product_state_flush_to_disk(const ProductStateSnapshot *state) {
    g_autofree gchar *path = NULL;
    g_autofree gchar *dir = NULL;
    g_autofree gchar *data = NULL;
    gsize data_len = 0;
    g_autoptr(GError) error = NULL;
    g_autoptr(GKeyFile) key_file = NULL;

    if (!state) return FALSE;

    path = product_state_storage_path();
    if (!path) return FALSE;

    dir = g_path_get_dirname(path);
    if (!dir) return FALSE;

    if (g_mkdir_with_parents(dir, 0700) != 0 && errno != EEXIST) {
        return FALSE;
    }

    key_file = g_key_file_new();
    g_key_file_set_string(key_file,
                          PRODUCT_STATE_GROUP,
                          PRODUCT_STATE_KEY_CONNECTION_MODE,
                          product_connection_mode_to_string(state->connection_mode));
    g_key_file_set_uint64(key_file,
                          PRODUCT_STATE_GROUP,
                          PRODUCT_STATE_KEY_ONBOARDING_SEEN_VERSION,
                          state->onboarding_seen_version);

    data = g_key_file_to_data(key_file, &data_len, NULL);
    if (!data) return FALSE;

    return g_file_set_contents(path, data, (gssize)data_len, &error);
}

static gboolean product_state_load_from_disk(ProductStateSnapshot *state,
                                             gboolean *out_loaded_any,
                                             gboolean *out_needs_flush) {
    g_autofree gchar *path = NULL;
    g_autoptr(GKeyFile) key_file = NULL;
    g_autoptr(GError) error = NULL;
    gboolean loaded_any = FALSE;
    gboolean needs_flush = FALSE;

    if (!state) return FALSE;

    path = product_state_storage_path();
    if (!path) return FALSE;

    key_file = g_key_file_new();
    if (g_file_test(path, G_FILE_TEST_EXISTS)) {
        if (g_key_file_load_from_file(key_file, path, G_KEY_FILE_NONE, &error)) {
            loaded_any = TRUE;

            if (g_key_file_has_key(key_file, PRODUCT_STATE_GROUP, PRODUCT_STATE_KEY_CONNECTION_MODE, NULL)) {
                g_autofree gchar *mode_value = g_key_file_get_string(key_file,
                                                                     PRODUCT_STATE_GROUP,
                                                                     PRODUCT_STATE_KEY_CONNECTION_MODE,
                                                                     NULL);
                ProductConnectionMode parsed_mode = product_connection_mode_from_string(mode_value);
                if (g_strcmp0(mode_value, "unspecified") != 0 &&
                    parsed_mode == PRODUCT_CONNECTION_MODE_UNSPECIFIED) {
                    needs_flush = TRUE;
                }
                state->connection_mode = parsed_mode;
            } else {
                needs_flush = TRUE;
            }

            if (g_key_file_has_key(key_file, PRODUCT_STATE_GROUP, PRODUCT_STATE_KEY_ONBOARDING_SEEN_VERSION, NULL)) {
                guint64 version = g_key_file_get_uint64(key_file,
                                                       PRODUCT_STATE_GROUP,
                                                       PRODUCT_STATE_KEY_ONBOARDING_SEEN_VERSION,
                                                       &error);
                if (!error && version <= G_MAXUINT) {
                    state->onboarding_seen_version = (guint)version;
                } else {
                    g_clear_error(&error);
                    needs_flush = TRUE;
                }
            }
        }
    }

    if (!loaded_any) {
        guint legacy_version = 0;
        if (product_state_load_legacy_onboarding_version(&legacy_version)) {
            state->onboarding_seen_version = legacy_version;
            loaded_any = TRUE;
            needs_flush = TRUE;
        }
    }

    product_state_normalize(state);

    if (out_loaded_any) *out_loaded_any = loaded_any;
    if (out_needs_flush) *out_needs_flush = needs_flush;
    return TRUE;
}

static void product_state_ensure_initialized(void) {
    ProductStateSnapshot snapshot = {0};
    gboolean loaded_any = FALSE;
    gboolean needs_flush = FALSE;

    if (g_store.initialized) return;

    product_state_apply_defaults(&snapshot);
    product_state_load_from_disk(&snapshot, &loaded_any, &needs_flush);
    g_store.snapshot = snapshot;
    g_store.initialized = TRUE;

    if (!loaded_any || needs_flush) {
        (void)product_state_flush_to_disk(&g_store.snapshot);
    }
}

void product_state_init(void) {
    product_state_ensure_initialized();
}

void product_state_get_snapshot(ProductStateSnapshot *out) {
    product_state_ensure_initialized();
    if (!out) return;
    *out = g_store.snapshot;
}

ProductConnectionMode product_state_get_connection_mode(void) {
    product_state_ensure_initialized();
    return g_store.snapshot.connection_mode;
}

ProductConnectionMode product_state_get_effective_connection_mode(void) {
    product_state_ensure_initialized();
    return product_state_effective_connection_mode(g_store.snapshot.connection_mode);
}

gboolean product_state_set_connection_mode(ProductConnectionMode mode) {
    ProductConnectionMode normalized = product_state_normalize_connection_mode(mode);

    product_state_ensure_initialized();
    if (g_store.snapshot.connection_mode == normalized) return TRUE;

    g_store.snapshot.connection_mode = normalized;
    return product_state_flush_to_disk(&g_store.snapshot);
}

guint product_state_get_onboarding_seen_version(void) {
    product_state_ensure_initialized();
    return g_store.snapshot.onboarding_seen_version;
}

gboolean product_state_set_onboarding_seen_version(guint version) {
    product_state_ensure_initialized();
    if (g_store.snapshot.onboarding_seen_version == version) return TRUE;

    g_store.snapshot.onboarding_seen_version = version;
    return product_state_flush_to_disk(&g_store.snapshot);
}

gboolean product_state_reset_onboarding_seen_version(void) {
    g_autofree gchar *legacy_path = NULL;

    product_state_ensure_initialized();
    g_store.snapshot.onboarding_seen_version = 0;

    legacy_path = product_state_legacy_marker_path();
    if (legacy_path) (void)g_unlink(legacy_path);

    return product_state_flush_to_disk(&g_store.snapshot);
}

void product_state_test_set_storage_path(const gchar *path) {
    g_free(g_store.storage_path_override);
    g_store.storage_path_override = g_strdup(path);
}

void product_state_test_set_legacy_marker_path(const gchar *path) {
    g_free(g_store.legacy_marker_path_override);
    g_store.legacy_marker_path_override = g_strdup(path);
}

void product_state_test_reset(void) {
    g_store.snapshot.connection_mode = PRODUCT_CONNECTION_MODE_UNSPECIFIED;
    g_store.snapshot.onboarding_seen_version = 0;
    g_store.initialized = FALSE;
}
