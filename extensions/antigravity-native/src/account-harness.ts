import type { AgentHarnessV2 } from "openclaw/plugin-sdk/agent-harness";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import type { AgySessionBinding } from "./bound-turn.js";

const runtime = "antigravity-native";

export function createAntigravityAccountHarness(
  openStore: (assertCurrent?: () => void) => PluginStateKeyedStore<AgySessionBinding, 2>,
): AgentHarnessV2 {
  const generation = new AbortController();
  return {
    id: runtime,
    label: "Google Antigravity",
    authBootstrap: "harness",
    autoSelection: { providerIds: [] },
    executionEnvironment: "host-only",
    interruptedRestartRecovery: "explicit-resume",
    supports: ({ requestedRuntime, provider, modelProvider }) => {
      if (requestedRuntime !== runtime || provider !== runtime) {
        return {
          supported: false,
          reason: "Antigravity requires its explicit native account route.",
        };
      }
      if (modelProvider?.requestTransportOverrides === "present") {
        return {
          supported: false,
          reason: "Antigravity cannot apply model request transport overrides.",
        };
      }
      return { supported: true };
    },
    async loadModelCatalog() {
      const signal = AbortSignal.any([generation.signal, AbortSignal.timeout(15_000)]);
      try {
        const { readAgyAccountCatalog } = await import("./account-catalog.js");
        const { models } = await readAgyAccountCatalog(signal, 15_000, () =>
          signal.throwIfAborted(),
        );
        return {
          entries: models.map(({ id, label }) => ({
            provider: runtime,
            id,
            name: label,
            nativeRuntime: runtime,
          })),
          outcomes: [{ provider: runtime, status: "ready" }],
        };
      } catch {
        generation.signal.throwIfAborted();
        return { entries: [], outcomes: [{ provider: runtime, status: "unavailable" }] };
      }
    },
    dispose() {
      generation.abort();
    },
    async runAttempt(params) {
      const { runAccountAttempt } = await import("./account-turn.js");
      return runAccountAttempt(params, openStore);
    },
    async reset(params) {
      if (params.sessionId) {
        await openStore().delete(params.sessionId);
      }
    },
  };
}
