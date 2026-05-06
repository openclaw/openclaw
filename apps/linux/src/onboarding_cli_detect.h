/*
 * onboarding_cli_detect.h
 *
 * Small probe surface for detecting the OpenClaw CLI during Linux onboarding.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#pragma once

#include <glib.h>

typedef gchar* (*OnboardingCliFindProgramFunc)(const gchar *program);

gboolean onboarding_cli_is_present(void);
void onboarding_cli_detect_set_test_hook(OnboardingCliFindProgramFunc find_program);

