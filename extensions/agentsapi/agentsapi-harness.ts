import {
  abortAndDrainAgentHarnessRun,
  AgentHarnessSessionSupersededError,
  type AgentHarnessAttemptParamsV2,
  type AgentHarnessV2,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { captureNativeSessionGenerationAuthority } from "openclaw/plugin-sdk/agent-harness-session-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { runAgentsApiAttempt } from "./agentsapi-attempt.js";
import { createAgentsApiBindings } from "./agentsapi-bindings.js";

/** Agents API owns native protocol; the host harness runtime owns coordination. */
export function createAgentsApiHarness(runtime: PluginRuntime): AgentHarnessV2 {
  let disposed = false;
  let closing = false;
  const runningSessions = new Map<string, number>();
  let bindings: ReturnType<typeof createAgentsApiBindings> | undefined;
  const getBindings = () => (bindings ??= createAgentsApiBindings(runtime));
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
    runAttempt: async (params) => {
      assertCurrent();
      if (closing) {
        throw new Error("Agents API harness is closing");
      }
      const target = validateAgentsApiInput(params);
      const authority = captureNativeSessionGenerationAuthority({
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
      authority.assertCurrent();
      runningSessions.set(params.sessionId, (runningSessions.get(params.sessionId) ?? 0) + 1);
      try {
        return await getBindings().withSession(
          params.sessionId,
          () => authority.assertCurrent(),
          (binding, bind, assertLeaseCurrent) => {
            if (closing) {
              throw new Error("Agents API harness is closing");
            }
            return runAgentsApiAttempt(
              params,
              binding,
              bind,
              () => {
                authority.assertCurrent();
                assertLeaseCurrent();
              },
              () => {
                assertCurrent();
                assertLeaseCurrent();
              },
              target,
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
      assertCurrent();
      if (params.sessionId) {
        await getBindings().reset(params.sessionId, assertCurrent);
      }
    },
    withSessionDeletion: (params, run) =>
      getBindings().withSessionDeletion(
        {
          ...params,
          assertCurrent: () => {
            params.assertCurrent();
            assertCurrent();
          },
        },
        run,
      ),
    dispose: async () => {
      closing = true;
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
    },
  };
}

function validateAgentsApiInput(params: AgentHarnessAttemptParamsV2) {
  const target = params.sessionTarget;
  if (
    !target?.agentId ||
    !target.sessionId ||
    !target.sessionKey ||
    !target.storePath ||
    target.sessionId !== params.sessionId ||
    target.agentId !== params.agentId ||
    target.sessionKey !== params.sessionKey
  ) {
    throw new Error("Agents API requires a matching host-prepared session target");
  }
  if (!params.resolvedApiKey) {
    throw new Error("Agents API MVP requires an OpenAI API key");
  }
  if (params.images?.length || params.sandbox) {
    throw new Error(
      "Agents API MVP supports text and its hosted VM only; images and Gateway sandbox placement are unsupported",
    );
  }
  if (params.contextEngine && params.contextEngine.info.id !== "legacy") {
    throw new Error("Agents API MVP currently supports only the default legacy context engine");
  }
  return {
    ...target,
    agentId: target.agentId,
    sessionId: target.sessionId,
    sessionKey: target.sessionKey,
    storePath: target.storePath,
  };
}
