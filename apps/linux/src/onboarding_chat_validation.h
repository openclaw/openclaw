/*
 * onboarding_chat_validation.h
 *
 * Pure chat-readiness model for the Linux onboarding validation page.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#pragma once

#include "readiness.h"

typedef enum {
    ONBOARDING_CHAT_VALIDATION_READY = 0,
    ONBOARDING_CHAT_VALIDATION_GATEWAY_STARTING,
    ONBOARDING_CHAT_VALIDATION_AUTH_REQUIRED,
    ONBOARDING_CHAT_VALIDATION_PAIRING_REQUIRED,
    ONBOARDING_CHAT_VALIDATION_PROVIDER_MISSING,
    ONBOARDING_CHAT_VALIDATION_MODEL_MISSING,
    ONBOARDING_CHAT_VALIDATION_CHAT_UNCONFIGURED,
    ONBOARDING_CHAT_VALIDATION_UNKNOWN,
} OnboardingChatValidationStatus;

OnboardingChatValidationStatus onboarding_chat_validation_status(AppState state,
                                                                 const ChatGateInfo *gate,
                                                                 const SystemdState *sys);
const char* onboarding_chat_validation_title(OnboardingChatValidationStatus status);

