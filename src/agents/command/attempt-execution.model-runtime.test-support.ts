import type { OpenClawConfig } from "../../config/types.openclaw.js";

export function createCliRuntimeExecutionProviderMock() {
  return ({
    provider,
    cfg,
    modelId,
  }: {
    provider?: string;
    cfg?: OpenClawConfig;
    modelId?: string;
  }) => {
    const key = provider && modelId ? `${provider}/${modelId}` : undefined;
    // Runtime alias tests only need the model-level runtime override path;
    // keeping the mock narrow avoids loading provider catalogs here.
    const runtime = key
      ? cfg?.agents?.defaults?.models?.[key]?.agentRuntime?.id?.trim()
      : undefined;
    return runtime || provider;
  };
}
