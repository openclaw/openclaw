import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createClaudeTranscriptTailer } from "./local-session-transcript-tail.js";

const SESSION_ID = "11111111-2222-4333-8444-555555555555";
const TS = "2026-09-10T20:07:11.304Z";
const TS_MS = Date.parse(TS);

function line(record: Record<string, unknown>): string {
  return `${JSON.stringify({ sessionId: SESSION_ID, timestamp: TS, isSidechain: false, ...record })}\n`;
}

function userLine(uuid: string, content: unknown, extra: Record<string, unknown> = {}) {
  return line({ type: "user", uuid, message: { role: "user", content }, ...extra });
}

function assistantLine(uuid: string, content: unknown, stopReason = "tool_use") {
  return line({
    type: "assistant",
    uuid,
    message: { role: "assistant", content, stop_reason: stopReason },
  });
}

describe("transcript line conversion", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "claude-line-")));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  // One line through the real tailer: the first emitted record carries seq 1.
  const convert = async (text: string) => {
    const filePath = path.join(dir, `${SESSION_ID}.jsonl`);
    await fs.writeFile(filePath, `${text.trimEnd()}\n`);
    const { records } = await createClaudeTranscriptTailer(filePath).bootstrap(0);
    return records[0];
  };

  it.each([
    ["user string", userLine("u1", "hello"), { kind: "user", text: "hello" }],
    [
      "user text blocks",
      userLine("u2", [{ type: "text", text: "hi" }]),
      { kind: "user", text: "hi" },
    ],
    [
      "assistant text ending the turn",
      assistantLine("a1", [{ type: "text", text: "done" }], "end_turn"),
      { kind: "assistant", text: "done", endsTurn: true },
    ],
    [
      "reasoning",
      assistantLine("a2", [{ type: "thinking", thinking: "plan", signature: "x" }]),
      { kind: "reasoning", text: "plan" },
    ],
    [
      "tool call with bounded JSON input",
      assistantLine("a3", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }]),
      { kind: "toolCall", toolName: "Bash", text: '{\n "command": "ls"\n}' },
    ],
    [
      "tool result",
      userLine("u3", [{ type: "tool_result", tool_use_id: "t1", content: "file.txt" }]),
      { kind: "toolResult", text: "file.txt" },
    ],
    [
      "channel echo carries the input id",
      userLine(
        "u4",
        '<channel source="openclaw" sender="Ann" openclaw_input_id="in_123">go</channel>',
        {
          isMeta: true,
        },
      ),
      { kind: "user", clientId: "in_123" },
    ],
  ])("converts %s", async (_label, raw, expected) => {
    expect(await convert(raw)).toMatchObject({ seq: 1, ts: TS_MS, ...expected });
  });

  it.each([
    ["meta prompts", userLine("m1", "<system-reminder>x</system-reminder>", { isMeta: true })],
    ["sidechains", userLine("s1", "side", { isSidechain: true })],
    ["metadata rows", line({ type: "custom-title", customTitle: "t" })],
    ["hook summaries", line({ type: "system", subtype: "stop_hook_summary", uuid: "h1" })],
    ["records without a uuid", line({ type: "user", message: { role: "user", content: "x" } })],
    ["malformed JSON", "{not json\n"],
  ])("skips %s", async (_label, raw) => {
    expect(await convert(raw)).toBeUndefined();
  });
});

describe("createClaudeTranscriptTailer", () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "claude-tail-")));
    filePath = path.join(dir, `${SESSION_ID}.jsonl`);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("numbers emitted records deterministically and skips metadata lines", async () => {
    await fs.writeFile(
      filePath,
      line({ type: "custom-title", customTitle: "t" }) +
        userLine("u1", "first") +
        line({ type: "file-history-snapshot" }) +
        assistantLine("a1", [{ type: "text", text: "reply" }], "end_turn"),
    );
    const tailer = createClaudeTranscriptTailer(filePath);
    const bootstrap = await tailer.bootstrap(0);
    expect(bootstrap.records.map((record) => [record.seq, record.id])).toEqual([
      [1, "u1"],
      [2, "a1"],
    ]);
    expect(bootstrap.earliestSeq).toBeUndefined();
    expect(tailer.lastSeq).toBe(2);
    const rescan = createClaudeTranscriptTailer(filePath);
    expect((await rescan.bootstrap(0)).records).toEqual(bootstrap.records);
  });

  it("never checkpoints a partial line", async () => {
    await fs.writeFile(filePath, userLine("u1", "first"));
    const tailer = createClaudeTranscriptTailer(filePath);
    await tailer.bootstrap(0);
    const full = assistantLine("a1", [{ type: "text", text: "partial then complete" }], "end_turn");
    await fs.appendFile(filePath, full.slice(0, 40));
    expect((await tailer.readNext()).records).toEqual([]);
    await fs.appendFile(filePath, full.slice(40));
    const { records } = await tailer.readNext();
    expect(records.map((record) => [record.seq, record.id, record.kind])).toEqual([
      [2, "a1", "assistant"],
    ]);
    expect((await tailer.readNext()).records).toEqual([]);
  });

  it("resumes after a cursor and reports the replay window start", async () => {
    await fs.writeFile(
      filePath,
      userLine("u1", "one") +
        assistantLine("a1", [{ type: "text", text: "two" }]) +
        userLine("u2", "three"),
    );
    const tailer = createClaudeTranscriptTailer(filePath);
    const bootstrap = await tailer.bootstrap(2);
    expect(bootstrap.records.map((record) => record.seq)).toEqual([3]);
    expect(bootstrap.earliestSeq).toBe(3);
    await fs.appendFile(filePath, userLine("u3", "four"));
    expect((await tailer.readNext()).records.map((record) => record.seq)).toEqual([4]);
  });

  it("rescans a truncated file and surfaces only records past the last handed-out seq", async () => {
    await fs.writeFile(filePath, userLine("u1", "one") + userLine("u2", "two"));
    const tailer = createClaudeTranscriptTailer(filePath);
    await tailer.bootstrap(0);
    await fs.writeFile(filePath, userLine("u1", "one"));
    expect((await tailer.readNext()).records).toEqual([]);
    await fs.appendFile(filePath, userLine("u2", "two") + userLine("u3", "three"));
    expect((await tailer.readNext()).records.map((record) => [record.seq, record.id])).toEqual([
      [3, "u3"],
    ]);
  });

  it("reports a removed transcript", async () => {
    await fs.writeFile(filePath, userLine("u1", "one"));
    const tailer = createClaudeTranscriptTailer(filePath);
    await tailer.bootstrap(0);
    await fs.rm(filePath);
    expect(await tailer.readNext()).toEqual({ records: [], missing: true });
  });
});
