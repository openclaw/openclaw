// Codex-specific outbound-event classifier.
//
// Codex app-server emits multiple assistant items per turn. Intermediate
// `agentMessage` items carry coordination/progress prose that the operator
// should NOT see as a final reply. Only the last assistant item of a turn
// — signaled by turn completion — is the user-visible final_reply.
//
// This module is the single source of truth for converting a Codex event
// payload into a MessageClass. It is pure so core can import and call it when
// relaying codex_app_server.* events into the system-event queue in a future
// phase. Today's relay only consumes the provider-agnostic "assistant" and
// "lifecycle" streams, so this file's direct consumer is its colocated tests
// plus future relay wiring.
//
// Why not import `MessageClass` from the plugin SDK? MessageClass is a closed
// string-literal union that does not cross a bundled-plugin boundary. Copying
// the literal set locally keeps extension → core import topology shallow and
// avoids pulling the classifier module into hot plugin-loading paths. The
// `satisfies` check below keeps the two in sync at compile time without a
// runtime dependency.

// Locally-scoped union. Kept in lockstep with src/infra/outbound/message-class.ts
// via the `satisfies` check on CODEX_STREAM_CLASSIFIERS.
export type CodexMessageClass =
  | "final_reply"
  | "progress"
  | "completion"
  | "internal_narration"
  | "resume"
  | "boot"
  | "blocked";

export type CodexEventLike = {
  stream: string;
  data?: unknown;
};

export type CodexTurnContext = {
  // True when the Codex turn has completed and the current assistant item is
  // the terminal assistant message for the turn. Callers compute this from
  // `turn/completed` / `item/completed` ordering upstream.
  isTurnEnd?: boolean;
};

export type CodexEventClassifier = (
  event: CodexEventLike,
  turnContext?: CodexTurnContext,
) => CodexMessageClass;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// Detect the Codex-native item type. Codex emits these as top-level `data.type`
// on `codex_app_server.item` events. See extensions/codex/src/app-server/
// event-projector.ts for the emission sites. Item types observed in practice:
// agentMessage, reasoning, plan, tool_call, tool_result, contextCompaction.
function readItemType(event: CodexEventLike): string | undefined {
  if (!isRecord(event.data)) {
    return undefined;
  }
  const direct = readString(event.data, "type");
  if (direct) {
    return direct;
  }
  // Some internal call sites nest the item under `.item` — tolerate that shape
  // for future-compat.
  const nested = event.data.item;
  if (isRecord(nested)) {
    return readString(nested, "type");
  }
  return undefined;
}

function readItemPhase(event: CodexEventLike): string | undefined {
  if (!isRecord(event.data)) {
    return undefined;
  }
  return readString(event.data, "phase");
}

// The assistant-visible user-input blocked heuristic. Kept conservative —
// false negatives only downgrade to final_reply, which is still user-visible.
// False positives would re-surface noise that the surface-policy predicate
// promised to never hide (blocked ALWAYS delivers), so the pattern set stays
// small. Mirrors the tighter set in message-class.ts.
const BLOCKED_HEURISTICS: ReadonlyArray<RegExp> = [
  /\bi['’]m blocked\b/i,
  /\bi am blocked\b/i,
  /\bshould i\b[^.?!]*\?/i,
  /\bneed (?:your )?(?:input|guidance|decision)\b/i,
  /\bwaiting (?:on|for) (?:you|input|approval)\b/i,
];

function detectBlocked(text: string | undefined): boolean {
  if (!text) {
    return false;
  }
  for (const pattern of BLOCKED_HEURISTICS) {
    if (pattern.test(text)) {
      return true;
    }
  }
  return false;
}

function readAssistantText(event: CodexEventLike): string | undefined {
  if (!isRecord(event.data)) {
    return undefined;
  }
  const direct = readString(event.data, "text");
  if (direct) {
    return direct;
  }
  const nested = event.data.item;
  if (isRecord(nested)) {
    return readString(nested, "text");
  }
  return undefined;
}

// Codex `codex_app_server.item` classifier.
//
// - `agentMessage` items are Codex's assistant prose. On turn end → final_reply;
//   on intermediate (completed but NOT turn-end, or start) → progress.
// - `reasoning`, `plan`, `tool_call`, `tool_result`, `contextCompaction` are
//   always internal. Blocked-prompt heuristic still applies to agentMessage
//   text.
function classifyCodexItem(
  event: CodexEventLike,
  turnContext?: CodexTurnContext,
): CodexMessageClass {
  const itemType = readItemType(event);
  const phase = readItemPhase(event);

  if (itemType === "agentMessage") {
    // Blocked-heuristic escalation: any assistant item asking for input MUST
    // surface, regardless of turn position, so the Blocked-Child Protocol
    // invariant holds.
    if (detectBlocked(readAssistantText(event))) {
      return "blocked";
    }
    // Turn-end final assistant message → final_reply. Otherwise progress.
    if (turnContext?.isTurnEnd && phase === "completed") {
      return "final_reply";
    }
    return "progress";
  }

  // plan / reasoning updates are developer-facing narration, never a user
  // reply.
  return "internal_narration";
}

// Known Codex-specific streams. Additional streams should be added here as
// they are introduced in extensions/codex/src/app-server/event-projector.ts.
export const CODEX_STREAM_CLASSIFIERS = {
  "codex_app_server.item": classifyCodexItem,
  "codex_app_server.guardian": (() => "internal_narration") as CodexEventClassifier,
  "codex_app_server.tool": (() => "internal_narration") as CodexEventClassifier,
  compaction: (() => "internal_narration") as CodexEventClassifier,
} as const satisfies Record<string, CodexEventClassifier>;

export type CodexClassifiedStream = keyof typeof CODEX_STREAM_CLASSIFIERS;

// Fail-closed wrapper: any unknown stream, or any exception thrown by a
// per-stream classifier, resolves to internal_narration. Callers never need
// to defensively wrap this call.
export function classifyCodexEvent(
  event: CodexEventLike,
  turnContext?: CodexTurnContext,
): CodexMessageClass {
  const classifier = (CODEX_STREAM_CLASSIFIERS as Record<string, CodexEventClassifier | undefined>)[
    event.stream
  ];
  if (!classifier) {
    return "internal_narration";
  }
  try {
    return classifier(event, turnContext);
  } catch {
    return "internal_narration";
  }
}

// Does this stream belong to the Codex-specific event vocabulary? Used by
// core relay dispatch to pick between the provider-agnostic allowlist and
// the Codex-native classifier.
export function isCodexStream(stream: string): boolean {
  return Object.prototype.hasOwnProperty.call(CODEX_STREAM_CLASSIFIERS, stream);
}
