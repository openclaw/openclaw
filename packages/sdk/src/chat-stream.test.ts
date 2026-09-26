import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import {
  createAgentEvent,
  createChatEvent,
  createClientFixture,
  createRunEventFixture,
  observeGatewaySequence,
} from "./client.test-support.js";
import type { OpenClawEvent } from "./types.js";

describe("SDK chat streaming", () => {
  it("does not surface raw chat projection events in per-run streams", async () => {
    const ts = 1_777_000_000_100;
    const { oc } = createRunEventFixture("run_chat_projection", "chat-projection", [
      createAgentEvent("run_chat_projection", 1, ts, "lifecycle", { phase: "start" }),
      createAgentEvent("run_chat_projection", 2, ts + 1, "assistant", { delta: "hello" }),
      createChatEvent("run_chat_projection", "chat-projection", 3, "delta", "hello", ts + 2, {
        deltaText: "hello",
      }),
      createAgentEvent("run_chat_projection", 4, ts + 3, "lifecycle", { phase: "end" }),
      createChatEvent("run_chat_projection", "chat-projection", 5, "final", "hello", ts + 4),
    ]);

    const run = await oc.runs.create({
      input: "stream with chat projection",
      idempotencyKey: "chat-projection-events",
      sessionKey: "chat-projection",
    });
    const seen: OpenClawEvent[] = [];

    for await (const event of run.events()) {
      seen.push(event);
      if (event.type === "run.completed") {
        break;
      }
    }

    expect(seen.map((event) => event.type)).toEqual([
      "run.started",
      "assistant.delta",
      "run.completed",
    ]);
    expect(seen.map((event) => event.raw?.event)).toEqual(["agent", "agent", "agent"]);
  });

  it.each(["reset", ""])("normalizes chat-only output and replacement %j", async (replacement) => {
    const ts = 1_777_000_000_200;
    const { oc } = createRunEventFixture("run_chat_only", "chat-only", [
      createChatEvent("run_chat_only", "chat-only", 1, "delta", "hello", ts, {
        deltaText: "hello",
      }),
      createChatEvent("run_chat_only", "chat-only", 2, "delta", undefined, ts + 1, {
        deltaText: " again",
      }),
      createChatEvent("run_chat_only", "chat-only", 3, "delta", undefined, ts + 2, {
        deltaText: replacement,
        replace: true,
      }),
      createChatEvent("run_chat_only", "chat-only", 4, "final", replacement, ts + 3),
      {
        event: "custom.debug",
        seq: 5,
        payload: { runId: "run_chat_only", ts: ts + 4, data: { ok: true } },
      },
    ]);

    const run = await oc.runs.create({
      input: "stream with chat-only projection",
      idempotencyKey: "chat-only-events",
      sessionKey: "chat-only",
    });
    const iterator = run.events()[Symbol.asyncIterator]();

    try {
      const first = await iterator.next();
      expect(first.done).toBe(false);
      if (first.done !== false) {
        throw new Error("expected first chat projection event");
      }
      expect(first.value.type).toBe("assistant.delta");
      expect(first.value.data).toEqual({ text: "hello", delta: "hello" });
      expect(first.value.raw?.event).toBe("chat");

      const second = await iterator.next();
      expect(second.done).toBe(false);
      if (second.done !== false) {
        throw new Error("expected second chat projection event");
      }
      expect(second.value.type).toBe("assistant.delta");
      expect(second.value.data).toEqual({ text: "hello again", delta: " again" });
      expect(second.value.raw?.event).toBe("chat");
      expect(second.value.raw?.payload).not.toHaveProperty("message");

      const third = await iterator.next();
      expect(third.done).toBe(false);
      if (third.done !== false) {
        throw new Error("expected replacement chat projection event");
      }
      expect(third.value.type).toBe("assistant.delta");
      expect(third.value.data).toEqual({ text: replacement, delta: replacement, replace: true });
      expect(third.value.raw?.event).toBe("chat");

      const fourth = await iterator.next();
      expect(fourth.done).toBe(false);
      if (fourth.done !== false) {
        throw new Error("expected chat projection completion event");
      }
      expect(fourth.value.type).toBe("run.completed");
      expect(fourth.value.data).toEqual({ phase: "end", outputText: replacement });
      expect(fourth.value.raw?.event).toBe("chat");
    } finally {
      await iterator.return?.();
    }
  });

  it("repairs normalized deltas from reconnect and replacement snapshots", async () => {
    const ts = 1_777_000_000_300;
    const { oc } = createRunEventFixture("run_chat_delta_text", "chat-delta-text", [
      createChatEvent("run_chat_delta_text", "chat-delta-text", 1, "delta", "hello", ts, {
        deltaText: "hello",
      }),
      createChatEvent("run_chat_delta_text", "chat-delta-text", 2, "delta", "hello again", ts + 1, {
        deltaText: "in",
      }),
      createChatEvent("run_chat_delta_text", "chat-delta-text", 3, "delta", "rewritten", ts + 2, {
        deltaText: "ten",
      }),
    ]);

    const run = await oc.runs.create({
      input: "stream with chat deltaText",
      idempotencyKey: "chat-delta-text-events",
      sessionKey: "chat-delta-text",
    });
    const iterator = run.events()[Symbol.asyncIterator]();

    try {
      const first = await iterator.next();
      expect(first.done).toBe(false);
      if (first.done !== false) {
        throw new Error("expected first chat projection event");
      }
      expect(first.value.type).toBe("assistant.delta");
      expect(first.value.data).toEqual({ text: "hello", delta: "hello" });

      const second = await iterator.next();
      expect(second.done).toBe(false);
      if (second.done !== false) {
        throw new Error("expected second chat projection event");
      }
      expect(second.value.type).toBe("assistant.delta");
      expect(second.value.data).toEqual({ text: "hello again", delta: " again" });
      await expect(iterator.next()).resolves.toMatchObject({
        value: {
          type: "assistant.delta",
          data: { text: "rewritten", delta: "rewritten", replace: true },
        },
      });
    } finally {
      await iterator.return?.();
    }
  });

  it("replays the chat tail before queued live events and drains it after close", async () => {
    const { transport, oc } = createClientFixture();
    const runId = "run_chat_delta_text_replay";
    let text = "";
    let iterator: AsyncIterator<OpenClawEvent> | undefined;

    try {
      await oc.connect();
      const observedLast = observeGatewaySequence(oc, 501);

      for (let index = 0; index <= 500; index += 1) {
        const deltaText = index === 0 ? "hello" : ` ${index}`;
        text += deltaText;
        transport.emit(
          createChatEvent(
            runId,
            "chat-delta-text-replay",
            index + 1,
            "delta",
            index === 0 ? text : undefined,
            1_777_000_000_300 + index,
            { deltaText },
          ),
        );
      }

      await observedLast;
      const run = await oc.runs.get(runId);
      iterator = run.events()[Symbol.asyncIterator]();
      const first = await iterator.next();
      expect(first.done).toBe(false);
      if (first.done !== false) {
        throw new Error("expected first replayed chat projection event");
      }
      expect(first.value.type).toBe("assistant.delta");
      expect(first.value.data).toEqual({ text: "hello 1", delta: "hello 1" });

      const observedLive = observeGatewaySequence(oc, 502);
      text += " 501";
      transport.emit(
        createChatEvent(
          runId,
          "chat-delta-text-replay",
          502,
          "delta",
          undefined,
          1_777_000_000_801,
          {
            deltaText: " 501",
          },
        ),
      );
      await observedLive;
      await oc.close();

      const seen = [first.value];
      while (true) {
        const next = await iterator.next();
        if (next.done) {
          break;
        }
        seen.push(next.value);
      }
      expect(seen.map((event) => event.raw?.seq)).toEqual(
        Array.from({ length: 501 }, (_, index) => index + 2),
      );
      expect(seen.at(-1)?.data).toEqual({ text, delta: " 501" });
      await expect(run.events()[Symbol.asyncIterator]().next()).rejects.toThrow(
        "OpenClaw SDK client is closed",
      );
      await expect(oc.connect()).rejects.toThrow("OpenClaw SDK client is closed");
    } finally {
      await iterator?.return?.();
      await oc.close();
    }
  });

  it.each(["chat", "assistant"])(
    "releases %s baseline protection when a custom event stream ends",
    async (stream) => {
      const { transport, oc } = createClientFixture({
        "chat.send": (params) => ({
          status: "started",
          runId: asRecord(params).idempotencyKey,
        }),
      });
      try {
        await oc.connect();
        const observedLast = observeGatewaySequence(oc, 101);
        for (let seq = 1; seq <= 101; seq += 1) {
          await oc.request("chat.send", {
            sessionKey: `session-${seq}`,
            message: "hello",
            idempotencyKey: `run-${seq}`,
          });
          transport.emit(
            stream === "chat"
              ? createChatEvent(`run-${seq}`, `session-${seq}`, seq, "delta", "unfinished", seq, {
                  deltaText: "unfinished",
                })
              : createAgentEvent(`run-${seq}`, seq, seq, "assistant", {
                  text: "unfinished",
                  delta: "unfinished",
                }),
          );
        }
        await observedLast;
        const exhausted = oc.events()[Symbol.asyncIterator]().next();
        transport.close();
        await expect(exhausted).resolves.toEqual({ done: true, value: undefined });
        await expect(oc.runEvents("run-1")[Symbol.asyncIterator]().next()).resolves.toEqual({
          done: true,
          value: undefined,
        });
      } finally {
        await oc.close();
      }
    },
  );

  it("retains an active chat baseline beyond the ordinary replay run limit", async () => {
    const { transport, oc } = createClientFixture();
    let iterator: AsyncIterator<OpenClawEvent> | undefined;
    try {
      await oc.connect();
      const observedLast = observeGatewaySequence(oc, 101);
      for (let seq = 1; seq <= 101; seq += 1) {
        transport.emit(
          createChatEvent(`run-${seq}`, `session-${seq}`, seq, "delta", "prefix", seq, {
            deltaText: "prefix",
          }),
        );
      }
      await observedLast;
      iterator = oc.runEvents("run-1")[Symbol.asyncIterator]();
      await expect(iterator.next()).resolves.toMatchObject({
        value: { data: { text: "prefix", delta: "prefix" } },
      });
      transport.emit(
        createChatEvent("run-1", "session-1", 102, "delta", undefined, 102, {
          deltaText: " suffix",
        }),
      );
      await expect(iterator.next()).resolves.toMatchObject({
        value: { data: { text: "prefix suffix", delta: " suffix" } },
      });
    } finally {
      await iterator?.return?.();
      await oc.close();
    }
  });
});
