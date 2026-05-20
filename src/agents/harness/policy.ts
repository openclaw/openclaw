import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveAgentConfig } from "../agent-scope-config.js";
import { resolveSessionAgentIds } from "../agent-scope.js";
import { resolveModelRuntimePolicy } from "../model-runtime-policy.js";
import {
  isOpenAICodexProvider,
  openAIProviderUsesCodexRuntimeByDefault,
} from "../openai-codex-routing.js";
import {
  normalizeEmbeddedAgentRuntime,
  type EmbeddedAgentRuntime,
} from "../pi-embedded-runner/runtime.js";

export type AgentHarnessPolicy = {
  runtime: EmbeddedAgentRuntime;
  runtimeSource?: "model" | "provider" | "implicit";
};

function normalizeExecPlacementHost(
  value: unknown,
): "auto" | "gateway" | "node" | "sandbox" | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "auto" ||
    normalized === "gateway" ||
    normalized === "node" ||
    normalized === "sandbox"
    ? normalized
    : undefined;
}

function resolveConfiguredExecHost(params: {
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  execHost?: string;
}): "auto" | "gateway" | "node" | "sandbox" | undefined {
  const overrideHost = normalizeExecPlacementHost(params.execHost);
  if (overrideHost) {
    return overrideHost;
  }
  const resolvedAgentId = params.config
    ? resolveSessionAgentIds({
        config: params.config,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
      }).sessionAgentId
    : params.agentId;
  const agentHost =
    params.config && resolvedAgentId
      ? normalizeExecPlacementHost(
          resolveAgentConfig(params.config, resolvedAgentId)?.tools?.exec?.host,
        )
      : undefined;
  return agentHost ?? normalizeExecPlacementHost(params.config?.tools?.exec?.host);
}

function shouldUsePiForOpenClawManagedExecPlacement(params: {
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  execHost?: string;
}): boolean {
  const host = resolveConfiguredExecHost(params);
  return host === "node" || host === "sandbox";
}

export function resolveAgentHarnessPolicy(params: {
  provider?: string;
  modelId?: string;
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  execHost?: string;
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
    openAIProviderUsesCodexRuntimeByDefault({ provider: params.provider, config: params.config })
  ) {
    if (runtime === "auto") {
      if (
        shouldUsePiForOpenClawManagedExecPlacement({
          config: params.config,
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          execHost: params.execHost,
        })
      ) {
        return { runtime: "pi", runtimeSource };
      }
      return { runtime: "codex", runtimeSource };
    }
    return { runtime, runtimeSource };
  }
  if (isOpenAICodexProvider(params.provider)) {
    if (runtime === "auto") {
      if (
        shouldUsePiForOpenClawManagedExecPlacement({
          config: params.config,
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          execHost: params.execHost,
        })
      ) {
        return { runtime: "pi", runtimeSource };
      }
      return { runtime: "codex", runtimeSource };
    }
    return { runtime, runtimeSource };
  }
  return {
    runtime,
    runtimeSource,
  };
}
