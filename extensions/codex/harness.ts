/**
 * Codex app-server agent harness registration and lazy runtime boundaries.
 */
import type {
  AgentHarness,
  AgentHarnessCompactParams,
  AgentHarnessCompactResult,
  ContextEngineHostCapability,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type {
  CodexAppServerListModelsOptions,
  CodexAppServerModel,
  CodexAppServerModelListResult,
} from "./src/app-server/models.js";
import type { CodexGetAccountResponse } from "./src/app-server/protocol.js";

const DEFAULT_CODEX_HARNESS_PROVIDER_IDS = new Set(["codex", "openai"]);
const CODEX_APP_SERVER_CONTEXT_ENGINE_HOST_CAPABILITIES = [
  "bootstrap",
  "assemble-before-prompt",
  "after-turn",
  "maintain",
  "compact",
  "runtime-llm-complete",
  "thread-bootstrap-projection",
] as const satisfies readonly ContextEngineHostCapability[];

/** Public model-listing types exposed for Codex app-server catalog callers. */
export type { CodexAppServerListModelsOptions, CodexAppServerModel, CodexAppServerModelListResult };

type CodexAppServerAgentHarness = AgentHarness & {
  compactAfterContextEngine?(
    params: AgentHarnessCompactParams,
  ): Promise<AgentHarnessCompactResult | undefined>;
};

/**
 * Creates the Codex app-server harness used for attempts, side questions,
 * compaction, reset, and disposal.
 */
export function createCodexAppServerAgentHarness(options?: {
  id?: string;
  label?: string;
  providerIds?: Iterable<string>;
  pluginConfig?: unknown;
  resolvePluginConfig?: () => unknown;
}): AgentHarness {
  const providerIds = new Set(
    [...(options?.providerIds ?? DEFAULT_CODEX_HARNESS_PROVIDER_IDS)].map((id) =>
      id.trim().toLowerCase(),
    ),
  );
  const harness: CodexAppServerAgentHarness = {
    id: options?.id ?? "codex",
    label: options?.label ?? "Codex agent harness",
    contextEngineHostCapabilities: CODEX_APP_SERVER_CONTEXT_ENGINE_HOST_CAPABILITIES,
    deliveryDefaults: {
      sourceVisibleReplies: "message_tool",
    },
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
    checkReadiness: async (ctx) => {
      const pluginConfig = options?.resolvePluginConfig?.() ?? options?.pluginConfig;
      const { resolveCodexAppServerRuntimeOptions } = await import("./src/app-server/config.js");
      const { createIsolatedCodexAppServerClient } =
        await import("./src/app-server/shared-client.js");
      const runtime = resolveCodexAppServerRuntimeOptions({
        pluginConfig,
        config: ctx.config,
        agentDir: ctx.agentDir,
        modelProvider: ctx.provider,
        model: ctx.modelId,
      });
      let client: Awaited<ReturnType<typeof createIsolatedCodexAppServerClient>> | undefined;
      try {
        client = await createIsolatedCodexAppServerClient({
          startOptions: runtime.start,
          timeoutMs: runtime.requestTimeoutMs,
          agentDir: ctx.agentDir,
          config: ctx.config,
          abandonSignal: ctx.signal,
        });
        const response = await client.request<CodexGetAccountResponse>(
          "account/read",
          {
            refreshToken: false,
          },
          {
            signal: ctx.signal,
            timeoutMs: runtime.requestTimeoutMs,
          },
        );
        return response.account || response.requiresOpenaiAuth === false
          ? { ready: true }
          : { ready: false, reason: "Codex app-server authentication is required" };
      } catch {
        return { ready: false, reason: "Codex app-server readiness check failed" };
      } finally {
        if (client) {
          await client.closeAndWait({ exitTimeoutMs: 2_000, forceKillDelayMs: 250 });
        }
      }
    },
    runAttempt: async (params) => {
      // Keep app-server runtime code behind lazy imports so plugin discovery and
      // cold provider catalog reads do not pull in the whole Codex runtime.
      const { runCodexAppServerAttempt } = await import("./src/app-server/run-attempt.js");
      return runCodexAppServerAttempt(params, {
        pluginConfig: options?.resolvePluginConfig?.() ?? options?.pluginConfig,
        nativeHookRelay: { enabled: true },
      });
    },
    runSideQuestion: async (params) => {
      const { runCodexAppServerSideQuestion } = await import("./src/app-server/side-question.js");
      return runCodexAppServerSideQuestion(params, {
        pluginConfig: options?.resolvePluginConfig?.() ?? options?.pluginConfig,
        nativeHookRelay: { enabled: true },
      });
    },
    compact: async (params) => {
      const { maybeCompactCodexAppServerSession } = await import("./src/app-server/compact.js");
      return maybeCompactCodexAppServerSession(params, {
        pluginConfig: options?.resolvePluginConfig?.() ?? options?.pluginConfig,
      });
    },
    compactAfterContextEngine: async (params) => {
      const { maybeCompactCodexAppServerSession } = await import("./src/app-server/compact.js");
      return maybeCompactCodexAppServerSession(params, {
        pluginConfig: options?.resolvePluginConfig?.() ?? options?.pluginConfig,
        allowNonManualNativeRequest: true,
      });
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
  return harness;
}
