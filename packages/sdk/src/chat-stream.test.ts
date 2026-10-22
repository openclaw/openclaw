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
  const iterators: Array<Pick<AsyncIterator<unknown>, "return">> = [];
  const track = <T>(stream: AsyncIterable<T>) => {
    const iterator = stream[Symbol.asyncIterator]();
    iterators.push(iterator);
    return iterator;
  };
  onTestFinished(async () => {
    for (const iterator of iterators) {
      await iterator.return?.();
    }
    await client.oc.close();
  });
  return {
    ...client,
    publish: async (seq: number, frames: GatewayEvent[]) => {
      const observed = observeGatewaySequence(client.oc, seq);
      frames.forEach((frame) => client.transport.emit(frame));
      await observed;
    },
    events: (runId = "run") => track(client.oc.runEvents(runId)),
    rawEvents: (seq: number) => track(client.oc.rawEvents((event) => event.seq === seq)),
  };
}

const chat = (seq: number, text: string | undefined, deltaText?: string, replace?: true) =>
  createChatEvent("run", "session", seq, "delta", text, seq, { deltaText, replace });
const assistant = (seq: number, data: Record<string, unknown>) =>
  createAgentEvent("run", seq, seq, "assistant", data);
type Expected = { type: OpenClawEvent["type"]; data?: Record<string, unknown>; raw?: number };
const projected = (data: Record<string, unknown>): Expected => ({ type: "assistant.delta", data });

async function readEvent(
  pending: Promise<IteratorResult<OpenClawEvent>>,
  expected: Expected,
  raw?: GatewayEvent,
) {
  const next = await pending;
  expect(next.done).toBe(false);
  if (next.done) {
    throw new Error("Expected projected output");
  }
  expect(next.value.type).toBe(expected.type);
  if (expected.data !== undefined) {
    expect(next.value.data).toEqual(expected.data);
  }
  if (raw !== undefined) {
    expect(next.value.raw).toBe(raw);
  }
  return next.value;
}

function streamFrame(stream: string, run: number, seq: number, text?: string, delta = text) {
  return stream === "chat"
    ? createChatEvent(`run-${run}`, `session-${run}`, seq, "delta", text, seq, { deltaText: delta })
    : createAgentEvent(`run-${run}`, seq, seq, "assistant", {
        ...(text === undefined ? {} : { text }),
        delta,
      });
}

type Scenario = [name: string, frames: GatewayEvent[], expected: Expected[], live?: boolean];
describe("SDK streaming projections", () => {
  it.each<Scenario>([
    [
      "canonical assistant suppression of chat projections",
      [
        createAgentEvent("run", 1, 1, "lifecycle", { phase: "start" }),
        assistant(2, { delta: "hello" }),
        chat(3, "hello", "hello"),
        createAgentEvent("run", 4, 4, "lifecycle", { phase: "end" }),
        createChatEvent("run", "session", 5, "final", "hello", 5),
      ],
      [
        { type: "run.started", raw: 0 },
        { type: "assistant.delta", raw: 1 },
        { type: "run.completed", raw: 3 },
      ],
    ],
    ...["reset", ""].map((replacement): Scenario => [
      `chat replacement ${JSON.stringify(replacement)}`,
      [
        chat(1, "hello", "hello"),
        chat(2, undefined, " again"),
        chat(3, undefined, replacement, true),
        createChatEvent("run", "session", 4, "final", replacement, 4),
        { event: "custom.debug", seq: 5, payload: { runId: "run", ts: 5, data: { ok: true } } },
      ],
      [
        projected({ text: "hello", delta: "hello" }),
        projected({ text: "hello again", delta: " again" }),
        projected({ text: replacement, delta: replacement, replace: true }),
        { type: "run.completed" as const, data: { phase: "end", outputText: replacement } },
      ],
    ]),
    [
      "chat reconnect and replacement snapshots",
      [chat(1, "hello", "hello"), chat(2, "hello again", "in"), chat(3, "rewritten", "ten")],
      [
        projected({ text: "hello", delta: "hello" }),
        projected({ text: "hello again", delta: " again" }),
        projected({ text: "rewritten", delta: "rewritten", replace: true }),
      ],
    ],
    assistantScenario(),
  ])("normalizes %s without changing wire frames", async (_name, frames, expected, live) => {
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
      const frame = frames[value.raw ?? index];
      if (!frame) {
        throw new Error(`Missing wire frame for expected event ${index}`);
      }
      const next = iterator.next();
      if (live) {
        transport.emit(frame);
      }
      await readEvent(next, value, frame);
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
          const next = await readEvent(
            iterator.next(),
            projected({
              itemId: "reply",
              text: "token ".repeat(index + 1),
              delta: "token ",
            }),
            frames[index],
          );
          expect(next.raw?.payload).not.toHaveProperty("data.text");
        }
        expect((await rawEvents(1001).next()).value).toBe(frames[500]);
      } else {
        const first = await readEvent(
          iterator.next(),
          projected({ text: "hello 1", delta: "hello 1" }),
        );
        const observedLive = observeGatewaySequence(oc, 502);
        text += " 501";
        transport.emit(chat(502, undefined, " 501"));
        await observedLive;
        await oc.close();
        const seen = [first];
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
      const { oc, transport, events, publish } = fixture();
      await oc.connect();
      await publish(
        101,
        Array.from({ length: 101 }, (_, i) => streamFrame(stream, i + 1, i + 1, "prefix")),
      );
      const iterator = events("run-1");
      await expect(iterator.next()).resolves.toMatchObject({
        value: { data: { text: "prefix", delta: "prefix" } },
      });
      transport.emit(streamFrame(stream, 1, 102, undefined, " suffix"));
      await expect(iterator.next()).resolves.toMatchObject({
        value: { data: { text: "prefix suffix", delta: " suffix" } },
      });
      await iterator.return?.();
      await publish(
        203,
        Array.from({ length: 101 }, (_, i) => {
          const index = i + 1,
            seq = 102 + index;
          return terminal === "chat"
            ? createChatEvent(`run-${index}`, `session-${index}`, seq, "final", "prefix", seq)
            : createAgentEvent(`run-${index}`, seq, seq, "lifecycle", { phase: "end" });
        }),
      );
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
        transport.emit(streamFrame(stream, seq, seq, "unfinished"));
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

function assistantScenario(): Scenario {
  const steps: Array<[Record<string, unknown>, string | undefined]> = [
    [{ itemId: "a", text: "first", delta: "first" }, "first"],
    [{ itemId: "a", delta: " tail" }, "first tail"],
    [{ itemId: "b", text: "second", delta: "ond" }, "second"],
    [{ itemId: "b", delta: "", replace: true }, ""],
    [{ itemId: "b", delta: "rewritten" }, "rewritten"],
    [{ itemId: "c", delta: "orphan" }, undefined],
    [{ itemId: "b", delta: "also orphan" }, undefined],
    [{ itemId: "c", text: "complete", delta: "lete" }, "complete"],
  ];
  return [
    "assistant snapshots, replacements, and item boundaries",
    steps.map(([data], index) => assistant(index + 1, data)),
    steps.map(([data, text]) => projected(text === undefined ? data : { ...data, text })),
    true,
  ];
}
