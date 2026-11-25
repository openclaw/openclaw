import { expectDefined } from "@openclaw/normalization-core";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import { expect, it, onTestFinished, vi } from "vitest";
import { createDiagnosticTraceContext } from "../../infra/diagnostic-trace-context.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import { makeProviderModelFixture } from "../test-helpers/provider-model-fixture.js";
import {
  mockedRunEmbeddedAttempt,
  resetSharedRunIntegrationHarnessMocks,
} from "./run.overflow-compaction.harness.js";
import {
  createSharedRunIntegrationSession,
  loadSharedRunIntegrationHarness,
} from "./run.shared-integration-harness.test-support.js";
import { wrapStreamFnWithDiagnosticModelCallEvents } from "./run/attempt.model-diagnostic-events.js";

it.each(["completion", "abort"] as const)(
  "serializes provider waits across model calls and ordinary run events (%s)",
  async (termination) => {
    const runEmbeddedAgent = await loadSharedRunIntegrationHarness();
    resetSharedRunIntegrationHarnessMocks();
    const session = await createSharedRunIntegrationSession();
    onTestFinished(() => session.cleanup());
    const firstWaitEntered = createDeferredCore();
    const releaseFirstWait = createDeferredCore();
    const delivered: string[] = [];
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attempt) => {
      const firstSource = createAssistantMessageEventStream();
      const secondSource = createAssistantMessageEventStream();
      const source = vi
        .fn<StreamFn>()
        .mockReturnValueOnce(firstSource)
        .mockReturnValueOnce(secondSource);
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
      expectDefined(source.mock.calls[0], "first model call")[2]?.onProviderWait?.("response");
      await firstWaitEntered.promise;
      firstSource.end(makeAssistantMessageFixture());
      await first.result();
      const abort = new AbortController();
      const second = await stream(model, { messages: [] }, { signal: abort.signal });
      expectDefined(source.mock.calls[1], "second model call")[2]?.onProviderWait?.("slot");
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
      secondSource.end(makeAssistantMessageFixture());
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
      return session.makeAttemptResult();
    });
    await runEmbeddedAgent({
      ...session.runParams,
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
