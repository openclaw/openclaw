// Pure message-summarization helpers extracted from `attempt.ts` so the
// embedded attempt orchestrator does not own diagnostic-only payload counting.
// This is the second ownership-boundary slice for RFC 72072 and the first
// piece of the lifecycle-domain extraction. The full lifecycle / stream-loop
// split that the RFC envisioned for PR 4 lands as separate follow-ups because
// the larger seams (`runEmbeddedAttempt` cleanup `finally` block at lines
// ~3036-3085, the per-turn stream loop at ~2200-2950) carry deep closure
// dependencies that need a dedicated focused pass.
//
// The exported helpers are pure:
//   - `summarizeMessagePayload(msg)` returns text/image character counts for
//     a single AgentMessage payload, normalising string and array content.
//   - `summarizeSessionContext(messages)` aggregates a session transcript
//     into role counts, total text chars, total image blocks, and per-message
//     max text chars. `attempt.ts` uses this once to emit a session-context
//     diagnostic before each prompt-cache observation.

import type { AgentMessage } from "@mariozechner/pi-agent-core";

export type EmbeddedAttemptMessagePayloadSummary = {
  textChars: number;
  imageBlocks: number;
};

export type EmbeddedAttemptSessionContextSummary = {
  roleCounts: string;
  totalTextChars: number;
  totalImageBlocks: number;
  maxMessageTextChars: number;
};

export function summarizeMessagePayload(msg: AgentMessage): EmbeddedAttemptMessagePayloadSummary {
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") {
    return { textChars: content.length, imageBlocks: 0 };
  }
  if (!Array.isArray(content)) {
    return { textChars: 0, imageBlocks: 0 };
  }

  let textChars = 0;
  let imageBlocks = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typedBlock = block as { type?: unknown; text?: unknown };
    if (typedBlock.type === "image") {
      imageBlocks++;
      continue;
    }
    if (typeof typedBlock.text === "string") {
      textChars += typedBlock.text.length;
    }
  }

  return { textChars, imageBlocks };
}

export function summarizeSessionContext(
  messages: AgentMessage[],
): EmbeddedAttemptSessionContextSummary {
  const roleCounts = new Map<string, number>();
  let totalTextChars = 0;
  let totalImageBlocks = 0;
  let maxMessageTextChars = 0;

  for (const msg of messages) {
    const role = typeof msg.role === "string" ? msg.role : "unknown";
    roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);

    const payload = summarizeMessagePayload(msg);
    totalTextChars += payload.textChars;
    totalImageBlocks += payload.imageBlocks;
    if (payload.textChars > maxMessageTextChars) {
      maxMessageTextChars = payload.textChars;
    }
  }

  return {
    roleCounts:
      [...roleCounts.entries()]
        .toSorted((a, b) => a[0].localeCompare(b[0]))
        .map(([role, count]) => `${role}:${count}`)
        .join(",") || "none",
    totalTextChars,
    totalImageBlocks,
    maxMessageTextChars,
  };
}
