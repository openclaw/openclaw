/*
 * onboarding_chat_validation.c
 *
 * Maps companion readiness state into onboarding chat-validation copy.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "onboarding_chat_validation.h"

OnboardingChatValidationStatus onboarding_chat_validation_status(AppState state,
                                                                 const ChatGateInfo *gate,
                                                                 const SystemdState *sys) {
    if (gate && gate->ready) {
        return ONBOARDING_CHAT_VALIDATION_READY;
    }
    if (sys && sys->activating) {
        return ONBOARDING_CHAT_VALIDATION_GATEWAY_STARTING;
    }
    if (state == STATE_STARTING || state == STATE_STOPPING) {
        return ONBOARDING_CHAT_VALIDATION_GATEWAY_STARTING;
    }
    if (!gate) {
        return ONBOARDING_CHAT_VALIDATION_UNKNOWN;
    }
    switch (gate->reason) {
    case CHAT_BLOCK_NO_CONFIG:
    case CHAT_BLOCK_CONFIG_INVALID:
    case CHAT_BLOCK_BOOTSTRAP_INCOMPLETE:
    case CHAT_BLOCK_SERVICE_INACTIVE:
    case CHAT_BLOCK_GATEWAY_UNREACHABLE:
        return ONBOARDING_CHAT_VALIDATION_CHAT_UNCONFIGURED;
    case CHAT_BLOCK_AUTH_INVALID:
        return ONBOARDING_CHAT_VALIDATION_AUTH_REQUIRED;
    case CHAT_BLOCK_PROVIDER_MISSING:
        return ONBOARDING_CHAT_VALIDATION_PROVIDER_MISSING;
    case CHAT_BLOCK_DEFAULT_MODEL_MISSING:
    case CHAT_BLOCK_MODEL_CATALOG_EMPTY:
    case CHAT_BLOCK_SELECTED_MODEL_UNRESOLVED:
        return ONBOARDING_CHAT_VALIDATION_MODEL_MISSING;
    case CHAT_BLOCK_AGENTS_UNAVAILABLE:
    case CHAT_BLOCK_UNKNOWN:
        return ONBOARDING_CHAT_VALIDATION_UNKNOWN;
    case CHAT_BLOCK_NONE:
    default:
        return ONBOARDING_CHAT_VALIDATION_UNKNOWN;
    }
}

const char* onboarding_chat_validation_title(OnboardingChatValidationStatus status) {
    switch (status) {
    case ONBOARDING_CHAT_VALIDATION_READY:
        return "Chat is ready";
    case ONBOARDING_CHAT_VALIDATION_GATEWAY_STARTING:
        return "Gateway is starting";
    case ONBOARDING_CHAT_VALIDATION_AUTH_REQUIRED:
        return "Gateway authentication needs attention";
    case ONBOARDING_CHAT_VALIDATION_PAIRING_REQUIRED:
        return "Pairing is required";
    case ONBOARDING_CHAT_VALIDATION_PROVIDER_MISSING:
        return "Provider setup needed";
    case ONBOARDING_CHAT_VALIDATION_MODEL_MISSING:
        return "Model setup needed";
    case ONBOARDING_CHAT_VALIDATION_CHAT_UNCONFIGURED:
        return "Chat is not configured yet";
    case ONBOARDING_CHAT_VALIDATION_UNKNOWN:
    default:
        return "Chat status unknown";
    }
}

