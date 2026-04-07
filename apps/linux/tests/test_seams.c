/*
 * test_seams.c
 *
 * Tests for pure helper functions in test_seams.c.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include <glib.h>
#include <string.h>
#include "../src/test_seams.h"

/* ── Ancestor Walk Tests (Task 10) ── */

static void test_ancestor_walk_existing_dir(void) {
    gchar *res = find_nearest_existing_ancestor("/tmp");
    g_assert_cmpstr(res, ==, "/tmp");
    g_free(res);
}

static void test_ancestor_walk_nonexistent_child(void) {
    gchar *path = g_strdup_printf("/tmp/openclaw_test_nonexistent_%d/foo/bar", g_random_int());
    gchar *res = find_nearest_existing_ancestor(path);
    g_assert_cmpstr(res, ==, "/tmp");
    g_free(res);
    g_free(path);
}

static void test_ancestor_walk_root(void) {
    gchar *res = find_nearest_existing_ancestor("/");
    g_assert_cmpstr(res, ==, "/");
    g_free(res);
}

static void test_ancestor_walk_null_or_empty(void) {
    gchar *res1 = find_nearest_existing_ancestor(NULL);
    g_assert_null(res1);
    
    gchar *res2 = find_nearest_existing_ancestor("");
    g_assert_null(res2);
}

/* ── Config Monitor Rearm Skip Tests (Task 10) ── */

static void test_monitor_skip_same_paths_all_monitors_exist(void) {
    gboolean skip = config_monitor_can_skip_rearm(
        "/etc/openclaw", "/etc/openclaw",
        "/etc/openclaw/config.json", "/etc/openclaw/config.json",
        TRUE, TRUE, TRUE);
    g_assert_true(skip);
}

static void test_monitor_skip_dir_changed(void) {
    gboolean skip = config_monitor_can_skip_rearm(
        "/new/dir", "/old/dir",
        "/new/dir/config.json", "/old/dir/config.json",
        TRUE, TRUE, TRUE);
    g_assert_false(skip);
}

static void test_monitor_skip_file_monitor_needed_but_missing(void) {
    gboolean skip = config_monitor_can_skip_rearm(
        "/etc/openclaw", "/etc/openclaw",
        "/etc/openclaw/config.json", "/etc/openclaw/config.json",
        TRUE, TRUE, FALSE); /* Need file monitor, but don't have it */
    g_assert_false(skip);
}

static void test_monitor_skip_file_monitor_not_needed_but_exists(void) {
    gboolean skip = config_monitor_can_skip_rearm(
        "/etc/openclaw", "/etc/openclaw",
        "/etc/openclaw/config.json", "/etc/openclaw/config.json",
        TRUE, FALSE, TRUE); /* Don't need file monitor, but have it */
    g_assert_false(skip);
}

int main(int argc, char **argv) {
    g_test_init(&argc, &argv, NULL);

    /* Ancestor Walk Tests */
    g_test_add_func("/seams/ancestor_walk/existing_dir", test_ancestor_walk_existing_dir);
    g_test_add_func("/seams/ancestor_walk/nonexistent_child", test_ancestor_walk_nonexistent_child);
    g_test_add_func("/seams/ancestor_walk/root", test_ancestor_walk_root);
    g_test_add_func("/seams/ancestor_walk/null_or_empty", test_ancestor_walk_null_or_empty);

    /* Config Monitor Rearm Skip Tests */
    g_test_add_func("/seams/monitor_skip/same_paths", test_monitor_skip_same_paths_all_monitors_exist);
    g_test_add_func("/seams/monitor_skip/dir_changed", test_monitor_skip_dir_changed);
    g_test_add_func("/seams/monitor_skip/file_monitor_needed_but_missing", test_monitor_skip_file_monitor_needed_but_missing);
    g_test_add_func("/seams/monitor_skip/file_monitor_not_needed_but_exists", test_monitor_skip_file_monitor_not_needed_but_exists);

    return g_test_run();
}
