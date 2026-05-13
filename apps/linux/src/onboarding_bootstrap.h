/*
 * onboarding_bootstrap.h
 *
 * Subprocess runner API for Linux onboarding bootstrap commands.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#pragma once

#include <gio/gio.h>
#include <glib.h>

#include "onboarding_bootstrap_resolver.h"

typedef enum {
    ONBOARDING_BOOTSTRAP_EVENT_STARTED,
    ONBOARDING_BOOTSTRAP_EVENT_OUTPUT,
    ONBOARDING_BOOTSTRAP_EVENT_DONE,
    ONBOARDING_BOOTSTRAP_EVENT_ERROR,
    ONBOARDING_BOOTSTRAP_EVENT_CANCELLED,
} OnboardingBootstrapEventKind;

typedef struct {
    OnboardingBootstrapEventKind kind;
    gint exit_code;
    const gchar *output;
    const gchar *message;
} OnboardingBootstrapEvent;

typedef void (*OnboardingBootstrapCallback)(const OnboardingBootstrapEvent *event,
                                            gpointer user_data);

typedef struct _OnboardingBootstrapRun OnboardingBootstrapRun;

OnboardingBootstrapRun* onboarding_bootstrap_run_step(OnboardingBootstrapStep step,
                                                      OnboardingBootstrapCallback callback,
                                                      gpointer user_data);
void onboarding_bootstrap_run_cancel(OnboardingBootstrapRun *run);
void onboarding_bootstrap_run_free(OnboardingBootstrapRun *run);

typedef struct {
    gboolean spawn_ok;
    const gchar *spawn_error;
    const gchar * const *stdout_lines;
    const gchar * const *stderr_lines;
    gboolean wait_ok;
    gint exit_code;
    gboolean complete_immediately;
} OnboardingBootstrapTestSpawnResult;

typedef gboolean (*OnboardingBootstrapSpawnerForTest)(const gchar * const *argv,
                                                      OnboardingBootstrapTestSpawnResult *out,
                                                      gpointer user_data);

void onboarding_bootstrap_set_spawner_for_test(OnboardingBootstrapSpawnerForTest spawner,
                                               gpointer user_data);
void onboarding_bootstrap_test_complete_pending(void);
void onboarding_bootstrap_test_timeout_pending(void);
gboolean onboarding_bootstrap_test_force_exit_was_scheduled(void);

