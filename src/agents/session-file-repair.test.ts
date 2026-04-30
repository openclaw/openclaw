import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { repairSessionFileIfNeeded } from "./session-file-repair.js";

function buildSessionHeaderAndMessage() {
  const header = {
    type: "session",
    version: 7,
    id: "session-1",
    timestamp: new Date().toISOString(),
    cwd: "/tmp",
  };
  const message = {
    type: "message",
    id: "msg-1",
    parentId: null,
    timestamp: new Date().toISOString(),
    message: { role: "user", content: "hello" },
  };
  return { header, message };
}

const tempDirs: string[] = [];

async function createTempSessionPath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-repair-"));
  tempDirs.push(dir);
  return { dir, file: path.join(dir, "session.jsonl") };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("repairSessionFileIfNeeded", () => {
  it("rewrites session files that contain malformed lines", async () => {
    const { file } = await createTempSessionPath();
    const { header, message } = buildSessionHeaderAndMessage();

    const content = `${JSON.stringify(header)}\n${JSON.stringify(message)}\n{"type":"message"`;
    await fs.writeFile(file, content, "utf-8");

    const result = await repairSessionFileIfNeeded({ sessionFile: file });
    expect(result.repaired).toBe(true);
    expect(result.droppedLines).toBe(1);
    expect(result.backupPath).toBeTruthy();

    const repaired = await fs.readFile(file, "utf-8");
    expect(repaired.trim().split("\n")).toHaveLength(2);

    if (result.backupPath) {
      const backup = await fs.readFile(result.backupPath, "utf-8");
      expect(backup).toBe(content);
    }
  });

  it("does not drop CRLF-terminated JSONL lines", async () => {
    const { file } = await createTempSessionPath();
    const { header, message } = buildSessionHeaderAndMessage();
    const content = `${JSON.stringify(header)}\r\n${JSON.stringify(message)}\r\n`;
    await fs.writeFile(file, content, "utf-8");

    const result = await repairSessionFileIfNeeded({ sessionFile: file });
    expect(result.repaired).toBe(false);
    expect(result.droppedLines).toBe(0);
  });

  it("warns and skips repair when the session header is invalid", async () => {
    const { file } = await createTempSessionPath();
    const badHeader = {
      type: "message",
      id: "msg-1",
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "hello" },
    };
    const content = `${JSON.stringify(badHeader)}\n{"type":"message"`;
    await fs.writeFile(file, content, "utf-8");

    const warn = vi.fn();
    const result = await repairSessionFileIfNeeded({ sessionFile: file, warn });

    expect(result.repaired).toBe(false);
    expect(result.reason).toBe("invalid session header");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("invalid session header");
  });

  it("returns a detailed reason when read errors are not ENOENT", async () => {
    const { dir } = await createTempSessionPath();
    const warn = vi.fn();

    const result = await repairSessionFileIfNeeded({ sessionFile: dir, warn });

    expect(result.repaired).toBe(false);
    expect(result.reason).toContain("failed to read session file");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("rewrites persisted assistant messages with empty content arrays (mid-transcript)", async () => {
    // Poisoned assistant entry followed by a user turn: the rewrite must preserve the entry
    // (with fallback text) because it is not a trailing assistant turn.
    const { file } = await createTempSessionPath();
    const { header, message } = buildSessionHeaderAndMessage();
    const poisonedAssistantEntry = {
      type: "message",
      id: "msg-2",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [],
        api: "bedrock-converse-stream",
        provider: "amazon-bedrock",
        model: "anthropic.claude-3-haiku-20240307-v1:0",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
        stopReason: "error",
        errorMessage: "transient stream failure",
      },
    };
    // header → poisoned assistant → user (not trailing)
    const original = `${JSON.stringify(header)}\n${JSON.stringify(poisonedAssistantEntry)}\n${JSON.stringify(message)}\n`;
    await fs.writeFile(file, original, "utf-8");

    const warn = vi.fn();
    const result = await repairSessionFileIfNeeded({ sessionFile: file, warn });

    expect(result.repaired).toBe(true);
    expect(result.droppedLines).toBe(0);
    expect(result.rewrittenAssistantMessages).toBe(1);
    expect(result.backupPath).toBeTruthy();
    expect(warn).toHaveBeenCalledTimes(1);
    const warnMessage = warn.mock.calls[0]?.[0] as string;
    expect(warnMessage).toContain("rewrote 1 assistant message(s)");

    const repaired = await fs.readFile(file, "utf-8");
    const repairedLines = repaired.trim().split("\n");
    expect(repairedLines).toHaveLength(3);
    const repairedEntry: { message: { content: { type: string; text: string }[] } } = JSON.parse(
      repairedLines[1] ?? "{}",
    );
    expect(repairedEntry.message.content).toEqual([
      { type: "text", text: "[assistant turn failed before producing content]" },
    ]);
  });

  it("drops persisted blank user text messages", async () => {
    const { file } = await createTempSessionPath();
    const { header, message } = buildSessionHeaderAndMessage();
    const blankUserEntry = {
      type: "message",
      id: "msg-blank",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "user",
        content: [{ type: "text", text: "" }],
      },
    };
    const original = `${JSON.stringify(header)}\n${JSON.stringify(blankUserEntry)}\n${JSON.stringify(message)}\n`;
    await fs.writeFile(file, original, "utf-8");

    const warn = vi.fn();
    const result = await repairSessionFileIfNeeded({ sessionFile: file, warn });

    expect(result.repaired).toBe(true);
    expect(result.droppedBlankUserMessages).toBe(1);
    expect(warn.mock.calls[0]?.[0]).toContain("dropped 1 blank user message(s)");

    const repaired = await fs.readFile(file, "utf-8");
    const repairedLines = repaired.trim().split("\n");
    expect(repairedLines).toHaveLength(2);
    expect(JSON.parse(repairedLines[1])?.id).toBe("msg-1");
  });

  it("removes blank user text blocks while preserving media blocks", async () => {
    const { file } = await createTempSessionPath();
    const { header } = buildSessionHeaderAndMessage();
    const mediaUserEntry = {
      type: "message",
      id: "msg-media",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "user",
        content: [
          { type: "text", text: "   " },
          { type: "image", data: "AA==", mimeType: "image/png" },
        ],
      },
    };
    const original = `${JSON.stringify(header)}\n${JSON.stringify(mediaUserEntry)}\n`;
    await fs.writeFile(file, original, "utf-8");

    const result = await repairSessionFileIfNeeded({ sessionFile: file });

    expect(result.repaired).toBe(true);
    expect(result.rewrittenUserMessages).toBe(1);
    const repaired = await fs.readFile(file, "utf-8");
    const repairedEntry = JSON.parse(repaired.trim().split("\n")[1] ?? "{}");
    expect(repairedEntry.message.content).toEqual([
      { type: "image", data: "AA==", mimeType: "image/png" },
    ]);
  });

  it("reports both drops and rewrites in the warn message when both occur", async () => {
    const { file } = await createTempSessionPath();
    const { header } = buildSessionHeaderAndMessage();
    const poisonedAssistantEntry = {
      type: "message",
      id: "msg-2",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [],
        api: "bedrock-converse-stream",
        provider: "amazon-bedrock",
        model: "anthropic.claude-3-haiku-20240307-v1:0",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
        stopReason: "error",
      },
    };
    const original = `${JSON.stringify(header)}\n${JSON.stringify(poisonedAssistantEntry)}\n{"type":"message"`;
    await fs.writeFile(file, original, "utf-8");

    const warn = vi.fn();
    const result = await repairSessionFileIfNeeded({ sessionFile: file, warn });

    expect(result.repaired).toBe(true);
    expect(result.droppedLines).toBe(1);
    expect(result.rewrittenAssistantMessages).toBe(1);
    const warnMessage = warn.mock.calls[0]?.[0] as string;
    expect(warnMessage).toContain("dropped 1 malformed line(s)");
    expect(warnMessage).toContain("rewrote 1 assistant message(s)");
  });

  it("does not rewrite silent-reply turns (stopReason=stop) mid-transcript", async () => {
    // A silent-reply assistant turn in the MIDDLE of a transcript (followed by a user turn)
    // must not be mutated into the synthetic fallback text — that would corrupt historical
    // replay. The trailing-assistant trim only applies when the entry is the LAST message.
    const { file } = await createTempSessionPath();
    const { header, message } = buildSessionHeaderAndMessage();
    const silentReplyEntry = {
      type: "message",
      id: "msg-2",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [],
        api: "openai-responses",
        provider: "ollama",
        model: "glm-5.1:cloud",
        usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 100 },
        stopReason: "stop",
      },
    };
    // header → silentReply → user → not a trailing assistant turn
    const original = `${JSON.stringify(header)}\n${JSON.stringify(silentReplyEntry)}\n${JSON.stringify(message)}\n`;
    await fs.writeFile(file, original, "utf-8");

    const result = await repairSessionFileIfNeeded({ sessionFile: file });

    expect(result.repaired).toBe(false);
    expect(result.rewrittenAssistantMessages ?? 0).toBe(0);
    const after = await fs.readFile(file, "utf-8");
    expect(after).toBe(original);
  });

  it("drops trailing repaired assistant error turns to prevent Anthropic 400 prefill rejection (#75271)", async () => {
    // Regression for openclaw/openclaw#75271: a session that ends on role=assistant
    // after this repair pass rewrites an empty error turn causes Anthropic to reject
    // with HTTP 400 "does not support assistant message prefill".
    const { file } = await createTempSessionPath();
    const { header, message } = buildSessionHeaderAndMessage();
    const assistantEntry = {
      type: "message",
      id: "msg-2",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
      },
    };
    // header -> user -> failed assistant artifact (trailing, should be dropped)
    const original = `${JSON.stringify(header)}\n${JSON.stringify(message)}\n${JSON.stringify(assistantEntry)}\n`;
    await fs.writeFile(file, original, "utf-8");

    const warn = vi.fn();
    const result = await repairSessionFileIfNeeded({ sessionFile: file, warn });

    expect(result.repaired).toBe(true);
    expect(result.rewrittenAssistantMessages).toBe(1);
    expect(result.droppedTrailingAssistantMessages).toBe(1);
    expect(warn.mock.calls[0]?.[0]).toContain("dropped 1 trailing assistant message(s)");

    const repaired = await fs.readFile(file, "utf-8");
    const repairedLines = repaired.trim().split("\n");
    expect(repairedLines).toHaveLength(2);
    expect(JSON.parse(repairedLines[1] ?? "{}").message?.role).toBe("user");
  });

  it("drops multiple consecutive trailing assistant repair artifacts", async () => {
    const { file } = await createTempSessionPath();
    const { header, message } = buildSessionHeaderAndMessage();
    const makeAssistant = (id: string) => ({
      type: "message",
      id,
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "[assistant turn failed before producing content]" }],
        stopReason: "error",
      },
    });
    const original =
      [header, message, makeAssistant("a1"), makeAssistant("a2")]
        .map((e) => JSON.stringify(e))
        .join("\n") + "\n";
    await fs.writeFile(file, original, "utf-8");

    const result = await repairSessionFileIfNeeded({ sessionFile: file });

    expect(result.repaired).toBe(true);
    expect(result.droppedTrailingAssistantMessages).toBe(2);
    const repaired = await fs.readFile(file, "utf-8");
    const lines = repaired.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1] ?? "{}").message?.role).toBe("user");
  });

  it("preserves normal completed trailing assistant turns", async () => {
    const { file } = await createTempSessionPath();
    const { header, message } = buildSessionHeaderAndMessage();
    const assistantEntry = {
      type: "message",
      id: "msg-2",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello from assistant." }],
        stopReason: "stop",
      },
    };
    const original = `${JSON.stringify(header)}\n${JSON.stringify(message)}\n${JSON.stringify(assistantEntry)}\n`;
    await fs.writeFile(file, original, "utf-8");

    const result = await repairSessionFileIfNeeded({ sessionFile: file });

    expect(result.repaired).toBe(false);
    expect(result.droppedTrailingAssistantMessages ?? 0).toBe(0);
    const after = await fs.readFile(file, "utf-8");
    expect(after).toBe(original);
  });

  it("is a no-op on a session that was already repaired (healed assistant mid-transcript)", async () => {
    // Idempotency check: after repair writes a healed assistant entry followed by a user turn,
    // a second repair pass must produce no further changes.
    const { file } = await createTempSessionPath();
    const { header, message } = buildSessionHeaderAndMessage();
    const healedEntry = {
      type: "message",
      id: "msg-2",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "[assistant turn failed before producing content]" }],
        api: "bedrock-converse-stream",
        provider: "amazon-bedrock",
        model: "anthropic.claude-3-haiku-20240307-v1:0",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
        stopReason: "error",
      },
    };
    // header → healed assistant → user (last entry is user, not assistant)
    const original = `${JSON.stringify(header)}\n${JSON.stringify(healedEntry)}\n${JSON.stringify(message)}\n`;
    await fs.writeFile(file, original, "utf-8");

    const result = await repairSessionFileIfNeeded({ sessionFile: file });

    expect(result.repaired).toBe(false);
    expect(result.rewrittenAssistantMessages ?? 0).toBe(0);
    const after = await fs.readFile(file, "utf-8");
    expect(after).toBe(original);
  });
});
