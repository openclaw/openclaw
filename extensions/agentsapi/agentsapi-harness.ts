import {
  abortAndDrainAgentHarnessRun,
  embeddedAgentLog,
  resolveAgentExecutorController,
  AgentHarnessPreflightError,
  AgentHarnessSessionCleanupError,
  AgentHarnessSessionSupersededError,
  formatErrorMessage,
  toolPolicy,
  type AgentHarnessAttemptParamsV2,
  type AgentHarnessSessionDeletionMutation,
  type AgentHarnessSessionDeletionParams,
  type AgentHarnessV2,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  combineNativeSessionBindingAuthority,
  createNativeSessionBindingAuthority,
  prepareNativeSessionGenerationAuthority,
  wrapNativeSessionDeletionMutation,
} from "openclaw/plugin-sdk/agent-harness-session-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { runAgentsApiAttempt, type AgentsApiPromptHistories } from "./agentsapi-attempt.js";
import { createAgentsApiBindings, type AgentsApiBinding } from "./agentsapi-bindings.js";
import { AgentsApiClient } from "./agentsapi-client.js";
import { retireAgentsApiExecutor } from "./agentsapi-environment.js";
import { runAgentsApiIsolatedCompletion } from "./agentsapi-isolated-completion.js";
import { requireAgentsApiSessionTarget } from "./agentsapi-target.js";

const AGENTS_API_NATIVE_TOOL_REQUIREMENTS = [
  "exec",
  "process",
  "read",
  "write",
  "edit",
  "apply_patch",
  "web_search",
] as const;

/** Agents API owns native protocol; the host harness runtime owns coordination. */
export function createAgentsApiHarness(runtime: PluginRuntime): AgentHarnessV2 {
  let disposed = false;
  let closing = false;
  const runningSessions = new Map<string, number>();
  const isolatedRuns = new Map<AbortController, Promise<unknown>>();
  const promptHistories: AgentsApiPromptHistories = new WeakMap();
  const preparedNativeCleanup = new Map<
    string,
    {
      nativeSessionId: string;
      configFingerprint: string;
      settle: (assertCleanupCurrent: () => void) => Promise<void>;
    }
  >();
  let bindings: ReturnType<typeof createAgentsApiBindings> | undefined;
  const getBindings = () =>
    (bindings ??= createAgentsApiBindings(runtime, {
      settle: async (localSessionId, binding, assertCleanupCurrent, targetAgentId) => {
        let prepared = preparedNativeCleanup.get(localSessionId);
        if (
          prepared?.nativeSessionId !== binding.sessionId ||
          prepared.configFingerprint !== binding.configFingerprint
        ) {
          assertCurrent();
          assertCleanupCurrent();
          // Reacquire agent-scoped auth after restart without persisting credentials
          // or validating the new configuration against the session being removed.
          const config = getRuntimeConfig();
          // Older hosted/external bindings have no executor metadata. The host
          // mutation target supplies their original agent, never the current default.
          const agentId = binding.executor?.agentId ?? targetAgentId;
          if (!agentId) {
            throw new Error("Agents API session cleanup requires its owning agent");
          }
          if (targetAgentId && targetAgentId !== agentId) {
            throw new Error("Agents API session cleanup target differs from its owning agent");
          }
          const auth = await resolveApiKeyForProvider({
            provider: "openai",
            cfg: config,
            agentDir: runtime.agent.resolveAgentDir(config, agentId),
            workspaceDir: runtime.agent.resolveAgentWorkspaceDir(config, agentId),
            signal: AbortSignal.timeout(30_000),
          });
          assertCurrent();
          assertCleanupCurrent();
          if (auth.mode !== "api-key" || !auth.apiKey?.trim()) {
            throw new Error(
              "Agents API session cleanup requires an OpenAI API key; restore API-key authentication and retry reset or deletion",
            );
          }
          prepared = prepareNativeCleanup(localSessionId, binding, auth.apiKey);
        }
        // Losing the binding before native settlement would orphan active work.
        try {
          await prepared.settle(assertCleanupCurrent);
        } catch (error) {
          // Retry with current authentication after an operator repairs access.
          preparedNativeCleanup.delete(localSessionId);
          throw error;
        }
      },
      retire: async (_localSessionId, binding, assertCleanupCurrent) => {
        await retireExecutor(binding, assertCleanupCurrent);
      },
    }));
  const assertCurrent = () => {
    if (disposed) {
      throw new Error("Agents API harness is disposed");
    }
  };
  return {
    id: "agentsapi",
    label: "OpenAI Agents API (MVP)",
    autoSelection: { providerIds: [] },
    deliveryDefaults: { visibleReplies: "automatic" },
    conversationToolPolicySupport: "exact",
    conversationToolPolicyNativeTools: AGENTS_API_NATIVE_TOOL_REQUIREMENTS,
    // These capabilities exist only in the policy-filtered Gateway tool surface.
    // Native multi-agent tools are disabled when the hosted session is created.
    conversationToolPolicySafeDenyTools: [
      "gateway",
      "agents_list",
      "openclaw",
      "session_status",
      "progress_card",
      "automations",
      "message",
      "sessions_send",
      "conversations_list",
      "conversations_send",
      "conversations_turn",
      "subagents",
      "sessions_list",
      "sessions_history",
      "sessions_search",
      "sessions_spawn",
    ],
    supports: (ctx) => {
      if (ctx.provider !== "openai") {
        return { supported: false, reason: "Agents API requires the OpenAI provider" };
      }
      if (
        ctx.modelProvider?.preparedAuth?.requirement === "subscription" ||
        (ctx.modelProvider?.api && ctx.modelProvider.api !== "openai-responses") ||
        ctx.modelProvider?.requestTransportOverrides === "present" ||
        (ctx.modelProvider?.baseUrl && ctx.modelProvider.baseUrl !== "https://api.openai.com/v1")
      ) {
        return { supported: false, reason: "Agents API MVP requires the official API-key route" };
      }
      return { supported: true };
    },
    runIsolatedCompletionV2: (params) => {
      assertCurrent();
      if (closing) {
        throw new Error("Agents API harness is closing");
      }
      const controller = new AbortController();
      const pending = runAgentsApiIsolatedCompletion(
        {
          ...params,
          abortSignal: params.abortSignal
            ? AbortSignal.any([params.abortSignal, controller.signal])
            : controller.signal,
        },
        assertCurrent,
      );
      isolatedRuns.set(controller, pending);
      return pending.finally(() => isolatedRuns.delete(controller));
    },
    runAttempt: async (params) => {
      assertCurrent();
      if (closing) {
        throw new Error("Agents API harness is closing");
      }
      const target = validateAgentsApiInput(params);
      const captured = await prepareNativeSessionGenerationAuthority({
        target,
        config: params.config,
        storePath: target.storePath,
        assertCurrent: () => {
          assertCurrent();
          params.hostCapabilities.assertActive();
        },
        createSupersededError: (sessionId) =>
          new AgentHarnessSessionSupersededError(
            `Agents API session generation is no longer current: ${sessionId}`,
          ),
      });
      const authority = captured.authority;
      authority.assertLegacyCurrent();
      runningSessions.set(params.sessionId, (runningSessions.get(params.sessionId) ?? 0) + 1);
      try {
        return await getBindings().withSession(
          params.sessionId,
          () => authority.assertLegacyCurrent(),
          (binding, bind, assertLeaseCurrent) => {
            if (closing) {
              throw new Error("Agents API harness is closing");
            }
            return runAgentsApiAttempt(
              params,
              binding,
              bind,
              combineNativeSessionBindingAuthority(
                authority,
                createNativeSessionBindingAuthority([], assertLeaseCurrent),
              ).assertLegacyCurrent,
              () => {
                assertCurrent();
                assertLeaseCurrent();
              },
              target,
              () => runtime.config.current().plugins?.entries?.agentsapi?.config,
              promptHistories,
              (nativeBinding, apiKey) =>
                prepareNativeCleanup(params.sessionId, nativeBinding, apiKey),
              (failedBinding) =>
                retireExecutor(failedBinding, () => {
                  assertCurrent();
                  assertLeaseCurrent();
                }),
            );
          },
        );
      } finally {
        const count = runningSessions.get(params.sessionId)! - 1;
        if (count > 0) {
          runningSessions.set(params.sessionId, count);
        } else {
          runningSessions.delete(params.sessionId);
        }
      }
    },
    reset: async (params) => {
      try {
        assertCurrent();
        if (params.sessionId) {
          if (
            runningSessions.has(params.sessionId) ||
            preparedNativeCleanup.has(params.sessionId)
          ) {
            await drainForExecutorCleanup(params.sessionId);
            assertCurrent();
          }
          await getBindings().reset(params.sessionId, assertCurrent, params.agentId);
          preparedNativeCleanup.delete(params.sessionId);
        }
      } catch (error) {
        // Native ownership is required cleanup, not a best-effort reset observer.
        throw new AgentHarnessSessionCleanupError(formatErrorMessage(error), { cause: error });
      }
    },
    withSessionDeletion,
    withSessionContextReset: async (params, run) => {
      params.assertCurrent();
      assertCurrent();
      const sessionId = getBindings().resolveContextResetSessionId(
        params.sessionId,
        params.previousSessionId,
      );
      return withSessionDeletion({ ...params, sessionId }, run, true);
    },
    dispose: async () => {
      closing = true;
      for (const controller of isolatedRuns.keys()) {
        controller.abort();
      }
      await Promise.allSettled(isolatedRuns.values());
      await Promise.all(
        [...runningSessions.keys()].map((sessionId) =>
          abortAndDrainAgentHarnessRun({ sessionId, settleMs: 95_000 }),
        ),
      );
      if (bindings) {
        await bindings.withExclusiveMutationFence(async () => {
          disposed = true;
        });
      } else {
        disposed = true;
      }
      // A Gateway restart drops credential handles, but retains the executor and
      // canonical native bindings so the next input can reconcile them.
      preparedNativeCleanup.clear();
    },
  };

  async function withSessionDeletion<T>(
    params: AgentHarnessSessionDeletionParams,
    run: (mutation: AgentHarnessSessionDeletionMutation) => Promise<T>,
    retireAfterCommit = false,
  ): Promise<T> {
    params.assertCurrent();
    assertCurrent();
    if (runningSessions.has(params.sessionId) || preparedNativeCleanup.has(params.sessionId)) {
      await drainForExecutorCleanup(params.sessionId);
      params.assertCurrent();
      assertCurrent();
    }
    let committed = false;
    try {
      return await getBindings().withSessionDeletion(
        {
          ...params,
          assertCurrent: () => {
            params.assertCurrent();
            assertCurrent();
          },
        },
        (mutation) =>
          run(
            wrapNativeSessionDeletionMutation(mutation, {
              assertCurrent: () => {
                params.assertCurrent();
                assertCurrent();
              },
              committed: () => {
                committed = true;
              },
              rolledBack: () => {
                committed = false;
              },
            }),
          ),
        retireAfterCommit,
      );
    } finally {
      if (committed) {
        preparedNativeCleanup.delete(params.sessionId);
      }
    }
  }

  async function retireExecutor(binding: AgentsApiBinding, assertCleanupCurrent: () => void) {
    const executor = binding.executor;
    if (!executor) {
      return;
    }
    await attemptExecutorCleanup(
      () =>
        retireAgentsApiExecutor(
          resolveAgentExecutorController(binding.executorControllerPluginId!),
          executor,
          assertCleanupCurrent,
        ),
      assertCleanupCurrent,
    );
  }

  async function attemptExecutorCleanup(
    run: () => Promise<void>,
    assertCleanupCurrent: () => void,
  ) {
    try {
      assertCleanupCurrent();
      await run();
      assertCleanupCurrent();
    } catch (error) {
      // Lost authority still stops mutation; an unused remote child must not
      // prevent the user from resetting or deleting the conversation.
      assertCleanupCurrent();
      embeddedAgentLog.warn("Agents API executor cleanup was not acknowledged", { error });
    }
  }

  async function drainForExecutorCleanup(sessionId: string) {
    const result = await abortAndDrainAgentHarnessRun({ sessionId, settleMs: 95_000 });
    assertCurrent();
    if ((result.aborted && !result.drained) || runningSessions.has(sessionId)) {
      throw new Error(
        "Agents API session is still settling; retry reset or deletion after its active turn finishes",
      );
    }
  }

  function prepareNativeCleanup(localSessionId: string, binding: AgentsApiBinding, apiKey: string) {
    assertCurrent();
    const prepared = {
      nativeSessionId: binding.sessionId,
      configFingerprint: binding.configFingerprint,
      settle: async (assertCleanupCurrent: () => void) => {
        const assertCleanup = () => {
          assertCurrent();
          assertCleanupCurrent();
        };
        assertCleanup();
        const client = new AgentsApiClient(apiKey, assertCleanup);
        const signal = AbortSignal.timeout(30_000);
        const session = await client.session(binding.sessionId, signal);
        assertCleanup();
        if (session.status !== "idle" && session.status !== "failed") {
          await client.cancel(binding.sessionId, signal);
          assertCleanup();
        }
      },
    };
    preparedNativeCleanup.set(localSessionId, prepared);
    return prepared;
  }
}

function validateAgentsApiInput(params: AgentHarnessAttemptParamsV2) {
  const runtimeToolAllowed = toolPolicy.createToolPolicyMatcher({ allow: params.toolsAllow });
  if (
    params.disableTools ||
    params.pluginHarnessToolPolicyRestricted ||
    params.toolExecutionAllow !== undefined ||
    params.toolsAllow?.length === 0 ||
    AGENTS_API_NATIVE_TOOL_REQUIREMENTS.some((name) => !runtimeToolAllowed(name))
  ) {
    throw new AgentHarnessPreflightError(
      "Agents API cannot enforce this run's restrictions on native shell, file, or web-search tools.",
      {
        scope: "harness",
        userMessage:
          "Agents API cannot run with this chat's tool restrictions because it cannot enforce them on native tools. Choose a harness that supports these restrictions or update the tool settings.",
      },
    );
  }
  const target = requireAgentsApiSessionTarget(params);
  if (!params.resolvedApiKey) {
    throw new Error("Agents API MVP requires an OpenAI API key");
  }
  if (params.sandbox) {
    throw new AgentHarnessPreflightError("Agents API does not support Gateway sandbox placement.", {
      scope: "harness",
      userMessage:
        "Agents API cannot run in the configured Gateway sandbox. Choose a harness that supports Gateway sandbox placement before retrying.",
    });
  }
  if (params.contextEngine && params.contextEngine.info.id !== "legacy") {
    throw new Error("Agents API MVP currently supports only the default legacy context engine");
  }
  return target;
}
