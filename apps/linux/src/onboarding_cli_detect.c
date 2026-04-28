/*
 * onboarding_cli_detect.c
 *
 * Detects whether the OpenClaw CLI is directly available on PATH.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "onboarding_cli_detect.h"

static OnboardingCliFindProgramFunc test_find_program = NULL;

void onboarding_cli_detect_set_test_hook(OnboardingCliFindProgramFunc find_program) {
    test_find_program = find_program;
}

gboolean onboarding_cli_is_present(void) {
    OnboardingCliFindProgramFunc find_program = test_find_program ? test_find_program : g_find_program_in_path;
    g_autofree gchar *path = find_program("openclaw");
    return path != NULL;
}

