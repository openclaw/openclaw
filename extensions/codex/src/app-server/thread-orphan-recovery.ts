import { AgentHarnessPreflightError } from "openclaw/plugin-sdk/agent-harness-runtime";
import { isIncognitoSessionKey } from "openclaw/plugin-sdk/session-key-runtime";
import { readVisibleSessionTranscriptMessageEntries } from "openclaw/plugin-sdk/session-transcript-runtime";
import { codexCatalogHomeId } from "../session-catalog-home-id.js";
import { CODEX_APP_SERVER_INTERRUPT_TIMEOUT_MS } from "./attempt-client-cleanup.js";
import { isTerminalTurnStatus } from "./attempt-notifications.js";
import { resolveCodexAppServerLocalHomeDir } from "./auth-start-options.js";
import {
  isCodexAppServerLiveThreadClaimed,
  isCodexAppServerLiveThreadProtected,
} from "./client-runtime.js";
import { isJsonObject, type CodexThread, type CodexTurn } from "./protocol.js";
import { requestCodexAppServerClientJson } from "./request.js";
import type { CodexAttemptResources } from "./run-attempt-resources.js";
import { sessionBindingIdentity, type CodexAppServerThreadBinding } from "./session-binding.js";
import { retainSharedCodexAppServerClientByInstanceId } from "./shared-client.js";
import {
  CodexAdoptedThreadActiveError,
  CodexThreadBindingConflictError,
} from "./thread-lifecycle-errors.js";
import { resolveCodexThreadAgentDir } from "./thread-lifecycle-preflight.js";
import type { CodexStartOrResumeThreadParams } from "./thread-lifecycle-types.js";
import { isSameCodexAppServerThreadOwner } from "./thread-ownership.js";
import { CodexThreadPolicyHandoffError } from "./thread-policy.js";
import {
  hasCodexMirrorOrigin,
  fingerprintCodexMirrorSourceMessage,
  readCodexMirrorSourceFingerprint,
} from "./transcript-mirror-attestation.js";
import { listCodexUpstreamTurns } from "./upstream-fork-boundary.js";
import { readMirrorIdentity, readUpstreamUserText } from "./upstream-prompt-provenance.js";

/** Persist acceptance before the local route can release tools; it never authorizes replay. */
export async function recordCodexAcceptedTurn(
  resources: CodexAttemptResources,
  turnId: string,
  assertCurrent: () => void,
): Promise<void> {
  const { connection } = resources.prompt.context.runtime;
  const { thread } = resources.state;
  if (
    connection.appServer.start.transport !== "websocket" ||
    thread.lifecycle.preserveExistingBinding ||
    thread.connectionScope ||
    thread.preserveNativeModel ||
    isIncognitoSessionKey(connection.params.sessionKey)
  ) {
    return;
  }
  const turnRecovery = { turnId, state: "accepted" as const };
  const committed = await connection.bindingStore.mutate(
    connection.bindingIdentity,
    {
      kind: "patch",
      threadId: thread.threadId,
      clientId: thread.clientId,
      patch: { turnRecovery },
    },
    assertCurrent,
    connection.authority,
  );
  assertCurrent();
  if (!committed) {
    throw new CodexThreadBindingConflictError(thread.threadId, "recording native turn acceptance");
  }
  thread.turnRecovery = turnRecovery;
}

/** A confirmed native terminal needs no future recovery receipt. Never clear a successor. */
export async function clearCodexAcceptedTurn(
  resources: CodexAttemptResources,
  turnId: string,
): Promise<void> {
  const { connection } = resources.prompt.context.runtime;
  const { thread } = resources.state;
  await connection.bindingStore.withLease(
    connection.bindingIdentity,
    async () => {
      const current = connection.bindingStore.read(connection.bindingIdentity);
      if (
        !isSameCodexAppServerThreadOwner(current, thread) ||
        current?.turnRecovery?.state !== "accepted" ||
        current.turnRecovery.turnId !== turnId
      ) {
        return;
      }
      if (
        await connection.bindingStore.mutate(
          connection.bindingIdentity,
          {
            kind: "patch",
            threadId: thread.threadId,
            clientId: thread.clientId,
            patch: { turnRecovery: undefined },
          },
          connection.assertCurrent,
          connection.authority,
        )
      ) {
        thread.turnRecovery = undefined;
      }
    },
    { assertCurrent: connection.assertCurrent, authority: connection.authority },
  );
}

/** A legacy transcript annotation is evidence of this host accepting this exact native turn. */
async function hasLegacyAcceptedTurn(
  params: CodexStartOrResumeThreadParams,
  turn: CodexTurn,
): Promise<boolean> {
  if (!params.params.sessionTarget || !params.params.sessionKey) {
    return false;
  }
  const firstUser = turn.items.find((item) => item.type === "userMessage");
  const pieces =
    firstUser && Array.isArray(firstUser.content)
      ? firstUser.content.map((item) =>
          isJsonObject(item) && item.type === "text" && typeof item.text === "string"
            ? item.text
            : undefined,
        )
      : undefined;
  const upstreamText = pieces?.every((piece) => piece !== undefined)
    ? pieces.join("\n")
    : undefined;
  if (!upstreamText) {
    return false;
  }
  const entries = await readVisibleSessionTranscriptMessageEntries({
    agentId: params.agentId ?? params.params.agentId,
    sessionId: params.params.sessionId,
    sessionKey: params.params.sessionKey,
    storePath: params.params.sessionTarget.storePath,
  });
  return entries.some(
    (entry) =>
      entry.message.role === "user" &&
      hasCodexMirrorOrigin(entry.message) &&
      readCodexMirrorSourceFingerprint(entry.message) ===
        fingerprintCodexMirrorSourceMessage(entry.message) &&
      readMirrorIdentity(entry.message) === `${turn.id}:prompt` &&
      readUpstreamUserText(entry.message) === upstreamText,
  );
}

/** Cold admission settles only an exact, provably owned orphan. It never resumes its execution. */
export async function settleCodexOrphanTurn(
  params: CodexStartOrResumeThreadParams,
  binding: CodexAppServerThreadBinding,
  thread: CodexThread,
  assertCurrent: () => void,
): Promise<CodexThread> {
  if (thread.status?.type !== "active" && !binding.turnRecovery) {
    return thread;
  }
  const fail = () =>
    new CodexAdoptedThreadActiveError(
      "The previous Codex task could not be safely settled. Its history and tool outcomes are preserved; no previous tool was retried.",
    );
  if (
    params.appServer.start.transport !== "websocket" ||
    binding.connectionScope ||
    binding.preserveNativeModel ||
    binding.pendingResumeConfiguration ||
    binding.contextEngine ||
    binding.ringZeroClientInstanceId ||
    binding.ringZeroConfigFingerprint ||
    isIncognitoSessionKey(params.params.sessionKey)
  ) {
    if (binding.turnRecovery) {
      throw fail();
    }
    return thread;
  }
  const identity = sessionBindingIdentity({
    sessionId: params.params.sessionId,
    sessionKey: params.params.sessionKey,
    agentId: params.agentId ?? params.params.agentId,
    config: params.params.config,
  });
  const prior = await retainSharedCodexAppServerClientByInstanceId(binding.clientId);
  try {
    const assertRecoveryCurrent = () => {
      assertCurrent();
      const current = params.bindingStore.read(identity);
      if (!isSameCodexAppServerThreadOwner(current, binding)) {
        throw new CodexThreadBindingConflictError(binding.threadId, "settling an orphan turn");
      }
      for (const client of [params.client, ...(prior ? [prior.client] : [])]) {
        if (
          isCodexAppServerLiveThreadClaimed(client, binding.threadId) ||
          isCodexAppServerLiveThreadProtected(client, binding.threadId)
        ) {
          throw fail();
        }
      }
    };
    assertRecoveryCurrent();
    if (
      (await params.bindingStore.hasOtherThreadOwner(binding.threadId, identity)) ||
      !(await params.bindingStore.managedThreads?.has(
        codexCatalogHomeId(
          resolveCodexAppServerLocalHomeDir(
            params.appServer.start,
            resolveCodexThreadAgentDir(params),
          ),
        ),
        binding.threadId,
      ))
    ) {
      if (thread.status?.type === "active" || binding.turnRecovery) {
        throw fail();
      }
      return thread;
    }
    const readTurns = () =>
      listCodexUpstreamTurns(
        {
          listTurnPage: (request) =>
            params.client.request("thread/turns/list", request, {
              signal: params.signal,
              assertCurrent: assertRecoveryCurrent,
              withCurrent: params.authority?.withCurrent,
            }),
        },
        binding.threadId,
      );
    const turns = await readTurns();
    assertRecoveryCurrent();
    const active = turns.filter((turn) => turn.status === "inProgress");
    let receipt = binding.turnRecovery;
    if (
      !receipt &&
      active.length === 1 &&
      active[0] === turns.at(-1) &&
      (await hasLegacyAcceptedTurn(params, active[0]!))
    ) {
      receipt = { turnId: active[0]!.id, state: "accepted" };
    }
    assertRecoveryCurrent();
    if (
      !receipt ||
      active.length > 1 ||
      (active.length === 1 && active[0]!.id !== receipt.turnId)
    ) {
      throw fail();
    }
    const owned = turns.find((turn) => turn.id === receipt.turnId);
    if (!owned) {
      throw fail();
    }
    // A previous admission already settled this exact turn. Leave the receipt
    // for the no-replay notice; there is no new interrupt or write to confirm.
    if (
      receipt.state === "settling" &&
      (thread.status?.type === "idle" || thread.status?.type === "notLoaded") &&
      active.length === 0 &&
      isTerminalTurnStatus(owned.status)
    ) {
      return thread;
    }
    // Native completion does not prove the lost host confirmed the task's outcome.
    // Live native cleanup clears acceptance; cold admission must preserve the
    // unresolved receipt even when every native item has already completed.
    const turnRecovery = { turnId: receipt.turnId, state: "settling" as const };
    if (
      !(await params.bindingStore.mutate(
        identity,
        {
          kind: "patch",
          threadId: binding.threadId,
          clientId: binding.clientId,
          patch: { turnRecovery },
        },
        assertRecoveryCurrent,
        params.authority,
      ))
    ) {
      throw fail();
    }
    binding.turnRecovery = turnRecovery;
    assertRecoveryCurrent();
    if (active.length === 1) {
      // A nonempty ID is mandatory: native rejects a replacement turn instead of interrupting it.
      try {
        await params.client.request(
          "turn/interrupt",
          { threadId: binding.threadId, turnId: receipt.turnId },
          {
            timeoutMs: Math.min(
              params.appServer.requestTimeoutMs,
              CODEX_APP_SERVER_INTERRUPT_TIMEOUT_MS,
            ),
            signal: params.signal,
            assertCurrent: assertRecoveryCurrent,
            withCurrent: params.authority?.withCurrent,
          },
        );
      } catch (error) {
        assertRecoveryCurrent();
        // Terminal can race the interrupt. Only readback may settle an ambiguous response.
        const settled = await readTurns();
        if (
          !settled.some((turn) => turn.id === receipt.turnId && isTerminalTurnStatus(turn.status))
        ) {
          throw new AgentHarnessPreflightError(
            "The previous Codex task interruption was not confirmed; no tools were retried.",
            { cause: error },
          );
        }
      }
    }
    const result = await params.client.request(
      "thread/read",
      { threadId: binding.threadId, includeTurns: false },
      {
        signal: params.signal,
        assertCurrent: assertRecoveryCurrent,
        withCurrent: params.authority?.withCurrent,
      },
    );
    const settled = await readTurns();
    assertRecoveryCurrent();
    if (
      result.thread.id !== binding.threadId ||
      result.thread.status?.type === "active" ||
      settled.some((turn) => turn.status === "inProgress") ||
      !settled.some((turn) => turn.id === receipt.turnId && isTerminalTurnStatus(turn.status))
    ) {
      throw fail();
    }
    return result.thread;
  } finally {
    await prior?.release();
  }
}

/** Keep the marker until native history and the replacement binding acknowledge this notice. */
export async function recordCodexOrphanTurnOutcome(
  params: CodexStartOrResumeThreadParams,
  binding: CodexAppServerThreadBinding,
  threadId: string,
  assertCurrent: () => void,
): Promise<void> {
  if (binding.turnRecovery?.state !== "settling") {
    return;
  }
  const text = `OpenClaw recovered from loss of the previous execution owner. The previous task (${binding.turnRecovery.turnId}) has ended; its existing history is preserved. Some tool effects may have occurred even when their results are missing, so those outcomes are uncertain. Do not automatically repeat any old tool call or resume the old task. Handle the current request independently; reconcile uncertain effects with read-only inspection before proposing a repeat. Explain the interrupted task briefly when relevant to a direct user request.`;
  try {
    await requestCodexAppServerClientJson({
      client: params.client,
      method: "thread/inject_items",
      requestParams: {
        threadId,
        items: [{ type: "message", role: "developer", content: [{ type: "input_text", text }] }],
      },
      timeoutMs: params.appServer.requestTimeoutMs,
      signal: params.signal,
      assertCurrent,
      withCurrent: params.authority?.withCurrent,
    });
    assertCurrent();
  } catch (error) {
    throw new CodexThreadPolicyHandoffError("unknown", error);
  }
}
