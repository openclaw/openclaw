import { expectDefined } from "@openclaw/normalization-core";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDiagnosticTraceContext } from "../../infra/diagnostic-trace-context.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import { makeProviderModelFixture } from "../test-helpers/provider-model-fixture.js";
import {
  mockedRunEmbeddedAttempt,
  resetSharedRunIntegrationHarnessMocks,
  type TestRunEmbeddedAgent,
} from "./run.overflow-compaction.harness.js";
import {
  createSharedRunIntegrationSession,
  loadSharedRunIntegrationHarness,
} from "./run.shared-integration-harness.test-support.js";
import { wrapStreamFnWithDiagnosticModelCallEvents } from "./run/attempt.model-diagnostic-events.js";

describe("agent event delivery through the public run owner", () => {
  let runEmbeddedAgent: TestRunEmbeddedAgent;
  let session: Awaited<ReturnType<typeof createSharedRunIntegrationSession>> | undefined;
  beforeAll(async () => {
    runEmbeddedAgent = await loadSharedRunIntegrationHarness();
  });
  beforeEach(resetSharedRunIntegrationHarnessMocks);
  afterEach(async () => {
    await session?.cleanup();
    session = undefined;
  });

  it.each(["completion", "abort"] as const)(
    "serializes provider waits across model calls and ordinary run events (%s)",
    async (termination) => {
      const currentSession = await createSharedRunIntegrationSession();
      session = currentSession;
      const firstWaitEntered = createDeferredCore();
      const releaseFirstWait = createDeferredCore();
      const delivered: string[] = [];
      mockedRunEmbeddedAttempt.mockImplementationOnce(async (attempt) => {
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
        const stream = wrapStreamFnWithDiagnosticModelCallEvents(source, {
          runId: attempt.runId,
          provider: "ollama",
          model: "local-model",
          trace: createDiagnosticTraceContext(),
          nextCallId: () => `call-${++callId}`,
          onAgentEvent: attempt.onAgentEvent,
        });
        const model = makeProviderModelFixture({
          id: "local-model",
          provider: "ollama",
          api: "ollama",
          baseUrl: "http://127.0.0.1:11434",
        });
        const first = await stream(model, { messages: [] });
        const firstCall = expectDefined(calls[0], "first model call");
        firstCall.report("response");
        await firstWaitEntered.promise;
        firstCall.stream.end(makeAssistantMessageFixture());
        await first.result();
        const abort = new AbortController();
        const second = await stream(model, { messages: [] }, { signal: abort.signal });
        const secondCall = expectDefined(calls[1], "second model call");
        secondCall.report("slot");
        const toolStarted = attempt.onAgentEvent?.({
          stream: "tool",
          data: { phase: "start" },
        });
        try {
          expect(delivered).toEqual(["waiting_for_model:response"]);
        } finally {
          releaseFirstWait.resolve();
        }
        await toolStarted;
        if (termination === "abort") {
          abort.abort();
        }
        secondCall.stream.end(makeAssistantMessageFixture());
        await second.result();
        await attempt.onAgentEvent?.({ stream: "tool", data: { phase: "result" } });
        expect(delivered).toEqual([
          "waiting_for_model:response",
          "starting_model",
          "waiting_for_model:slot",
          "start",
          "starting_model",
          "result",
        ]);
        return currentSession.makeAttemptResult();
      });
      await runEmbeddedAgent({
        ...currentSession.runParams,
        onAgentEvent: async (event) => {
          const reason = typeof event.data.reason === "string" ? event.data.reason : "";
          delivered.push(`${event.data.phase}${reason ? `:${reason}` : ""}`);
          if (event.data.reason === "response") {
            firstWaitEntered.resolve();
            await releaseFirstWait.promise;
          }
        },
      });
    },
  );
});
