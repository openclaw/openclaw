/*
 * test_exec_approval_store.c
 *
 * Coverage for the quick-mode policy store: round-trip via explicit
 * state-dir, lazy buffering when state-dir is unset, file permissions,
 * and tolerance to corrupt input.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "../src/exec_approval_store.h"
#include "../src/json_access.h"

#include <glib.h>
#include <glib/gstdio.h>
#include <json-glib/json-glib.h>
#include <sys/stat.h>
#include <string.h>

static gchar* make_tempdir(const gchar *suffix) {
    /* g_dir_make_tmp expects a basename-only template (no path segments)
     * and places the directory under TMPDIR. */
    g_autofree gchar *tpl = g_strdup_printf("openclaw-exec-approval-%s-XXXXXX",
                                            suffix);
    g_autoptr(GError) err = NULL;
    gchar *out = g_dir_make_tmp(tpl, &err);
    if (!out) {
        g_test_message("g_dir_make_tmp(%s) failed: %s", tpl,
                       err ? err->message : "(no detail)");
    }
    return out;
}

static gchar* read_file_or_null(const gchar *path) {
    g_autoptr(GError) error = NULL;
    gchar *contents = NULL;
    if (!g_file_get_contents(path, &contents, NULL, &error)) {
        return NULL;
    }
    return contents;
}

static void assert_defaults_match(const gchar *path,
                                  const gchar *expected_security,
                                  const gchar *expected_ask) {
    g_autofree gchar *contents = read_file_or_null(path);
    g_assert_nonnull(contents);

    g_autoptr(JsonParser) parser = json_parser_new();
    g_autoptr(GError) error = NULL;
    g_assert_true(json_parser_load_from_data(parser, contents, -1, &error));
    JsonNode *root = json_parser_get_root(parser);
    g_assert_true(JSON_NODE_HOLDS_OBJECT(root));
    JsonObject *obj = json_node_get_object(root);
    JsonObject *defaults = oc_json_object_member(obj, "defaults");
    g_assert_nonnull(defaults);
    g_assert_cmpstr(oc_json_string_member(defaults, "security"), ==, expected_security);
    g_assert_cmpstr(oc_json_string_member(defaults, "ask"), ==, expected_ask);
}

static void test_default_quick_mode_is_ask(void) {
    exec_approval_store_test_reset();
    g_assert_cmpint(exec_approval_store_get_quick_mode(), ==, OC_EXEC_QUICK_MODE_ASK);
}

static void test_round_trip_via_state_dir(void) {
    exec_approval_store_test_reset();
    g_autofree gchar *dir = make_tempdir("rt");
    g_assert_nonnull(dir);

    exec_approval_store_set_state_dir(dir);
    g_assert_cmpint(exec_approval_store_get_quick_mode(), ==, OC_EXEC_QUICK_MODE_ASK);

    g_assert_true(exec_approval_store_set_quick_mode(OC_EXEC_QUICK_MODE_DENY));
    g_autofree gchar *path = g_build_filename(dir, "exec-approvals.json", NULL);
    g_assert_true(g_file_test(path, G_FILE_TEST_EXISTS));
    assert_defaults_match(path, "deny", "off");

    g_assert_true(exec_approval_store_set_quick_mode(OC_EXEC_QUICK_MODE_ALLOW));
    assert_defaults_match(path, "full", "off");

    g_assert_true(exec_approval_store_set_quick_mode(OC_EXEC_QUICK_MODE_ASK));
    assert_defaults_match(path, "allowlist", "on-miss");

    /* Re-init to a fresh process state and verify reload. */
    exec_approval_store_test_reset();
    exec_approval_store_set_state_dir(dir);
    g_assert_cmpint(exec_approval_store_get_quick_mode(), ==, OC_EXEC_QUICK_MODE_ASK);

    /* Cleanup */
    g_unlink(path);
    g_rmdir(dir);
}

static void test_buffer_until_state_dir_is_known(void) {
    exec_approval_store_test_reset();
    g_autofree gchar *dir = make_tempdir("buf");
    g_assert_nonnull(dir);

    /* Operator toggles before the gateway client resolves the state dir. */
    g_assert_false(exec_approval_store_set_quick_mode(OC_EXEC_QUICK_MODE_DENY));
    /* In-memory cache reflects the choice. */
    g_assert_cmpint(exec_approval_store_get_quick_mode(), ==, OC_EXEC_QUICK_MODE_DENY);

    /* No file should have been written yet. */
    g_autofree gchar *path = g_build_filename(dir, "exec-approvals.json", NULL);
    g_assert_false(g_file_test(path, G_FILE_TEST_EXISTS));

    /* Once the state dir lands, the buffered value flushes to disk. */
    exec_approval_store_set_state_dir(dir);
    g_assert_true(g_file_test(path, G_FILE_TEST_EXISTS));
    assert_defaults_match(path, "deny", "off");

    g_unlink(path);
    g_rmdir(dir);
}

static void test_set_state_dir_reads_existing_file(void) {
    exec_approval_store_test_reset();
    g_autofree gchar *dir = make_tempdir("read");
    g_autofree gchar *path = g_build_filename(dir, "exec-approvals.json", NULL);

    /* Pre-seed an on-disk file with allow defaults. */
    const gchar *seed =
        "{\n"
        "  \"version\": 1,\n"
        "  \"defaults\": { \"security\": \"full\", \"ask\": \"off\" },\n"
        "  \"agents\": { \"keepme\": { \"security\": \"deny\" } }\n"
        "}\n";
    g_assert_true(g_file_set_contents(path, seed, -1, NULL));
    g_chmod(path, 0600);

    exec_approval_store_set_state_dir(dir);
    g_assert_cmpint(exec_approval_store_get_quick_mode(), ==, OC_EXEC_QUICK_MODE_ALLOW);

    /* Mutating the quick mode must preserve the agents subtree. */
    g_assert_true(exec_approval_store_set_quick_mode(OC_EXEC_QUICK_MODE_DENY));
    g_autofree gchar *contents = read_file_or_null(path);
    g_assert_nonnull(contents);
    g_assert_nonnull(strstr(contents, "\"keepme\""));

    g_unlink(path);
    g_rmdir(dir);
}

static void test_corrupt_file_falls_back_to_defaults(void) {
    exec_approval_store_test_reset();
    g_autofree gchar *dir = make_tempdir("corrupt");
    g_autofree gchar *path = g_build_filename(dir, "exec-approvals.json", NULL);
    g_assert_true(g_file_set_contents(path, "{ this is not json", -1, NULL));

    exec_approval_store_set_state_dir(dir);
    g_assert_cmpint(exec_approval_store_get_quick_mode(), ==, OC_EXEC_QUICK_MODE_ASK);

    /* And the next mutation should rewrite the file cleanly. */
    g_assert_true(exec_approval_store_set_quick_mode(OC_EXEC_QUICK_MODE_DENY));
    assert_defaults_match(path, "deny", "off");

    g_unlink(path);
    g_rmdir(dir);
}

static void test_file_permissions_are_0600(void) {
    exec_approval_store_test_reset();
    g_autofree gchar *dir = make_tempdir("perms");
    g_autofree gchar *path = g_build_filename(dir, "exec-approvals.json", NULL);

    exec_approval_store_set_state_dir(dir);
    g_assert_true(exec_approval_store_set_quick_mode(OC_EXEC_QUICK_MODE_DENY));

    struct stat st;
    g_assert_cmpint(g_stat(path, &st), ==, 0);
    /* Permission bits only — clear file-type bits. */
    g_assert_cmpint(st.st_mode & 0777, ==, 0600);

    g_unlink(path);
    g_rmdir(dir);
}

static void test_storage_path_override(void) {
    exec_approval_store_test_reset();
    g_autofree gchar *dir = make_tempdir("override");
    g_autofree gchar *path = g_build_filename(dir, "custom-approvals.json", NULL);

    exec_approval_store_test_set_storage_path(path);
    g_assert_cmpint(exec_approval_store_get_quick_mode(), ==, OC_EXEC_QUICK_MODE_ASK);
    g_assert_true(exec_approval_store_set_quick_mode(OC_EXEC_QUICK_MODE_ALLOW));
    assert_defaults_match(path, "full", "off");

    /* Clearing the override returns to state-dir-based resolution. */
    exec_approval_store_test_set_storage_path(NULL);
    g_unlink(path);
    g_rmdir(dir);
}

/*
 * Regression: switching from a state dir whose policy was ALLOW to a
 * state dir with no exec-approvals.json must NOT inherit ALLOW. The
 * store contract is "no valid file => ASK". This guards against a
 * release-blocking policy leak across profiles/state roots.
 */
static void test_switch_to_empty_state_dir_resets_to_ask(void) {
    exec_approval_store_test_reset();

    g_autofree gchar *dir_a = make_tempdir("switch-a");
    g_autofree gchar *dir_b = make_tempdir("switch-b");
    g_assert_nonnull(dir_a);
    g_assert_nonnull(dir_b);

    exec_approval_store_set_state_dir(dir_a);
    g_assert_true(exec_approval_store_set_quick_mode(OC_EXEC_QUICK_MODE_ALLOW));
    g_assert_cmpint(exec_approval_store_get_quick_mode(), ==, OC_EXEC_QUICK_MODE_ALLOW);

    /* dir_b has no exec-approvals.json. It must not inherit ALLOW. */
    exec_approval_store_set_state_dir(dir_b);
    g_assert_cmpint(exec_approval_store_get_quick_mode(), ==, OC_EXEC_QUICK_MODE_ASK);

    /* Switching back to dir_a must rediscover the ALLOW we wrote earlier. */
    exec_approval_store_set_state_dir(dir_a);
    g_assert_cmpint(exec_approval_store_get_quick_mode(), ==, OC_EXEC_QUICK_MODE_ALLOW);

    g_autofree gchar *path_a = g_build_filename(dir_a, "exec-approvals.json", NULL);
    g_unlink(path_a);
    g_rmdir(dir_a);
    g_rmdir(dir_b);
}

/*
 * Regression: corrupt-file fallback must reset to ASK even when the
 * store was previously loaded with ALLOW. The fallback must never
 * preserve the prior cached mode.
 */
static void test_corrupt_file_after_allow_falls_back_to_ask(void) {
    exec_approval_store_test_reset();

    g_autofree gchar *dir_a = make_tempdir("corrupt-prev");
    g_autofree gchar *dir_b = make_tempdir("corrupt-next");
    g_assert_nonnull(dir_a);
    g_assert_nonnull(dir_b);

    exec_approval_store_set_state_dir(dir_a);
    g_assert_true(exec_approval_store_set_quick_mode(OC_EXEC_QUICK_MODE_ALLOW));
    g_assert_cmpint(exec_approval_store_get_quick_mode(), ==, OC_EXEC_QUICK_MODE_ALLOW);

    g_autofree gchar *path_b = g_build_filename(dir_b, "exec-approvals.json", NULL);
    g_assert_true(g_file_set_contents(path_b, "{ not json", -1, NULL));

    exec_approval_store_set_state_dir(dir_b);
    g_assert_cmpint(exec_approval_store_get_quick_mode(), ==, OC_EXEC_QUICK_MODE_ASK);

    g_autofree gchar *path_a = g_build_filename(dir_a, "exec-approvals.json", NULL);
    g_unlink(path_a);
    g_unlink(path_b);
    g_rmdir(dir_a);
    g_rmdir(dir_b);
}

/*
 * Regression: a non-object JSON root (valid syntactically but wrong
 * shape, e.g. an array or a bare value) must also reset to ASK rather
 * than preserve a prior cached mode.
 */
static void test_non_object_root_falls_back_to_ask(void) {
    exec_approval_store_test_reset();

    g_autofree gchar *dir_a = make_tempdir("nonobj-prev");
    g_autofree gchar *dir_b = make_tempdir("nonobj-next");
    g_assert_nonnull(dir_a);
    g_assert_nonnull(dir_b);

    exec_approval_store_set_state_dir(dir_a);
    g_assert_true(exec_approval_store_set_quick_mode(OC_EXEC_QUICK_MODE_ALLOW));

    g_autofree gchar *path_b = g_build_filename(dir_b, "exec-approvals.json", NULL);
    /* Valid JSON, wrong shape. */
    g_assert_true(g_file_set_contents(path_b, "[\"not\", \"an\", \"object\"]", -1, NULL));

    exec_approval_store_set_state_dir(dir_b);
    g_assert_cmpint(exec_approval_store_get_quick_mode(), ==, OC_EXEC_QUICK_MODE_ASK);

    g_autofree gchar *path_a = g_build_filename(dir_a, "exec-approvals.json", NULL);
    g_unlink(path_a);
    g_unlink(path_b);
    g_rmdir(dir_a);
    g_rmdir(dir_b);
}

int main(int argc, char **argv) {
    g_test_init(&argc, &argv, NULL);
    /* The store emits g_warning for non-fatal disk-IO / parse failures
     * (corrupt file fallback, missing parent dir on first write). Don't
     * let those abort the test process. */
    g_log_set_always_fatal((GLogLevelFlags)(G_LOG_LEVEL_ERROR | G_LOG_LEVEL_CRITICAL));
    g_test_add_func("/exec_approval_store/default_is_ask",          test_default_quick_mode_is_ask);
    g_test_add_func("/exec_approval_store/round_trip",              test_round_trip_via_state_dir);
    g_test_add_func("/exec_approval_store/buffer_until_dir",        test_buffer_until_state_dir_is_known);
    g_test_add_func("/exec_approval_store/read_existing_file",      test_set_state_dir_reads_existing_file);
    g_test_add_func("/exec_approval_store/corrupt_file_fallback",   test_corrupt_file_falls_back_to_defaults);
    g_test_add_func("/exec_approval_store/file_perms_0600",         test_file_permissions_are_0600);
    g_test_add_func("/exec_approval_store/storage_path_override",   test_storage_path_override);
    g_test_add_func("/exec_approval_store/switch_to_empty_resets",  test_switch_to_empty_state_dir_resets_to_ask);
    g_test_add_func("/exec_approval_store/corrupt_after_allow_resets", test_corrupt_file_after_allow_falls_back_to_ask);
    g_test_add_func("/exec_approval_store/non_object_root_resets",  test_non_object_root_falls_back_to_ask);
    return g_test_run();
}
