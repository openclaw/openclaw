import {
  createModelProviderRouteOverrideResolver,
  findConfiguredProviderModel,
  resolveMergedModelProviderConfig,
} from "../config/model-provider-config.js";
import { projectConfigOntoRuntimeSourceSnapshot } from "../config/runtime-source-projection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { resolveProviderRefOwnership } from "../plugins/providers.js";
import { hasAuthoredProviderRequestParams } from "./model-extra-params.js";
import { resolveModelRuntimePolicy } from "./model-runtime-policy.js";
import { canonicalizeProviderModelId } from "./provider-model-route.js";
import { buildAgentRuntimeAuthPlan } from "./runtime-plan/auth.js";
import type { PrepareAgentRuntimeAuthPlanParams } from "./runtime-plan/prepare-auth.types.js";
import type { PreparedAgentRuntimeAuth } from "./runtime-plan/types.js";

type NativeCommandAuthRoute =
  | { supported: false; reason: string }
  | { supported: true; runtimeId: "codex"; api: "openai-responses"; baseUrl: string };

/** Configured eligibility only: the native runtime validates and executes its own command. */
export function resolveNativeCommandAuthRoute(params: {
  config?: OpenClawConfig;
  provider: string;
  modelId?: string;
  api?: string | null;
  baseUrl?: unknown;
  agentId?: string;
  workspaceDir?: string;
  metadataSnapshot?: PluginMetadataSnapshot;
  providerOwnership?: ReturnType<typeof resolveProviderRefOwnership>;
}): NativeCommandAuthRoute | undefined {
  const provider = resolveMergedModelProviderConfig(params.config, params.provider);
  if (provider?.auth !== "native-command") {
    return undefined;
  }
  const unsupported = (reason: string): NativeCommandAuthRoute => ({ supported: false, reason });
  const ownership = params.providerOwnership ?? resolveProviderRefOwnership(params);
  if (ownership.status !== "unowned") {
    return unsupported("Native command auth requires an unowned custom provider ID");
  }
  const runtime = resolveModelRuntimePolicy(params);
  if (runtime.forcedByEnvironment || runtime.policy?.id !== "codex") {
    return unsupported("Native command auth requires an explicit Codex model or provider runtime");
  }
  if (provider.apiKey !== undefined) {
    return unsupported("Native command auth cannot be combined with an API key or profile binding");
  }
  const model = params.modelId
    ? findConfiguredProviderModel(provider, params.provider, params.modelId, (id) =>
        canonicalizeProviderModelId(params.provider, id),
      )
    : undefined;
  const api = model?.api ?? provider.api;
  const baseUrl = model?.baseUrl ?? provider.baseUrl;
  const url = URL.parse(baseUrl);
  if (
    !model ||
    api !== "openai-responses" ||
    url?.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (params.api != null && params.api !== api) ||
    (params.baseUrl != null && params.baseUrl !== baseUrl)
  ) {
    return unsupported(
      "Native command auth requires the configured HTTPS Responses endpoint and model",
    );
  }
  const authoredConfig = params.config && projectConfigOntoRuntimeSourceSnapshot(params.config);
  if (
    createModelProviderRouteOverrideResolver({
      provider: params.provider,
      authoredConfig,
      canonicalizeModelId: (id) => canonicalizeProviderModelId(params.provider, id),
    })(params.modelId) === "present" ||
    hasAuthoredProviderRequestParams({ ...params, modelId: params.modelId })
  ) {
    return unsupported("Native command auth cannot reproduce authored request transport overrides");
  }
  return { supported: true, runtimeId: "codex", api, baseUrl };
}

/** Native auth never enters host profile ordering or direct credential discovery. */
export function prepareNativeCommandAuth(
  input: PrepareAgentRuntimeAuthPlanParams,
): PreparedAgentRuntimeAuth | undefined {
  const native = resolveNativeCommandAuthRoute({
    ...input,
    api: input.modelApi,
    baseUrl: input.modelBaseUrl,
  });
  if (native) {
    if (!native.supported) {
      throw new Error(native.reason);
    }
    if (input.harnessId !== native.runtimeId || input.harnessAuthBootstrap !== "harness") {
      throw new Error("Native command auth requires an explicit Codex harness runtime");
    }
    if (input.requiredAuthProfileId || input.sessionAuthProfileId) {
      throw new Error("Native command auth cannot be combined with an auth profile binding");
    }
    if (
      input.requestTransportOverrides === "present" ||
      input.observedRoutes?.some(
        (route) => route.api !== native.api || route.baseUrl !== native.baseUrl,
      )
    ) {
      throw new Error("Native command auth cannot reproduce the observed provider route");
    }
    const plan = {
      ...buildAgentRuntimeAuthPlan({
        ...input,
        allowHarnessAuthProfileForwarding: false,
        credentialSource: { kind: "none" },
      }),
      selectedAuthMode: "native-command",
    };
    return { plan, attempts: [{ kind: "implicit", plan }] };
  }
  return undefined;
}
