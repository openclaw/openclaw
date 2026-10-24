import { expectDefined } from "@openclaw/normalization-core";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import { afterEach, expect, it, vi } from "vitest";
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

const runId = "model-wait-test";
const model = makeProviderModelFixture({
  id: "local-model",
  provider: "ollama",
  api: "ollama",
  baseUrl: "http://127.0.0.1:11434",
});
const starting = { phase: "starting_model" };
const waiting = (reason: "response" | "slot") => ({ phase: "waiting_for_model", reason });
let unsubscribe: (() => void) | undefined;
afterEach(() => {
  unsubscribe?.();
  clearAgentRunContext(runId);
});

function harness() {
  registerAgentRunContext(runId, {});
  const statuses: Array<Record<string, unknown>> = [];
  const delivered: Array<Record<string, unknown>> = [];
  unsubscribe = onAgentEvent((event) => {
    if (event.runId === runId && event.stream === "run_status") {
      statuses.push(event.data);
    }
  });
  const source = vi.fn<StreamFn>();
  let callId = 0;
  const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(source, {
    runId,
    provider: "ollama",
    model: "local-model",
    trace: createDiagnosticTraceContext(),
    nextCallId: () => `call-${++callId}`,
    onAgentEvent: ({ data }) => void delivered.push(data),
  });
  return {
    statuses,
    delivered,
    async start(signal?: AbortSignal) {
      const stream = createAssistantMessageEventStream();
      source.mockReturnValueOnce(stream);
      const observed = await wrapped(model, { messages: [] }, { signal });
      const options = expectDefined(source.mock.calls.at(-1), "started call")[2];
      return { stream, observed, report: expectDefined(options?.onProviderWait, "wait reporter") };
    },
  };
}

it("clears wait on the first stream event and admits another wait on a later call", async () => {
  const h = harness();
  const first = await h.start();
  first.report("response");
  expect(getAgentRunContext(runId)?.localModelWait).toEqual({ requestId: "call-1" });
  first.report("response");
  first.stream.push({ type: "start", partial: makeAssistantMessageFixture() });
  await first.observed[Symbol.asyncIterator]().next();
  expect(getAgentRunContext(runId)?.localModelWait).toBeUndefined();
  first.report("slot");
  first.stream.end(makeAssistantMessageFixture());
  await first.observed.result();

  const second = await h.start();
  second.report("slot");
  first.report("response");
  second.stream.end(makeAssistantMessageFixture());
  await second.observed.result();
  await Promise.resolve();

  expect(h.statuses).toEqual([waiting("response"), starting, waiting("slot"), starting]);
  expect(h.delivered).toEqual(h.statuses);
});

it.each(["abort", "failure", "completion"] as const)("clears %s waits", async (termination) => {
  const h = harness();
  const abort = new AbortController();
  const call = await h.start(abort.signal);
  call.report("response");
  if (termination === "abort") {
    abort.abort();
    expect(h.statuses.at(-1)).toEqual(starting);
  }
  call.stream.end(
    makeAssistantMessageFixture({
      stopReason: termination === "completion" ? "stop" : "error",
      ...(termination === "completion" ? {} : { errorMessage: "synthetic failure" }),
    }),
  );
  await call.observed.result();
  expect(getAgentRunContext(runId)?.localModelWait).toBeUndefined();
  call.report("slot");
  expect(h.statuses).toEqual([waiting("response"), starting]);
});
