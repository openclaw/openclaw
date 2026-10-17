import { IMAGE_BLOCK_TOKENS } from "../../../packages/agent-core/src/harness/compaction/compaction-cut-point.js";
import { estimateTokens } from "../../../packages/agent-core/src/harness/compaction/compaction.js";
import type { AgentMessage } from "../../../packages/agent-core/src/types.js";
import { persistCompactionBoundaryWithSessionEntryAsync } from "../../config/sessions/session-accessor.js";
import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { withOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context.js";
import { boundContextEngineAssembly } from "../../context-engine/bounded-context.js";
import {
  BOUNDED_CONTEXT_NOTICE,
  resolveMaxActiveTranscriptBytes,
} from "../../context-engine/transcript-byte-limit.js";
import type { ContextEngineRuntimeContext } from "../../context-engine/types.js";
import { DEFAULT_CONTEXT_TOKENS } from "../defaults.js";
import { requireCompactionWriterEntry } from "../embedded-agent-runner/compaction-successor.js";
import { attachCompactionAccountingRecorder } from "../embedded-agent-runner/run/compaction-accounting-bridge.js";
import type { EmbeddedRunAttemptInternalParams } from "../embedded-agent-runner/run/internal-params.js";
import { normalizeContextTokenBudget } from "../embedded-agent-runner/utils.js";
import { SessionManager } from "../sessions/session-manager.js";
import type {
  AgentHarnessHostCapabilities,
  AgentHarnessContextMedia,
  AgentHarnessContextMediaRequest,
} from "./host-capability-types.js";

type SeedSourceScope = <T>(run: () => Promise<T>, signal?: AbortSignal) => Promise<T>;

/** The admitted host owns summary persistence; native threads only consume the bounded view. */
export function bindBoundedSeed(
  input: Partial<EmbeddedRunAttemptInternalParams>,
  assertActive: () => void,
  withSource: SeedSourceScope,
  hostSignal?: AbortSignal,
  media?: { capabilities: Pick<AgentHarnessHostCapabilities, "prepareContextMedia"> },
): Pick<AgentHarnessHostCapabilities, "prepareBoundedSeed" | "prepareContextMedia"> | undefined {
  const { config, workspaceDir, contextEngine } = input;
  const target = input.preparedSessionTarget?.target ?? input.sessionTarget;
  const maxBytes = resolveMaxActiveTranscriptBytes(config);
  if (
    !target?.agentId ||
    !target.sessionId ||
    !target.sessionKey ||
    !target.storePath ||
    !workspaceDir ||
    maxBytes === undefined ||
    contextEngine?.info.ownsCompaction ||
    (contextEngine && contextEngine.info.id !== "legacy")
  ) {
    return undefined;
  }
  const hostTokenBudget =
    normalizeContextTokenBudget(input.contextTokenBudget) || DEFAULT_CONTEXT_TOKENS;
  const sessionTarget = {
    ...target,
    agentId: target.agentId,
    sessionId: target.sessionId,
    sessionKey: target.sessionKey,
    storePath: target.storePath,
  };
  const attempt = {
    ...input,
    sessionTarget,
    abortSignal: hostSignal
      ? input.abortSignal
        ? AbortSignal.any([hostSignal, input.abortSignal])
        : hostSignal
      : input.abortSignal,
  };
  const prepareMedia = media?.capabilities.prepareContextMedia;
  const preparedMedia = new WeakMap<AgentMessage, AgentHarnessContextMedia>();
  const assertSource = () => {
    assertActive();
    attempt.abortSignal?.throwIfAborted();
    attempt.preparedSessionTarget?.assertCurrent();
  };
  const prepare: NonNullable<AgentHarnessHostCapabilities["prepareBoundedSeed"]> = async ({
    assertCurrent,
    signal: callerSignal,
    tokenBudget: requestedTokenBudget,
  }) => {
    const signal =
      callerSignal && attempt.abortSignal
        ? AbortSignal.any([callerSignal, attempt.abortSignal])
        : (callerSignal ?? attempt.abortSignal);
    const assert = () => {
      signal?.throwIfAborted();
      assertSource();
      assertCurrent();
    };
    assert();
    const admission = attempt.userTurnTranscriptRecorder?.getAdmissionReceipt();
    const requested = normalizeContextTokenBudget(requestedTokenBudget);
    const tokenBudget = requested && requested < hostTokenBudget ? requested : hostTokenBudget;
    const maxSeedBytes = Math.min(maxBytes, tokenBudget * 4);
    const admittedKey =
      admission?.idempotencyKey ?? attempt.userTurnTranscriptRecorder?.message?.idempotencyKey;
    const isAdmittedUser = (message: AgentMessage) =>
      message.role === "user" &&
      Boolean(admittedKey) &&
      Reflect.get(message, "idempotencyKey") === admittedKey;
    const refresh = attempt.pluginRuntimeRefreshMessages;
    const handoff =
      refresh || attempt.continuation
        ? [...(refresh ?? []), ...(attempt.continuation?.messages ?? [])]
        : undefined;
    let activeCount = 0;
    let omitted = 0;
    const read = async () => {
      const history = await SessionManager.readSessionContextAsync(
        sessionTarget,
        (items) => Array.from(items),
        { signal },
      );
      assert();
      if (handoff) {
        const current = history.findIndex(isAdmittedUser);
        const active = [
          ...(refresh && current >= 0 && !handoff.some(isAdmittedUser) ? [history[current]!] : []),
          ...handoff,
        ];
        activeCount = active.length;
        return [...(current < 0 ? history : history.slice(0, current)), ...active];
      }
      return history.filter((message) => !isAdmittedUser(message));
    };
    const select = async (messages: AgentMessage[]) => {
      omitted = 0;
      const history = activeCount ? messages.slice(0, -activeCount) : messages;
      const active = activeCount ? messages.slice(-activeCount) : [];
      const bounded = boundContextEngineAssembly(
        { messages: history, estimatedTokens: 0 },
        maxSeedBytes,
        tokenBudget,
      );
      if (!prepareMedia && !activeCount && bounded.messages.length === history.length) {
        return bounded.messages;
      }
      const additionalBytes = new Map<AgentMessage, number>();
      if (prepareMedia) {
        for (const message of activeCount ? [...bounded.messages, ...active] : bounded.messages) {
          if (message.role !== "user") {
            continue;
          }
          const prepared = await prepareMedia({ message, maxChars: tokenBudget * 4 });
          assert();
          preparedMedia.set(message, prepared);
          additionalBytes.set(
            message,
            Buffer.byteLength(prepared.text ?? "", "utf8") +
              (prepared.text ? 2 : 0) +
              prepared.images.length * IMAGE_BLOCK_TOKENS * 4,
          );
        }
      }
      // The active exchange is not discardable history, but still consumes delivery capacity.
      const activeTokens = active.reduce(
        (sum, message) =>
          sum + estimateTokens(message) + Math.ceil((additionalBytes.get(message) ?? 0) / 4),
        0,
      );
      if (activeTokens > tokenBudget) {
        throw new Error("Active native continuation exceeds the history delivery allowance");
      }
      let remainingTokens = tokenBudget - activeTokens;
      let bytes = Math.min(maxBytes, remainingTokens * 4);
      const boundHistory = () =>
        boundContextEngineAssembly(bounded, bytes, remainingTokens, additionalBytes).messages;
      let retained = boundHistory();
      omitted = history.length - retained.length;
      if (omitted) {
        const notice: AgentMessage = {
          role: "user",
          content: BOUNDED_CONTEXT_NOTICE,
          timestamp: 0,
        };
        remainingTokens -= estimateTokens(notice);
        bytes = Math.min(
          maxBytes - Buffer.byteLength(JSON.stringify(notice)) - 1,
          remainingTokens * 4,
        );
        if (bytes < 2) {
          throw new Error("Native history allowance cannot fit its omission notice");
        }
        retained = boundHistory();
        omitted = history.length - retained.length;
        return [notice, ...retained, ...active];
      }
      return activeCount ? [...retained, ...active] : retained;
    };
    let messages = await read();
    let bounded = await select(messages);
    if (
      config?.agents?.defaults?.compaction?.enabled !== false &&
      messages.slice(0, omitted).some((message) => message.role !== "compactionSummary")
    ) {
      const entry = await readSessionEntryReadOnlyInWorker(
        { ...sessionTarget, readConsistency: "latest" },
        assert,
      );
      if (!entry || entry.sessionId !== sessionTarget.sessionId) {
        throw new Error("Session changed before preparing native thread history");
      }
      const expected = {
        sessionId: sessionTarget.sessionId,
        lifecycleRevision: sessionTarget.expectedLifecycleRevision ?? entry.lifecycleRevision,
        activeWriterRunId: sessionTarget.expectedWriterRunId ?? entry.activeWriterRunId,
      };
      requireCompactionWriterEntry(entry, expected);
      const writeTarget = {
        ...sessionTarget,
        expectedLifecycleRevision: expected.lifecycleRevision,
        expectedWriterRunId: expected.activeWriterRunId,
        expectedOwner: expected,
      };
      const runtimeContext: ContextEngineRuntimeContext = {};
      attachCompactionAccountingRecorder(runtimeContext, {
        pendingRequestState: "unresolved",
        pendingUserEntryId: admission?.entryId,
      });
      // The compactor imports harness preparation; loading it eagerly creates a runtime cycle.
      const { compactEmbeddedAgentSessionDirect } =
        await import("../embedded-agent-runner/compact.js");
      assert();
      await withOwnedSessionTranscriptWrites(
        {
          sessionTarget: writeTarget,
          assertCommitAllowed: assert,
          withTranscriptWrite: async (run) => run(),
        },
        () =>
          compactEmbeddedAgentSessionDirect(
            {
              ...attempt,
              sessionId: sessionTarget.sessionId,
              sessionKey: sessionTarget.sessionKey,
              sessionFile: sessionTarget.sessionKey,
              sessionTarget,
              workspaceDir,
              model: attempt.modelId,
              senderId: attempt.senderId ?? undefined,
              senderName: attempt.senderName ?? undefined,
              senderUsername: attempt.senderUsername ?? undefined,
              senderE164: attempt.senderE164 ?? undefined,
              contextEngineRuntimeContext: runtimeContext,
              trigger: "budget",
              abortSignal: signal,
            },
            (prepared) =>
              persistCompactionBoundaryWithSessionEntryAsync(writeTarget, { prepared }, assert),
          ),
      );
      assert();
      messages = await read();
      bounded = await select(messages);
    }
    assert();
    if (omitted) {
      await attempt.onAgentEvent?.({ stream: "compaction", data: { phase: "context_bounded" } });
      assert();
    }
    return bounded;
  };
  return {
    prepareBoundedSeed: (request) => withSource(() => prepare(request), request.signal),
    prepareContextMedia:
      prepareMedia &&
      (async (request: AgentHarnessContextMediaRequest) => {
        assertSource();
        const prepared = preparedMedia.get(request.message) ?? (await prepareMedia(request));
        assertSource();
        return prepared;
      }),
  };
}
