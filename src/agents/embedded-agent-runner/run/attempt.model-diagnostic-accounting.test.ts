import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { resetDiagnosticEventsForTest } from "../../../infra/diagnostic-events.js";
import { createDiagnosticTraceContext } from "../../../infra/diagnostic-trace-context.js";
import { flushDiagnosticsTimeline } from "../../../infra/diagnostics-timeline.js";
import { makeAssistantMessageFixture } from "../../test-helpers/assistant-message-fixtures.js";
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
