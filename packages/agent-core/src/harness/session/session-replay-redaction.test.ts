import { markRedactionProvenance } from "@openclaw/normalization-core/redaction-provenance";
// Replay must never present persisted redaction masks as real values (#142821).
// Persistence marks every mask it produces with explicit provenance, so replay swaps
// only marked spans for a re-derive placeholder. Unmarked text is literal history:
// the stored bytes cannot prove it was redaction output, so it stays untouched.
import { describe, expect, it } from "vitest";
import type { SessionTreeEntry } from "../types.js";
import { buildSessionContext, projectSessionEntryMessage } from "./session.js";

const timestamp = "2026-09-02T00:00:00.000Z";
// Pins the exact user-visible instruction replay hands the model.
const REPLAY_REDACTED_VALUE_PLACEHOLDER = "[redacted: re-derive this value, do not reuse]";

function assistantToolEntry(
  id: string,
  parentId: string | null,
  toolCallId: string,
  name: string,
  args: Record<string, unknown>,
): SessionTreeEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: {
      role: "assistant",
      api: "openai-responses",
      content: [{ type: "toolCall", id: toolCallId, name, arguments: args }],
      provider: "test-provider",
      model: "test-model",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: Date.parse(timestamp),
    },
  };
}

function toolResultEntry(
  id: string,
  parentId: string,
  toolCallId: string,
  content: unknown,
): SessionTreeEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: {
      role: "toolResult",
      toolCallId,
      toolName: "exec",
      content,
      timestamp: Date.parse(timestamp),
    } as unknown as Extract<SessionTreeEntry, { type: "message" }>["message"],
  };
}

function readToolCallArgs(entry: SessionTreeEntry): Record<string, unknown> {
  const message = (entry as { message: { content: Array<{ arguments?: unknown }> } }).message;
  return (message.content[0]?.arguments ?? {}) as Record<string, unknown>;
}

function readToolCallBlock(entry: SessionTreeEntry): Record<string, unknown> {
  const message = (entry as unknown as { message: { content: Array<Record<string, unknown>> } })
    .message;
  return message.content[0] ?? {};
}

describe("replay redaction provenance (#142821)", () => {
  it("replaces marked masks in tool-call arguments with a re-derive placeholder", () => {
    const stored = assistantToolEntry("m1", null, "call_1", "feishu_doc", {
      action: "read",
      doc_token: markRedactionProvenance("***"),
      app_token: markRedactionProvenance("G8B3AB…Cn5c"),
      note: "keep me",
    });
    const args = readToolCallArgs({
      message: projectSessionEntryMessage(stored),
    } as SessionTreeEntry);
    expect(args.doc_token).toBe(REPLAY_REDACTED_VALUE_PLACEHOLDER);
    expect(args.app_token).toBe(REPLAY_REDACTED_VALUE_PLACEHOLDER);
    // Untouched values keep their exact bytes.
    expect(args.action).toBe("read");
    expect(args.note).toBe("keep me");
  });

  it("keeps surrounding text when a marked mask is embedded in a string", () => {
    const stored = assistantToolEntry("m1", null, "call_1", "exec", {
      command: `APP_ID = "cli_abc"\nAPP_SECRET = "${markRedactionProvenance("***")}"`,
      url: `https://example.test/x?token=${markRedactionProvenance("sk-abc…0xyz")}&page=2`,
    });
    const args = readToolCallArgs({
      message: projectSessionEntryMessage(stored),
    } as SessionTreeEntry);
    expect(args.command).toBe(
      `APP_ID = "cli_abc"\nAPP_SECRET = "${REPLAY_REDACTED_VALUE_PLACEHOLDER}"`,
    );
    expect(args.url).toBe(
      `https://example.test/x?token=${REPLAY_REDACTED_VALUE_PLACEHOLDER}&page=2`,
    );
  });

  it("processes nested payload lookalikes instead of skipping them by key name", () => {
    const stored = assistantToolEntry("m1", null, "call_1", "shell", {
      arguments: { id: markRedactionProvenance("sk-bug…9f3a") },
      result: { nested: [{ toolCallId: markRedactionProvenance("***") }] },
    });
    const args = readToolCallArgs({
      message: projectSessionEntryMessage(stored),
    } as SessionTreeEntry);
    expect((args.arguments as Record<string, unknown>).id).toBe(REPLAY_REDACTED_VALUE_PLACEHOLDER);
    expect(
      (args.result as { nested: Array<{ toolCallId: unknown }> }).nested[0]?.toolCallId ?? null,
    ).toBe(REPLAY_REDACTED_VALUE_PLACEHOLDER);
  });

  it("leaves unmarked correlation fields byte-identical", () => {
    const stored = assistantToolEntry("m1", null, "call_1", "feishu_doc", { action: "read" });
    const message = (stored as unknown as { message: Record<string, unknown> }).message;
    message.idempotencyKey = "dedupe-key";
    const replayed = projectSessionEntryMessage(stored);
    const block = readToolCallBlock({ message: replayed } as SessionTreeEntry);
    expect(block.id).toBe("call_1");
    expect((replayed as unknown as Record<string, unknown>).idempotencyKey).toBe("dedupe-key");
  });

  it("rebuilds session context without replayable masks", () => {
    const user = {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp,
      message: {
        role: "user",
        content: "add a line to the doc we just made",
        timestamp: Date.parse(timestamp),
      },
    } as unknown as SessionTreeEntry;
    const assistant = assistantToolEntry("m1", "u1", "call_1", "feishu_doc", {
      action: "read",
      doc_token: markRedactionProvenance("***"),
    });
    const result = toolResultEntry("t1", "m1", "call_1", markRedactionProvenance("sk-buggy…9f3a"));
    const context = buildSessionContext([user, assistant, result]);
    const serialized = JSON.stringify(context.messages);
    expect(serialized).toContain("re-derive");
    expect(serialized).not.toContain("sk-buggy…9f3a");
    expect(serialized).toContain("add a line to the doc we just made");
  });

  it("returns the identical reference when no mask carries provenance", () => {
    const stored = assistantToolEntry("m1", null, "call_1", "read", { path: "/tmp/notes.md" });
    const message = (stored as { message: unknown }).message;
    expect(projectSessionEntryMessage(stored)).toBe(message);
  });
});

describe("legacy text without provenance stays literal (#142821)", () => {
  it("preserves ordinary ellipsis prose", () => {
    const stored = assistantToolEntry("m1", null, "call_1", "exec", {
      command: "the file is here…world of pain",
    });
    const args = readToolCallArgs({
      message: projectSessionEntryMessage(stored),
    } as SessionTreeEntry);
    expect(args.command).toBe("the file is here…world of pain");
  });

  it("preserves a markdown thematic break and emphasis", () => {
    const stored = {
      type: "message",
      id: "m1",
      parentId: null,
      timestamp,
      message: {
        role: "assistant",
        api: "openai-responses",
        content: [{ type: "text", text: "---\n***\nfix ***bold italic*** now" }],
        provider: "test-provider",
        model: "test-model",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.parse(timestamp),
      },
    } as unknown as SessionTreeEntry;
    const replayed = projectSessionEntryMessage(stored) as unknown as {
      content: Array<{ text: string }>;
    };
    expect(replayed.content[0]?.text).toBe("---\n***\nfix ***bold italic*** now");
  });

  it("preserves an assignment prefix around an unmarked mask-shaped value", () => {
    const stored = assistantToolEntry("m1", null, "call_1", "exec", {
      command: "value=sk-bug…9f3a",
    });
    const args = readToolCallArgs({
      message: projectSessionEntryMessage(stored),
    } as SessionTreeEntry);
    expect(args.command).toBe("value=sk-bug…9f3a");
  });

  it("does not rewrite unmarked historical masks", () => {
    const stored = assistantToolEntry("m1", null, "call_1", "feishu_doc", {
      doc_token: "***",
      app_token: "G8B3AB…Cn5c",
    });
    const replayed = projectSessionEntryMessage(stored);
    const message = (stored as { message: unknown }).message;
    // Legacy policy: ambiguous stored bytes are a maintainer decision, so replay
    // leaves them exactly as persisted rather than guessing.
    expect(replayed).toBe(message);
    expect(readToolCallArgs({ message: replayed } as SessionTreeEntry).doc_token).toBe("***");
  });

  it("stays idempotent once a marked span became the placeholder", () => {
    const stored = assistantToolEntry("m1", null, "call_1", "exec", {
      command: `k=${markRedactionProvenance("***")}`,
    });
    const once = projectSessionEntryMessage(stored);
    const twice = projectSessionEntryMessage({ ...stored, message: once } as SessionTreeEntry);
    expect(twice).toBe(once);
  });
});
