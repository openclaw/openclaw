// Project Claude Agent SDK messages into OpenClaw's pi-ai JSONL session
// shape and write them to two destinations:
//
//   1. The CANONICAL primary session file (`params.sessionFile`). Frames
//      are wrapped in the `{ type: "message", message: { role, content,
//      ... } }` envelope that core readers like
//      `src/gateway/session-utils.fs.ts` and
//      `src/memory-host-sdk/host/session-files.ts` consume. Without this
//      write, those readers would see claude-sdk sessions as empty even
//      after a successful turn — a regression vs the embedded runtime.
//
//   2. A SIDECAR file at `<primaryPath>.claude-sdk.jsonl`. This file is
//      the deterministic on-disk evidence that a turn went through the
//      claude-sdk runtime: it includes a tagged `{ type: "system",
//      source: "claude-sdk" }` marker plus a `claudeSdk: true` annotation
//      on every projected message. Tooling that wants to surface
//      "this turn ran on claude-sdk" should check the sidecar.
//
// Resume reads stay on the canonical file. Future Phase 4 work can
// either flip the authoritative path to the SDK's own
// `~/.claude/projects/...` JSONL or retire the sidecar separately.
//
// Intentionally narrow: this module does not project every SDK message
// variant — only the assistant-text and tool-use/tool-result frames that
// existing readers render today. Unknown SDK message types are dropped
// silently (they're still in the SDK primary, so no data is lost) to
// keep the projection schema stable.

import * as fs from "node:fs";
import * as path from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("agents/claude-sdk");

/**
 * Canonical pi-ai transcript record envelope. Matches the shape that
 * `src/gateway/session-utils.fs.ts` walks: a top-level `{ type:
 * "message", message: { role, content, ... } }`. We add a `claudeSdk:
 * true` discriminator so tooling can distinguish SDK-driven turns from
 * pi-ai-driven ones at a glance.
 */
export type CanonicalMessageRecord = {
  type: "message";
  /** Optional run-scoped identifier; pi-ai uses `id`, we mirror the convention. */
  id?: string;
  /** True iff this record was emitted by the claude-sdk mirror. */
  claudeSdk: true;
  message: CanonicalMessage;
};

export type CanonicalMessage =
  | {
      role: "user";
      content: Array<{ type: "text"; text: string }>;
      timestamp: number;
    }
  | {
      role: "assistant";
      content: Array<
        | { type: "text"; text: string }
        | { type: "toolCall"; id: string; name: string; input: unknown }
      >;
      api: "claude-sdk";
      provider: "anthropic";
      model: string;
      usage: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        total: number;
      };
      stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
      timestamp: number;
    }
  | {
      role: "tool";
      content: Array<{
        type: "toolResult";
        toolCallId: string;
        output: unknown;
        isError?: boolean;
      }>;
      timestamp: number;
    };

/**
 * Sidecar-only marker entries. Not part of the canonical schema; only
 * written to the `*.claude-sdk.jsonl` sidecar to give a tagged record
 * of run lifecycle (open, stop, errors) for runtime-source forensics.
 */
export type SidecarMarker =
  | {
      type: "system";
      at: number;
      source: "claude-sdk";
      payload: { sessionId: string; note?: string };
    }
  | {
      type: "stop";
      at: number;
      source: "claude-sdk";
      reason: string;
    };

export type SessionMirror = {
  writeSdkMessage(msg: SDKMessage): void;
  writeStop(reason: string): void;
  close(): void;
};

export type OpenSessionMirrorParams = {
  /**
   * Absolute path to the OpenClaw primary (canonical) JSONL session
   * file for this run. Canonical envelope records are appended here so
   * existing gateway/memory readers see SDK turns. A sidecar file at
   * `<primaryPath>.claude-sdk.jsonl` also receives a tagged copy plus
   * lifecycle markers.
   */
  primaryPath: string;
  /** The SDK session id to include in the initial system marker. */
  sdkSessionId: string;
  /**
   * Effective model id resolved by the runtime. Recorded on every
   * canonical assistant record so downstream `model ?? fallback`
   * chains see a real value.
   */
  model?: string;
};

/**
 * Resolve the sidecar mirror path for a given primary session-file path.
 */
export function resolveSessionMirrorPath(primaryPath: string): string {
  return `${primaryPath}.claude-sdk.jsonl`;
}

/**
 * Open an append-only session mirror for the duration of a run. The
 * caller is responsible for calling `close()` when the run ends.
 */
export function openSessionMirror(params: OpenSessionMirrorParams): SessionMirror {
  const dir = path.dirname(params.primaryPath);
  fs.mkdirSync(dir, { recursive: true });
  const sidecarPath = resolveSessionMirrorPath(params.primaryPath);
  // Both streams are append-only: the canonical primary is shared with
  // pi-ai's SessionManager (which truncates/rewrites it during its own
  // open path); appending after pi-ai has finished initialization is
  // the safe shape because by the time we write our first projected
  // message, the SDK has already produced its first response — pi-ai's
  // open-and-rewrite happens earlier in the run lifecycle.
  const primaryStream = fs.createWriteStream(params.primaryPath, { flags: "a" });
  const sidecarStream = fs.createWriteStream(sidecarPath, { flags: "a" });

  // Without explicit 'error' listeners, any async write failure (transient
  // I/O, disk full, EPERM after startup) fires an 'unhandled error' event
  // that terminates the Node process. The try/catch around
  // writeSdkMessage in run.ts can't catch async stream events, so one
  // mirror write failure would bring down an otherwise-recoverable run.
  // Catching and logging keeps the run alive; we lose that one frame's
  // evidence trail but the user-visible reply still arrives.
  primaryStream.on("error", (err) => {
    log.warn(
      `[claude-sdk] primary session-mirror stream error path=${params.primaryPath} err=${err.message}`,
    );
  });
  sidecarStream.on("error", (err) => {
    log.warn(
      `[claude-sdk] sidecar session-mirror stream error path=${sidecarPath} err=${err.message}`,
    );
  });

  const writeBoth = (line: string): void => {
    primaryStream.write(line);
    sidecarStream.write(line);
  };
  const writeSidecarOnly = (line: string): void => {
    sidecarStream.write(line);
  };

  // Sidecar-only system marker: deterministic evidence the run took the
  // claude-sdk path. NOT written to the canonical file because it isn't
  // a `{ type: "message" }` envelope and existing readers would skip it
  // anyway.
  const sysMarker: SidecarMarker = {
    type: "system",
    at: Date.now(),
    source: "claude-sdk",
    payload: { sessionId: params.sdkSessionId },
  };
  writeSidecarOnly(`${JSON.stringify(sysMarker)}\n`);

  return {
    writeSdkMessage(msg) {
      const projected = projectSdkMessage(msg, { model: params.model });
      for (const record of projected) {
        writeBoth(`${JSON.stringify(record)}\n`);
      }
    },
    writeStop(reason) {
      const stopMarker: SidecarMarker = {
        type: "stop",
        at: Date.now(),
        source: "claude-sdk",
        reason,
      };
      writeSidecarOnly(`${JSON.stringify(stopMarker)}\n`);
    },
    close() {
      primaryStream.end();
      sidecarStream.end();
    },
  };
}

export type ProjectionContext = {
  /** Effective model id for stamping assistant records. */
  model?: string;
};

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
} as const;

/**
 * Project a single SDK message into zero-or-more canonical envelope
 * records. Exported for unit tests so we can exercise the projection
 * without touching the filesystem.
 */
export function projectSdkMessage(
  msg: SDKMessage,
  ctx: ProjectionContext = {},
): CanonicalMessageRecord[] {
  const now = Date.now();
  // SDKMessage is a tagged union: { type: "assistant" | "user" | "result" | "system" | "partial_assistant" | ... }
  // Narrow the shape via unknown cast to avoid depending on SDK-internal
  // type exports, which vary across 0.x releases.
  const m = msg as unknown as { type?: string; [k: string]: unknown };
  if (m.type === "assistant" || m.type === "partial_assistant") {
    const extracted = extractTextContent(m);
    const content: Array<
      | { type: "text"; text: string }
      | { type: "toolCall"; id: string; name: string; input: unknown }
    > = [];
    if (extracted.text) {
      content.push({ type: "text", text: extracted.text });
    }
    for (const call of extracted.toolCalls) {
      content.push({
        type: "toolCall",
        id: call.id,
        name: call.name,
        input: call.input,
      });
    }
    if (content.length === 0) {
      return [];
    }
    return [
      {
        type: "message",
        claudeSdk: true,
        message: {
          role: "assistant",
          content,
          api: "claude-sdk",
          provider: "anthropic",
          model: ctx.model ?? "",
          usage: { ...ZERO_USAGE },
          stopReason: "stop",
          timestamp: now,
        },
      },
    ];
  }
  if (m.type === "user") {
    const extracted = extractTextContent(m);
    const records: CanonicalMessageRecord[] = [];
    if (extracted.text) {
      records.push({
        type: "message",
        claudeSdk: true,
        message: {
          role: "user",
          content: [{ type: "text", text: extracted.text }],
          timestamp: now,
        },
      });
    }
    if (extracted.toolResults.length > 0) {
      records.push({
        type: "message",
        claudeSdk: true,
        message: {
          role: "tool",
          content: extracted.toolResults.map((r) => ({
            type: "toolResult" as const,
            toolCallId: r.id,
            output: r.output,
            isError: r.isError,
          })),
          timestamp: now,
        },
      });
    }
    return records;
  }
  // result/system/partial chunks we don't project — the sidecar's
  // separate `stop` marker (written by writeStop) records run end.
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
