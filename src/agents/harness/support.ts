import { findNormalizedProviderValue } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveProviderRefOwnership } from "../../plugins/providers.js";
import { listRegisteredAgentHarnesses } from "./registry.js";
import type { AgentHarness, AgentHarnessSupport, AgentHarnessSupportContext } from "./types.js";

/** Builds the provider/model facts passed to registered harness support probes. */
export function buildAgentHarnessSupportContext(params: {
  provider: string;
  modelId?: string;
  requestedRuntime: AgentHarnessSupportContext["requestedRuntime"];
  config?: OpenClawConfig;
}): AgentHarnessSupportContext {
  const providerOwnership = resolveProviderRefOwnership({
    provider: params.provider,
    config: params.config,
  });
  const providerConfig = findNormalizedProviderValue(
    params.config?.models?.providers,
    params.provider,
  );
  const modelConfig = params.modelId
    ? providerConfig?.models?.find((entry) => entry.id === params.modelId)
    : undefined;
  return {
    provider: params.provider,
    modelId: params.modelId,
    modelProvider: providerConfig
      ? {
          api: modelConfig?.api ?? providerConfig.api ?? "openai-responses",
          baseUrl: modelConfig?.baseUrl ?? providerConfig.baseUrl,
          azureApiVersion: readStringParam(
            modelConfig?.params?.azureApiVersion ?? providerConfig.params?.azureApiVersion,
          ),
          request: providerConfig.request,
        }
      : undefined,
    requestedRuntime: params.requestedRuntime,
    providerOwnerStatus: providerOwnership.status,
    providerOwnerPluginIds:
      providerOwnership.status === "unowned" ? [] : providerOwnership.pluginIds,
  };
}

/** Resolves the registered plugin harness that auto selection would choose. */
export function resolveAutoAgentHarnessId(params: {
  provider: string;
  modelId?: string;
  config?: OpenClawConfig;
}): string | undefined {
  const supportContext = buildAgentHarnessSupportContext({
    ...params,
    requestedRuntime: "auto",
  });
  return listRegisteredAgentHarnesses()
    .map(({ harness }) => ({ harness, support: harness.supports(supportContext) }))
    .filter(isSupportedHarness)
    .toSorted(compareHarnessSupport)[0]?.harness.id;
}

export function compareHarnessSupport(
  left: { harness: AgentHarness; support: AgentHarnessSupport & { supported: true } },
  right: { harness: AgentHarness; support: AgentHarnessSupport & { supported: true } },
): number {
  const priorityDelta = (right.support.priority ?? 0) - (left.support.priority ?? 0);
  return priorityDelta !== 0 ? priorityDelta : left.harness.id.localeCompare(right.harness.id);
}

function isSupportedHarness(entry: {
  harness: AgentHarness;
  support: AgentHarnessSupport;
}): entry is {
  harness: AgentHarness;
  support: AgentHarnessSupport & { supported: true };
} {
  return entry.support.supported;
}

function readStringParam(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
