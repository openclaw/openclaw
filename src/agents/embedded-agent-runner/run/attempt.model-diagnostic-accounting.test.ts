import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { onInternalDiagnosticEvent } from "../../../infra/diagnostic-events.js";
import { waitForDiagnosticEventsDrained } from "../../../infra/diagnostic-events.js";
import { resetDiagnosticEventsForTest } from "../../../infra/diagnostic-events.js";
import { createDiagnosticTraceContext } from "../../../infra/diagnostic-trace-context.js";
import { flushDiagnosticsTimeline } from "../../../infra/diagnostics-timeline.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { makeAssistantMessageFixture } from "../../test-helpers/assistant-message-fixtures.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import { wrapAnthropicStreamWithRecovery } from "../thinking.js";
import { wrapStreamFnWithDiagnosticModelCallEvents } from "./attempt.model-diagnostic-events.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  flushDiagnosticsTimeline();
  resetDiagnosticEventsForTest();
  vi.unstubAllEnvs();
});

it("counts one logical call when the inner production-order recovery sends two requests", async () => {
  const file = join(tempDirs.make("model-call-accounting-"), "timeline.jsonl");
  vi.stubEnv("OPENCLAW_DIAGNOSTICS", "timeline");
  vi.stubEnv("OPENCLAW_DIAGNOSTICS_TIMELINE_PATH", file);
  const transport = vi
    .fn<StreamFn>()
    .mockRejectedValueOnce(new Error("invalid signature on thinking block"))
    .mockImplementationOnce(() => {
      const stream = createAssistantMessageEventStream();
      stream.end(makeAssistantMessageFixture({ stopReason: "stop", errorMessage: undefined }));
      return stream;
    });
  // attempt-stream installs recovery first, then the diagnostic wrapper around it.
  const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
    wrapAnthropicStreamWithRecovery(transport, { id: "session" }),
    {
      runId: "run-1",
      provider: "anthropic",
      model: "fixture",
      api: "anthropic-messages",
      trace: createDiagnosticTraceContext(),
      nextCallId: () => "call-1",
    },
  );
  const stream = await wrapped({} as never, {
    messages: [
      makeAssistantMessageFixture({
        content: [
          { type: "thinking", thinking: "fixture", thinkingSignature: "fixture-signature" },
        ],
      }),
    ],
  });
  for await (const _ of stream) {
    /* drain */
  }
  await stream.result();
  flushDiagnosticsTimeline();
  const events = readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(transport).toHaveBeenCalledTimes(2);
  expect(events.filter((event) => event.name === "provider.request.started")).toHaveLength(1);
  expect(events.filter((event) => event.type === "provider.request")).toMatchObject([
    {
      ok: true,
      runId: "run-1",
      spanId: "call-1",
      attributes: { observationUnit: "logical-call" },
    },
  ]);
});

function wrap(
  streamFn: StreamFn,
  context: Partial<Parameters<typeof wrapStreamFnWithDiagnosticModelCallEvents>[1]> = {},
) {
  return wrapStreamFnWithDiagnosticModelCallEvents(streamFn, {
    runId: "run-1",
    provider: "openai",
    model: "fixture",
    api: "openai-responses",
    trace: createDiagnosticTraceContext(),
    nextCallId: () => "call-1",
    ...context,
  });
}
async function collect(run: () => Promise<void>) {
  const events: Array<{ type: string }> = [];
  const stop = onInternalDiagnosticEvent((event) => {
    if (event.type.startsWith("model.call.")) events.push(event);
  });
  try {
    await run();
    await waitForDiagnosticEventsDrained();
    return events;
  } finally {
    stop();
  }
}
it("shares unopened return and closes the acquired source without awaiting its value", async () => {
  const value = createDeferredCore<string>();
  const cleanup = createDeferredCore();
  const sourceNext = vi.fn(async () => ({ done: true as const, value: undefined }));
  const sourceReturn = vi.fn(async () => {
    await cleanup.promise;
    return { done: true as const, value: undefined };
  });
  const result = vi.fn(async () => makeAssistantMessageFixture());
  const finished = vi.fn();
  const events = await collect(async () => {
    const response = await wrap(
      () => ({
        [Symbol.asyncIterator]: () => ({ next: sourceNext, return: sourceReturn }),
        result,
      }),
      { onFinished: finished },
    )(
      makeProviderModelFixture({
        id: "test-model",
        provider: "test-provider",
        api: "openai-responses",
        baseUrl: "https://example.invalid",
      }),
      { messages: [] },
    );
    const iterator = response[Symbol.asyncIterator]();
    const returning = iterator.return!(value.promise);
    expect(iterator.return!("ignored")).toBe(returning);
    const failure = new Error("queued throw");
    let thrown = false;
    const throwing = iterator.throw!(failure).catch((error: unknown) => {
      expect(error).toBe(failure);
      thrown = true;
    });
    await nextTurn();
    expect(thrown).toBe(false);
    cleanup.resolve();
    const returned = await returning;
    await throwing;
    expect(thrown).toBe(true);
    expect(returned.done).toBe(true);
    expect(returned.value).toBe(value.promise);
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    expect(iterator.return!("also ignored")).toBe(returning);
    value.resolve("later");
  });
  expect(sourceNext).not.toHaveBeenCalled();
  expect(sourceReturn).toHaveBeenCalledOnce();
  expect(result).not.toHaveBeenCalled();
  expect(finished).toHaveBeenCalledExactlyOnceWith("call-1");
  expect(events.map((event) => event.type)).toEqual(["model.call.started", "model.call.completed"]);
});
