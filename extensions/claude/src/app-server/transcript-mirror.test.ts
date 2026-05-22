import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectorAccumulator } from "./event-projector.js";
import {
  buildMirrorMessages,
  idempotencyKeyFor,
  mirrorClaudeAppServerTranscript,
} from "./transcript-mirror.js";

const tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function createTempSessionFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-claude-mirror-"));
  tempDirs.push(dir);
  return path.join(dir, "session.jsonl");
}

async function readMirroredMessages(
  sessionFile: string,
): Promise<Array<{ type?: string; message?: { idempotencyKey?: string; role?: string } }>> {
  const raw = await fs.readFile(sessionFile, "utf8");
  // appendSessionTranscriptMessage prepends a `{type: "session", ...}` header
  // line on first write; filter it out so test expectations only count
  // mirrored message records.
  return raw
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map(
      (l) =>
        JSON.parse(l) as { type?: string; message?: { idempotencyKey?: string; role?: string } },
    )
    .filter((r) => r.type !== "session");
}

function acc(overrides: Partial<ProjectorAccumulator> = {}): ProjectorAccumulator {
  return {
    assistantTexts: [],
    toolMetas: [],
    reasoning: "",
    itemCount: 0,
    toolCalls: new Map(),
    ...overrides,
  };
}

describe("idempotencyKeyFor", () => {
  it("produces the documented threadId/turnId/role/index shape", () => {
    expect(
      idempotencyKeyFor({ threadId: "thr_a", turnId: "turn_b", role: "assistant", index: 0 }),
    ).toBe("claude/thr_a/turn_b/assistant/0");
  });

  it("distinguishes tool result keys by index", () => {
    const k1 = idempotencyKeyFor({
      threadId: "thr",
      turnId: "t",
      role: "toolResult",
      index: 0,
    });
    const k2 = idempotencyKeyFor({
      threadId: "thr",
      turnId: "t",
      role: "toolResult",
      index: 1,
    });
    expect(k1).not.toBe(k2);
  });

  it("distinguishes across threads + turns", () => {
    expect(
      idempotencyKeyFor({ threadId: "thr_a", turnId: "t", role: "assistant", index: 0 }),
    ).not.toBe(idempotencyKeyFor({ threadId: "thr_b", turnId: "t", role: "assistant", index: 0 }));
    expect(
      idempotencyKeyFor({ threadId: "thr", turnId: "t1", role: "assistant", index: 0 }),
    ).not.toBe(idempotencyKeyFor({ threadId: "thr", turnId: "t2", role: "assistant", index: 0 }));
  });
});

describe("buildMirrorMessages", () => {
  it("returns an empty list when accumulator carries nothing", () => {
    const msgs = buildMirrorMessages({
      threadId: "thr",
      turnId: "t",
      lifecycleOutcome: "started",
      acc: acc(),
    });
    expect(msgs).toEqual([]);
  });

  it("emits a single assistant message when text is present", () => {
    const msgs = buildMirrorMessages({
      threadId: "thr",
      turnId: "t",
      lifecycleOutcome: "started",
      acc: acc({ assistantTexts: ["hello world"], itemCount: 1 }),
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.role).toBe("assistant");
    expect((msgs[0] as { content: string }).content).toBe("hello world");
  });

  it("tags lifecycleOutcome on the assistant message meta", () => {
    const msgs = buildMirrorMessages({
      threadId: "thr",
      turnId: "t",
      lifecycleOutcome: "resumed",
      acc: acc({ assistantTexts: ["x"] }),
    });
    const meta = (msgs[0] as unknown as { meta: { lifecycleOutcome: string } }).meta;
    expect(meta.lifecycleOutcome).toBe("resumed");
  });

  it("emits tool results before the assistant message", () => {
    const toolCalls = new Map<
      string,
      ProjectorAccumulator["toolCalls"] extends Map<string, infer V> ? V : never
    >();
    toolCalls.set("call_1", {
      name: "Read",
      result: "file contents",
      isError: false,
      startedAt: 1000,
      isDynamic: false,
    });
    toolCalls.set("call_2", {
      name: "vestige_search",
      result: [{ type: "inputText", text: "hits" }],
      isError: false,
      startedAt: 2000,
      isDynamic: true,
    });
    const msgs = buildMirrorMessages({
      threadId: "thr_a",
      turnId: "turn_b",
      lifecycleOutcome: "started",
      acc: acc({ toolCalls, assistantTexts: ["done"] }),
    });
    expect(msgs).toHaveLength(3);
    expect(msgs[0]?.role).toBe("toolResult");
    expect(msgs[1]?.role).toBe("toolResult");
    expect(msgs[2]?.role).toBe("assistant");
  });

  it("attaches stable idempotency keys to every message", () => {
    const toolCalls = new Map<
      string,
      ProjectorAccumulator["toolCalls"] extends Map<string, infer V> ? V : never
    >();
    toolCalls.set("call_1", { name: "Read", result: "x", isDynamic: false });
    const msgs = buildMirrorMessages({
      threadId: "thr",
      turnId: "t",
      lifecycleOutcome: "started",
      acc: acc({ toolCalls, assistantTexts: ["y"] }),
    });
    expect((msgs[0] as unknown as { idempotencyKey: string }).idempotencyKey).toBe(
      "claude/thr/t/toolResult/0",
    );
    expect((msgs[1] as unknown as { idempotencyKey: string }).idempotencyKey).toBe(
      "claude/thr/t/assistant/0",
    );
  });

  it("stringifies non-string tool results", () => {
    const toolCalls = new Map<
      string,
      ProjectorAccumulator["toolCalls"] extends Map<string, infer V> ? V : never
    >();
    toolCalls.set("call_1", {
      name: "vestige_search",
      result: { hits: [{ id: 1 }, { id: 2 }] },
      isDynamic: true,
    });
    const msgs = buildMirrorMessages({
      threadId: "thr",
      turnId: "t",
      lifecycleOutcome: "started",
      acc: acc({ toolCalls }),
    });
    expect((msgs[0] as { content: string }).content).toBe('{"hits":[{"id":1},{"id":2}]}');
  });

  it("flags errored tool results in meta", () => {
    const toolCalls = new Map<
      string,
      ProjectorAccumulator["toolCalls"] extends Map<string, infer V> ? V : never
    >();
    toolCalls.set("call_1", {
      name: "Bash",
      result: "exit 1",
      isError: true,
      isDynamic: false,
    });
    const msgs = buildMirrorMessages({
      threadId: "thr",
      turnId: "t",
      lifecycleOutcome: "started",
      acc: acc({ toolCalls }),
    });
    const meta = (msgs[0] as unknown as { meta: { isError: boolean } }).meta;
    expect(meta.isError).toBe(true);
  });
});

describe("mirrorClaudeAppServerTranscript", () => {
  it("appends one entry per message on a fresh session", async () => {
    const sessionFile = await createTempSessionFile();
    await mirrorClaudeAppServerTranscript({
      sessionFile,
      threadId: "thr",
      turnId: "turn_1",
      lifecycleOutcome: "started",
      acc: acc({ assistantTexts: ["hello"] }),
    });
    const lines = await readMirroredMessages(sessionFile);
    expect(lines).toHaveLength(1);
  });

  it("is a no-op when the accumulator carries nothing to mirror", async () => {
    const sessionFile = await createTempSessionFile();
    await mirrorClaudeAppServerTranscript({
      sessionFile,
      threadId: "thr",
      turnId: "turn_1",
      lifecycleOutcome: "started",
      acc: acc(),
    });
    await expect(fs.readFile(sessionFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("skips messages whose idempotencyKey already exists in the transcript (replay-safe)", async () => {
    const sessionFile = await createTempSessionFile();
    // First mirror writes the assistant entry once.
    await mirrorClaudeAppServerTranscript({
      sessionFile,
      threadId: "thr",
      turnId: "turn_1",
      lifecycleOutcome: "started",
      acc: acc({ assistantTexts: ["first"] }),
    });
    const afterFirst = await readMirroredMessages(sessionFile);
    expect(afterFirst).toHaveLength(1);

    // Replay (e.g. crash recovery, retry) with the same threadId/turnId must
    // not produce a second entry; the idempotency key is identical.
    await mirrorClaudeAppServerTranscript({
      sessionFile,
      threadId: "thr",
      turnId: "turn_1",
      lifecycleOutcome: "started",
      acc: acc({ assistantTexts: ["first"] }),
    });
    const afterReplay = await readMirroredMessages(sessionFile);
    expect(afterReplay).toHaveLength(1);
  });

  it("appends only the new entries when some keys already exist (partial overlap)", async () => {
    const sessionFile = await createTempSessionFile();
    const toolCalls = new Map<
      string,
      ProjectorAccumulator["toolCalls"] extends Map<string, infer V> ? V : never
    >();
    toolCalls.set("call_1", { name: "Read", result: "x", isDynamic: false });

    // Round 1: only the toolResult is in the accumulator.
    await mirrorClaudeAppServerTranscript({
      sessionFile,
      threadId: "thr",
      turnId: "turn_1",
      lifecycleOutcome: "started",
      acc: acc({ toolCalls }),
    });
    expect(await readMirroredMessages(sessionFile)).toHaveLength(1);

    // Round 2: the same toolResult is still in the accumulator, but now the
    // assistant text has appeared too. The toolResult must dedupe; the
    // assistant text must append.
    await mirrorClaudeAppServerTranscript({
      sessionFile,
      threadId: "thr",
      turnId: "turn_1",
      lifecycleOutcome: "started",
      acc: acc({ toolCalls, assistantTexts: ["done"] }),
    });
    const final = await readMirroredMessages(sessionFile);
    expect(final).toHaveLength(2);
    const keys = final
      .map((r) => r.message?.idempotencyKey)
      .filter((k): k is string => typeof k === "string");
    expect(keys).toEqual([
      idempotencyKeyFor({ threadId: "thr", turnId: "turn_1", role: "toolResult", index: 0 }),
      idempotencyKeyFor({ threadId: "thr", turnId: "turn_1", role: "assistant", index: 0 }),
    ]);
  });
});
