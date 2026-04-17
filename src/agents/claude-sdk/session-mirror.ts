// Project Claude Agent SDK messages into OpenClaw's pi-ai JSONL session
// shape, so an SDK-driven run still writes to
// `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl` for the
// existing tooling (session log viewers, /session-logs skill,
// `openclaw doctor`, etc.) to consume.
//
// Design notes:
//   * The SDK already writes its own JSONL to `~/.claude/projects/...` in
//     Anthropic SDK message shape — that's the "primary" SDK transcript
//     and is what supports `claude continue`/`claude resume`.
//   * OpenClaw's existing primary (for pi-ai runs) is the
//     `~/.openclaw/agents/.../*.jsonl` path. We mirror SDK messages into
//     that path during the Phase 2 compat window so OpenClaw's session
//     tooling continues to work without a behavior change visible to the
//     user.
//   * Resume reads stay on OpenClaw's primary path; this mirror is
//     write-only. When Phase 4 retires the legacy runtime we can either
//     flip the authoritative path to `~/.claude/projects/...` or keep the
//     mirror and retire it separately.
//
// Intentionally narrow: this module does not emit every SDK message
// variant — only the assistant-text and tool-use/tool-result frames that
// OpenClaw's viewers render today. Unknown SDK message types are dropped
// silently (they're still in the SDK primary, so no data is lost) to
// keep the projection schema stable.

import * as fs from "node:fs";
import * as path from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

/**
 * Minimal pi-ai JSONL entry shape — enough for the current viewer tools.
 * Matches the envelope `{ type: "<role>", ... }` that OpenClaw's existing
 * `.jsonl` files use for assistant/user messages. Tool calls and results
 * are projected as synthetic assistant frames with a `toolCall` payload
 * so the viewer's existing rendering path picks them up.
 */
export type PiJsonlEntry =
  | {
      type: "system";
      at: number;
      source: "claude-sdk";
      payload: { sessionId: string; note?: string };
    }
  | {
      type: "user";
      at: number;
      source: "claude-sdk";
      text: string;
    }
  | {
      type: "assistant";
      at: number;
      source: "claude-sdk";
      text?: string;
      toolCall?: { id: string; name: string; input: unknown };
      toolResult?: { id: string; output: unknown; isError?: boolean };
    }
  | {
      type: "stop";
      at: number;
      source: "claude-sdk";
      reason: string;
    };

export type SessionMirror = {
  writePiFrame(entry: PiJsonlEntry): void;
  writeSdkMessage(msg: SDKMessage): void;
  close(): void;
};

export type OpenSessionMirrorParams = {
  /** Absolute path to the OpenClaw primary JSONL file for this run. */
  primaryPath: string;
  /** The SDK session id to include in the initial system frame. */
  sdkSessionId: string;
};

/**
 * Open an append-only session mirror for the duration of a run. The
 * caller is responsible for calling `close()` when the run ends.
 */
export function openSessionMirror(params: OpenSessionMirrorParams): SessionMirror {
  const dir = path.dirname(params.primaryPath);
  fs.mkdirSync(dir, { recursive: true });
  const stream = fs.createWriteStream(params.primaryPath, { flags: "a" });

  const writeEntry = (entry: PiJsonlEntry): void => {
    stream.write(`${JSON.stringify(entry)}\n`);
  };

  writeEntry({
    type: "system",
    at: Date.now(),
    source: "claude-sdk",
    payload: { sessionId: params.sdkSessionId },
  });

  return {
    writePiFrame(entry) {
      writeEntry(entry);
    },
    writeSdkMessage(msg) {
      const projected = projectSdkMessage(msg);
      for (const p of projected) {
        writeEntry(p);
      }
    },
    close() {
      stream.end();
    },
  };
}

/**
 * Project a single SDK message into zero-or-more pi-ai JSONL entries.
 *
 * Exported for unit tests so we can exercise the projection without
 * touching the filesystem.
 */
export function projectSdkMessage(msg: SDKMessage): PiJsonlEntry[] {
  const at = Date.now();
  // SDKMessage is a tagged union: { type: "assistant" | "user" | "result" | "system" | "partial_assistant" | ... }
  // Narrow the shape via unknown cast to avoid depending on SDK-internal
  // type exports, which vary across 0.x releases.
  const m = msg as unknown as { type?: string; [k: string]: unknown };
  if (m.type === "assistant" || m.type === "partial_assistant") {
    const content = extractTextContent(m);
    const entries: PiJsonlEntry[] = [];
    if (content.text) {
      entries.push({
        type: "assistant",
        at,
        source: "claude-sdk",
        text: content.text,
      });
    }
    for (const call of content.toolCalls) {
      entries.push({
        type: "assistant",
        at,
        source: "claude-sdk",
        toolCall: call,
      });
    }
    return entries;
  }
  if (m.type === "user") {
    const content = extractTextContent(m);
    const entries: PiJsonlEntry[] = [];
    if (content.text) {
      entries.push({
        type: "user",
        at,
        source: "claude-sdk",
        text: content.text,
      });
    }
    for (const result of content.toolResults) {
      entries.push({
        type: "assistant",
        at,
        source: "claude-sdk",
        toolResult: result,
      });
    }
    return entries;
  }
  if (m.type === "result") {
    const reason = typeof m.stop_reason === "string" ? m.stop_reason : "completed";
    return [{ type: "stop", at, source: "claude-sdk", reason }];
  }
  // system messages, partial chunks we don't recognize, etc. — drop.
  return [];
}

type ExtractedContent = {
  text: string;
  toolCalls: Array<{ id: string; name: string; input: unknown }>;
  toolResults: Array<{ id: string; output: unknown; isError?: boolean }>;
};

function extractTextContent(m: { [k: string]: unknown }): ExtractedContent {
  const out: ExtractedContent = { text: "", toolCalls: [], toolResults: [] };
  const message = m.message as { content?: unknown } | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) {
    return out;
  }
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const b = block as { type?: string; [k: string]: unknown };
    if (b.type === "text" && typeof b.text === "string") {
      out.text += (out.text ? "\n" : "") + b.text;
    } else if (b.type === "tool_use") {
      out.toolCalls.push({
        id: typeof b.id === "string" ? b.id : "",
        name: typeof b.name === "string" ? b.name : "",
        input: b.input,
      });
    } else if (b.type === "tool_result") {
      out.toolResults.push({
        id: typeof b.tool_use_id === "string" ? b.tool_use_id : "",
        output: b.content,
        isError: typeof b.is_error === "boolean" ? b.is_error : undefined,
      });
    }
  }
  return out;
}
