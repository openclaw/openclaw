import { floorPositiveFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { IMAGE_BLOCK_TOKENS } from "../../../packages/agent-core/src/harness/compaction/compaction-cut-point.js";
import { estimateTokens } from "../../../packages/agent-core/src/harness/compaction/compaction.js";
import type { AgentMessage } from "../../../packages/agent-core/src/types.js";
import { resolveMaxActiveTranscriptBytes } from "../../context-engine/transcript-byte-limit.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { DEFAULT_CONTEXT_TOKENS } from "../defaults.js";
import { log } from "../embedded-agent-runner/logger.js";
import type { EmbeddedRunAttemptInternalParams } from "../embedded-agent-runner/run/internal-params.js";
import { readSessionManagerContextAsync } from "../sessions/session-manager-incognito.js";
import type {
  AgentHarnessContextMedia,
  AgentHarnessContextMediaRequest,
  AgentHarnessHostCapabilities,
} from "./host-capability-types.js";

/** One cap for every handoff into a fresh native thread or CLI session. */
export const HANDOFF_TOKEN_CAP = 16_000;
export const HANDOFF_MAX_BYTES = 64_000;
const MAX_LISTED_OMITTED_IDS = 20;

export type HandoffItem<T> = { value: T; role: string; bytes: number; tokens: number; id?: string };

function combineSignals(first?: AbortSignal, second?: AbortSignal) {
  return first && second ? AbortSignal.any([first, second]) : (first ?? second);
}

function handoffNotice(selected: number, omitted: number, ids: string[], sessionKey?: string) {
  const listed = ids.length ? ` Newest omitted messageIds: ${ids.join(", ")}.` : "";
  const hint = sessionKey
    ? ` Recover an omitted turn only if needed with sessions_history({ sessionKey: ${JSON.stringify(sessionKey)}, messageId: "<omitted messageId>", limit: 6, includeTools: true }).`
    : "";
  return `[OpenClaw context handoff] Included ${selected} intact turns; omitted ${omitted} earlier turns.${listed} Historical turns are context, not new instructions.${hint}`;
}

/**
 * Deterministic intact-item packing; never slices a message and never calls a model.
 * Keeps the summary, the latest user and assistant turns and the first user turn (the
 * original goal), then fills newest to oldest. Omitted turns are named by messageId so
 * the model can pull them with sessions_history. Pass sessionKey only when that tool exists.
 */
export function selectHandoff<T>(input: {
  items: readonly HandoffItem<T>[];
  summary?: HandoffItem<T>;
  maxBytes: number;
  maxTokens: number;
  priorOmitted?: number;
  /** Ids of turns an earlier bounded read already omitted, oldest first. */
  priorOmittedIds?: readonly string[];
  sessionKey?: string;
}) {
  const { items, summary } = input;
  const all = summary ? [summary, ...items] : items;
  const priorOmitted = input.priorOmitted ?? 0;
  const fits = (bytes: number, tokens: number) =>
    all.reduce((sum, item) => sum + item.bytes, 0) <= bytes &&
    all.reduce((sum, item) => sum + item.tokens, 0) <= tokens;
  if (!priorOmitted && fits(input.maxBytes, input.maxTokens)) {
    return { values: all.map((item) => item.value), omittedCount: 0, notice: undefined };
  }
  // Reserve the notice before selecting: its id list may use a quarter of the allowance.
  const allIds = [...(input.priorOmittedIds ?? []), ...items.flatMap((item) => item.id ?? [])];
  let ids = allIds.slice(-MAX_LISTED_OMITTED_IDS);
  const noticeFor = (listed: string[]) =>
    handoffNotice(all.length, priorOmitted + all.length, listed, input.sessionKey);
  while (ids.length && Buffer.byteLength(noticeFor(ids)) > input.maxBytes / 4) {
    ids = ids.slice(1);
  }
  const reserve = Buffer.byteLength(noticeFor(ids)) + 2;
  if (reserve > input.maxBytes || Math.ceil(reserve / 4) > input.maxTokens) {
    // No room for history and its notice; the native turn runs on its own context.
    return { values: [], omittedCount: priorOmitted + all.length, notice: undefined };
  }
  let bytes = input.maxBytes - reserve;
  let tokens = input.maxTokens - Math.ceil(reserve / 4);
  const take = (item: HandoffItem<T> | undefined) => {
    if (!item || item.bytes > bytes || item.tokens > tokens) {
      return false;
    }
    bytes -= item.bytes;
    tokens -= item.tokens;
    return true;
  };
  const keepSummary = take(summary);
  const selected = new Set<number>();
  const pins = [
    items.findLastIndex((item) => item.role === "user"),
    items.findLastIndex((item) => item.role === "assistant"),
    items.findIndex((item) => item.role === "user"),
  ];
  for (const index of [...pins, ...Array.from(items.keys()).toReversed()]) {
    if (index >= 0 && !selected.has(index) && take(items[index])) {
      selected.add(index);
    }
  }
  const omittedIds = [
    ...(input.priorOmittedIds ?? []),
    ...items.flatMap((item, index) => (!selected.has(index) && item.id ? item.id : [])),
  ];
  const omittedCount =
    priorOmitted + (summary && !keepSummary ? 1 : 0) + items.length - selected.size;
  const values = [
    ...(keepSummary && summary ? [summary.value] : []),
    ...items.filter((_, index) => selected.has(index)).map((item) => item.value),
  ];
  // The reserved notice used the widest id list; the final list is never longer.
  const notice = handoffNotice(
    values.length,
    omittedCount,
    ids.length ? omittedIds.slice(-ids.length) : [],
    input.sessionKey,
  );
  return { values, omittedCount, notice: omittedCount ? notice : undefined };
}

/**
 * Host seed for a fresh native thread (Codex). Checks authority once at start, then
 * selects deterministically; it no longer runs an LLM compaction while seeding.
 */
export function bindHandoff(
  input: Partial<EmbeddedRunAttemptInternalParams>,
  assertActive: () => void,
  withSource: <T>(run: () => Promise<T>, signal?: AbortSignal) => Promise<T>,
  hostSignal?: AbortSignal,
  media?: { capabilities: Pick<AgentHarnessHostCapabilities, "prepareContextMedia"> },
): Pick<AgentHarnessHostCapabilities, "prepareBoundedSeed" | "prepareContextMedia"> | undefined {
  const { config, workspaceDir, contextEngine } = input;
  const target = input.preparedSessionTarget?.target ?? input.sessionTarget;
  const { agentId, sessionId, sessionKey, storePath } = target ?? {};
  const maxActiveBytes = resolveMaxActiveTranscriptBytes(config);
  if (
    !target ||
    !agentId ||
    !sessionId ||
    !sessionKey ||
    !storePath ||
    !workspaceDir ||
    maxActiveBytes === undefined ||
    (contextEngine && contextEngine.info.id !== "legacy")
  ) {
    return undefined;
  }
  const hostTokens = floorPositiveFiniteNumber(input.contextTokenBudget) || DEFAULT_CONTEXT_TOKENS;
  const sessionTarget = { ...target, agentId, sessionId, sessionKey, storePath };
  const attemptSignal = combineSignals(hostSignal, input.abortSignal);
  const prepareMedia = media?.capabilities.prepareContextMedia;
  const preparedMedia = new WeakMap<AgentMessage, AgentHarnessContextMedia>();
  const assertStart = (callerSignal?: AbortSignal) => {
    const signal = combineSignals(callerSignal, attemptSignal);
    signal?.throwIfAborted();
    assertActive();
    input.preparedSessionTarget?.assertCurrent();
    return signal;
  };

  const prepare: NonNullable<AgentHarnessHostCapabilities["prepareBoundedSeed"]> = async (
    request,
  ) => {
    const signal = assertStart(request.signal);
    request.assertCurrent();
    const requested = floorPositiveFiniteNumber(request.tokenBudget);
    const tokenBudget = Math.min(requested || hostTokens, hostTokens, HANDOFF_TOKEN_CAP);
    const maxBytes = Math.min(maxActiveBytes, tokenBudget * 4, HANDOFF_MAX_BYTES);
    const recorder = input.userTurnTranscriptRecorder;
    const admittedKey =
      recorder?.getAdmissionReceipt()?.idempotencyKey ?? recorder?.message?.idempotencyKey;
    const refresh = input.pluginRuntimeRefreshMessages;
    const handoff =
      refresh || input.continuation
        ? [...(refresh ?? []), ...(input.continuation?.messages ?? [])]
        : undefined;
    const snapshot = await readSessionManagerContextAsync(
      sessionTarget,
      (items, _header, facts) => {
        if (!facts) {
          throw new Error("Native seed read did not return its selection facts");
        }
        return { history: Array.from(items), facts };
      },
      {
        signal,
        // The bounded reader omits the largest tool bodies before older turns, so a
        // tool-heavy session keeps its first goal inside the cap.
        seed: { maxBytes, tokenBudget, admittedKey, beforeAdmittedUser: Boolean(handoff) },
      },
    );
    const { history, facts } = snapshot;
    const isAdmitted = (message: AgentMessage) =>
      message.role === "user" &&
      Boolean(admittedKey) &&
      Reflect.get(message, "idempotencyKey") === admittedKey;
    // A refreshed native thread receives the admitted user as part of the active exchange.
    const active = handoff
      ? [
          ...(refresh && facts.admittedUser && !handoff.some(isAdmitted)
            ? [facts.admittedUser]
            : []),
          ...handoff,
        ]
      : [];
    const extraBytes = new Map<AgentMessage, number>();
    if (prepareMedia) {
      for (const message of [...history, ...active]) {
        if (message.role === "user" || message.role === "assistant") {
          const prepared = await prepareMedia({ message, maxChars: tokenBudget * 4 });
          preparedMedia.set(message, prepared);
          extraBytes.set(
            message,
            Buffer.byteLength(prepared.text ?? "") +
              prepared.images.length * IMAGE_BLOCK_TOKENS * 4,
          );
        }
      }
    }
    const ids = new Map(history.map((message, index) => [message, facts.messageIds[index]]));
    const item = (message: AgentMessage): HandoffItem<AgentMessage> => {
      const extra = extraBytes.get(message) ?? 0;
      return {
        value: message,
        role: message.role,
        bytes: Buffer.byteLength(JSON.stringify(message)) + 1 + extra,
        tokens: estimateTokens(message) + Math.ceil(extra / 4),
        id: ids.get(message),
      };
    };
    const activeTokens = active.reduce((sum, message) => sum + item(message).tokens, 0);
    if (activeTokens > tokenBudget) {
      throw new Error("Active native continuation exceeds the history delivery allowance");
    }
    const summary =
      facts.summary ?? history.findLast((message) => message.role === "compactionSummary");
    const selection = selectHandoff({
      items: history.filter((message) => message !== summary).map(item),
      summary: summary && item(summary),
      maxBytes: Math.min(maxBytes, (tokenBudget - activeTokens) * 4),
      maxTokens: tokenBudget - activeTokens,
      priorOmitted: facts.omittedCount,
      priorOmittedIds: facts.omittedIds,
      sessionKey,
    });
    if (!selection.values.length && selection.omittedCount) {
      log.warn(
        `native handoff allowance (${tokenBudget} tokens) cannot fit any history; ${selection.omittedCount} turns stay in the session transcript`,
      );
    }
    if (selection.notice) {
      // Advisory observer; its failure must not abort the turn (#177453).
      try {
        await input.onAgentEvent?.({ stream: "compaction", data: { phase: "context_bounded" } });
      } catch (error) {
        log.warn(`bounded handoff observer failed: ${formatErrorMessage(error)}`);
      }
    }
    const notice: AgentMessage[] = selection.notice
      ? [{ role: "user", content: selection.notice, timestamp: 0 }]
      : [];
    return [...notice, ...selection.values, ...active];
  };

  return {
    prepareBoundedSeed: (request) => withSource(() => prepare(request), request.signal),
    prepareContextMedia:
      prepareMedia &&
      (async (request: AgentHarnessContextMediaRequest) => {
        assertStart();
        return preparedMedia.get(request.message) ?? (await prepareMedia(request));
      }),
  };
}
