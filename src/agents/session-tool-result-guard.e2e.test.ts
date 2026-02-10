import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  installSessionToolResultGuard,
  redactEntryForPersistence,
} from "./session-tool-result-guard.js";

type AppendMessage = Parameters<SessionManager["appendMessage"]>[0];

const asAppendMessage = (message: unknown) => message as AppendMessage;

const toolCallMessage = asAppendMessage({
  role: "assistant",
  content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
});

/** Read JSONL entries from a session file, parsing each line as JSON. */
function readSessionJsonl(filePath: string): unknown[] {
  const content = fs.readFileSync(filePath, "utf-8").trim();
  if (!content) {
    return [];
  }
  return content
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

/** Extract text from a tool result message entry's first text content block. */
function extractToolResultText(entry: Record<string, unknown>): string | undefined {
  const msg = entry.message as { content?: Array<{ type: string; text?: string }> } | undefined;
  return msg?.content?.find((b) => b.type === "text")?.text;
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs) {
    fs.rmSync(d, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
});

/** Create a disk-persisted SessionManager in a temp directory with reliable cleanup. */
function createTrackedDiskSM(): { sm: SessionManager; getSessionFile: () => string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-test-"));
  tmpDirs.push(tmpDir);
  const sm = new SessionManager(process.cwd(), tmpDir, undefined, true);
  return {
    sm,
    getSessionFile: () => (sm as unknown as { sessionFile: string }).sessionFile,
  };
}

// No upstream hash guards needed — we wrap _persist/_rewriteFile instead of
// replicating them. The wrapper swaps fileEntries with redacted copies during
// writes, preserving all upstream persistence semantics unchanged.

describe("redactEntryForPersistence", () => {
  it("redacts secrets in compaction summary", () => {
    const entry = {
      type: "compaction" as const,
      id: "c1",
      parentId: null,
      timestamp: new Date().toISOString(),
      summary:
        "The user shared their Slack token xoxb-compaction-secret-token-abcdefghij for debugging",
      firstKeptEntryId: "e1",
      tokensBefore: 5000,
    };
    const redacted = redactEntryForPersistence(entry as never);
    expect((redacted as { summary: string }).summary).not.toContain(
      "xoxb-compaction-secret-token-abcdefghij",
    );
    // Original unchanged
    expect(entry.summary).toContain("xoxb-compaction-secret-token-abcdefghij");
  });

  it("redacts secrets in branch_summary", () => {
    const entry = {
      type: "branch_summary" as const,
      id: "b1",
      parentId: null,
      timestamp: new Date().toISOString(),
      fromId: "e0",
      summary: "Branch contained API key sk-ant-branch-secret-abcdefghijklmnopqrstuvwxyz",
    };
    const redacted = redactEntryForPersistence(entry as never);
    expect((redacted as { summary: string }).summary).not.toContain(
      "sk-ant-branch-secret-abcdefghijklmnopqrstuvwxyz",
    );
  });

  it("redacts secrets in custom_message with string content", () => {
    const entry = {
      type: "custom_message" as const,
      id: "cm1",
      parentId: null,
      timestamp: new Date().toISOString(),
      customType: "my-extension",
      content: "Extension injected ghp_SecretGitHubTokenThatIsLongEnough1234 into context",
      display: true,
    };
    const redacted = redactEntryForPersistence(entry as never);
    expect((redacted as { content: string }).content).not.toContain(
      "ghp_SecretGitHubTokenThatIsLongEnough1234",
    );
    // Original unchanged
    expect(entry.content).toContain("ghp_SecretGitHubTokenThatIsLongEnough1234");
  });

  it("redacts secrets in custom_message with TextContent[] content", () => {
    const entry = {
      type: "custom_message" as const,
      id: "cm2",
      parentId: null,
      timestamp: new Date().toISOString(),
      customType: "my-extension",
      content: [
        { type: "text", text: "Config: xapp-extension-secret-token-abcdefghij" },
        { type: "image", source: "data:image/png;base64,..." },
      ],
      display: true,
    };
    const redacted = redactEntryForPersistence(entry as never);
    const textBlock = (redacted as { content: Array<{ type: string; text?: string }> }).content[0];
    expect(textBlock.text).not.toContain("xapp-extension-secret-token-abcdefghij");
    // Image block unchanged
    const imgBlock = (redacted as { content: Array<{ type: string }> }).content[1];
    expect(imgBlock.type).toBe("image");
  });

  it("does not modify compaction summary without secrets", () => {
    const entry = {
      type: "compaction" as const,
      id: "c1",
      parentId: null,
      timestamp: new Date().toISOString(),
      summary: "User discussed project architecture and testing strategies",
      firstKeptEntryId: "e1",
      tokensBefore: 3000,
    };
    const result = redactEntryForPersistence(entry as never);
    // Should return the same reference when nothing changed
    expect(result).toBe(entry);
  });
});

describe("installSessionToolResultGuard", () => {
  it("inserts synthetic toolResult before non-tool message when pending", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm);

    sm.appendMessage(toolCallMessage);
    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "text", text: "error" }],
        stopReason: "error",
      }),
    );

    const entries = sm
      .getEntries()
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: AgentMessage }).message);

    expect(entries.map((m) => m.role)).toEqual(["assistant", "toolResult", "assistant"]);
    const synthetic = entries[1] as {
      toolCallId?: string;
      isError?: boolean;
      content?: Array<{ type?: string; text?: string }>;
    };
    expect(synthetic.toolCallId).toBe("call_1");
    expect(synthetic.isError).toBe(true);
    expect(synthetic.content?.[0]?.text).toContain("missing tool result");
  });

  it("flushes pending tool calls when asked explicitly", () => {
    const sm = SessionManager.inMemory();
    const guard = installSessionToolResultGuard(sm);

    sm.appendMessage(toolCallMessage);
    guard.flushPendingToolResults();

    const messages = sm
      .getEntries()
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: AgentMessage }).message);

    expect(messages.map((m) => m.role)).toEqual(["assistant", "toolResult"]);
  });

  it("does not add synthetic toolResult when a matching one exists", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm);

    sm.appendMessage(toolCallMessage);
    sm.appendMessage(
      asAppendMessage({
        role: "toolResult",
        toolCallId: "call_1",
        content: [{ type: "text", text: "ok" }],
        isError: false,
      }),
    );

    const messages = sm
      .getEntries()
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: AgentMessage }).message);

    expect(messages.map((m) => m.role)).toEqual(["assistant", "toolResult"]);
  });

  it("preserves ordering with multiple tool calls and partial results", () => {
    const sm = SessionManager.inMemory();
    const guard = installSessionToolResultGuard(sm);

    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_a", name: "one", arguments: {} },
          { type: "toolUse", id: "call_b", name: "two", arguments: {} },
        ],
      }),
    );
    sm.appendMessage(
      asAppendMessage({
        role: "toolResult",
        toolUseId: "call_a",
        content: [{ type: "text", text: "a" }],
        isError: false,
      }),
    );
    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "text", text: "after tools" }],
      }),
    );

    const messages = sm
      .getEntries()
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: AgentMessage }).message);

    expect(messages.map((m) => m.role)).toEqual([
      "assistant", // tool calls
      "toolResult", // call_a real
      "toolResult", // synthetic for call_b
      "assistant", // text
    ]);
    expect((messages[2] as { toolCallId?: string }).toolCallId).toBe("call_b");
    expect(guard.getPendingIds()).toEqual([]);
  });

  it("flushes pending on guard when no toolResult arrived", () => {
    const sm = SessionManager.inMemory();
    const guard = installSessionToolResultGuard(sm);

    sm.appendMessage(toolCallMessage);
    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "text", text: "hard error" }],
        stopReason: "error",
      }),
    );
    expect(guard.getPendingIds()).toEqual([]);
  });

  it("handles toolUseId on toolResult", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm);

    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "toolUse", id: "use_1", name: "f", arguments: {} }],
      }),
    );
    sm.appendMessage(
      asAppendMessage({
        role: "toolResult",
        toolUseId: "use_1",
        content: [{ type: "text", text: "ok" }],
      }),
    );

    const messages = sm
      .getEntries()
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: AgentMessage }).message);
    expect(messages.map((m) => m.role)).toEqual(["assistant", "toolResult"]);
  });

  it("drops malformed tool calls missing input before persistence", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm);

    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read" }],
      }),
    );

    const messages = sm
      .getEntries()
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: AgentMessage }).message);

    expect(messages).toHaveLength(0);
  });

  it("flushes pending tool results when a sanitized assistant message is dropped", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm);

    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
      }),
    );

    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_2", name: "read" }],
      }),
    );

    const messages = sm
      .getEntries()
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: AgentMessage }).message);

    expect(messages.map((m) => m.role)).toEqual(["assistant", "toolResult"]);
  });

  it("caps oversized tool result text during persistence", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm);

    sm.appendMessage(toolCallMessage);
    sm.appendMessage(
      asAppendMessage({
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "x".repeat(500_000) }],
        isError: false,
        timestamp: Date.now(),
      }),
    );

    const entries = sm
      .getEntries()
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: AgentMessage }).message);

    const toolResult = entries.find((m) => m.role === "toolResult") as {
      content: Array<{ type: string; text: string }>;
    };
    expect(toolResult).toBeDefined();
    const textBlock = toolResult.content.find((b: { type: string }) => b.type === "text") as {
      text: string;
    };
    expect(textBlock.text.length).toBeLessThan(500_000);
    expect(textBlock.text).toContain("truncated");
  });

  it("does not truncate tool results under the limit", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm);

    const originalText = "small tool result";
    sm.appendMessage(toolCallMessage);
    sm.appendMessage(
      asAppendMessage({
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: originalText }],
        isError: false,
        timestamp: Date.now(),
      }),
    );

    const entries = sm
      .getEntries()
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: AgentMessage }).message);

    const toolResult = entries.find((m) => m.role === "toolResult") as {
      content: Array<{ type: string; text: string }>;
    };
    const textBlock = toolResult.content.find((b: { type: string }) => b.type === "text") as {
      text: string;
    };
    expect(textBlock.text).toBe(originalText);
  });

  it("applies message persistence transform to user messages", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm, {
      transformMessageForPersistence: (message) =>
        (message as { role?: string }).role === "user"
          ? ({
              ...(message as unknown as Record<string, unknown>),
              provenance: { kind: "inter_session", sourceTool: "sessions_send" },
            } as AgentMessage)
          : message,
    });

    sm.appendMessage(
      asAppendMessage({
        role: "user",
        content: "forwarded",
        timestamp: Date.now(),
      }),
    );

    const persisted = sm.getEntries().find((e) => e.type === "message") as
      | { message?: Record<string, unknown> }
      | undefined;
    expect(persisted?.message?.role).toBe("user");
    expect(persisted?.message?.provenance).toEqual({
      kind: "inter_session",
      sourceTool: "sessions_send",
    });

  it("keeps secrets in memory but redacts them on disk (xoxb token)", () => {
    const { sm, getSessionFile } = createTrackedDiskSM();
    installSessionToolResultGuard(sm);

    const secret = "xoxb-fake-test-token-not-real-abcdefghij";
    sm.appendMessage(toolCallMessage);
    sm.appendMessage(
      asAppendMessage({
        role: "toolResult",
        toolCallId: "call_1",
        content: [{ type: "text", text: `{"botToken": "${secret}"}` }],
      }),
    );

    // In-memory: agent sees the unredacted secret
    const memEntries = sm
      .getEntries()
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: AgentMessage }).message);
    const memText = (
      memEntries.find((m) => m.role === "toolResult") as {
        content: Array<{ type: string; text: string }>;
      }
    ).content.find((b) => b.type === "text")!.text;
    expect(memText).toContain(secret);

    // On disk: secret is redacted
    const diskEntries = readSessionJsonl(getSessionFile());
    const diskToolResult = diskEntries.find(
      (e) =>
        (e as Record<string, unknown>).type === "message" &&
        ((e as Record<string, unknown>).message as { role?: string })?.role === "toolResult",
    ) as Record<string, unknown>;
    const diskText = extractToolResultText(diskToolResult)!;
    expect(diskText).not.toContain(secret);
    expect(diskText).toContain("xoxb-f");
    expect(diskText).toContain("…");
  });

  it("keeps secrets in memory but redacts them on disk (sk-ant key)", () => {
    const { sm, getSessionFile } = createTrackedDiskSM();
    installSessionToolResultGuard(sm);

    const secret = "sk-ant-fake-test-key-abcdefghijklmnopqrstuvwxyz";
    sm.appendMessage(toolCallMessage);
    sm.appendMessage(
      asAppendMessage({
        role: "toolResult",
        toolCallId: "call_1",
        content: [{ type: "text", text: `token: "${secret}"` }],
      }),
    );

    // In-memory: unredacted
    const memText = (
      sm
        .getEntries()
        .filter((e) => e.type === "message")
        .map((e) => (e as { message: AgentMessage }).message)
        .find((m) => m.role === "toolResult") as { content: Array<{ type: string; text: string }> }
    ).content.find((b) => b.type === "text")!.text;
    expect(memText).toContain(secret);

    // On disk: redacted
    const diskEntries = readSessionJsonl(getSessionFile());
    const diskToolResult = diskEntries.find(
      (e) =>
        (e as Record<string, unknown>).type === "message" &&
        ((e as Record<string, unknown>).message as { role?: string })?.role === "toolResult",
    ) as Record<string, unknown>;
    expect(extractToolResultText(diskToolResult)).not.toContain(secret);
  });

  it("keeps secrets in memory but redacts them on disk (Bearer JWT)", () => {
    const { sm, getSessionFile } = createTrackedDiskSM();
    installSessionToolResultGuard(sm);

    const jwt = "eyJhbGciOiJSUzI1NiIsInR5cCIgOiAiSldUIiwiZXhwIjoiMTIzNCJ9.payload.signature";
    sm.appendMessage(toolCallMessage);
    sm.appendMessage(
      asAppendMessage({
        role: "toolResult",
        toolCallId: "call_1",
        content: [{ type: "text", text: `curl -H "Authorization: Bearer ${jwt}"` }],
      }),
    );

    // In-memory: unredacted
    const memText = (
      sm
        .getEntries()
        .filter((e) => e.type === "message")
        .map((e) => (e as { message: AgentMessage }).message)
        .find((m) => m.role === "toolResult") as { content: Array<{ type: string; text: string }> }
    ).content.find((b) => b.type === "text")!.text;
    expect(memText).toContain(jwt);

    // On disk: redacted
    const diskEntries = readSessionJsonl(getSessionFile());
    const diskToolResult = diskEntries.find(
      (e) =>
        (e as Record<string, unknown>).type === "message" &&
        ((e as Record<string, unknown>).message as { role?: string })?.role === "toolResult",
    ) as Record<string, unknown>;
    expect(extractToolResultText(diskToolResult)).not.toContain(jwt);
  });

  it("does not modify tool results without secrets (memory and disk match)", () => {
    const { sm, getSessionFile } = createTrackedDiskSM();
    installSessionToolResultGuard(sm);

    const cleanText = "total 42\ndrwxr-xr-x 5 user user 4096 Feb 8 ls output";
    sm.appendMessage(toolCallMessage);
    sm.appendMessage(
      asAppendMessage({
        role: "toolResult",
        toolCallId: "call_1",
        content: [{ type: "text", text: cleanText }],
      }),
    );

    // In-memory: unchanged
    const memText = (
      sm
        .getEntries()
        .filter((e) => e.type === "message")
        .map((e) => (e as { message: AgentMessage }).message)
        .find((m) => m.role === "toolResult") as { content: Array<{ type: string; text: string }> }
    ).content.find((b) => b.type === "text")!.text;
    expect(memText).toBe(cleanText);

    // On disk: also unchanged
    const diskEntries = readSessionJsonl(getSessionFile());
    const diskToolResult = diskEntries.find(
      (e) =>
        (e as Record<string, unknown>).type === "message" &&
        ((e as Record<string, unknown>).message as { role?: string })?.role === "toolResult",
    ) as Record<string, unknown>;
    expect(extractToolResultText(diskToolResult)).toBe(cleanText);
  });

  it("keeps secrets in memory but redacts them on disk (Google API key)", () => {
    const { sm, getSessionFile } = createTrackedDiskSM();
    installSessionToolResultGuard(sm);

    const secret = "AIzaSyBxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
    sm.appendMessage(toolCallMessage);
    sm.appendMessage(
      asAppendMessage({
        role: "toolResult",
        toolCallId: "call_1",
        content: [{ type: "text", text: `"apiKey": "${secret}"` }],
      }),
    );

    // In-memory: unredacted
    const memText = (
      sm
        .getEntries()
        .filter((e) => e.type === "message")
        .map((e) => (e as { message: AgentMessage }).message)
        .find((m) => m.role === "toolResult") as { content: Array<{ type: string; text: string }> }
    ).content.find((b) => b.type === "text")!.text;
    expect(memText).toContain(secret);

    // On disk: redacted
    const diskEntries = readSessionJsonl(getSessionFile());
    const diskToolResult = diskEntries.find(
      (e) =>
        (e as Record<string, unknown>).type === "message" &&
        ((e as Record<string, unknown>).message as { role?: string })?.role === "toolResult",
    ) as Record<string, unknown>;
    expect(extractToolResultText(diskToolResult)).not.toContain(secret);
  });

  it("redacts secrets on disk when _rewriteFile is triggered", () => {
    const { sm, getSessionFile } = createTrackedDiskSM();
    installSessionToolResultGuard(sm);

    const secret = "xoxb-rewrite-test-token-abcdefghijklmnop";
    // Build up entries that would trigger _rewriteFile (e.g., migration)
    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "text", text: `Token: ${secret}` }],
      }),
    );

    // Force a rewrite (simulates migration/recovery)
    (sm as unknown as { _rewriteFile: () => void })._rewriteFile();

    // On disk: secret should be redacted after rewrite
    const diskEntries = readSessionJsonl(getSessionFile());
    const assistantEntry = diskEntries.find(
      (e) =>
        (e as Record<string, unknown>).type === "message" &&
        ((e as Record<string, unknown>).message as { role?: string })?.role === "assistant",
    ) as Record<string, unknown>;
    expect(extractToolResultText(assistantEntry)).not.toContain(secret);

    // In-memory: still unredacted
    const memEntries = sm
      .getEntries()
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: AgentMessage }).message);
    const memText = (
      memEntries.find((m) => m.role === "assistant") as {
        content: Array<{ type: string; text: string }>;
      }
    ).content.find((b) => b.type === "text")!.text;
    expect(memText).toContain(secret);
  });

  it("redacts secrets in assistant messages on disk", () => {
    const { sm, getSessionFile } = createTrackedDiskSM();
    installSessionToolResultGuard(sm);

    const secret = "xoxb-leaked-in-assistant-message-abcdefghij";
    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "text", text: `The token is ${secret}` }],
      }),
    );

    // In-memory: unredacted
    const memEntries = sm
      .getEntries()
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: AgentMessage }).message);
    const memText = (
      memEntries.find((m) => m.role === "assistant") as {
        content: Array<{ type: string; text: string }>;
      }
    ).content.find((b) => b.type === "text")!.text;
    expect(memText).toContain(secret);

    // On disk: redacted
    const diskEntries = readSessionJsonl(getSessionFile());
    const assistantEntry = diskEntries.find(
      (e) =>
        (e as Record<string, unknown>).type === "message" &&
        ((e as Record<string, unknown>).message as { role?: string })?.role === "assistant",
    ) as Record<string, unknown>;
    expect(extractToolResultText(assistantEntry)).not.toContain(secret);
  });

  it("redacts secrets in user messages on disk", () => {
    const { sm, getSessionFile } = createTrackedDiskSM();
    installSessionToolResultGuard(sm);

    const secret = "sk-ant-user-pasted-secret-abcdefghijklmnopqr";
    // Need assistant first for persistence to trigger
    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
      }),
    );
    sm.appendMessage(
      asAppendMessage({
        role: "user",
        content: [{ type: "text", text: `My key is ${secret}` }],
      }),
    );

    // In-memory: unredacted
    const memEntries = sm
      .getEntries()
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: AgentMessage }).message);
    const memText = (
      memEntries.find((m) => m.role === "user") as {
        content: Array<{ type: string; text: string }>;
      }
    ).content.find((b) => b.type === "text")!.text;
    expect(memText).toContain(secret);

    // On disk: redacted
    const diskEntries = readSessionJsonl(getSessionFile());
    const userEntry = diskEntries.find(
      (e) =>
        (e as Record<string, unknown>).type === "message" &&
        ((e as Record<string, unknown>).message as { role?: string })?.role === "user",
    ) as Record<string, unknown>;
    expect(extractToolResultText(userEntry)).not.toContain(secret);
  });

  it("does not modify non-message entries (session header, labels)", () => {
    const { sm, getSessionFile } = createTrackedDiskSM();
    installSessionToolResultGuard(sm);

    // Trigger persistence with an assistant message
    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
      }),
    );

    // Session header should be unchanged on disk
    const diskEntries = readSessionJsonl(getSessionFile());
    const header = diskEntries.find(
      (e) => (e as Record<string, unknown>).type === "session",
    ) as Record<string, unknown>;
    expect(header).toBeDefined();
    expect(header.type).toBe("session");
    expect(header.id).toBeDefined();
  });
});
