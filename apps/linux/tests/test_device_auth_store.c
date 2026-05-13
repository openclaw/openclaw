/*
 * test_device_auth_store.c
 *
 * Unit tests for device_auth_store.{c,h}.
 *
 * Covers:
 *   - missing store: load returns NULL, no file created
 *   - save/load roundtrip: token and normalized scopes preserved
 *   - scope normalization: operator.admin implies read + write; sorted+deduped
 *   - deviceId mismatch: load returns NULL even if record present
 *   - clear: removes entry, remaining roles untouched
 *   - file mode 0600, parent dir 0700
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "../src/device_auth_store.h"

#include <glib.h>
#include <glib/gstdio.h>
#include <string.h>
#include <sys/stat.h>

static gchar *make_tmp_state_dir(void) {
    gchar *tmpl = g_build_filename(g_get_tmp_dir(), "openclaw-authstore-XXXXXX", NULL);
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

static gsize strv_len(gchar * const *v) {
    gsize n = 0;
    while (v && v[n]) n++;
    return n;
}

static gboolean strv_contains_s(gchar * const *v, const gchar *needle) {
    for (gsize i = 0; v && v[i]; i++) {
        if (g_strcmp0(v[i], needle) == 0) return TRUE;
    }
    return FALSE;
}

static void test_load_missing_returns_null(void) {
    g_autofree gchar *dir = make_tmp_state_dir();
    OcDeviceAuthEntry *e = oc_device_auth_store_load(dir, "dev-abc", "operator");
    g_assert_null(e);
    rm_rf(dir);
}

static void test_save_then_load_roundtrip(void) {
    g_autofree gchar *dir = make_tmp_state_dir();
    const gchar *scopes[] = {"operator.read", "operator.admin", NULL};
    g_assert_true(oc_device_auth_store_save(dir, "dev-abc", "operator", "tok-1", scopes));

    OcDeviceAuthEntry *e = oc_device_auth_store_load(dir, "dev-abc", "operator");
    g_assert_nonnull(e);
    g_assert_cmpstr(e->token, ==, "tok-1");
    g_assert_cmpstr(e->role, ==, "operator");
    g_assert_cmpint(e->updated_at_ms, >, 0);

    /* admin implies read + write; sorted+deduped */
    g_assert_cmpint(strv_len(e->scopes), ==, 3);
    g_assert_true(strv_contains_s(e->scopes, "operator.admin"));
    g_assert_true(strv_contains_s(e->scopes, "operator.read"));
    g_assert_true(strv_contains_s(e->scopes, "operator.write"));
    g_assert_cmpstr(e->scopes[0], ==, "operator.admin");
    g_assert_cmpstr(e->scopes[1], ==, "operator.read");
    g_assert_cmpstr(e->scopes[2], ==, "operator.write");

    oc_device_auth_entry_free(e);

    /* File should be 0600, dir 0700 */
    g_autofree gchar *id_dir = g_build_filename(dir, "identity", NULL);
    g_autofree gchar *f = g_build_filename(id_dir, "device-auth.json", NULL);
    assert_mode(id_dir, 0700);
    assert_mode(f, 0600);

    rm_rf(dir);
}

static void test_normalize_scopes_seam(void) {
    const gchar *in1[] = {"operator.admin", NULL};
    g_auto(GStrv) out1 = oc_device_auth_normalize_scopes(in1);
    g_assert_cmpint(strv_len(out1), ==, 3);
    g_assert_true(strv_contains_s(out1, "operator.admin"));
    g_assert_true(strv_contains_s(out1, "operator.read"));
    g_assert_true(strv_contains_s(out1, "operator.write"));

    const gchar *in2[] = {"operator.write", "operator.read", NULL};
    g_auto(GStrv) out2 = oc_device_auth_normalize_scopes(in2);
    g_assert_cmpint(strv_len(out2), ==, 2);
    g_assert_true(strv_contains_s(out2, "operator.read"));
    g_assert_true(strv_contains_s(out2, "operator.write"));

    const gchar *in3[] = {"operator.read", "operator.read", NULL};
    g_auto(GStrv) out3 = oc_device_auth_normalize_scopes(in3);
    g_assert_cmpint(strv_len(out3), ==, 1);
    g_assert_cmpstr(out3[0], ==, "operator.read");

    g_auto(GStrv) out4 = oc_device_auth_normalize_scopes(NULL);
    g_assert_nonnull(out4);
    g_assert_cmpint(strv_len(out4), ==, 0);
}

static void test_device_id_mismatch_returns_null(void) {
    g_autofree gchar *dir = make_tmp_state_dir();
    const gchar *scopes[] = {"operator.admin", NULL};
    g_assert_true(oc_device_auth_store_save(dir, "dev-abc", "operator", "tok-1", scopes));

    OcDeviceAuthEntry *e = oc_device_auth_store_load(dir, "dev-xyz", "operator");
    g_assert_null(e);

    rm_rf(dir);
}

static void test_clear_removes_entry_only(void) {
    g_autofree gchar *dir = make_tmp_state_dir();
    const gchar *scopes[] = {"operator.admin", NULL};
    g_assert_true(oc_device_auth_store_save(dir, "dev-abc", "operator", "tok-op", scopes));
    g_assert_true(oc_device_auth_store_save(dir, "dev-abc", "viewer", "tok-v", NULL));

    g_assert_true(oc_device_auth_store_clear(dir, "dev-abc", "operator"));

    g_assert_null(oc_device_auth_store_load(dir, "dev-abc", "operator"));
    OcDeviceAuthEntry *v = oc_device_auth_store_load(dir, "dev-abc", "viewer");
    g_assert_nonnull(v);
    g_assert_cmpstr(v->token, ==, "tok-v");
    oc_device_auth_entry_free(v);

    rm_rf(dir);
}

static void test_clear_on_mismatched_device_id_is_noop(void) {
    g_autofree gchar *dir = make_tmp_state_dir();
    const gchar *scopes[] = {"operator.admin", NULL};
    g_assert_true(oc_device_auth_store_save(dir, "dev-abc", "operator", "tok-op", scopes));

    g_assert_true(oc_device_auth_store_clear(dir, "dev-xyz", "operator"));

    /* Entry still present under the original deviceId. */
    OcDeviceAuthEntry *e = oc_device_auth_store_load(dir, "dev-abc", "operator");
    g_assert_nonnull(e);
    oc_device_auth_entry_free(e);

    rm_rf(dir);
}

int main(int argc, char **argv) {
    g_test_init(&argc, &argv, NULL);
    g_test_add_func("/device_auth_store/load_missing_null", test_load_missing_returns_null);
    g_test_add_func("/device_auth_store/save_load_roundtrip", test_save_then_load_roundtrip);
    g_test_add_func("/device_auth_store/normalize_scopes", test_normalize_scopes_seam);
    g_test_add_func("/device_auth_store/device_id_mismatch_null", test_device_id_mismatch_returns_null);
    g_test_add_func("/device_auth_store/clear_removes_entry_only", test_clear_removes_entry_only);
    g_test_add_func("/device_auth_store/clear_mismatched_noop", test_clear_on_mismatched_device_id_is_noop);
    return g_test_run();
}
