/**
 * Post-turn capture (Phase 2, 02-01): append every completed user/assistant turn to
 * the durable `turns` store. Runs as a CORE session extension on the `agent_end`
 * event — no plugin, no public SDK contract — because durable content-anchored ids
 * (`u:<ts>` / `a:<responseId|t+ts>`, the same scheme as the accordion, derived from
 * pi/llm-core message anchors) give replay-stable idempotency WITHOUT a `runId`. The
 * id is the cursor: re-emitting the full message array each turn only ever appends the
 * genuinely new turns (appendTurns dedupes on `idempotency_key`).
 *
 * Capture is fire-and-forget — a failure logs and must never break the turn; the next
 * dreaming sweep (Phase 3) reconciles any gap.
 */
import { createHash } from "node:crypto";
import type { AgentMessage } from "../runtime/index.js";
import type { AgentEndEvent, ExtensionAPI, ExtensionFactory } from "../sessions/index.js";
import { appendTurns, type NewTurn } from "./turns-store.js";

// Conservative hot-path noise marker; the dreaming light pass (Phase 3) owns durable
// noise classification. Matches a leading [SILENT] envelope on automation turns.
const SILENT_PREFIX = /^\s*\[SILENT\]/;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function textOf(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter(
        (block): block is { type: "text"; text: string } =>
          !!block &&
          (block as { type?: unknown }).type === "text" &&
          typeof (block as { text?: unknown }).text === "string",
      )
      .map((block) => block.text)
      .join("\n");
  }
  return "";
}

/**
 * Build the durable turn rows for one `agent_end` message array. Only user/assistant
 * turns with text are captured; the durable per-message anchor becomes the dedupe key.
 */
export function buildCapturedTurns(
  sessionKey: string,
  messages: readonly AgentMessage[],
): NewTurn[] {
  const turns: NewTurn[] = [];
  for (const message of messages) {
    const m = message as {
      role?: string;
      content?: unknown;
      timestamp?: number;
      responseId?: string;
    };
    if (m.role !== "user" && m.role !== "assistant") {
      continue;
    }
    const text = textOf(m.content);
    if (!text) {
      continue;
    }
    // Per-message durable anchor — stable across restart/compaction, no runId needed.
    const anchor =
      m.role === "user" ? `u:${m.timestamp}` : `a:${m.responseId ?? `t${m.timestamp}`}`;
    turns.push({
      role: m.role,
      content: text,
      contentHash: sha256(text),
      idempotencyKey: sha256(`${sessionKey}|${anchor}`),
      ts: typeof m.timestamp === "number" ? m.timestamp : 0,
      noiseClass: SILENT_PREFIX.test(text) ? "suppressed" : null,
    });
  }
  return turns;
}

/** Capture the new turns from one agent_end into the per-agent durable store. */
export function captureConversationTurns(opts: {
  agentId: string;
  sessionKey: string;
  messages: readonly AgentMessage[];
  env?: NodeJS.ProcessEnv;
}): number {
  const turns = buildCapturedTurns(opts.sessionKey, opts.messages);
  if (turns.length === 0) {
    return 0;
  }
  return appendTurns({
    agentId: opts.agentId,
    sessionKey: opts.sessionKey,
    turns,
    ...(opts.env ? { env: opts.env } : {}),
  });
}

/**
 * Core session extension that captures turns on `agent_end`. Registered by
 * buildEmbeddedExtensionFactories only when conversationalMemory is enabled and the
 * run carries an agentId + sessionKey.
 */
export function conversationalMemoryCaptureExtension(opts: {
  agentId: string;
  sessionKey: string;
}): ExtensionFactory {
  return (api: ExtensionAPI) => {
    api.on("agent_end", (event: AgentEndEvent) => {
      try {
        captureConversationTurns({
          agentId: opts.agentId,
          sessionKey: opts.sessionKey,
          messages: event.messages,
        });
      } catch (err) {
        console.warn(
          `[conversational-memory] turn capture failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  };
}
