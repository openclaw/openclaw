import { describe, expect, it } from "vitest";
import {
  createAgentEvent,
  createChatEvent,
  createClientFixture,
  observeGatewaySequence,
} from "./client.test-support.js";
import type { GatewayEvent, OpenClawEvent } from "./types.js";

describe("SDK assistant streaming", () => {
  it("replays full assistant-item text after its wire baseline is evicted alongside chat", async () => {
    const { transport, oc } = createClientFixture();
    const frames: GatewayEvent[] = [];
    let iterator: AsyncIterator<OpenClawEvent> | undefined;
    let rawIterator: AsyncIterator<GatewayEvent> | undefined;
    try {
      await oc.connect();
      const observedLast = observeGatewaySequence(oc, 1002);
      for (let index = 0; index <= 500; index += 1) {
        const seq = index * 2 + 1;
        const assistant = createAgentEvent("run", seq, seq, "assistant", {
          itemId: "reply",
          delta: "token ",
          ...(index === 0 ? { text: "token " } : {}),
        });
        frames.push(assistant);
        transport.emit(assistant);
        transport.emit(
          createChatEvent(
            "run",
            "session",
            seq + 1,
            "delta",
            index === 0 ? "token " : undefined,
            seq,
            {
              deltaText: "token ",
            },
          ),
        );
      }
      await observedLast;
      iterator = oc.runEvents("run")[Symbol.asyncIterator]();
      for (let index = 251; index <= 500; index += 1) {
        const next = await iterator.next();
        if (next.done) {
          throw new Error("Expected the retained assistant replay");
        }
        expect(next.value.type).toBe("assistant.delta");
        expect(next.value.data).toEqual({
          itemId: "reply",
          text: "token ".repeat(index + 1),
          delta: "token ",
        });
        expect(next.value.raw).toBe(frames[index]);
        expect(next.value.raw?.payload).not.toHaveProperty("data.text");
      }
      rawIterator = oc.rawEvents((event) => event.seq === 1001)[Symbol.asyncIterator]();
      expect((await rawIterator.next()).value).toBe(frames[500]);
    } finally {
      await iterator?.return?.();
      await rawIterator?.return?.();
      await oc.close();
    }
  });

  it("keeps snapshots, replacements, and item boundaries distinct", async () => {
    const { transport, oc } = createClientFixture();
    let iterator: AsyncIterator<OpenClawEvent> | undefined;
    const cases: Array<{ data: Record<string, unknown>; text?: string }> = [
      { data: { itemId: "a", text: "first", delta: "first" }, text: "first" },
      { data: { itemId: "a", delta: " tail" }, text: "first tail" },
      { data: { itemId: "b", text: "second", delta: "ond" }, text: "second" },
      { data: { itemId: "b", delta: "", replace: true }, text: "" },
      { data: { itemId: "b", delta: "rewritten" }, text: "rewritten" },
      { data: { itemId: "c", delta: "orphan" } },
      { data: { itemId: "b", delta: "also orphan" } },
      { data: { itemId: "c", text: "complete", delta: "lete" }, text: "complete" },
    ];
    try {
      await oc.connect();
      iterator = oc.runEvents("run")[Symbol.asyncIterator]();
      for (const [index, scenario] of cases.entries()) {
        const next = iterator.next();
        const wire = createAgentEvent("run", index + 1, index, "assistant", scenario.data);
        transport.emit(wire);
        const result = await next;
        if (result.done) {
          throw new Error("Expected assistant output");
        }
        expect(result.value.data).toEqual({
          ...scenario.data,
          ...(scenario.text === undefined ? {} : { text: scenario.text }),
        });
        expect(result.value.raw).toBe(wire);
      }
    } finally {
      await iterator?.return?.();
      await oc.close();
    }
  });

  it.each(["chat", "agent"])(
    "protects active assistant baselines until the %s terminal",
    async (terminal) => {
      const { transport, oc } = createClientFixture();
      let iterator: AsyncIterator<OpenClawEvent> | undefined;
      try {
        await oc.connect();
        const observedActive = observeGatewaySequence(oc, 101);
        for (let seq = 1; seq <= 101; seq += 1) {
          transport.emit(
            createAgentEvent(`run-${seq}`, seq, seq, "assistant", {
              text: "prefix",
              delta: "prefix",
            }),
          );
        }
        await observedActive;
        iterator = oc.runEvents("run-1")[Symbol.asyncIterator]();
        await expect(iterator.next()).resolves.toMatchObject({
          value: { data: { text: "prefix" } },
        });
        await iterator.return?.();
        const observedTerminal = observeGatewaySequence(oc, 202);
        for (let index = 1; index <= 101; index += 1) {
          const seq = 101 + index;
          transport.emit(
            terminal === "chat"
              ? createChatEvent(`run-${index}`, `session-${index}`, seq, "final", "prefix", seq)
              : createAgentEvent(`run-${index}`, seq, seq, "lifecycle", { phase: "end" }),
          );
        }
        await observedTerminal;
        iterator = oc.runEvents("run-1")[Symbol.asyncIterator]();
        const first = iterator.next();
        transport.emit(createAgentEvent("run-1", 203, 203, "lifecycle", { phase: "start" }));
        await expect(first).resolves.toMatchObject({
          value: { type: "run.started", raw: { seq: 203 } },
        });
      } finally {
        await iterator?.return?.();
        await oc.close();
      }
    },
  );
});
