/*
 * test_onboarding_cli_detect.c
 *
 * Headless tests for Linux onboarding CLI detection.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "../src/onboarding_cli_detect.h"

#include <glib.h>

static gchar *fake_openclaw = NULL;

static gchar* fake_find_program(const gchar *program) {
    if (g_strcmp0(program, "openclaw") == 0 && fake_openclaw) {
        return g_strdup(fake_openclaw);
    }
    return NULL;
}

static void test_cli_present(void) {
    onboarding_cli_detect_set_test_hook(fake_find_program);
    fake_openclaw = g_strdup("/usr/local/bin/openclaw");
    g_assert_true(onboarding_cli_is_present());
    g_clear_pointer(&fake_openclaw, g_free);
}

static void test_cli_missing(void) {
    onboarding_cli_detect_set_test_hook(fake_find_program);
    g_clear_pointer(&fake_openclaw, g_free);
    g_assert_false(onboarding_cli_is_present());
}

int main(int argc, char **argv) {
    g_test_init(&argc, &argv, NULL);
    g_test_add_func("/onboarding/cli_detect/present", test_cli_present);
    g_test_add_func("/onboarding/cli_detect/missing", test_cli_missing);
    return g_test_run();
}

