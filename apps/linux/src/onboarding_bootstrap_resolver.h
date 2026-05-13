/*
 * onboarding_bootstrap_resolver.h
 *
 * Public resolver API for Linux onboarding bootstrap commands.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#pragma once

#include <glib.h>

typedef enum {
    ONBOARDING_BOOTSTRAP_RESOLUTION_OPENCLAW_PATH = 0,
    ONBOARDING_BOOTSTRAP_RESOLUTION_DEV_TREE = 1,
    ONBOARDING_BOOTSTRAP_RESOLUTION_MISSING = 2,
} OnboardingBootstrapResolutionKind;

typedef enum {
    ONBOARDING_BOOTSTRAP_STEP_SETUP = 0,
    ONBOARDING_BOOTSTRAP_STEP_GATEWAY_INSTALL = 1,
} OnboardingBootstrapStep;

typedef struct {
    OnboardingBootstrapResolutionKind kind;
    gchar *repo_root;
    gchar *missing_reason;
    gchar **setup_argv;
    gchar **gateway_install_argv;
    gboolean uses_shell;
} OnboardingBootstrapResolution;

typedef gchar* (*OnboardingBootstrapFindProgramFunc)(const gchar *program);
typedef gchar* (*OnboardingBootstrapPathFunc)(void);

gboolean onboarding_bootstrap_resolve_commands(OnboardingBootstrapResolution *out);
gchar** onboarding_bootstrap_resolution_dup_argv(const OnboardingBootstrapResolution *resolution,
                                                 OnboardingBootstrapStep step);
void onboarding_bootstrap_resolution_clear(OnboardingBootstrapResolution *resolution);

void onboarding_bootstrap_resolver_set_test_hooks(OnboardingBootstrapFindProgramFunc find_program,
                                                  OnboardingBootstrapPathFunc executable_path,
                                                  OnboardingBootstrapPathFunc current_dir);

