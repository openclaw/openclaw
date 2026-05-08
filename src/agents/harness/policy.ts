import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveModelRuntimePolicy } from "../model-runtime-policy.js";
import {
  isOpenAICodexProvider,
  openAIProviderUsesCodexRuntimeByDefault,
  openAIProviderUsesPiRuntimeForDirectAuthProfile,
} from "../openai-codex-routing.js";
import {
  normalizeEmbeddedAgentRuntime,
  type EmbeddedAgentRuntime,
} from "../pi-embedded-runner/runtime.js";

export type AgentHarnessPolicy = {
  runtime: EmbeddedAgentRuntime;
  runtimeSource?: "model" | "provider" | "implicit";
};

export function resolveAgentHarnessPolicy(params: {
  provider?: string;
  modelId?: string;
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  authProfileId?: string;
  authProfileProvider?: string;
  env?: NodeJS.ProcessEnv;
}): AgentHarnessPolicy {
  const configured = resolveModelRuntimePolicy({
    config: params.config,
    provider: params.provider,
    modelId: params.modelId,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
  const configuredRuntime = configured.policy?.id?.trim();
  const runtimeSource = configured.source ?? "implicit";
  const runtime =
    configuredRuntime && configuredRuntime !== "default"
      ? normalizeEmbeddedAgentRuntime(configuredRuntime)
      : "auto";
  if (
    openAIProviderUsesPiRuntimeForDirectAuthProfile({
      provider: params.provider,
      config: params.config,
      authProfileId: params.authProfileId,
      authProfileProvider: params.authProfileProvider,
    })
  ) {
    if (runtime === "auto") {
      return { runtime: "pi", runtimeSource };
    }
    return { runtime, runtimeSource };
  }
  if (
    openAIProviderUsesCodexRuntimeByDefault({
      provider: params.provider,
      config: params.config,
      authProfileId: params.authProfileId,
      authProfileProvider: params.authProfileProvider,
    })
  ) {
    if (runtime === "auto") {
      return { runtime: "codex", runtimeSource };
    }
    return { runtime, runtimeSource };
  }
  if (isOpenAICodexProvider(params.provider)) {
    if (runtime === "auto") {
      return { runtime: "codex", runtimeSource };
    }
    return { runtime, runtimeSource };
  }
  return {
    runtime,
    runtimeSource,
  };
}
