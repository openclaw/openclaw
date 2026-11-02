import {
  hasRememberedNativeRuntimeConsent,
  rememberNativeRuntimeConsent,
} from "../../config/native-runtime-consent.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { WizardPrompter } from "../../wizard/prompts.js";
import type { AgentHarness } from "./types.js";

/** Prepare consent with setup; only the setup owner's successful commit persists it. */
export async function requestNativeRuntimeConsent(params: {
  config: OpenClawConfig;
  agentId: string;
  harness: Pick<AgentHarness, "id" | "label" | "executionEnvironment">;
  prompter?: WizardPrompter;
  assertCurrent?: () => void;
}): Promise<OpenClawConfig> {
  const { config, agentId, harness, prompter } = params;
  params.assertCurrent?.();
  if (
    harness.executionEnvironment !== "host-only" ||
    hasRememberedNativeRuntimeConsent(config, agentId, harness.id) ||
    !prompter
  ) {
    return config;
  }
  const agentName = config.agents?.entries?.[agentId]?.name ?? agentId;
  await prompter.select({
    message: `Use ${harness.label}’s native permissions?\n\n${harness.label} will run on the Gateway host under its own permissions. OpenClaw’s optional native tool and sandbox restrictions, including workspace-only restrictions, will not be enforced for this harness. OpenClaw-hosted tools keep their own policy checks.\n\nRemember this choice for ${agentName}. New chats using ${harness.label} will use Full access with sandbox off.`,
    options: [{ value: "continue", label: "Continue" }],
  });
  params.assertCurrent?.();
  return rememberNativeRuntimeConsent(config, agentId, harness.id);
}
