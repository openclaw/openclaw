/*
 * readiness.h
 *
 * Readiness presentation for the OpenClaw Linux Companion App.
 *
 * Derives user-facing readiness information (classification, missing
 * prerequisites, next recommended action) from the canonical AppState
 * and supporting context. This module consumes the state derivation
 * result — it does NOT introduce a second decision table.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#ifndef OPENCLAW_LINUX_READINESS_H
#define OPENCLAW_LINUX_READINESS_H

#include "state.h"

typedef struct {
    const char *classification;  /* e.g. "Fully Ready", "Setup Required" */
    const char *missing;         /* missing prerequisite(s), or NULL */
    const char *next_action;     /* next recommended action, or NULL */
} ReadinessInfo;

typedef enum {
    ONBOARDING_STAGE_PENDING = 0,
    ONBOARDING_STAGE_IN_PROGRESS,
    ONBOARDING_STAGE_COMPLETE,
} OnboardingStageState;

typedef struct {
    OnboardingStageState configuration;
    OnboardingStageState service_gateway;
    OnboardingStageState connection;
    gboolean operational_ready;
} OnboardingStageProgress;

typedef struct {
    gboolean ready;
    ChatBlockReason reason;
    const char *status;
    const char *next_action;
} ChatGateInfo;

void readiness_evaluate(AppState state, const HealthState *health,
                        const SystemdState *sys, ReadinessInfo *out);

void readiness_build_onboarding_progress(AppState state,
                                         const HealthState *health,
                                         const SystemdState *sys,
                                         OnboardingStageProgress *out);

const char* readiness_chat_block_reason_to_string(ChatBlockReason reason);
void readiness_describe_chat_gate(const DesktopReadinessSnapshot *snapshot,
                                  ChatGateInfo *out);

#endif /* OPENCLAW_LINUX_READINESS_H */
