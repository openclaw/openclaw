import { afterEach, describe, expect, it } from "vitest";
import type { AssistantMessage, Context, Message, UserMessage } from "../../llm/types.js";
import {
  admitSessionPrefix,
  clearSessionPrefixSeries,
  requestSessionPrefixRebuild,
} from "./session-prefix-owner.js";

const model = { provider: "p", api: "anthropic-messages", id: "m", baseUrl: "https://x" } as const;
const user = (text: string, timestamp: number): UserMessage => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp,
});
const assistant = (content: AssistantMessage["content"], timestamp: number): AssistantMessage => ({
  role: "assistant",
  content,
  api: "anthropic-messages",
  provider: "p",
  model: "m",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp,
});
const context = (messages: Message[], tools: Context["tools"] = []): Context => ({
  systemPrompt: "system",
  tools,
  messages,
});
const tool = (name: string) => ({
  name,
  description: name,
  parameters: { type: "object", properties: {} },
});

afterEach(() => clearSessionPrefixSeries());

describe("admitSessionPrefix", () => {
  it("re-sends the bytes already sent for an entry when a later request re-derives it", () => {
    const first = [user("hi", 1), assistant([{ type: "text", text: "yo" }], 2), user("next", 3)];
    admitSessionPrefix("s", model, context(first)).commit();
    // Replay re-derived the first turn differently (a timestamp prefix, a resized image, ...).
    const drifted = [
      user("[Mon 10:00] hi", 1),
      first[1]!,
      first[2]!,
      assistant([], 4),
      user("x", 5),
    ];
    const admitted = admitSessionPrefix("s", model, context(drifted));
    expect(admitted.context.messages).toEqual([...first, drifted[3], drifted[4]]);
    expect(admitted.report).toEqual({ kind: "absorbed", index: 0, count: 1, role: "user" });
  });

  it("starts a new series at compaction, a model switch and a declared repair", () => {
    const sent = [user("a", 1), assistant([{ type: "text", text: "b" }], 2), user("c", 3)];
    admitSessionPrefix("s", model, context(sent)).commit();
    const compacted = [user("summary", 10), user("d", 11)];
    const compaction = admitSessionPrefix("s", model, context(compacted));
    compaction.commit();
    expect(compaction.report).toEqual({
      kind: "rebuild",
      reason: "history",
      index: 0,
    });
    const switched = admitSessionPrefix("s", { ...model, id: "other" }, context(compacted));
    switched.commit();
    expect(switched.report).toEqual({ kind: "rebuild", reason: "prefix" });
    requestSessionPrefixRebuild("s");
    const repaired = [user("SUMMARY repaired", 10), user("d", 11)];
    const admitted = admitSessionPrefix("s", { ...model, id: "other" }, context(repaired));
    expect(admitted.report).toEqual({ kind: "rebuild", reason: "declared" });
    expect(admitted.context.messages).toEqual(repaired);
  });

  it("does not hold a retry to the bytes of a request the provider never accepted", () => {
    const rejected = admitSessionPrefix("s", model, context([user("first projection", 1)]));
    expect(rejected.report).toEqual({ kind: "first" });
    // No commit: the provider answered 429.
    const retry = [user("retried projection", 1)];
    expect(admitSessionPrefix("s", model, context(retry)).context.messages).toEqual(retry);
  });

  it("keeps the first tool order and lets a sanctioned thinking removal through", () => {
    const thinking = assistant(
      [
        { type: "thinking", thinking: "t", thinkingSignature: "sig" },
        { type: "text", text: "b" },
      ],
      2,
    );
    admitSessionPrefix(
      "s",
      model,
      context([user("a", 1), thinking, user("c", 3)], [tool("x"), tool("y")]),
    ).commit();
    const withoutThinking = assistant([{ type: "text", text: "b" }], 2);
    const admitted = admitSessionPrefix(
      "s",
      model,
      context([user("a", 1), withoutThinking, user("c", 3), user("d", 4)], [tool("y"), tool("x")]),
    );
    expect(admitted.context.tools?.map(({ name }) => name)).toEqual(["x", "y"]);
    expect(admitted.context.messages[1]).toEqual(withoutThinking);
    expect(admitted.report).toEqual({ kind: "extended" });
  });
});
