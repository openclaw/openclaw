import { expectDefined } from "@openclaw/normalization-core";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import { afterEach, expect, it } from "vitest";
import { onAgentEvent } from "../../../infra/agent-events.js";
import {
  clearAgentRunContext,
  getAgentRunContext,
  registerAgentRunContext,
} from "../../../infra/agent-run-registry.js";
import { createDiagnosticTraceContext } from "../../../infra/diagnostic-trace-context.js";
import { makeAssistantMessageFixture } from "../../test-helpers/assistant-message-fixtures.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import { wrapStreamFnWithDiagnosticModelCallEvents } from "./attempt.model-diagnostic-events.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

function harness() {
  registerAgentRunContext("model-wait-test", {});
  cleanups.push(() => clearAgentRunContext("model-wait-test"));
  const statuses: Array<Record<string, unknown>> = [];
  const delivered: Array<Record<string, unknown>> = [];
  cleanups.push(
    onAgentEvent((event) => {
      if (event.runId === "model-wait-test" && event.stream === "run_status") {
        statuses.push(event.data);
      }
    }),
  );
  const calls: Array<{
    stream: ReturnType<typeof createAssistantMessageEventStream>;
    report: NonNullable<NonNullable<Parameters<StreamFn>[2]>["onProviderWait"]>;
  }> = [];
  const source: StreamFn = (_model, _context, options) => {
    const stream = createAssistantMessageEventStream();
    calls.push({ stream, report: (reason) => options?.onProviderWait?.(reason) });
    return stream;
  };
  let callId = 0;
  const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(source, {
    runId: "model-wait-test",
    provider: "ollama",
    model: "local-model",
    trace: createDiagnosticTraceContext(),
    nextCallId: () => `call-${++callId}`,
    onAgentEvent: (event) => {
      delivered.push(event.data);
    },
  });
  return {
    statuses,
    delivered,
    calls,
    async start(signal?: AbortSignal) {
      return await wrapped(
        makeProviderModelFixture({
          id: "local-model",
          provider: "ollama",
          api: "ollama",
          baseUrl: "http://127.0.0.1:11434",
        }),
        { messages: [] },
        { signal },
      );
    },
  };
}

it("clears wait on the first stream event and admits another wait on a later call", async () => {
  const h = harness();
  const first = await h.start();
  const firstCall = expectDefined(h.calls[0], "first call");
  firstCall.report("response");
  expect(getAgentRunContext("model-wait-test")?.localModelWait).toEqual({ requestId: "call-1" });
  firstCall.report("response");
  firstCall.stream.push({ type: "start", partial: makeAssistantMessageFixture() });
  const iterator = first[Symbol.asyncIterator]();
  await iterator.next();
  expect(getAgentRunContext("model-wait-test")?.localModelWait).toBeUndefined();
  firstCall.report("slot");
  firstCall.stream.end(makeAssistantMessageFixture());
  await first.result();

  const second = await h.start();
  const secondCall = expectDefined(h.calls[1], "second call");
  secondCall.report("slot");
  firstCall.report("response");
  secondCall.stream.end(makeAssistantMessageFixture());
  await second.result();
  await Promise.resolve();

  expect(h.statuses).toEqual([
    { phase: "waiting_for_model", reason: "response" },
    { phase: "starting_model" },
    { phase: "waiting_for_model", reason: "slot" },
    { phase: "starting_model" },
  ]);
  expect(h.delivered).toEqual(h.statuses);
});

it.each(["abort", "failure", "completion"] as const)(
  "clears a wait on %s without needing another stream event",
  async (termination) => {
    const h = harness();
    const abort = new AbortController();
    const result = await h.start(abort.signal);
    const call = expectDefined(h.calls[0], "held call");
    call.report("response");
    if (termination === "abort") {
      abort.abort();
      expect(h.statuses.at(-1)).toEqual({ phase: "starting_model" });
    }
    call.stream.end(
      makeAssistantMessageFixture({
        stopReason: termination === "completion" ? "stop" : "error",
        ...(termination === "completion" ? {} : { errorMessage: "synthetic failure" }),
      }),
    );
    await result.result();
    expect(getAgentRunContext("model-wait-test")?.localModelWait).toBeUndefined();
    call.report("slot");
    expect(h.statuses).toEqual([
      { phase: "waiting_for_model", reason: "response" },
      { phase: "starting_model" },
    ]);
  },
);
