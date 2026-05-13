/*
 * onboarding_wizard.h
 *
 * RPC-backed setup-wizard model for Linux onboarding.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#pragma once

#include <glib.h>
#include <json-glib/json-glib.h>

typedef enum {
    ONBOARDING_WIZARD_STATUS_IDLE,
    ONBOARDING_WIZARD_STATUS_RUNNING,
    ONBOARDING_WIZARD_STATUS_DONE,
    ONBOARDING_WIZARD_STATUS_CANCELLED,
    ONBOARDING_WIZARD_STATUS_ERROR,
} OnboardingWizardStatus;

typedef struct _OnboardingWizardModel OnboardingWizardModel;

typedef void (*OnboardingWizardChangedCallback)(OnboardingWizardModel *model,
                                                gpointer user_data);

OnboardingWizardModel* onboarding_wizard_model_new(OnboardingWizardChangedCallback callback,
                                                   gpointer user_data);
void onboarding_wizard_model_free(OnboardingWizardModel *model);
void onboarding_wizard_start(OnboardingWizardModel *model, const gchar *mode);
void onboarding_wizard_submit(OnboardingWizardModel *model, JsonNode *value);
void onboarding_wizard_cancel(OnboardingWizardModel *model);

OnboardingWizardStatus onboarding_wizard_get_status(const OnboardingWizardModel *model);
const gchar* onboarding_wizard_get_error(const OnboardingWizardModel *model);
const gchar* onboarding_wizard_get_session_id(const OnboardingWizardModel *model);
JsonObject* onboarding_wizard_get_step(const OnboardingWizardModel *model);
gboolean onboarding_wizard_is_busy(const OnboardingWizardModel *model);

gboolean onboarding_wizard_should_skip_for_health(gboolean has_wizard_onboard_marker);

