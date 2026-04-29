import type {
  AgentHarness,
  AgentHarnessV2,
  AgentHarnessV2CleanupParams,
  AgentHarnessV2PreparedRun,
  AgentHarnessV2Session,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type {
  CodexAppServerListModelsOptions,
  CodexAppServerModel,
  CodexAppServerModelListResult,
} from "./src/app-server/models.js";

const DEFAULT_CODEX_HARNESS_PROVIDER_IDS = new Set(["codex"]);

export type { CodexAppServerListModelsOptions, CodexAppServerModel, CodexAppServerModelListResult };

export type CodexAppServerHarnessV2PreparedRun = AgentHarnessV2PreparedRun;
export type CodexAppServerHarnessV2Session = AgentHarnessV2Session;
export type CodexAppServerHarnessV2 = AgentHarnessV2;

export function createCodexAppServerAgentHarness(options?: {
  id?: string;
  label?: string;
  providerIds?: Iterable<string>;
  pluginConfig?: unknown;
}): AgentHarness {
  const providerIds = new Set(
    [...(options?.providerIds ?? DEFAULT_CODEX_HARNESS_PROVIDER_IDS)].map((id) =>
      id.trim().toLowerCase(),
    ),
  );
  return {
    id: options?.id ?? "codex",
    label: options?.label ?? "Codex agent harness",
    supports: (ctx) => {
      const provider = ctx.provider.trim().toLowerCase();
      if (providerIds.has(provider)) {
        return { supported: true, priority: 100 };
      }
      return {
        supported: false,
        reason: `provider is not one of: ${[...providerIds].toSorted().join(", ")}`,
      };
    },
    runAttempt: async (params) => {
      const { runCodexAppServerAttempt } = await import("./src/app-server/run-attempt.js");
      return runCodexAppServerAttempt(params, { pluginConfig: options?.pluginConfig });
    },
    compact: async (params) => {
      const { maybeCompactCodexAppServerSession } = await import("./src/app-server/compact.js");
      return maybeCompactCodexAppServerSession(params, { pluginConfig: options?.pluginConfig });
    },
    reset: async (params) => {
      if (params.sessionFile) {
        const { clearCodexAppServerBinding } = await import("./src/app-server/session-binding.js");
        await clearCodexAppServerBinding(params.sessionFile);
      }
    },
    dispose: async () => {
      const { clearSharedCodexAppServerClientAndWait } =
        await import("./src/app-server/shared-client.js");
      await clearSharedCodexAppServerClientAndWait();
    },
  };
}

export function createCodexAppServerAgentHarnessV2(
  harness: AgentHarness,
  options?: { pluginConfig?: unknown },
): CodexAppServerHarnessV2 {
  return {
    id: harness.id,
    label: harness.label,
    pluginId: harness.pluginId,
    supports: (ctx) => harness.supports(ctx),
    prepare: async (params) => ({
      harnessId: harness.id,
      label: harness.label,
      pluginId: harness.pluginId,
      params,
      lifecycleState: "prepared",
    }),
    start: async (prepared) => ({
      harnessId: prepared.harnessId,
      label: prepared.label,
      pluginId: prepared.pluginId,
      params: prepared.params,
      lifecycleState: "started",
    }),
    send: async (session) => {
      const { runCodexAppServerAttempt } = await import("./src/app-server/run-attempt.js");
      return runCodexAppServerAttempt(session.params, { pluginConfig: options?.pluginConfig });
    },
    resolveOutcome: async (session, result) => {
      if (!harness.classify) {
        return {
          ...result,
          agentHarnessId: session.harnessId,
        };
      }
      const {
        agentHarnessResultClassification: _previousClassification,
        ...resultWithoutPrevious
      } = result;
      const classification = harness.classify(resultWithoutPrevious, session.params);
      if (!classification || classification === "ok") {
        return {
          ...resultWithoutPrevious,
          agentHarnessId: session.harnessId,
        };
      }
      return {
        ...resultWithoutPrevious,
        agentHarnessId: session.harnessId,
        agentHarnessResultClassification: classification,
      };
    },
    cleanup: async (_params: AgentHarnessV2CleanupParams) => {
      // Codex app-server attempt cleanup is owned by runCodexAppServerAttempt.
      // This hook remains per-attempt no-op to preserve V1 adapter parity.
    },
    compact: harness.compact ? (params) => harness.compact!(params) : undefined,
    reset: harness.reset ? (params) => harness.reset!(params) : undefined,
    dispose: harness.dispose ? () => harness.dispose!() : undefined,
  };
}
