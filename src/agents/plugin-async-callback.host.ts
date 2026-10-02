import { getRuntimeConfig } from "../config/config.js";
import { resolveSessionStorePathCore } from "../config/sessions.js";
import { withSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { getAgentRunContext } from "../infra/agent-run-registry.js";
import { scheduleMemorySessionDelivery } from "../infra/session-delivery-queue-runtime.js";
import type {
  OpenClawPluginAsyncToolCallback,
  OpenClawPluginAsyncToolCallbackStatus,
} from "../plugins/tool-types.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { onSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import { isIncognitoSessionKey } from "../shared/incognito-session-key.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { capturePluginCallbackMemoryLifetime } from "./plugin-async-callback-memory-lifetime.js";
import {
  getMemoryPluginCallbackAccess,
  isMemoryPluginCallbackToken,
  issueMemoryPluginCallback,
  withPluginCallbackMemoryOwner,
} from "./plugin-async-callback-memory.js";
import type { PluginAsyncCallbackBinding } from "./plugin-async-callback-policy.js";
import { runPluginAsyncCallbackCommand } from "./plugin-async-callback.js";
import { getLatestLiveSubagentRunByChildSessionKey } from "./subagents/registry/subagent-registry-read.js";

class CallbackChildUnavailableError extends Error {}

function assertLiveCallbackChild(binding: Readonly<PluginAsyncCallbackBinding>) {
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
    throw new CallbackChildUnavailableError("Callback native child is no longer current");
  }
  return current;
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
  // The registered native owner already retains the original session incarnation.
  // Do not mint a second persistent identity in the callback ledger.
  const childIdentity = assertLiveCallbackChild(binding).childSessionIdentity;
  if (!childIdentity || childIdentity.sessionId !== binding.childSessionId) {
    throw new CallbackChildUnavailableError(
      "Callback native child session identity is unavailable",
    );
  }
  const expectedLifecycleRevision = childIdentity.lifecycleRevision ?? null;
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
      throw new CallbackChildUnavailableError("Callback native child session is no longer current");
    }
    const currentIdentity = assertLiveCallbackChild(binding).childSessionIdentity;
    if (
      currentIdentity?.sessionId !== binding.childSessionId ||
      (currentIdentity.lifecycleRevision ?? null) !== expectedLifecycleRevision
    ) {
      throw new CallbackChildUnavailableError("Callback native child session is no longer current");
    }
  };
  try {
    return await withSessionEntryReadOnlyInWorker(
      {
        agentId,
        sessionKey: binding.childSessionKey,
        storePath: isIncognitoSessionKey(binding.childSessionKey)
          ? resolveIncognitoOpenClawAgentSqlitePath({ agentId })
          : resolveSessionStorePathCore(getRuntimeConfig().session?.store, { agentId }),
      },
      assertCurrent,
      async (read) => {
        if (!read.ok) {
          throw read.error;
        }
        if (
          read.value?.sessionId !== binding.childSessionId ||
          (read.value.lifecycleRevision ?? null) !== expectedLifecycleRevision ||
          read.value.archivedAt !== undefined
        ) {
          throw new CallbackChildUnavailableError(
            "Callback native child session is no longer current",
          );
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
  if (isMemoryPluginCallbackToken(params.token)) {
    const access = await getMemoryPluginCallbackAccess(params.token, params.pluginId);
    params.assertPluginCurrent();
    if (!access) {
      return "unknown";
    }
    const status = access.status().status;
    if (status === "unknown" || status === "expired") {
      return status;
    }
    if (status !== "pending") {
      return "duplicate";
    }
    return withCallbackChild(access.binding, params.assertPluginCurrent, async (assertCurrent) => {
      assertCurrent();
      const result = access.complete(params.resultText);
      if (result.status === "accepted") {
        scheduleMemorySessionDelivery(result.queueId);
      }
      return result.status;
    });
  }
  const context = captureOpenClawStateWorkerContext();
  const binding = await runPluginAsyncCallbackCommand(
    { type: "pluginCallback.lookup", input: { token: params.token } },
    () => params.assertPluginCurrent(),
    context,
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
      context,
    );
    return result.status;
  });
}

/** A token discloses only its own receipt, never a session binding or result payload. */
export async function getHostPluginAsyncCallbackStatus(params: {
  pluginId: string;
  token: string;
  assertPluginCurrent: () => void;
}): Promise<OpenClawPluginAsyncToolCallbackStatus> {
  params.assertPluginCurrent();
  if (isMemoryPluginCallbackToken(params.token)) {
    const access = await getMemoryPluginCallbackAccess(params.token, params.pluginId);
    params.assertPluginCurrent();
    if (!access) {
      return { status: "unknown" };
    }
    if (access.status().status === "pending") {
      try {
        await withCallbackChild(access.binding, params.assertPluginCurrent, async (assertCurrent) =>
          assertCurrent(),
        );
      } catch (error) {
        if (!(error instanceof CallbackChildUnavailableError)) {
          throw error;
        }
        access.revoke();
      }
    }
    params.assertPluginCurrent();
    return access.status();
  }
  const context = captureOpenClawStateWorkerContext();
  const binding = await runPluginAsyncCallbackCommand(
    { type: "pluginCallback.lookup", input: { token: params.token } },
    () => params.assertPluginCurrent(),
    context,
  );
  params.assertPluginCurrent();
  if (!binding || binding.pluginId !== params.pluginId) {
    return { status: "unknown" };
  }
  const readStatus = () =>
    runPluginAsyncCallbackCommand(
      { type: "pluginCallback.status", input: { token: params.token, binding } },
      () => params.assertPluginCurrent(),
      context,
    );
  let receipt = await readStatus();
  if (receipt.status === "pending") {
    try {
      await withCallbackChild(binding, params.assertPluginCurrent, async (assertCurrent) => {
        assertCurrent();
      });
    } catch (error) {
      if (!(error instanceof CallbackChildUnavailableError)) {
        throw error;
      }
      // Revocation only: never reacquire a child or cancel an already-admitted result.
      await runPluginAsyncCallbackCommand(
        { type: "pluginCallback.cancel", input: { token: params.token, binding } },
        () => params.assertPluginCurrent(),
        context,
      );
      receipt = await readStatus();
    }
  }
  context.admission.assertCurrent();
  params.assertPluginCurrent();
  return receipt;
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
  const { sessionKey, sessionId, runId, agentId } = params;
  if (!sessionKey || !sessionId || !runId || !agentId) {
    throw new Error("Async callback requires an admitted native child invocation");
  }
  const assertIssuingRunCurrent = () => {
    params.assertInvocationCurrent();
    const run = getAgentRunContext(runId);
    if (
      !run ||
      run.sessionKey !== sessionKey ||
      run.sessionId !== sessionId ||
      run.agentId !== agentId
    ) {
      throw new Error("Async callback requires an admitted native child invocation");
    }
  };
  assertIssuingRunCurrent();
  const child = getLatestLiveSubagentRunByChildSessionKey(sessionKey);
  if (!child || child.runId !== runId || child.collect || child.execution.status !== "running") {
    throw new Error("Async callback requires the exact running, non-collector native child");
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
      assertIssuingRunCurrent();
      params.assertPluginCurrent();
    },
    async (assertCurrent) => {
      if (isIncognitoSessionKey(sessionKey)) {
        const lifetime = await withPluginCallbackMemoryOwner(() =>
          capturePluginCallbackMemoryLifetime(binding),
        );
        assertCurrent();
        const result = issueMemoryPluginCallback(binding, params.ttlMs, lifetime);
        scheduleMemorySessionDelivery(result.queueId);
        return result;
      }
      return runPluginAsyncCallbackCommand(
        { type: "pluginCallback.issue", input: { binding, ttlMs: params.ttlMs } },
        assertCurrent,
      );
    },
  );
  return {
    token: issued.token,
    expiresAt: issued.expiresAt,
    storage: isIncognitoSessionKey(sessionKey) ? "memory" : "persistent",
    status: () =>
      getHostPluginAsyncCallbackStatus({
        pluginId: params.pluginId,
        token: issued.token,
        assertPluginCurrent: params.assertPluginCurrent,
      }),
    complete: (resultText) =>
      completeHostPluginAsyncCallback({
        pluginId: params.pluginId,
        token: issued.token,
        resultText,
        assertPluginCurrent: params.assertPluginCurrent,
      }),
  };
}
