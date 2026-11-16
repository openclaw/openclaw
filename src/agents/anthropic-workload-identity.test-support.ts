import { readGlobalSingleton } from "../shared/global-singleton.js";

type WorkloadIdentityTestState = {
  configKey?: string;
  provider?: unknown;
  current?: unknown;
  pending?: unknown;
  recentTokens: string[];
};

/** Clears cached workload identity credentials and minted-token history between tests. */
export function resetAnthropicWorkloadIdentityForTest(): void {
  const state = readGlobalSingleton(Symbol.for("openclaw.anthropicWorkloadIdentity")) as
    | WorkloadIdentityTestState
    | undefined;
  if (!state) {
    return;
  }
  state.configKey = undefined;
  state.provider = undefined;
  state.current = undefined;
  state.pending = undefined;
  state.recentTokens = [];
}
