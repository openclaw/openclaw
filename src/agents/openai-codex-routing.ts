import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeEmbeddedAgentRuntime } from "./pi-embedded-runner/runtime.js";
import { resolveProviderIdForAuth } from "./provider-auth-aliases.js";
import { findNormalizedProviderValue } from "./provider-id.js";
export {
  OPENAI_CODEX_PROVIDER_ID,
  OPENAI_PROVIDER_ID,
  hasOpenAICodexAuthProfileOverride,
  isOpenAICodexProvider,
  isOpenAIProvider,
  modelRefUsesOpenAIProvider,
  modelSelectionShouldEnsureCodexPlugin,
  openAIProviderUsesCodexRuntimeByDefault,
  parseModelRefProvider,
  resolveContextConfigProviderForRuntime,
} from "./openai-codex-runtime-ids.js";
import {
  OPENAI_CODEX_PROVIDER_ID,
  OPENAI_PROVIDER_ID,
  hasOpenAICodexAuthProfileOverride,
  isOpenAIProvider,
  openAIProviderUsesCodexRuntimeByDefault,
} from "./openai-codex-runtime-ids.js";

function configuredOpenAIAuthOrderStartsWithCodexProfile(config: OpenClawConfig | undefined) {
  if (!openAIProviderUsesCodexRuntimeByDefault({ provider: OPENAI_PROVIDER_ID, config })) {
    return false;
  }
  const configuredOpenAIOrder = findNormalizedProviderValue(
    config?.auth?.order,
    OPENAI_PROVIDER_ID,
  );
  const firstProfile = configuredOpenAIOrder?.find(
    (profileId) => typeof profileId === "string" && profileId.trim().length > 0,
  );
  return hasOpenAICodexAuthProfileOverride(firstProfile);
}

export function shouldRouteOpenAIPiThroughCodexAuthProvider(params: {
  provider: string;
  harnessRuntime?: string;
  agentHarnessId?: string;
  authProfileProvider?: string;
  authProfileId?: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
}): boolean {
  if (!isOpenAIProvider(params.provider)) {
    return false;
  }
  const runtime = normalizeEmbeddedAgentRuntime(params.agentHarnessId ?? params.harnessRuntime);
  if (runtime !== "pi") {
    return false;
  }
  if (!hasOpenAICodexAuthProfileOverride(params.authProfileId)) {
    return false;
  }
  const aliasLookupParams = {
    config: params.config,
    workspaceDir: params.workspaceDir,
  };
  const authProfileProvider = resolveProviderIdForAuth(
    params.authProfileProvider ?? params.authProfileId?.split(":", 1)[0] ?? "",
    aliasLookupParams,
  );
  return authProfileProvider === OPENAI_CODEX_PROVIDER_ID;
}

export function listOpenAIAuthProfileProvidersForAgentRuntime(params: {
  provider: string;
  harnessRuntime?: string;
  agentHarnessId?: string;
  config?: OpenClawConfig;
}): string[] {
  if (!isOpenAIProvider(params.provider)) {
    return [params.provider];
  }
  const runtime = normalizeEmbeddedAgentRuntime(
    normalizeExplicitRuntimePin(params.agentHarnessId) ?? params.harnessRuntime,
  );
  if (runtime === "codex") {
    return [OPENAI_CODEX_PROVIDER_ID];
  }
  if (runtime === "pi") {
    if (configuredOpenAIAuthOrderStartsWithCodexProfile(params.config)) {
      return [OPENAI_CODEX_PROVIDER_ID, OPENAI_PROVIDER_ID];
    }
    return [OPENAI_PROVIDER_ID, OPENAI_CODEX_PROVIDER_ID];
  }
  return [params.provider];
}

function normalizeExplicitRuntimePin(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const runtime = normalizeEmbeddedAgentRuntime(value);
  return runtime === "auto" || runtime === "default" ? undefined : runtime;
}

export function resolveOpenAIRuntimeProviderForPi(params: {
  provider: string;
  harnessRuntime?: string;
  agentHarnessId?: string;
  authProfileProvider?: string;
  authProfileId?: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
}): string {
  return shouldRouteOpenAIPiThroughCodexAuthProvider(params)
    ? OPENAI_CODEX_PROVIDER_ID
    : params.provider;
}

export function resolveSelectedOpenAIPiRuntimeProvider(params: {
  provider: string;
  harnessRuntime?: string;
  agentHarnessId?: string;
  authProfileProvider?: string;
  authProfileId?: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
}): string {
  if (shouldRouteOpenAIPiThroughCodexAuthProvider(params)) {
    return OPENAI_CODEX_PROVIDER_ID;
  }
  const runtime = normalizeEmbeddedAgentRuntime(params.agentHarnessId ?? params.harnessRuntime);
  if (!isOpenAIProvider(params.provider)) {
    return params.provider;
  }
  if (runtime === "codex") {
    return OPENAI_CODEX_PROVIDER_ID;
  }
  return runtime === "pi" &&
    !params.authProfileId?.trim() &&
    configuredOpenAIAuthOrderStartsWithCodexProfile(params.config)
    ? OPENAI_CODEX_PROVIDER_ID
    : params.provider;
}
