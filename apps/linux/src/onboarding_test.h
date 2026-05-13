/*
 * onboarding_test.h
 *
 * Internal test seam for the OpenClaw Linux onboarding controller.
 *
 * Declares the narrow UI-hook override used by `onboarding.c` and the
 * headless onboarding controller tests. This header is intentionally
 * test-only and is not part of the public onboarding API.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#pragma once

#include "onboarding_view.h"

typedef struct {
    gpointer (*get_default_application)(void);
    gpointer (*build_and_present_window)(gpointer app,
                                         OnboardingRoute route,
                                         const OnboardingViewCallbacks *callbacks,
                                         GCallback destroy_callback,
                                         gpointer destroy_user_data,
                                         gpointer *out_carousel,
                                         gpointer *out_indicator);
    void (*present_window)(gpointer window);
    void (*destroy_window)(gpointer window);
    void (*rebuild_pages)(gpointer carousel,
                          OnboardingRoute route,
                          const OnboardingViewCallbacks *callbacks);
    void (*refresh_live_content)(void);
    void (*reset_view)(void);
} OnboardingTestUiHooks;

void onboarding_test_set_ui_hooks(const OnboardingTestUiHooks *hooks);
void onboarding_test_reset(void);
