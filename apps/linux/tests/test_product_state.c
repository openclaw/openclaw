/*
 * test_product_state.c
 *
 * Focused coverage for persisted product state in the Linux companion app.
 *
 * Verifies storage, migration, and reset behavior for connection mode and
 * onboarding-seen version persistence.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "../src/product_state.h"

#include <glib.h>
#include <glib/gstdio.h>

static gchar *make_tmp_dir(void) {
    gchar *tmpl = g_build_filename(g_get_tmp_dir(), "openclaw-product-state-XXXXXX", NULL);
    gchar *dir = g_mkdtemp(tmpl);
    g_assert_nonnull(dir);
    return dir;
}

static void remove_if_exists(const gchar *path) {
    if (!path) return;
    if (g_file_test(path, G_FILE_TEST_EXISTS)) {
        g_remove(path);
    }
}

static void cleanup_tmp_dir(const gchar *dir) {
    if (!dir) return;
    if (g_file_test(dir, G_FILE_TEST_IS_DIR)) {
        g_rmdir(dir);
    }
}

static void reset_product_state_for_paths(const gchar *storage_path,
                                          const gchar *legacy_path) {
    product_state_test_set_storage_path(storage_path);
    product_state_test_set_legacy_marker_path(legacy_path);
    product_state_test_reset();
}

static void clear_product_state_test_overrides(void) {
    product_state_test_reset();
    product_state_test_set_storage_path(NULL);
    product_state_test_set_legacy_marker_path(NULL);
}

static gchar* read_file_or_null(const gchar *path) {
    gchar *contents = NULL;
    if (!g_file_get_contents(path, &contents, NULL, NULL)) return NULL;
    return contents;
}

static void test_defaults_create_local_state(void) {
    g_autofree gchar *dir = make_tmp_dir();
    g_autofree gchar *storage_path = g_build_filename(dir, "product-state.ini", NULL);
    g_autofree gchar *legacy_path = g_build_filename(dir, "onboarding_version", NULL);
    ProductStateSnapshot snapshot = {0};

    reset_product_state_for_paths(storage_path, legacy_path);
    product_state_init();
    product_state_get_snapshot(&snapshot);

    g_assert_cmpint(snapshot.connection_mode, ==, PRODUCT_CONNECTION_MODE_LOCAL);
    g_assert_cmpuint(snapshot.onboarding_seen_version, ==, 0);
    g_assert_true(g_file_test(storage_path, G_FILE_TEST_EXISTS));

    g_autofree gchar *contents = read_file_or_null(storage_path);
    g_assert_nonnull(contents);
    g_assert_nonnull(g_strstr_len(contents, -1, "connection_mode=local"));
    g_assert_nonnull(g_strstr_len(contents, -1, "onboarding_seen_version=0"));

    clear_product_state_test_overrides();
    remove_if_exists(storage_path);
    remove_if_exists(legacy_path);
    cleanup_tmp_dir(dir);
}

static void test_onboarding_seen_version_roundtrip(void) {
    g_autofree gchar *dir = make_tmp_dir();
    g_autofree gchar *storage_path = g_build_filename(dir, "product-state.ini", NULL);
    g_autofree gchar *legacy_path = g_build_filename(dir, "onboarding_version", NULL);

    reset_product_state_for_paths(storage_path, legacy_path);
    product_state_init();
    g_assert_true(product_state_set_onboarding_seen_version(7));

    product_state_test_reset();
    product_state_init();

    g_assert_cmpuint(product_state_get_onboarding_seen_version(), ==, 7);
    g_assert_cmpint(product_state_get_connection_mode(), ==, PRODUCT_CONNECTION_MODE_LOCAL);
    g_assert_cmpint(product_state_get_effective_connection_mode(), ==, PRODUCT_CONNECTION_MODE_LOCAL);

    clear_product_state_test_overrides();
    remove_if_exists(storage_path);
    remove_if_exists(legacy_path);
    cleanup_tmp_dir(dir);
}

static void test_remote_mode_roundtrip(void) {
    g_autofree gchar *dir = make_tmp_dir();
    g_autofree gchar *storage_path = g_build_filename(dir, "product-state.ini", NULL);
    g_autofree gchar *legacy_path = g_build_filename(dir, "onboarding_version", NULL);

    reset_product_state_for_paths(storage_path, legacy_path);
    product_state_init();
    g_assert_true(product_state_set_connection_mode(PRODUCT_CONNECTION_MODE_REMOTE));

    product_state_test_reset();
    product_state_init();

    g_assert_cmpint(product_state_get_connection_mode(), ==, PRODUCT_CONNECTION_MODE_REMOTE);
    g_assert_cmpint(product_state_get_effective_connection_mode(), ==, PRODUCT_CONNECTION_MODE_REMOTE);

    g_autofree gchar *contents = read_file_or_null(storage_path);
    g_assert_nonnull(contents);
    g_assert_nonnull(g_strstr_len(contents, -1, "connection_mode=remote"));

    clear_product_state_test_overrides();
    remove_if_exists(storage_path);
    remove_if_exists(legacy_path);
    cleanup_tmp_dir(dir);
}

static void test_unspecified_mode_resolves_to_effective_local(void) {
    g_autofree gchar *dir = make_tmp_dir();
    g_autofree gchar *storage_path = g_build_filename(dir, "product-state.ini", NULL);
    g_autofree gchar *legacy_path = g_build_filename(dir, "onboarding_version", NULL);

    reset_product_state_for_paths(storage_path, legacy_path);
    product_state_init();
    g_assert_true(product_state_set_connection_mode(PRODUCT_CONNECTION_MODE_UNSPECIFIED));

    product_state_test_reset();
    product_state_init();

    g_assert_cmpint(product_state_get_connection_mode(), ==, PRODUCT_CONNECTION_MODE_UNSPECIFIED);
    g_assert_cmpint(product_state_get_effective_connection_mode(), ==, PRODUCT_CONNECTION_MODE_LOCAL);

    g_autofree gchar *contents = read_file_or_null(storage_path);
    g_assert_nonnull(contents);
    g_assert_nonnull(g_strstr_len(contents, -1, "connection_mode=unspecified"));

    clear_product_state_test_overrides();
    remove_if_exists(storage_path);
    remove_if_exists(legacy_path);
    cleanup_tmp_dir(dir);
}

static void test_invalid_mode_falls_back_to_unspecified_effective_local(void) {
    g_autofree gchar *dir = make_tmp_dir();
    g_autofree gchar *storage_path = g_build_filename(dir, "product-state.ini", NULL);
    g_autofree gchar *legacy_path = g_build_filename(dir, "onboarding_version", NULL);
    const gchar *bad_data = "[product]\nconnection_mode=bogus\nonboarding_seen_version=4\n";

    g_assert_true(g_file_set_contents(storage_path, bad_data, -1, NULL));
    reset_product_state_for_paths(storage_path, legacy_path);
    product_state_init();

    g_assert_cmpint(product_state_get_connection_mode(), ==, PRODUCT_CONNECTION_MODE_UNSPECIFIED);
    g_assert_cmpint(product_state_get_effective_connection_mode(), ==, PRODUCT_CONNECTION_MODE_LOCAL);
    g_assert_cmpuint(product_state_get_onboarding_seen_version(), ==, 4);

    g_autofree gchar *contents = read_file_or_null(storage_path);
    g_assert_nonnull(contents);
    g_assert_nonnull(g_strstr_len(contents, -1, "connection_mode=unspecified"));

    clear_product_state_test_overrides();
    remove_if_exists(storage_path);
    remove_if_exists(legacy_path);
    cleanup_tmp_dir(dir);
}

static void test_invalid_seen_version_falls_back_to_zero(void) {
    g_autofree gchar *dir = make_tmp_dir();
    g_autofree gchar *storage_path = g_build_filename(dir, "product-state.ini", NULL);
    g_autofree gchar *legacy_path = g_build_filename(dir, "onboarding_version", NULL);
    const gchar *bad_data = "[product]\nconnection_mode=local\nonboarding_seen_version=oops\n";

    g_assert_true(g_file_set_contents(storage_path, bad_data, -1, NULL));
    reset_product_state_for_paths(storage_path, legacy_path);
    product_state_init();

    g_assert_cmpint(product_state_get_connection_mode(), ==, PRODUCT_CONNECTION_MODE_LOCAL);
    g_assert_cmpuint(product_state_get_onboarding_seen_version(), ==, 0);

    clear_product_state_test_overrides();
    remove_if_exists(storage_path);
    remove_if_exists(legacy_path);
    cleanup_tmp_dir(dir);
}

static void test_legacy_marker_migrates_to_product_state(void) {
    g_autofree gchar *dir = make_tmp_dir();
    g_autofree gchar *storage_path = g_build_filename(dir, "product-state.ini", NULL);
    g_autofree gchar *legacy_path = g_build_filename(dir, "onboarding_version", NULL);

    g_assert_true(g_file_set_contents(legacy_path, "3\n", -1, NULL));
    reset_product_state_for_paths(storage_path, legacy_path);
    product_state_init();

    g_assert_cmpuint(product_state_get_onboarding_seen_version(), ==, 3);
    g_assert_true(g_file_test(storage_path, G_FILE_TEST_EXISTS));

    g_autofree gchar *contents = read_file_or_null(storage_path);
    g_assert_nonnull(contents);
    g_assert_nonnull(g_strstr_len(contents, -1, "connection_mode=local"));
    g_assert_nonnull(g_strstr_len(contents, -1, "onboarding_seen_version=3"));

    clear_product_state_test_overrides();
    remove_if_exists(storage_path);
    remove_if_exists(legacy_path);
    cleanup_tmp_dir(dir);
}

static void test_reset_onboarding_seen_version_persists_zero(void) {
    g_autofree gchar *dir = make_tmp_dir();
    g_autofree gchar *storage_path = g_build_filename(dir, "product-state.ini", NULL);
    g_autofree gchar *legacy_path = g_build_filename(dir, "onboarding_version", NULL);

    reset_product_state_for_paths(storage_path, legacy_path);
    product_state_init();
    g_assert_true(product_state_set_onboarding_seen_version(9));
    g_assert_true(product_state_reset_onboarding_seen_version());

    product_state_test_reset();
    product_state_init();

    g_assert_cmpuint(product_state_get_onboarding_seen_version(), ==, 0);

    clear_product_state_test_overrides();
    remove_if_exists(storage_path);
    remove_if_exists(legacy_path);
    cleanup_tmp_dir(dir);
}

int main(int argc, char **argv) {
    g_test_init(&argc, &argv, NULL);
    g_test_add_func("/product_state/defaults_create_local_state", test_defaults_create_local_state);
    g_test_add_func("/product_state/onboarding_seen_version_roundtrip", test_onboarding_seen_version_roundtrip);
    g_test_add_func("/product_state/remote_mode_roundtrip", test_remote_mode_roundtrip);
    g_test_add_func("/product_state/unspecified_mode_resolves_to_effective_local", test_unspecified_mode_resolves_to_effective_local);
    g_test_add_func("/product_state/invalid_mode_falls_back_to_unspecified_effective_local", test_invalid_mode_falls_back_to_unspecified_effective_local);
    g_test_add_func("/product_state/invalid_seen_version_falls_back_to_zero", test_invalid_seen_version_falls_back_to_zero);
    g_test_add_func("/product_state/legacy_marker_migrates", test_legacy_marker_migrates_to_product_state);
    g_test_add_func("/product_state/reset_onboarding_seen_version_persists_zero", test_reset_onboarding_seen_version_persists_zero);
    return g_test_run();
}
