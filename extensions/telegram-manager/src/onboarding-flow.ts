// Onboarding flow facade (OP-167, Phase 2).
// The transition table is owned by provisioning-states.ts; the drive loop by
// provisioning-orchestrator.ts. This module only names the user-visible steps
// so the manager bot and docs share one vocabulary without a second owner.
// (No re-exports: api.ts already exports the state/transition owners.)

import type { ProvisioningState } from "./provisioning-states.js";

/** User-visible step labels in flow order (READY/FAILED terminal). */
export const ONBOARDING_STEPS = [
  "REQUESTED",
  "CREATING_BOT",
  "BOT_CREATED",
  "CREATING_SERVER",
  "SERVER_CREATED",
  "INSTALLING_OPENCLAW",
  "CONFIGURING_OPENCLAW",
  "VERIFYING",
  "READY",
] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export function isOnboardingStep(value: string): value is OnboardingStep {
  return (ONBOARDING_STEPS as readonly string[]).includes(value);
}

export function describeOnboardingStep(step: OnboardingStep | ProvisioningState): string {
  switch (step) {
    case "REQUESTED":
      return "Request received — starting bot creation.";
    case "CREATING_BOT":
      return "Creating your Telegram bot via MTProto managed bots.";
    case "BOT_CREATED":
      return "Bot created — provisioning your server.";
    case "CREATING_SERVER":
      return "Creating your Hetzner server.";
    case "SERVER_CREATED":
      return "Server online — installing OpenClaw.";
    case "INSTALLING_OPENCLAW":
      return "Installing Docker + OpenClaw (cloud-init).";
    case "CONFIGURING_OPENCLAW":
      return "Configuring your bot token and gateway.";
    case "VERIFYING":
      return "Verifying the gateway health check.";
    case "READY":
      return "Ready — your bot is live.";
    case "FAILED":
      return "Failed — send /install to retry.";
  }
}
