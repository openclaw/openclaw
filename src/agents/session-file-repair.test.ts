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

  it("rewrites persisted assistant messages with empty content arrays", async () => {
    // A mid-transcript errored-empty assistant entry (one followed by a real
    // user turn) is rewritten in place to the sentinel so the historical
    // timeline stays readable. Trailing errored-empty entries are handled
    // separately by the trailing-drop pass below — the rewrite path is
    // specifically the mid-transcript case here.
    const { file } = await createTempSessionPath();
    const { header, message: leadingUser } = buildSessionHeaderAndMessage();
    const poisonedAssistantEntry = {
      type: "message",
      id: "msg-2",
      parentId: "msg-1",
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
    const trailingUser = {
      type: "message",
      id: "msg-3",
      parentId: "msg-2",
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "continuing after the error" },
    };
    const original = `${JSON.stringify(header)}\n${JSON.stringify(leadingUser)}\n${JSON.stringify(poisonedAssistantEntry)}\n${JSON.stringify(trailingUser)}\n`;
    await fs.writeFile(file, original, "utf-8");

    const warn = vi.fn();
    const result = await repairSessionFileIfNeeded({ sessionFile: file, warn });

    expect(result.repaired).toBe(true);
    expect(result.droppedLines).toBe(0);
    expect(result.rewrittenAssistantMessages).toBe(1);
    expect(result.droppedTrailingErrorEntries ?? 0).toBe(0);
    expect(result.backupPath).toBeTruthy();
    // Warn message must omit the "dropped 0 malformed line(s)" noise when
    // nothing was dropped; only the rewrite count is reported.
    expect(warn).toHaveBeenCalledTimes(1);
    const warnMessage = warn.mock.calls[0]?.[0] as string;
    expect(warnMessage).toContain("rewrote 1 assistant message(s)");
    expect(warnMessage).not.toContain("dropped");

    const repaired = await fs.readFile(file, "utf-8");
    const repairedLines = repaired.trim().split("\n");
    expect(repairedLines).toHaveLength(4);
    const repairedEntry: { message: { content: { type: string; text: string }[] } } = JSON.parse(
      repairedLines[2],
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
    const { header, message: leadingUser } = buildSessionHeaderAndMessage();
    const poisonedAssistantEntry = {
      type: "message",
      id: "msg-2",
      parentId: "msg-1",
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
    const trailingUser = {
      type: "message",
      id: "msg-3",
      parentId: "msg-2",
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "keep going" },
    };
    const original = `${JSON.stringify(header)}\n${JSON.stringify(leadingUser)}\n${JSON.stringify(poisonedAssistantEntry)}\n${JSON.stringify(trailingUser)}\n{"type":"message"`;
    await fs.writeFile(file, original, "utf-8");

    const warn = vi.fn();
    const result = await repairSessionFileIfNeeded({ sessionFile: file, warn });

    expect(result.repaired).toBe(true);
    expect(result.droppedLines).toBe(1);
    expect(result.rewrittenAssistantMessages).toBe(1);
    expect(result.droppedTrailingErrorEntries ?? 0).toBe(0);
    const warnMessage = warn.mock.calls[0]?.[0] as string;
    expect(warnMessage).toContain("dropped 1 malformed line(s)");
    expect(warnMessage).toContain("rewrote 1 assistant message(s)");
  });

  it("does not rewrite silent-reply turns (stopReason=stop, content=[]) on disk", async () => {
    // Mirror of the in-memory replay-history test: a clean stop with no
    // content is a legitimate silent reply (NO_REPLY token path). Repair
    // must NOT permanently mutate it into a synthetic "[assistant turn
    // failed before producing content]" entry — that would corrupt the
    // historical transcript and replay fabricated failure text on every
    // future provider request.
    const { file } = await createTempSessionPath();
    const { header } = buildSessionHeaderAndMessage();
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
    const original = `${JSON.stringify(header)}\n${JSON.stringify(silentReplyEntry)}\n`;
    await fs.writeFile(file, original, "utf-8");

    const result = await repairSessionFileIfNeeded({ sessionFile: file });

    expect(result.repaired).toBe(false);
    expect(result.rewrittenAssistantMessages ?? 0).toBe(0);
    const after = await fs.readFile(file, "utf-8");
    expect(after).toBe(original);
  });

  it("is a no-op on a session that was already repaired", async () => {
    // Already-healed sentinel sitting *between* a real user turn and a later
    // user turn is still a valid mid-transcript artifact — leave it alone.
    const { file } = await createTempSessionPath();
    const { header, message: leadingUser } = buildSessionHeaderAndMessage();
    const healedEntry = {
      type: "message",
      id: "msg-2",
      parentId: "msg-1",
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
    const trailingUser = {
      type: "message",
      id: "msg-3",
      parentId: "msg-2",
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "continuing after the error" },
    };
    const original = `${JSON.stringify(header)}\n${JSON.stringify(leadingUser)}\n${JSON.stringify(healedEntry)}\n${JSON.stringify(trailingUser)}\n`;
    await fs.writeFile(file, original, "utf-8");

    const result = await repairSessionFileIfNeeded({ sessionFile: file });

    expect(result.repaired).toBe(false);
    expect(result.rewrittenAssistantMessages ?? 0).toBe(0);
    expect(result.droppedTrailingErrorEntries ?? 0).toBe(0);
    const after = await fs.readFile(file, "utf-8");
    expect(after).toBe(original);
  });

  it("drops a trailing errored-empty assistant entry instead of rewriting it", async () => {
    // Regression for the heartbeat resume loop: rewriting a *trailing*
    // empty-content errored assistant turn into the sentinel never restores
    // the "conversation must end with a user message" invariant that
    // Anthropic Messages enforces, so the next replay 400s with the same
    // "This model does not support assistant message prefill" error and
    // each failed attempt appends another empty assistant entry the next
    // repair pass also cannot fix in place. Dropping the trailing entry
    // breaks the loop by leaving the transcript ending on a user turn.
    const { file } = await createTempSessionPath();
    const { header, message: userMessage } = buildSessionHeaderAndMessage();
    const trailingErroredEntry = {
      type: "message",
      id: "msg-2",
      parentId: "msg-1",
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-opus-4-7",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
        stopReason: "error",
        errorMessage:
          '400 {"type":"error","error":{"type":"invalid_request_error","message":"This model does not support assistant message prefill. The conversation must end with a user message."}}',
      },
    };
    const original = `${JSON.stringify(header)}\n${JSON.stringify(userMessage)}\n${JSON.stringify(trailingErroredEntry)}\n`;
    await fs.writeFile(file, original, "utf-8");

    const warn = vi.fn();
    const result = await repairSessionFileIfNeeded({ sessionFile: file, warn });

    expect(result.repaired).toBe(true);
    expect(result.droppedTrailingErrorEntries).toBe(1);
    expect(result.rewrittenAssistantMessages ?? 0).toBe(0);
    const warnMessage = warn.mock.calls[0]?.[0] as string;
    expect(warnMessage).toContain("dropped 1 trailing errored assistant entry(ies)");
    expect(warnMessage).not.toContain("rewrote");

    const repaired = await fs.readFile(file, "utf-8");
    const repairedLines = repaired.trim().split("\n");
    expect(repairedLines).toHaveLength(2);
    const lastEntry = JSON.parse(repairedLines[1]) as { message: { role: string } };
    expect(lastEntry.message.role).toBe("user");
  });

  it("drops a trailing already-healed errored assistant entry on a second pass", async () => {
    // Sessions that were healed before this fix shipped already have the
    // sentinel form `[assistant turn failed before producing content]`
    // sitting at the tail. Treat that as droppable too — otherwise the
    // post-upgrade heartbeat keeps hitting the same provider 400 even
    // though the transcript looks "already repaired" to the prior heuristic.
    const { file } = await createTempSessionPath();
    const { header, message: userMessage } = buildSessionHeaderAndMessage();
    const trailingHealedEntry = {
      type: "message",
      id: "msg-2",
      parentId: "msg-1",
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "[assistant turn failed before producing content]" }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-opus-4-7",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
        stopReason: "error",
      },
    };
    const original = `${JSON.stringify(header)}\n${JSON.stringify(userMessage)}\n${JSON.stringify(trailingHealedEntry)}\n`;
    await fs.writeFile(file, original, "utf-8");

    const result = await repairSessionFileIfNeeded({ sessionFile: file });

    expect(result.repaired).toBe(true);
    expect(result.droppedTrailingErrorEntries).toBe(1);
    expect(result.rewrittenAssistantMessages ?? 0).toBe(0);
    const repaired = await fs.readFile(file, "utf-8");
    const repairedLines = repaired.trim().split("\n");
    expect(repairedLines).toHaveLength(2);
  });

  it("drops a run of trailing errored assistant entries from a stuck session", async () => {
    // Reproduces the production bleed: each failed heartbeat appends another
    // errored assistant entry (some empty, some already healed by a prior
    // repair pass) and the next repair cannot rescue the session in place.
    // The trailing-drop pass must clear the entire run so the transcript
    // ends on the original user turn again.
    const { file } = await createTempSessionPath();
    const { header, message: userMessage } = buildSessionHeaderAndMessage();
    const tailEntries = [
      {
        type: "message",
        id: "msg-tail-1",
        parentId: "msg-1",
        timestamp: new Date().toISOString(),
        message: {
          role: "assistant",
          content: [{ type: "text", text: "[assistant turn failed before producing content]" }],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude-opus-4-7",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
          stopReason: "error",
        },
      },
      {
        type: "message",
        id: "msg-tail-2",
        parentId: "msg-tail-1",
        timestamp: new Date().toISOString(),
        message: {
          role: "assistant",
          content: [],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude-opus-4-7",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
          stopReason: "error",
        },
      },
    ];
    const original = `${JSON.stringify(header)}\n${JSON.stringify(userMessage)}\n${tailEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
    await fs.writeFile(file, original, "utf-8");

    const result = await repairSessionFileIfNeeded({ sessionFile: file });

    expect(result.repaired).toBe(true);
    expect(result.droppedTrailingErrorEntries).toBe(2);
    expect(result.rewrittenAssistantMessages ?? 0).toBe(0);
    const repaired = await fs.readFile(file, "utf-8");
    const repairedLines = repaired.trim().split("\n");
    expect(repairedLines).toHaveLength(2);
    const lastEntry = JSON.parse(repairedLines[1]) as { message: { role: string } };
    expect(lastEntry.message.role).toBe("user");
  });

  it("does not drop trailing entries that come after non-message tail entries", async () => {
    // Non-message tail entries (compaction, model_change, branch_summary,
    // thinking_level_change, etc.) sit on top of the message timeline and
    // are not sent to the model, so they do not break the "ends with user"
    // invariant on their own. The trailing-drop pass must leave them alone
    // so unrelated state at the file tail is not silently discarded.
    const { file } = await createTempSessionPath();
    const { header, message: userMessage } = buildSessionHeaderAndMessage();
    const compactionEntry = {
      type: "compaction",
      id: "compaction-1",
      timestamp: new Date().toISOString(),
      summary: "prior turns compacted for context window management",
    };
    const original = `${JSON.stringify(header)}\n${JSON.stringify(userMessage)}\n${JSON.stringify(compactionEntry)}\n`;
    await fs.writeFile(file, original, "utf-8");

    const result = await repairSessionFileIfNeeded({ sessionFile: file });

    expect(result.repaired).toBe(false);
    expect(result.droppedTrailingErrorEntries ?? 0).toBe(0);
    const after = await fs.readFile(file, "utf-8");
    expect(after).toBe(original);
  });
});
