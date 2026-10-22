import { expect, it } from "vitest";
import { createAgentEvent, createClientFixture } from "./client.test-support.js";
import type { GatewayEvent, OpenClawEvent } from "./types.js";

const runId = "sdk-observed-run";

async function collect<T>(source: AsyncIterable<T>, stop: (event: T) => boolean) {
  const events: T[] = [];
  for await (const event of source) {
    events.push(event);
    if (stop(event)) {
      break;
    }
  }
  return events;
}

async function collectSdkRunFixture(
  mode: "live" | "replay",
  frames: readonly [GatewayEvent, ...GatewayEvent[]],
) {
  const expectedRaw = structuredClone(frames);
  const { oc, transport } = createClientFixture();
  transport.request = async () => {
    throw new Error("This stream test must not issue RPC requests");
  };
  const iterator = oc.runEvents(runId)[Symbol.asyncIterator]();
  const isMarker = (event: { raw?: GatewayEvent }) => event.raw?.event === "custom.debug";
  const observed: OpenClawEvent[] = [];

  try {
    await oc.connect();
    if (mode === "replay") {
      const drained = collect(oc.events(), isMarker);
      frames.forEach(transport.emit);
      await drained;
    } else {
      const firstEvent = iterator.next();
      transport.emit(frames[0]);
      const first = await firstEvent;
      if (first.done) {
        throw new Error("SDK stream closed before its start event");
      }
      observed.push(first.value);
    }
    const pending = collect({ [Symbol.asyncIterator]: () => iterator }, isMarker);
    if (mode === "live") {
      frames.slice(1).forEach(transport.emit);
    }
    observed.push(...(await pending));

    const raw = await collect(oc.rawEvents(), (event) => event.event === "custom.debug");
    expect(raw).toEqual(expectedRaw);
    return observed;
  } finally {
    await iterator.return?.();
    await oc.close();
  }
}

const agent = (seq: number, stream: string, data: Record<string, unknown>) =>
  createAgentEvent(runId, seq, seq, stream, data);
const chat = (seq: number, payload: Record<string, unknown>): GatewayEvent => ({
  event: "chat",
  seq,
  payload: { runId, ts: seq, ...payload },
});
const start = agent(1, "lifecycle", { phase: "start" });
const marker: GatewayEvent = { event: "custom.debug", seq: 6, payload: { runId, ts: 6 } };

const terminalCases = [
  [
    {
      state: "final",
      message: { role: "assistant", content: [{ type: "text", text: "successful fallback" }] },
    },
    "run.completed",
    { phase: "end", outputText: "successful fallback" },
  ],
  [
    { state: "error", errorMessage: "fallback exhausted" },
    "run.failed",
    { phase: "error", error: "fallback exhausted" },
  ],
  [
    { state: "error", errorKind: "timeout", errorMessage: "provider timed out" },
    "run.timed_out",
    { phase: "error", error: "provider timed out" },
  ],
  [
    { state: "aborted", stopReason: "rpc" },
    "run.cancelled",
    { phase: "end", aborted: true, stopReason: "rpc" },
  ],
  [
    { state: "aborted", stopReason: "timeout" },
    "run.timed_out",
    { phase: "end", aborted: true, stopReason: "timeout" },
  ],
] as const;

it.each([
  ...terminalCases.map((entry) => ["live", ...entry] as const),
  ["replay", ...terminalCases[0]] as const,
])(
  "preserves %s %j ordering and raw events",
  async (mode, terminal, terminalType, terminalData) => {
    const frames = [
      start,
      agent(2, "error", { reason: "seq gap", expected: 2, received: 3 }),
      agent(3, "lifecycle", { phase: "error", endedAt: 3, error: "retryable provider failure" }),
      chat(4, { state: "delta", message: { role: "assistant", content: "partial fallback" } }),
      chat(5, terminal),
      marker,
    ] as const;
    const observed = await collectSdkRunFixture(mode, frames);

    expect(observed.map((event) => event.type)).toEqual([
      "run.started",
      "raw",
      "raw",
      "assistant.delta",
      terminalType,
      "raw",
    ]);
    expect(observed.at(-2)?.data).toEqual(terminalData);
  },
);
it.each([
  { stopReason: "rpc", terminalType: "run.cancelled", mode: "live" },
  { stopReason: "timeout", terminalType: "run.timed_out", mode: "replay" },
] as const)(
  "emits one $mode $stopReason terminal across both carriers",
  async ({ mode, stopReason, terminalType }) => {
    const frames = [
      start,
      chat(2, { state: "aborted", stopReason }),
      agent(3, "lifecycle", { phase: "end", status: "cancelled", aborted: true, stopReason }),
      marker,
    ] as const;
    const observed = await collectSdkRunFixture(mode, frames);

    expect(observed.map((event) => event.type)).toEqual(["run.started", terminalType, "raw"]);
  },
);
