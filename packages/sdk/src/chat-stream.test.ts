import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  createAgentEvent,
  createChatEvent,
  createClientFixture,
  createRunEventFixture,
  observeGatewaySequence,
} from "./client.test-support.js";
import type { GatewayEvent, OpenClawEvent } from "./types.js";

function fixture(client = createClientFixture()) {
  const iterators: Array<AsyncIterator<OpenClawEvent> | AsyncIterator<GatewayEvent>> = [];
  onTestFinished(async () => {
    for (const iterator of iterators) {
      await iterator.return?.();
    }
    await client.oc.close();
  });
  return {
    ...client,
    events: (runId = "run") => {
      const iterator = client.oc.runEvents(runId)[Symbol.asyncIterator]();
      iterators.push(iterator);
      return iterator;
    },
    rawEvents: (seq: number) => {
      const iterator = client.oc.rawEvents((event) => event.seq === seq)[Symbol.asyncIterator]();
      iterators.push(iterator);
      return iterator;
    },
  };
}

const chat = (seq: number, text: string | undefined, deltaText?: string, replace?: true) =>
  createChatEvent("run", "session", seq, "delta", text, seq, { deltaText, replace });
const assistant = (seq: number, data: Record<string, unknown>) =>
  createAgentEvent("run", seq, seq, "assistant", data);

describe("SDK streaming projections", () => {
  it("does not surface raw chat projections alongside canonical assistant events", async () => {
    const { oc } = fixture(
      createRunEventFixture("run", "session", [
        createAgentEvent("run", 1, 1, "lifecycle", { phase: "start" }),
        assistant(2, { delta: "hello" }),
        chat(3, "hello", "hello"),
        createAgentEvent("run", 4, 4, "lifecycle", { phase: "end" }),
        createChatEvent("run", "session", 5, "final", "hello", 5),
      ]),
    );
    const run = await oc.runs.create({
      input: "hello",
      idempotencyKey: "run",
      sessionKey: "session",
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

  it.each<{
    name: string;
    live?: boolean;
    frames: GatewayEvent[];
    expected: Array<{ type: OpenClawEvent["type"]; data: Record<string, unknown> }>;
  }>([
    ...["reset", ""].map((replacement) => ({
      name: `chat replacement ${JSON.stringify(replacement)}`,
      frames: [
        chat(1, "hello", "hello"),
        chat(2, undefined, " again"),
        chat(3, undefined, replacement, true),
        createChatEvent("run", "session", 4, "final", replacement, 4),
        { event: "custom.debug", seq: 5, payload: { runId: "run", ts: 5, data: { ok: true } } },
      ],
      expected: [
        { type: "assistant.delta" as const, data: { text: "hello", delta: "hello" } },
        { type: "assistant.delta" as const, data: { text: "hello again", delta: " again" } },
        {
          type: "assistant.delta" as const,
          data: { text: replacement, delta: replacement, replace: true },
        },
        { type: "run.completed" as const, data: { phase: "end", outputText: replacement } },
      ],
    })),
    {
      name: "chat reconnect and replacement snapshots",
      frames: [
        chat(1, "hello", "hello"),
        chat(2, "hello again", "in"),
        chat(3, "rewritten", "ten"),
      ],
      expected: [
        { type: "assistant.delta", data: { text: "hello", delta: "hello" } },
        { type: "assistant.delta", data: { text: "hello again", delta: " again" } },
        { type: "assistant.delta", data: { text: "rewritten", delta: "rewritten", replace: true } },
      ],
    },
    {
      name: "assistant snapshots, replacements, and item boundaries",
      live: true,
      frames: [
        { itemId: "a", text: "first", delta: "first" },
        { itemId: "a", delta: " tail" },
        { itemId: "b", text: "second", delta: "ond" },
        { itemId: "b", delta: "", replace: true },
        { itemId: "b", delta: "rewritten" },
        { itemId: "c", delta: "orphan" },
        { itemId: "b", delta: "also orphan" },
        { itemId: "c", text: "complete", delta: "lete" },
      ].map((data, index) => assistant(index + 1, data)),
      expected: [
        { itemId: "a", text: "first", delta: "first" },
        { itemId: "a", text: "first tail", delta: " tail" },
        { itemId: "b", text: "second", delta: "ond" },
        { itemId: "b", text: "", delta: "", replace: true },
        { itemId: "b", text: "rewritten", delta: "rewritten" },
        { itemId: "c", delta: "orphan" },
        { itemId: "b", delta: "also orphan" },
        { itemId: "c", text: "complete", delta: "lete" },
      ].map((data) => ({ type: "assistant.delta", data })),
    },
  ])("normalizes $name without changing wire frames", async ({ frames, expected, live }) => {
    const original = structuredClone(frames);
    const { oc, transport, events } = fixture(
      live ? createClientFixture() : createRunEventFixture("run", "session", frames),
    );
    if (live) {
      await oc.connect();
    } else {
      await oc.runs.create({ input: "hello", idempotencyKey: "run", sessionKey: "session" });
    }
    const iterator = events();
    for (const [index, value] of expected.entries()) {
      const frame = frames[index];
      if (!frame) {
        throw new Error(`Missing wire frame for expected event ${index}`);
      }
      const next = iterator.next();
      if (live) {
        transport.emit(frame);
      }
      const result = await next;
      expect(result.done).toBe(false);
      if (result.done) {
        throw new Error("Expected projected output");
      }
      expect(result.value.type).toBe(value.type);
      expect(result.value.data).toEqual(value.data);
      expect(result.value.raw).toBe(frame);
    }
    expect(frames).toEqual(original);
  });

  it.each(["chat", "assistant"] as const)(
    "replays the retained %s tail before live output and drains after close",
    async (stream) => {
      const { oc, transport, events, rawEvents } = fixture();
      const frames: GatewayEvent[] = [];
      await oc.connect();
      const observedLast = observeGatewaySequence(oc, stream === "chat" ? 501 : 1002);
      let text = "";
      for (let index = 0; index <= 500; index++) {
        const delta = stream === "chat" ? (index === 0 ? "hello" : ` ${index}`) : "token ";
        text += delta;
        const seq = stream === "chat" ? index + 1 : index * 2 + 1;
        const frame =
          stream === "chat"
            ? chat(seq, index === 0 ? text : undefined, delta)
            : assistant(seq, { itemId: "reply", delta, ...(index === 0 ? { text } : {}) });
        frames.push(frame);
        transport.emit(frame);
        if (stream === "assistant") {
          transport.emit(chat(seq + 1, index === 0 ? text : undefined, delta));
        }
      }
      await observedLast;
      const run = await oc.runs.get("run");
      const iterator = events(run.id);
      if (stream === "assistant") {
        for (let index = 251; index <= 500; index++) {
          const next = await iterator.next();
          expect(next.done).toBe(false);
          if (next.done) {
            throw new Error("Expected retained assistant replay");
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
        expect((await rawEvents(1001).next()).value).toBe(frames[500]);
      } else {
        const first = await iterator.next();
        expect(first.done).toBe(false);
        if (first.done) {
          throw new Error("Expected retained chat replay");
        }
        expect(first.value.type).toBe("assistant.delta");
        expect(first.value.data).toEqual({ text: "hello 1", delta: "hello 1" });
        const observedLive = observeGatewaySequence(oc, 502);
        text += " 501";
        transport.emit(chat(502, undefined, " 501"));
        await observedLive;
        await oc.close();
        const seen = [first.value];
        for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
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
      }
    },
  );

  it.each([
    { stream: "assistant", terminal: "chat" },
    { stream: "assistant", terminal: "agent" },
    { stream: "chat", terminal: "chat" },
  ])(
    "protects active $stream baselines until the $terminal terminal",
    async ({ stream, terminal }) => {
      const { oc, transport, events } = fixture();
      await oc.connect();
      const observedActive = observeGatewaySequence(oc, 101);
      for (let seq = 1; seq <= 101; seq++) {
        transport.emit(
          stream === "chat"
            ? createChatEvent(`run-${seq}`, `session-${seq}`, seq, "delta", "prefix", seq, {
                deltaText: "prefix",
              })
            : createAgentEvent(`run-${seq}`, seq, seq, "assistant", {
                text: "prefix",
                delta: "prefix",
              }),
        );
      }
      await observedActive;
      const iterator = events("run-1");
      await expect(iterator.next()).resolves.toMatchObject({
        value: { data: { text: "prefix", delta: "prefix" } },
      });
      transport.emit(
        stream === "chat"
          ? createChatEvent("run-1", "session-1", 102, "delta", undefined, 102, {
              deltaText: " suffix",
            })
          : createAgentEvent("run-1", 102, 102, "assistant", { delta: " suffix" }),
      );
      await expect(iterator.next()).resolves.toMatchObject({
        value: { data: { text: "prefix suffix", delta: " suffix" } },
      });
      await iterator.return?.();
      const observedTerminal = observeGatewaySequence(oc, 203);
      for (let index = 1; index <= 101; index++) {
        const seq = 102 + index;
        transport.emit(
          terminal === "chat"
            ? createChatEvent(`run-${index}`, `session-${index}`, seq, "final", "prefix", seq)
            : createAgentEvent(`run-${index}`, seq, seq, "lifecycle", { phase: "end" }),
        );
      }
      await observedTerminal;
      const first = events("run-1").next();
      transport.emit(createAgentEvent("run-1", 204, 204, "lifecycle", { phase: "start" }));
      await expect(first).resolves.toMatchObject({
        value: { type: "run.started", raw: { seq: 204 } },
      });
    },
  );

  it.each(["chat", "assistant"])(
    "releases %s baseline protection when a custom event stream ends",
    async (stream) => {
      const { oc, transport } = fixture(
        createClientFixture({
          "chat.send": (params) => ({ status: "started", runId: asRecord(params).idempotencyKey }),
        }),
      );
      await oc.connect();
      const observedLast = observeGatewaySequence(oc, 101);
      for (let seq = 1; seq <= 101; seq++) {
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
    },
  );
});
