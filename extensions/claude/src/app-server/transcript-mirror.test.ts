import { describe, expect, it } from "vitest";
import type { ProjectorAccumulator } from "./event-projector.js";
import { buildMirrorMessages, idempotencyKeyFor } from "./transcript-mirror.js";

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
