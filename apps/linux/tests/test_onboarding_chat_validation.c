/*
 * test_onboarding_chat_validation.c
 *
 * Headless tests for Linux onboarding chat-readiness mapping.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "../src/onboarding_chat_validation.h"

#include <glib.h>

static void test_ready(void) {
    ChatGateInfo gate = { .ready = TRUE };
    g_assert_cmpint(onboarding_chat_validation_status(STATE_RUNNING, &gate, NULL),
                    ==, ONBOARDING_CHAT_VALIDATION_READY);
}

static void test_provider_missing(void) {
    ChatGateInfo gate = { .ready = FALSE, .reason = CHAT_BLOCK_PROVIDER_MISSING };
    g_assert_cmpint(onboarding_chat_validation_status(STATE_RUNNING, &gate, NULL),
                    ==, ONBOARDING_CHAT_VALIDATION_PROVIDER_MISSING);
}

static void test_model_missing(void) {
    ChatGateInfo gate = { .ready = FALSE, .reason = CHAT_BLOCK_SELECTED_MODEL_UNRESOLVED };
    g_assert_cmpint(onboarding_chat_validation_status(STATE_RUNNING, &gate, NULL),
                    ==, ONBOARDING_CHAT_VALIDATION_MODEL_MISSING);
}

static void test_chat_unconfigured(void) {
    ChatGateInfo gate = { .ready = FALSE, .reason = CHAT_BLOCK_BOOTSTRAP_INCOMPLETE };
    g_assert_cmpint(onboarding_chat_validation_status(STATE_NEEDS_ONBOARDING, &gate, NULL),
                    ==, ONBOARDING_CHAT_VALIDATION_CHAT_UNCONFIGURED);
}

static void test_starting(void) {
    ChatGateInfo gate = { .ready = FALSE, .reason = CHAT_BLOCK_GATEWAY_UNREACHABLE };
    SystemdState sys = { .activating = TRUE };
    g_assert_cmpint(onboarding_chat_validation_status(STATE_STARTING, &gate, &sys),
                    ==, ONBOARDING_CHAT_VALIDATION_GATEWAY_STARTING);
}

int main(int argc, char **argv) {
    g_test_init(&argc, &argv, NULL);
    g_test_add_func("/onboarding/chat_validation/ready", test_ready);
    g_test_add_func("/onboarding/chat_validation/provider_missing", test_provider_missing);
    g_test_add_func("/onboarding/chat_validation/model_missing", test_model_missing);
    g_test_add_func("/onboarding/chat_validation/chat_unconfigured", test_chat_unconfigured);
    g_test_add_func("/onboarding/chat_validation/starting", test_starting);
    return g_test_run();
}

