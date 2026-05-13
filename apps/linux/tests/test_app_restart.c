/*
 * test_app_restart.c
 *
 * Hermetic regression for the `Restart App` argv builder. The actual
 * spawn path is intentionally NOT exercised here — adding a process-
 * spawning seam to the production module would create a foot-gun
 * larger than the tested behavior. Instead this suite locks down the
 * argv shape so a future refactor cannot silently change the relaunch
 * contract.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include <glib.h>
#include <string.h>

#include "../src/app_restart.h"

static void test_argv_builder_rejects_null_self(void) {
    g_assert_null(app_restart_build_argv_for_test(NULL));
    g_assert_null(app_restart_build_argv_for_test(""));
}

static void test_argv_builder_emits_sh_dash_c_form(void) {
    g_auto(GStrv) argv = app_restart_build_argv_for_test("/usr/local/bin/openclaw-linux");
    g_assert_nonnull(argv);
    g_assert_cmpuint(g_strv_length(argv), ==, 5u);
    g_assert_cmpstr(argv[0], ==, "/bin/sh");
    g_assert_cmpstr(argv[1], ==, "-c");
    g_assert_cmpstr(argv[3], ==, "sh");
    g_assert_cmpstr(argv[4], ==, "/usr/local/bin/openclaw-linux");
    g_assert_null(argv[5]);
}

static void test_argv_builder_script_contains_sleep_and_exec(void) {
    g_auto(GStrv) argv = app_restart_build_argv_for_test("/opt/openclaw/openclaw-linux");
    g_assert_nonnull(argv);
    g_assert_nonnull(strstr(argv[2], "sleep "));
    g_assert_nonnull(strstr(argv[2], "exec \"$1\""));
}

static void test_argv_builder_passes_self_path_as_dollar_one(void) {
    /* The shell snippet uses exec "$1", so the self path MUST be
     * argv[4] (i.e. shell positional $1, after argv[3] = "sh"/$0). */
    g_auto(GStrv) argv = app_restart_build_argv_for_test("/tmp/my-build/openclaw-linux");
    g_assert_nonnull(argv);
    g_assert_cmpstr(argv[4], ==, "/tmp/my-build/openclaw-linux");
}

int main(int argc, char **argv) {
    g_test_init(&argc, &argv, NULL);

    g_test_add_func("/app_restart/argv_builder_rejects_null_self",
                    test_argv_builder_rejects_null_self);
    g_test_add_func("/app_restart/argv_builder_emits_sh_dash_c_form",
                    test_argv_builder_emits_sh_dash_c_form);
    g_test_add_func("/app_restart/argv_builder_script_contains_sleep_and_exec",
                    test_argv_builder_script_contains_sleep_and_exec);
    g_test_add_func("/app_restart/argv_builder_passes_self_path_as_dollar_one",
                    test_argv_builder_passes_self_path_as_dollar_one);

    return g_test_run();
}
