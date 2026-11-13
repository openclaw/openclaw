import { registerSessionResourceCleanup } from "@openclaw/ai/internal/runtime";
import type { Context, Message } from "../../llm/types.js";

/**
 * The one owner of a session's sent request prefix.
 *
 * Contract (docs/reference/prompt-caching.md#session-prefix-stability): within a series, a request
 * is the frozen system prompt and tools plus an append-only log. Upstream code proposes a context;
 * this owner re-sends the exact entries it already sent and appends only the entries it has not.
 *
 * The series' tool definitions are frozen at its first request. A turn that builds more tools (a
 * wake or handoff with a wider surface) does not extend them: the tool set must not depend on what
 * started a turn. Tools a turn did not build stay listed; the agent refuses their calls.
 *
 * A series starts again only when:
 * - the route or system prompt changes (`prefix`: a model or provider switch, a rebuilt system
 *   prompt after compaction, `/new` or a tool-policy change, or a side request with its own prefix);
 * - the proposed log no longer extends the sent log by entry identity (`history`: compaction,
 *   `/new`, `/reset`), or a sent tool result changed (a late real result replaced its placeholder:
 *   a correction the model must see, never drift);
 * - a caller requested it (`declared`: a provider rejected replayed history, context-overflow
 *   truncation, or idle pruning after the cache expired).
 *
 * Upstream transforms still re-derive history from the transcript on every attempt. Byte drift
 * they produce for an entry that was already sent is absorbed here and reported, so it can be found
 * and removed at its source.
 */
type SentSeries = { ids: string[]; messages: Message[]; tools: Context["tools"] };

export type SessionPrefixReport =
  | { kind: "first" }
  | { kind: "extended" }
  | { kind: "absorbed"; index: number; count: number; role: Message["role"] }
  | { kind: "toolsHeld"; added: string[] }
  | { kind: "rebuild"; reason: "prefix" | "history" | "declared"; index?: number };

type RouteModel = { provider: string; api: string; id: string; baseUrl?: string };

const MAX_SESSIONS = 64;
const MAX_LINEAGES_PER_SESSION = 4;
/** Per session, the sent series of each prefix lineage (main conversation and side requests). */
const sessions = new Map<string, Map<string, SentSeries>>();
const pendingRebuilds = new Set<string>();
const encoded = new WeakMap<object, string>();

/** The next request of this session starts a new series with exactly the proposed bytes. */
export function requestSessionPrefixRebuild(sessionId: string): void {
  pendingRebuilds.add(sessionId);
}

export function clearSessionPrefixSeries(sessionId?: string): void {
  if (sessionId === undefined) {
    sessions.clear();
    pendingRebuilds.clear();
    return;
  }
  sessions.delete(sessionId);
  pendingRebuilds.delete(sessionId);
}
// Session reset, Gateway shutdown and fork teardown release the sent prefix; warm turns keep it.
registerSessionResourceCleanup(clearSessionPrefixSeries);

function encode(value: object): string {
  let text = encoded.get(value);
  if (text === undefined) {
    text = JSON.stringify(value);
    encoded.set(value, text);
  }
  return text;
}

/** Stable identity of a log entry: who wrote it and when, never its bytes. */
function identities(messages: readonly Message[]): string[] {
  const seen = new Map<string, number>();
  return messages.map((message) => {
    const base =
      message.role === "toolResult"
        ? `toolResult:${message.toolCallId}`
        : `${message.role}:${message.timestamp}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base}#${count}`;
  });
}

/** Providers drop earlier thinking themselves on some models; removing it is always accepted. */
function thinkingRemovedOnly(sent: Message, proposed: Message): boolean {
  if (sent.role !== "assistant" || proposed.role !== "assistant") {
    return false;
  }
  const kept = sent.content.filter((block) => block.type !== "thinking");
  return (
    kept.length !== sent.content.length && encode({ ...sent, content: kept }) === encode(proposed)
  );
}

export function admitSessionPrefix(
  sessionId: string,
  model: RouteModel,
  context: Context,
): { context: Context; report: SessionPrefixReport; commit: () => void } {
  const lineage = [
    model.provider,
    model.api,
    model.id,
    model.baseUrl ?? "",
    context.systemPrompt ?? "",
  ].join("\u0000");
  const proposed = context.messages;
  const ids = identities(proposed);
  const lineages = sessions.get(sessionId) ?? new Map<string, SentSeries>();
  const rebuild = pendingRebuilds.has(sessionId);
  const sent = rebuild ? undefined : lineages.get(lineage);
  let report: SessionPrefixReport;
  let messages = proposed;
  if (!sent) {
    report =
      lineages.size === 0
        ? { kind: "first" }
        : { kind: "rebuild", reason: lineages.has(lineage) ? "declared" : "prefix" };
  } else {
    const divergence = sent.ids.findIndex(
      (id, index) =>
        ids[index] !== id ||
        (sent.messages[index]!.role === "toolResult" &&
          sent.messages[index] !== proposed[index] &&
          encode(sent.messages[index]!) !== encode(proposed[index]!)),
    );
    if (divergence >= 0) {
      report = { kind: "rebuild", reason: "history", index: divergence };
    } else {
      let first = -1;
      let count = 0;
      const replay = sent.messages.map((message, index) => {
        const next = proposed[index]!;
        if (
          message === next ||
          encode(message) === encode(next) ||
          thinkingRemovedOnly(message, next)
        ) {
          return next;
        }
        first = first < 0 ? index : first;
        count += 1;
        return message;
      });
      messages = count > 0 ? [...replay, ...proposed.slice(sent.messages.length)] : proposed;
      report =
        count > 0
          ? { kind: "absorbed", index: first, count, role: sent.messages[first]!.role }
          : { kind: "extended" };
    }
  }
  // A new series (no sent snapshot, or a history rebuild) sends the proposed tools.
  const tools = sent && report.kind !== "rebuild" ? sent.tools : context.tools;
  if (sent && report.kind !== "rebuild") {
    const frozen = new Set((sent.tools ?? []).map((tool) => tool.name));
    const added = (context.tools ?? [])
      .map((tool) => tool.name)
      .filter((name) => !frozen.has(name));
    if (added.length > 0 && report.kind === "extended") {
      report = { kind: "toolsHeld", added };
    }
  }
  // A request becomes part of the series only once the provider accepted it: a rejected or
  // aborted request wrote no cache, and its retry may legitimately differ.
  const commit = () => {
    if (rebuild) {
      pendingRebuilds.delete(sessionId);
    }
    const current = sessions.get(sessionId) ?? lineages;
    current.delete(lineage);
    current.set(lineage, { ids, messages, tools });
    if (current.size > MAX_LINEAGES_PER_SESSION) {
      current.delete(current.keys().next().value!);
    }
    sessions.delete(sessionId);
    sessions.set(sessionId, current);
    if (sessions.size > MAX_SESSIONS) {
      sessions.delete(sessions.keys().next().value!);
    }
  };
  return {
    context:
      messages === proposed && tools === context.tools ? context : { ...context, messages, tools },
    report,
    commit,
  };
}
