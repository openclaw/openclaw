import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveCliRuntimeExecutionProvider } from "../model-runtime-aliases.js";
import { isCliProvider } from "../model-selection.js";

/** Select a candidate's CLI route without reinterpreting a locked harness as a backend. */
export function resolveRunEntryCliRuntime(params: {
  config: OpenClawConfig;
  provider: string;
  model: string;
  agentId: string;
  authProfileId?: string;
  sessionRuntimeOverride?: string;
  pinnedHarnessId?: string;
}) {
  const runtime = params.sessionRuntimeOverride;
  const pinnedCliRuntime =
    runtime && runtime !== params.pinnedHarnessId && isCliProvider(runtime, params.config)
      ? runtime
      : undefined;
  const cliExecutionProvider =
    pinnedCliRuntime ??
    (runtime
      ? params.provider
      : (resolveCliRuntimeExecutionProvider({
          provider: params.provider,
          cfg: params.config,
          agentId: params.agentId,
          modelId: params.model,
          authProfileId: params.authProfileId,
        }) ?? params.provider));
  return {
    cliExecutionProvider,
    useCliExecution: runtime
      ? pinnedCliRuntime !== undefined
      : isCliProvider(cliExecutionProvider, params.config),
  };
}
