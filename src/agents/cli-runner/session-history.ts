import { timestampMsToIsoString } from "@openclaw/normalization-core/number-coercion";
import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  buildSessionContext,
  iterateSessionContextEntries,
} from "../../../packages/agent-core/src/harness/session/session.js";
import { selectResetKeptEntries } from "../../../packages/agent-core/src/harness/session/tool-result-pairing.js";
import {
  waitForSessionTranscriptProjection,
  type SessionTranscriptRuntimeTarget,
} from "../../config/sessions/session-accessor.js";
import {
  captureIncognitoSessionHistoryBinding,
  captureIncognitoSessionSource,
} from "../../config/sessions/session-incognito-binding.js";
import { SessionTranscriptStorageUnavailableError } from "../../config/sessions/session-transcript-projection-error.js";
import { resolveSessionTranscriptReadFence } from "../../config/sessions/session-transcript-read-fence.js";
import { readSessionTranscriptWatermarkAsync } from "../../config/sessions/session-transcript-watermark.js";
import {
  resolveAdmittedRunActiveAssertion,
  type AdmittedRunContext,
} from "../admitted-run-context.js";
import { estimateToolResultTextChars } from "../embedded-agent-runner/tool-result-text-budget.js";
import { MAX_AGENT_HOOK_HISTORY_MESSAGES } from "../harness/hook-history.js";
import { isOpenClawRuntimeContextCustomMessage } from "../internal-runtime-context.js";
import { wrapUntrustedPromptDataBlock } from "../sanitize-for-prompt.js";
import {
  SessionManager,
  type SessionEntry,
  type SessionMessageEntry,
} from "../sessions/session-manager.js";
import { cliBackendLog } from "./log.js";

const MAX_CLI_SESSION_HISTORY_BYTES = 5 * 1024 * 1024;
const MAX_CLI_SESSION_HISTORY_MESSAGES = MAX_AGENT_HOOK_HISTORY_MESSAGES;
// Reseeding uses a context-derived budget bounded by these floor and ceiling values.
const MAX_CLI_SESSION_RESEED_HISTORY_CHARS = 12 * 1024;
const MAX_AUTO_CLI_SESSION_RESEED_HISTORY_CHARS = 256 * 1024;
const CLI_SESSION_RESEED_HISTORY_CONTEXT_SHARE = 0.08;
const CHARS_PER_TOKEN_ESTIMATE = 4;
const MAX_CLI_SESSION_HISTORY_EVENTS = 10_000;
const MAX_CLI_DURABLE_CONTEXT_CHARS = 2_000;
const CLI_DURABLE_CONTEXT_OMISSION = "[Session notes truncated; earlier notes may be omitted.]";

type CliSessionHistoryParams = {
  abortSignal?: AbortSignal;
  sessionManager?: SessionManager;
  sessionTarget?: SessionTranscriptRuntimeTarget;
};
const CLI_SESSION_RESEED_CURRENCY_GUIDANCE =
  "[Recovered history may be stale; verify current and time-sensitive facts before acting.]";

type HistoryMessage = {
  role?: unknown;
  content?: unknown;
  summary?: unknown;
  toolName?: unknown;
  isError?: unknown;
  timestamp?: unknown;
};
type RawTranscriptReseedReason =
  | "auth-unknown"
  | "auth-profile"
  | "auth-epoch"
  | "message-policy"
  | "system-prompt"
  | "cwd"
  | "mcp"
  | "missing-transcript"
  | "orphaned-tool-use"
  | "session-expired"
  | "stateless";

export function resolveAutoCliSessionReseedHistoryChars(contextWindowTokens: number): number {
  if (!Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0) {
    return MAX_CLI_SESSION_RESEED_HISTORY_CHARS;
  }
  const contextShareChars = Math.floor(
    contextWindowTokens * CLI_SESSION_RESEED_HISTORY_CONTEXT_SHARE * CHARS_PER_TOKEN_ESTIMATE,
  );
  return Math.max(
    MAX_CLI_SESSION_RESEED_HISTORY_CHARS,
    Math.min(MAX_AUTO_CLI_SESSION_RESEED_HISTORY_CHARS, contextShareChars),
  );
}

function coerceHistoryText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((block) => {
      if (!block || typeof block !== "object") {
        return [];
      }
      const text = (block as { text?: unknown }).text;
      return typeof text === "string" && text.trim().length > 0 ? [text.trim()] : [];
    })
    .join("\n")
    .trim();
}

function formatHistoryTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const timestamp = timestampMsToIsoString(Date.parse(value));
  return timestamp === value ? timestamp : undefined;
}

function renderHistoryMessage(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const entry = message as HistoryMessage;
  const role =
    entry.role === "assistant"
      ? "Assistant"
      : entry.role === "user"
        ? "User"
        : entry.role === "toolResult"
          ? `Tool result${typeof entry.toolName === "string" ? ` (${entry.toolName})` : ""}${entry.isError === true ? " [error]" : ""}`
          : entry.role === "compactionSummary"
            ? "Compaction summary"
            : undefined;
  if (!role) {
    return undefined;
  }
  const text =
    entry.role === "compactionSummary" && typeof entry.summary === "string"
      ? entry.summary.trim()
      : coerceHistoryText(entry.content);
  if (!text) {
    return undefined;
  }
  const timestamp = formatHistoryTimestamp(entry.timestamp);
  return `${timestamp ? `[${timestamp}] ` : ""}${role}: ${text}`;
}

export function buildCliSessionHistoryPrompt(params: {
  messages: unknown[];
  prompt: string;
  maxHistoryChars?: number;
}): string | undefined {
  const maxHistoryChars = params.maxHistoryChars ?? MAX_CLI_SESSION_RESEED_HISTORY_CHARS;
  const historyBudget = maxHistoryChars - CLI_SESSION_RESEED_CURRENCY_GUIDANCE.length - "\n".length;
  if (historyBudget <= 0) {
    return undefined;
  }

  // Pin the leading compaction summary; tail-slicing the whole transcript would
  // discard it whenever the recent turns exceed the budget.
  const firstEntry = params.messages[0];
  const firstIsCompaction =
    Boolean(firstEntry) &&
    typeof firstEntry === "object" &&
    (firstEntry as HistoryMessage).role === "compactionSummary";
  const summaryRendered = firstIsCompaction ? renderHistoryMessage(firstEntry) : undefined;
  const tailMessages = firstIsCompaction ? params.messages.slice(1) : params.messages;

  const tailRaw = tailMessages.map(renderHistoryMessage).filter(Boolean).join("\n\n").trim();

  const truncationMarker = "[OpenClaw reseed history truncated; older turns dropped]";
  const renderTruncatedTail = (raw: string, budget: number): string => {
    if (budget <= truncationMarker.length + "\n".length) {
      return sliceUtf16Safe(raw, -budget).trimStart();
    }
    const tailBudget = budget - truncationMarker.length - "\n".length;
    return `${truncationMarker}\n${sliceUtf16Safe(raw, -tailBudget).trimStart()}`;
  };
  const renderTruncatedSummaryWithTail = (renderedSummary: string): string => {
    if (historyBudget <= truncationMarker.length + "\n".length) {
      return tailRaw.length > 0
        ? sliceUtf16Safe(tailRaw, -historyBudget).trimStart()
        : truncateUtf16Safe(renderedSummary, historyBudget).trimEnd();
    }
    const tailBudget =
      tailRaw.length > 0 ? Math.min(tailRaw.length, Math.floor(historyBudget / 2)) : 0;
    const separatorBudget = tailBudget > 0 ? 2 : 1;
    const summaryBudget = Math.max(
      0,
      historyBudget - truncationMarker.length - separatorBudget - tailBudget,
    );
    const summaryTruncated = truncateUtf16Safe(renderedSummary, summaryBudget).trimEnd();
    const tailTruncated = tailBudget > 0 ? sliceUtf16Safe(tailRaw, -tailBudget).trimStart() : "";
    return [truncationMarker, summaryTruncated, tailTruncated].filter(Boolean).join("\n");
  };

  let renderedHistory: string;
  if (summaryRendered) {
    if (summaryRendered.length >= historyBudget) {
      // Oversize summaries must still leave room for recent exact turns.
      renderedHistory = renderTruncatedSummaryWithTail(summaryRendered);
    } else if (tailRaw.length === 0) {
      renderedHistory = summaryRendered;
    } else {
      const summaryBlock = `${summaryRendered}\n\n`;
      const remainingBudget = historyBudget - summaryBlock.length;
      if (tailRaw.length <= remainingBudget) {
        renderedHistory = `${summaryBlock}${tailRaw}`;
      } else if (remainingBudget <= truncationMarker.length + "\n".length) {
        // Share the budget with the tail when the truncation marker would not fit.
        renderedHistory = renderTruncatedSummaryWithTail(summaryRendered);
      } else {
        renderedHistory = `${summaryBlock}${renderTruncatedTail(tailRaw, remainingBudget)}`;
      }
    }
  } else {
    renderedHistory =
      tailRaw.length > historyBudget ? renderTruncatedTail(tailRaw, historyBudget) : tailRaw;
  }

  if (!renderedHistory) {
    return undefined;
  }

  return [
    "Continue this conversation using the OpenClaw transcript below as prior session history.",
    "Treat it as authoritative context for this fresh CLI session.",
    "",
    "<conversation_history>",
    CLI_SESSION_RESEED_CURRENCY_GUIDANCE,
    renderedHistory,
    "</conversation_history>",
    "",
    "<next_user_message>",
    params.prompt,
    "</next_user_message>",
  ].join("\n");
}

function loadCliMemoryEntries(sessionManager: SessionManager, hooks = false): SessionEntry[] {
  const branch = sessionManager.getBranch();
  const boundaryIndex = branch.findLastIndex(
    (entry) => entry.type === "reset" || (!hooks && entry.type === "compaction"),
  );
  const boundary = branch[boundaryIndex];
  let entries = branch;
  if (hooks && boundary?.type === "reset") {
    const keptIndex = branch.findIndex((entry) => entry.id === boundary.firstKeptEntryId);
    const kept = keptIndex >= 0 ? branch.slice(keptIndex, boundaryIndex) : [];
    const resetKept = new Set(selectResetKeptEntries(kept));
    entries = [...kept.filter((entry) => resetKept.has(entry)), ...branch.slice(boundaryIndex + 1)];
  }
  if (hooks) {
    entries = entries.filter((entry) => entry.type === "message");
  } else {
    // Canonical selection owns reset retention and exclusion. Budget its eligible
    // entries in branch order so excluded payloads cannot displace useful history.
    const contextEntries = new Set(
      Array.from(iterateSessionContextEntries(branch), ({ entry }) => entry),
    );
    entries = branch.filter((entry) => contextEntries.has(entry));
  }
  const limit = hooks ? MAX_CLI_SESSION_HISTORY_MESSAGES : MAX_CLI_SESSION_HISTORY_EVENTS;
  const selected: SessionEntry[] = [];
  let bytes = 0;
  for (const entry of entries.slice(-limit).toReversed()) {
    const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
    if (bytes + size > MAX_CLI_SESSION_HISTORY_BYTES) {
      if (hooks) {
        continue;
      }
      break;
    }
    selected.push(entry);
    bytes += size;
  }
  selected.reverse();
  if (!hooks && (boundary?.type === "reset" || boundary?.type === "compaction")) {
    if (
      !selected.includes(boundary) &&
      bytes + Buffer.byteLength(JSON.stringify(boundary)) + 1 <= MAX_CLI_SESSION_HISTORY_BYTES
    ) {
      selected.unshift(boundary);
    }
    // A bounded cut may omit the original retained anchor. Advance it within the
    // selected retained range, never backward into summarized/reset history.
    const cut = selected.indexOf(boundary);
    if (cut >= 0) {
      selected[cut] = { ...boundary, firstKeptEntryId: selected[0]?.id ?? boundary.id };
    }
  }
  if (selected.length < entries.length) {
    cliBackendLog.warn("cli session history truncated to bounded caller-owned context");
  }
  return structuredClone(selected);
}

// Both owners return an ordered branch. Bounded omissions may leave parent IDs
// outside this view, so projection must not reconstruct ancestry a second time.
async function loadCliSessionEntries({
  sessionManager,
  sessionTarget,
  abortSignal,
}: CliSessionHistoryParams): Promise<SessionEntry[]> {
  abortSignal?.throwIfAborted();
  if (sessionManager) {
    return loadCliMemoryEntries(sessionManager);
  }
  if (!sessionTarget) {
    return [];
  }
  const admission = resolveSessionTranscriptReadFence(sessionTarget);
  const { restoreSessionColdTranscript } =
    await import("../../config/sessions/session-cold-storage.js");
  await restoreSessionColdTranscript(sessionTarget, () => abortSignal?.throwIfAborted());
  await waitForSessionTranscriptProjection(sessionTarget, abortSignal);
  // Normalize bounded cuts with opaque ancestry before rebuilding CLI context.
  try {
    return (
      await SessionManager.openBoundedAsync(sessionTarget, {
        signal: abortSignal,
        maxBytes: MAX_CLI_SESSION_HISTORY_BYTES,
        maxEvents: MAX_CLI_SESSION_HISTORY_EVENTS,
        onTruncated: () =>
          cliBackendLog.warn(
            `cli session history truncated to bounded active context: ${sessionTarget.sessionId}`,
          ),
      })
    ).getBranch();
  } catch (error) {
    if (
      error instanceof SessionTranscriptStorageUnavailableError &&
      error.reason === "database-missing" &&
      !admission
    ) {
      // History precedes the approved user-turn writer, which owns first-store creation.
      return [];
    }
    throw error;
  }
}

export async function hasCliSessionTranscript({
  sessionManager,
  sessionTarget,
  abortSignal,
}: CliSessionHistoryParams): Promise<boolean> {
  if (sessionManager) {
    return sessionManager.getEntries().length > 0;
  }
  const source = sessionTarget && captureIncognitoSessionSource(sessionTarget);
  if (source && "kind" in source) {
    abortSignal?.throwIfAborted();
    source.assertCurrent();
    return false;
  }
  return (
    sessionTarget !== undefined &&
    (await readSessionTranscriptWatermarkAsync(sessionTarget)).maxSeq !== null
  );
}

/** Loads reset-aware active transcript messages for CLI lifecycle hook context. */
export async function loadCliSessionHistoryMessages({
  sessionManager,
  sessionTarget,
  abortSignal,
}: CliSessionHistoryParams): Promise<unknown[]> {
  abortSignal?.throwIfAborted();
  if (sessionManager) {
    return loadCliMemoryEntries(sessionManager, true).flatMap((entry) =>
      entry.type === "message" ? [entry.message] : [],
    );
  }
  if (!sessionTarget) {
    return [];
  }
  const source = captureIncognitoSessionSource(sessionTarget);
  if (source && "kind" in source) {
    source.assertCurrent();
    return [];
  }
  const incognito = captureIncognitoSessionHistoryBinding(sessionTarget);
  const target = {
    ...sessionTarget,
    ...(incognito ? { storePath: incognito.actor.path } : {}),
  };
  const { restoreSessionColdTranscript } =
    await import("../../config/sessions/session-cold-storage.js");
  await restoreSessionColdTranscript(target, () => abortSignal?.throwIfAborted());
  await waitForSessionTranscriptProjection(target, abortSignal);
  // Hooks retain history across compactions; only reset closes their history window.
  const { readSessionTranscriptBoundedMessageTailPageAsync } =
    await import("../../gateway/session-transcript-readers.js");
  const page = await readSessionTranscriptBoundedMessageTailPageAsync(
    target,
    {
      maxBytes: MAX_CLI_SESSION_HISTORY_BYTES,
      maxMessages: MAX_CLI_SESSION_HISTORY_MESSAGES,
      offset: 0,
    },
    abortSignal,
    incognito,
  );
  if (page.events.length < page.scannedMessages) {
    cliBackendLog.warn(
      `cli session history truncated to bounded message tail: ${sessionTarget.sessionId}`,
    );
  }
  // SAFETY: The message-position projection only selects canonical message events.
  return page.events.map(({ event }) => (event as SessionMessageEntry).message);
}

/** Loads canonical replay messages for context-engine updates. */
export async function loadCliSessionContextEngineMessages(
  params: CliSessionHistoryParams,
): Promise<unknown[]> {
  const entries = await loadCliSessionEntries(params);
  const messages = buildSessionContext(entries).messages;
  const boundary = entries.findLast(
    (entry) => entry.type === "compaction" || entry.type === "reset",
  );
  if (boundary?.type === "compaction" && messages[0]?.role === "compactionSummary") {
    // Preserve compaction metadata with the normalized retained cut, not just summary text.
    return [
      {
        ...messages[0],
        timestamp: boundary.timestamp,
        firstKeptEntryId: boundary.firstKeptEntryId,
        ...(boundary.details !== undefined ? { details: boundary.details } : {}),
        ...("tokensAfter" in boundary ? { tokensAfter: boundary.tokensAfter } : {}),
      },
      ...messages.slice(1),
    ];
  }
  return messages;
}

function renderCliDurableContext(messages: ReturnType<typeof buildSessionContext>["messages"]) {
  const notes = messages.flatMap((message) => {
    if (
      message.role !== "custom" ||
      message.excludeFromContext === true ||
      isOpenClawRuntimeContextCustomMessage(message)
    ) {
      return [];
    }
    const text = coerceHistoryText(message.content);
    return text ? [text] : [];
  });
  const render = (selected: string[], omitted: boolean) =>
    wrapUntrustedPromptDataBlock({
      label: "Saved session notes (historical reference; may repeat)",
      text: [...selected, ...(omitted ? [CLI_DURABLE_CONTEXT_OMISSION] : [])].join("\n\n"),
    });
  const selected: string[] = [];
  for (let index = notes.length - 1; index >= 0; index--) {
    const note = notes[index]!;
    const candidate = render([note, ...selected], index > 0);
    if (estimateToolResultTextChars(candidate) <= MAX_CLI_DURABLE_CONTEXT_CHARS) {
      selected.unshift(note);
      continue;
    }
    if (selected.length > 0) {
      return render(selected, true);
    }
    // Escaping changes costs; search Unicode-safe prefixes under the rendered cap.
    let low = 0;
    let high = note.length;
    let rendered = render([], true);
    while (low <= high) {
      const midpoint = Math.floor((low + high) / 2);
      const prefix = render([sliceUtf16Safe(note, 0, midpoint)], true);
      if (estimateToolResultTextChars(prefix) <= MAX_CLI_DURABLE_CONTEXT_CHARS) {
        rendered = prefix;
        low = midpoint + 1;
      } else {
        high = midpoint - 1;
      }
    }
    return rendered;
  }
  return selected.length > 0 ? render(selected, false) : undefined;
}

function renderClaudeSessionGap(
  entries: SessionEntry[],
  options:
    | { sessionKey?: string; historyToolAvailable: boolean; freshSession: boolean }
    | undefined,
): string | undefined {
  if (!options) {
    return undefined;
  }
  // An empty Claude reply has no saved assistant row, so the next turn may repeat this note.
  const lastClaude = entries.findLastIndex(
    (entry) =>
      entry.type === "message" &&
      entry.message.role === "assistant" &&
      entry.message.provider === "claude-cli",
  );
  if (!options.freshSession && lastClaude < 0) {
    return undefined;
  }
  const gap = entries
    .slice(options.freshSession ? 0 : lastClaude + 1)
    .filter(
      (entry): entry is SessionMessageEntry =>
        entry.type === "message" &&
        (entry.message.role === "user" || entry.message.role === "assistant"),
    );
  const models = new Set<string>();
  for (const entry of gap) {
    if (entry.message.role === "assistant") {
      models.add(`${entry.message.provider}/${entry.message.model}`);
    }
  }
  const first = gap[0];
  const last = gap.at(-1);
  if (!first || !last || models.size === 0) {
    return undefined;
  }
  const modelNames = [...models].toSorted();
  const modelSummary = modelNames
    .slice(0, 4)
    .map((model) => JSON.stringify(truncateUtf16Safe(model, 120)))
    .join(", ");
  const readHint =
    options.historyToolAvailable && options.sessionKey
      ? ` Before answering a question that may depend on these messages, call mcp__openclaw__sessions_history(${JSON.stringify({ sessionKey: options.sessionKey, limit: 100 })}) to read them; page older messages with offset if needed.`
      : "";
  const description = options.freshSession
    ? "earlier messages in this chat"
    : "messages occurred outside this Claude session";
  return `[OpenClaw: ${gap.length} ${description} from ${first.timestamp} to ${last.timestamp}, using ${modelSummary}${modelNames.length > 4 ? ` (+${modelNames.length - 4} more models)` : ""}. Their contents are not included here.${readHint}]`;
}

/** Reads one active branch for bounded reference notes and eligible fresh-session history. */
export async function loadCliSessionPromptContext(
  params: CliSessionHistoryParams & {
    allowRawTranscriptReseed?: boolean;
    rawTranscriptReseedReason?: RawTranscriptReseedReason;
    admittedRunContext?: AdmittedRunContext;
    sessionId?: string;
    /** The native handle already accepted by the CLI reuse owner, never a fresh handle. */
    nativeSessionId?: string;
    provider?: string;
    sessionKey?: string;
    tools?: readonly { name: string }[];
  },
) {
  const assertActive =
    params.provider === "claude-cli" &&
    params.sessionTarget &&
    params.sessionId === params.sessionTarget.sessionId &&
    params.sessionKey === params.sessionTarget.sessionKey &&
    params.admittedRunContext
      ? resolveAdmittedRunActiveAssertion(params.admittedRunContext, params.abortSignal)
      : undefined;
  // e20b56c0b26 (#140294) still blocks raw content across accounts. Metadata
  // can point an admitted fresh session to on-demand, policy-controlled history.
  const contentBlocked =
    params.rawTranscriptReseedReason === "auth-profile" ||
    params.rawTranscriptReseedReason === "auth-epoch" ||
    params.rawTranscriptReseedReason === "auth-unknown";
  if (contentBlocked) {
    cliBackendLog.warn(
      `cli session history refused across auth boundary: reason=${params.rawTranscriptReseedReason}`,
    );
    if (!assertActive) {
      return {
        reseedMessages: [],
        durableContext: undefined,
        sessionGapContext: undefined,
      };
    }
  }
  assertActive?.();
  const entries = await loadCliSessionEntries(params);
  assertActive?.();
  const sessionGapContext = renderClaudeSessionGap(
    entries,
    assertActive &&
      ((!contentBlocked && params.nativeSessionId) ||
        params.rawTranscriptReseedReason === "auth-unknown" ||
        (contentBlocked && !params.nativeSessionId))
      ? {
          sessionKey: params.sessionKey,
          historyToolAvailable:
            params.tools?.some((tool) => tool.name === "sessions_history") === true,
          freshSession: !params.nativeSessionId,
        }
      : undefined,
  );
  if (contentBlocked) {
    return {
      reseedMessages: [],
      durableContext: undefined,
      sessionGapContext,
    };
  }
  // This freshly loaded branch is reseed-owned; use persistence rather than provider timestamps.
  for (const entry of entries) {
    if (entry.type === "message") {
      entry.message.timestamp = Date.parse(entry.timestamp);
    }
  }
  const historyMessages = buildSessionContext(entries).messages;
  // CLI bindings have no local-history coverage cursor. Reference notes are
  // bounded at-least-once context, never evidence that a native turn consumed them.
  const durableContext = renderCliDurableContext(historyMessages);
  const summary = historyMessages[0];
  const hasSummary = summary?.role === "compactionSummary" && summary.summary.trim().length > 0;
  if (
    !hasSummary &&
    !params.sessionManager &&
    (params.allowRawTranscriptReseed !== true || !params.rawTranscriptReseedReason)
  ) {
    return { reseedMessages: [], durableContext, sessionGapContext };
  }
  const history = historyMessages.filter(
    (message) =>
      message.role === "user" || message.role === "assistant" || message.role === "toolResult",
  );
  const selected = hasSummary
    ? [summary, ...history.slice(-(MAX_CLI_SESSION_HISTORY_MESSAGES - 1))]
    : history.slice(-MAX_CLI_SESSION_HISTORY_MESSAGES);
  // Bound the tail before projecting renderer fields; full replay records are unnecessary.
  const reseedMessages = selected.map((message) => {
    const timestamp = timestampMsToIsoString(message.timestamp);
    return message.role === "compactionSummary"
      ? { role: message.role, summary: message.summary.trim(), timestamp }
      : {
          role: message.role,
          content: message.content,
          timestamp,
          toolName: message.role === "toolResult" ? message.toolName : undefined,
          isError: message.role === "toolResult" ? message.isError : undefined,
        };
  });
  return { reseedMessages, durableContext, sessionGapContext };
}
