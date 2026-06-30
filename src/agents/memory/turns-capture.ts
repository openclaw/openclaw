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
import { messageAnchorId } from "./accordion-blocks.js";
import { associateSegmentationTopics } from "./associate-topics.js";
import { isSuppressedMemoryNoise } from "./noise.js";
import { segmentConversationTurns } from "./segment-spans.js";
import { appendTurns, type NewTurn } from "./turns-store.js";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Stable per-turn idempotency key = sha256(sessionKey | durable message anchor).
 * Single source shared by capture (dedupe on append) and the accordion (mapping a
 * live message back to its captured turn). `null` when the message has no durable
 * anchor (skip it). No `runId` — the anchor is already replay-stable.
 */
export function turnIdempotencyKey(sessionKey: string, message: AgentMessage): string | null {
  const anchor = messageAnchorId(message);
  return anchor == null ? null : sha256(`${sessionKey}|${anchor}`);
}

function textOf(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter(
        (block): block is { type: "text"; text: string } =>
          Boolean(block) &&
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
    const m = message as { role?: string; content?: unknown; timestamp?: number };
    if (m.role !== "user" && m.role !== "assistant") {
      continue;
    }
    const text = textOf(m.content);
    if (!text) {
      continue;
    }
    // Per-message durable anchor — stable across restart/compaction, no runId needed.
    const idempotencyKey = turnIdempotencyKey(sessionKey, message);
    if (idempotencyKey == null) {
      continue;
    }
    turns.push({
      role: m.role,
      content: text,
      contentHash: sha256(text),
      idempotencyKey,
      ts: typeof m.timestamp === "number" ? m.timestamp : 0,
      noiseClass: isSuppressedMemoryNoise({ content: text }) ? "suppressed" : null,
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
  const inserted = appendTurns({
    agentId: opts.agentId,
    sessionKey: opts.sessionKey,
    turns,
    ...(opts.env ? { env: opts.env } : {}),
  });
  try {
    const segmentation = segmentConversationTurns({
      agentId: opts.agentId,
      sessionKey: opts.sessionKey,
      ...(opts.env ? { env: opts.env } : {}),
    });
    // Fuel the associative store from the same segmentation output: durable topic tags
    // linked to their non-noise spans/boxes. Idempotent, so replaying a turn is safe.
    associateSegmentationTopics({
      agentId: opts.agentId,
      sessionKey: opts.sessionKey,
      segmentation,
      ...(opts.env ? { env: opts.env } : {}),
    });
  } catch (err) {
    console.warn(
      `[conversational-memory] turn segmentation/association failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return inserted;
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
