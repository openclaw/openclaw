// Replay must never present persisted redaction masks as real values (#142821).
// Persisted transcripts store "***" / partial (first6…last4) masks produced by the
// default-on shape/name battery; resumed, reconciled, or compacted context is rebuilt
// from that store, and models copy the masks into new commands, files, and replies.
import { describe, expect, it } from "vitest";
import type { SessionTreeEntry } from "../types.js";
import { buildSessionContext, projectSessionEntryMessage } from "./session.js";

const timestamp = "2026-09-02T00:00:00.000Z";

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

describe("replay redaction provenance (#142821)", () => {
  it("does not replay persisted masks as real tool-call argument values", () => {
    const stored = assistantToolEntry("m1", null, "call_1", "feishu_doc", {
      action: "read",
      doc_token: "***",
      page_token: "***",
      note: "keep me",
    });
    const replayed = projectSessionEntryMessage(stored);
    const args = readToolCallArgs({ message: replayed } as SessionTreeEntry);
    expect(args.doc_token).not.toBe("***");
    expect(args.page_token).not.toBe("***");
    expect(args.note).toBe("keep me");
    // The replacement must tell the model to re-derive instead of reusing it.
    expect(String(args.doc_token)).toMatch(/re-derive/i);
  });

  it("does not replay embedded masks inside persisted command text", () => {
    const stored = assistantToolEntry("m1", null, "call_1", "exec", {
      command: 'APP_ID = "cli_abc"\nAPP_SECRET = "***"',
    });
    const replayed = projectSessionEntryMessage(stored);
    const args = readToolCallArgs({ message: replayed } as SessionTreeEntry);
    expect(String(args.command)).not.toContain('"***"');
    expect(String(args.command)).toContain("cli_abc");
  });

  it("replaces partial masks with a re-derive placeholder", () => {
    const stored = assistantToolEntry("m1", null, "call_1", "feishu_bitable_list_records", {
      app_token: "G8B3AB…Cn5c",
      page_size: 50,
    });
    const replayed = projectSessionEntryMessage(stored);
    const args = readToolCallArgs({ message: replayed } as SessionTreeEntry);
    expect(String(args.app_token)).toMatch(/re-derive/i);
    expect(args.page_size).toBe(50);
  });

  it("rebuilds session context without bare masks", () => {
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
      doc_token: "***",
    });
    const result = toolResultEntry("t1", "m1", "call_1", "sk-buggy…9f3a");
    const context = buildSessionContext([user, assistant, result]);
    const serialized = JSON.stringify(context.messages);
    expect(serialized).not.toContain('"***"');
    expect(serialized).not.toContain("sk-buggy…9f3a");
  });

  it("leaves markdown emphasis and benign values intact", () => {
    const stored = {
      type: "message",
      id: "m1",
      parentId: null,
      timestamp,
      message: {
        role: "assistant",
        api: "openai-responses",
        content: [{ type: "text", text: "fix ***bold italic*** now" }],
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
    const replayed = projectSessionEntryMessage(stored);
    expect(JSON.stringify(replayed)).toContain("***bold italic***");
  });

  it("returns the identical reference when no masks are present", () => {
    const stored = assistantToolEntry("m1", null, "call_1", "read", { path: "/tmp/notes.md" });
    const message = (stored as { message: unknown }).message;
    expect(projectSessionEntryMessage(stored)).toBe(message);
  });
});
