import { floorPositiveFiniteNumber } from "@openclaw/normalization-core/number-coercion";
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
import { formatErrorMessage } from "../../infra/errors.js";
import { DEFAULT_CONTEXT_TOKENS } from "../defaults.js";
import { requireCompactionWriterEntry } from "../embedded-agent-runner/compaction-successor.js";
import { log } from "../embedded-agent-runner/logger.js";
import { attachCompactionAccountingRecorder } from "../embedded-agent-runner/run/compaction-accounting-bridge.js";
import type { EmbeddedRunAttemptInternalParams } from "../embedded-agent-runner/run/internal-params.js";
import {
  createCompactionRequestBudget,
  estimateCompactionHistoryTokens,
} from "../sessions/compaction/request-budget.js";
import { SessionManager } from "../sessions/session-manager.js";
import type {
  AgentHarnessHostCapabilities,
  AgentHarnessContextMedia,
  AgentHarnessContextMediaRequest,
} from "./host-capability-types.js";

type SeedSourceScope = <T>(run: () => Promise<T>, signal?: AbortSignal) => Promise<T>;

function combineSignals(first?: AbortSignal, second?: AbortSignal) {
  return first && second ? AbortSignal.any([first, second]) : (first ?? second);
}

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
  const { agentId, sessionId, sessionKey, storePath } = target ?? {};
  const maxBytes = resolveMaxActiveTranscriptBytes(config);
  if (
    !target ||
    !agentId ||
    !sessionId ||
    !sessionKey ||
    !storePath ||
    !workspaceDir ||
    maxBytes === undefined ||
    (contextEngine && contextEngine.info.id !== "legacy")
  ) {
    return undefined;
  }
  const hostTokenBudget =
    floorPositiveFiniteNumber(input.contextTokenBudget) || DEFAULT_CONTEXT_TOKENS;
  const sessionTarget = { ...target, agentId, sessionId, sessionKey, storePath };
  const attempt = {
    ...input,
    sessionTarget,
    abortSignal: combineSignals(hostSignal, input.abortSignal),
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
    const signal = combineSignals(callerSignal, attempt.abortSignal);
    const assert = () => {
      signal?.throwIfAborted();
      assertSource();
      assertCurrent();
    };
    assert();
    const admission = attempt.userTurnTranscriptRecorder?.getAdmissionReceipt();
    const requested = floorPositiveFiniteNumber(requestedTokenBudget);
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
    let cut = 0;
    let retainedInputTokens = 0;
    let retainedHistoryTokens = 0;
    const read = async () => {
      const history = await SessionManager.readSessionContextAsync(
        sessionTarget,
        (items) => Array.from(items),
        { signal },
      );
      assert();
      const current = history.findIndex(isAdmittedUser);
      retainedInputTokens = estimateCompactionHistoryTokens(
        current < 0 ? [] : history.slice(current),
      );
      if (handoff) {
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
      cut = 0;
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
          if (message.role !== "user" && message.role !== "assistant") {
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
      cut = history.length - retained.length;
      if (cut) {
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
        retainedHistoryTokens = Math.floor(bytes / 4);
        // A retained oversized turn must not crowd out the summary that covers its older history.
        const summary = history.findLast((message) => message.role === "compactionSummary");
        const summaryBytes = summary ? Buffer.byteLength(JSON.stringify(summary)) + 1 : 0;
        const summaryTokens = summary ? estimateTokens(summary) : 0;
        const prefix =
          summary && summaryBytes + 2 <= bytes && summaryTokens <= remainingTokens ? [summary] : [];
        bytes -= prefix.length ? summaryBytes : 0;
        remainingTokens -= prefix.length ? summaryTokens : 0;
        if (prefix.length) {
          bounded.messages = bounded.messages.filter((message) => message !== summary);
        }
        retained = boundHistory();
        cut = history.length - retained.length;
        return [notice, ...prefix, ...retained, ...active];
      }
      return activeCount ? [...retained, ...active] : retained;
    };
    let messages = await read();
    let bounded = await select(messages);
    if (
      config?.agents?.defaults?.compaction?.enabled !== false &&
      messages.slice(0, cut).some((message) => message.role !== "compactionSummary")
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
        // Select the verbatim tail against the seed's allowance, not the model's larger window.
        requestBudget: createCompactionRequestBudget({
          contextWindow: retainedInputTokens + retainedHistoryTokens,
          reserveTokens: 0,
        }),
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
              persistCompactionBoundaryWithSessionEntryAsync(
                writeTarget,
                { prepared, transcriptByteCompactionLatch: null },
                assert,
              ),
          ),
      );
      assert();
      messages = await read();
      bounded = await select(messages);
    }
    assert();
    if (cut) {
      // The host observer is advisory. Its failure must not abort the turn.
      try {
        await attempt.onAgentEvent?.({ stream: "compaction", data: { phase: "context_bounded" } });
      } catch (error) {
        log.warn(`bounded seed observer failed: ${formatErrorMessage(error)}`);
      }
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
