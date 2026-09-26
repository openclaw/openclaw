import { getRuntimeConfig } from "../config/config.js";
import { resolveSessionStorePathCore } from "../config/sessions.js";
import { withSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { getAgentRunContext } from "../infra/agent-run-registry.js";
import type { OpenClawPluginAsyncToolCallback } from "../plugins/tool-types.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { onSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import { runPluginAsyncCallbackCommand } from "./plugin-async-callback.js";
import type { PluginAsyncCallbackBinding } from "./plugin-async-callback.store.js";
import { getLatestLiveSubagentRunByChildSessionKey } from "./subagents/registry/subagent-registry-read.js";

function assertLiveCallbackChild(binding: Readonly<PluginAsyncCallbackBinding>): void {
  const current = getLatestLiveSubagentRunByChildSessionKey(binding.childSessionKey);
  if (
    !current ||
    current.runId !== binding.childRunId ||
    current.generation !== binding.childGeneration ||
    current.createdAt !== binding.childCreatedAt ||
    current.collect ||
    current.endedReason ||
    current.killIntent ||
    current.killReconciliation ||
    current.terminalOwner ||
    current.suppressAnnounceReason ||
    current.cleanupCompletedAt !== undefined ||
    current.execution.suppressSessionEffects ||
    current.expectsCompletionMessage === false ||
    (current.execution.status !== "running" && current.pauseReason !== "sessions_yield")
  ) {
    throw new Error("Callback native child is no longer current");
  }
}

/** Prepare the exact session in a reader worker; fence resets during the admitted write. */
async function withCallbackChild<T>(
  binding: PluginAsyncCallbackBinding,
  assertPluginCurrent: () => void,
  consume: (assertCurrent: () => void) => Promise<T>,
): Promise<T> {
  const agentId = parseAgentSessionKey(binding.childSessionKey)?.agentId;
  if (!agentId) {
    throw new Error("Callback requires a native child session");
  }
  let replaced = false;
  const unsubscribe = onSessionIdentityMutation((mutation) => {
    if (
      mutation.agentId === agentId &&
      (mutation.previous.sessionId === binding.childSessionId ||
        mutation.previous.sessionKeys.includes(binding.childSessionKey))
    ) {
      replaced = true;
    }
  });
  const assertCurrent = () => {
    assertPluginCurrent();
    if (replaced) {
      throw new Error("Callback native child session is no longer current");
    }
    assertLiveCallbackChild(binding);
  };
  try {
    return await withSessionEntryReadOnlyInWorker(
      {
        agentId,
        sessionKey: binding.childSessionKey,
        storePath: resolveSessionStorePathCore(getRuntimeConfig().session?.store, { agentId }),
      },
      assertCurrent,
      async (read) => {
        if (!read.ok) {
          throw read.error;
        }
        if (
          read.value?.sessionId !== binding.childSessionId ||
          read.value.archivedAt !== undefined
        ) {
          throw new Error("Callback native child session is no longer current");
        }
        assertCurrent();
        return consume(assertCurrent);
      },
    );
  } finally {
    unsubscribe();
  }
}

/** Bound to the current plugin instance, never a plugin-supplied child or destination. */
export async function completeHostPluginAsyncCallback(params: {
  pluginId: string;
  token: string;
  resultText: string;
  assertPluginCurrent: () => void;
}): Promise<"accepted" | "duplicate" | "expired" | "cancelled" | "unknown"> {
  params.assertPluginCurrent();
  const binding = await runPluginAsyncCallbackCommand(
    { type: "pluginCallback.lookup", input: { token: params.token } },
    () => params.assertPluginCurrent(),
  );
  params.assertPluginCurrent();
  if (!binding || binding.pluginId !== params.pluginId) {
    return "unknown";
  }
  if (binding.status === "completed") {
    return "duplicate";
  }
  if (binding.status === "cancelled" || binding.status === "expired") {
    return binding.status;
  }
  return withCallbackChild(binding, params.assertPluginCurrent, async (assertCurrent) => {
    const result = await runPluginAsyncCallbackCommand(
      {
        type: "pluginCallback.complete",
        input: { binding, token: params.token, resultText: params.resultText },
      },
      assertCurrent,
    );
    return result.status;
  });
}

/** Called only inside the registered V2 tool's admitted execute invocation. */
export async function issueHostPluginAsyncCallback(params: {
  pluginId: string;
  toolName: string;
  runId?: string;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  ttlMs: number;
  assertInvocationCurrent: () => void;
  assertPluginCurrent: () => void;
}): Promise<OpenClawPluginAsyncToolCallback> {
  params.assertInvocationCurrent();
  const { sessionKey, sessionId, runId, agentId } = params;
  const run = runId ? getAgentRunContext(runId) : undefined;
  if (
    !run ||
    !sessionKey ||
    !sessionId ||
    !agentId ||
    run.sessionKey !== sessionKey ||
    run.sessionId !== sessionId ||
    run.agentId !== agentId
  ) {
    throw new Error("Async callback requires an admitted native child invocation");
  }
  const child = getLatestLiveSubagentRunByChildSessionKey(sessionKey);
  if (!child || child.collect || child.execution.status !== "running") {
    throw new Error("Async callback requires a running, non-collector native child");
  }
  const binding: PluginAsyncCallbackBinding = {
    pluginId: params.pluginId,
    toolName: params.toolName,
    childSessionKey: sessionKey,
    childSessionId: sessionId,
    childRunId: child.runId,
    childGeneration: child.generation,
    childCreatedAt: child.createdAt,
  };
  const issued = await withCallbackChild(
    binding,
    () => {
      params.assertInvocationCurrent();
      params.assertPluginCurrent();
    },
    (assertCurrent) =>
      runPluginAsyncCallbackCommand(
        { type: "pluginCallback.issue", input: { binding, ttlMs: params.ttlMs } },
        assertCurrent,
      ),
  );
  return {
    token: issued.token,
    expiresAt: issued.expiresAt,
    complete: (resultText) =>
      completeHostPluginAsyncCallback({
        pluginId: params.pluginId,
        token: issued.token,
        resultText,
        assertPluginCurrent: params.assertPluginCurrent,
      }),
  };
}
