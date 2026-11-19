import type { Context, Model, SimpleStreamOptions } from "openclaw/plugin-sdk/llm";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { CompactionProvider } from "../../plugins/compaction-provider.js";
import { requireActivePluginRegistry } from "../../plugins/runtime.js";
import { subscribeEmbeddedAgentSession } from "../embedded-agent-subscribe.js";
import { safeguardFixture, textStream } from "./agent-session-boundary.test-support.js";
import {
  collectCompactionEnds,
  createAssistant,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";
import { SessionManager } from "./session-manager.js";

registerAgentSessionLoopTestLifecycle();

// Provider errors fall back to the built-in summarizer; only caller abort cancels.
it.each([
  ["provider timeout", "TimeoutError", false, "degraded"],
  ["provider-side abort", "AbortError", false, "recovered"],
  ["caller cancellation", "AbortError", true, "cancelled"],
] as const)(
  "preserves the safeguard boundary after %s",
  async (_name, errorName, cancelCaller, outcome) => {
    const model = {
      ...testModel,
      api: "compaction-test-api",
      contextWindow: 4_096,
      maxTokens: 128,
    };
    const summary =
      outcome === "recovered"
        ? "## Decisions\nThe old prompt was answered.\n\n## Open TODOs\nNone.\n\n## Constraints/Rules\nPreserve the session history.\n\n## Pending user asks\nNone.\n\n## Exact identifiers\nNone."
        : "Core summary without required safeguard headings";
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendMessage({ role: "user", content: "old prompt", timestamp: 1 });
    sessionManager.appendMessage({ ...createAssistant(model, "old answer"), timestamp: 2 });
    sessionManager.appendMessage({ role: "user", content: "latest prompt", timestamp: 3 });
    const providerStarted = createDeferred();
    const releaseProvider = createDeferred();
    const summarize = vi.fn<CompactionProvider["summarize"]>(async () => {
      providerStarted.resolve();
      await releaseProvider.promise;
      throw Object.assign(new Error("synthetic custom-provider failure"), { name: errorName });
    });
    const registration = {
      provider: { id: "session-compaction-test", label: "Session compaction test", summarize },
    };
    const registry = requireActivePluginRegistry();
    registry.compactionProviders.push(registration);
    streamMocks.streamSimple.mockImplementation(
      (activeModel: Model, _context: Context, options?: SimpleStreamOptions) =>
        textStream(activeModel, summary, options?.signal?.aborted ? "aborted" : "stop"),
    );
    const fixture = await safeguardFixture(model, sessionManager, registration.provider.id);
    const { session, network } = fixture;
    try {
      const subscription = subscribeEmbeddedAgentSession({
        session,
        runId: "run-safeguard-summary-usage",
      });
      const entriesBefore = structuredClone(sessionManager.getEntries());
      const messagesBefore = structuredClone(session.messages);
      const compactionEnds = collectCompactionEnds(session);
      const compaction = session.compact().then(
        (result) => result.summary,
        () => undefined,
      );
      // Cancel through the public session API while the custom provider is in flight.
      await Promise.race([providerStarted.promise, compaction]);
      const callerSignal = summarize.mock.calls[0]?.[0].signal;
      const callerAbortedAtProviderEntry = callerSignal?.aborted;
      if (cancelCaller) {
        session.abortCompaction();
      }
      releaseProvider.resolve();
      const result = await compaction;
      const appended = sessionManager.getEntries().filter((entry) => entry.type === "compaction");
      expect
        .soft([callerAbortedAtProviderEntry, callerSignal?.aborted])
        .toEqual([false, cancelCaller]);
      expect.soft(result).toEqual(cancelCaller ? undefined : expect.stringContaining(summary));
      expect
        .soft(compactionEnds.map((event) => event.outcome.status))
        .toEqual([cancelCaller ? "aborted" : "completed"]);
      expect.soft(appended).toHaveLength(cancelCaller ? 0 : 1);
      expect(subscription.getUsageTotals()?.total ?? 0).toBe(
        streamMocks.streamSimple.mock.calls.length * 2,
      );
      subscription.unsubscribe();
      if (!cancelCaller) {
        expect(appended[0]).toMatchObject({
          summary: expect.stringContaining("old prompt"),
          fromHook: true,
        });
        expect(
          (appended[0]?.details as { qualityDegraded?: true } | undefined)?.qualityDegraded,
        ).toBe(outcome === "degraded" ? true : undefined);
        expect(appended[0]?.summary).toContain(summary);
      } else {
        expect.soft(sessionManager.getEntries()).toEqual(entriesBefore);
        expect.soft(session.messages).toEqual(messagesBefore);
      }
      expect(network).not.toHaveBeenCalled();
    } finally {
      releaseProvider.resolve();
      fixture.dispose();
      registry.compactionProviders.splice(registry.compactionProviders.indexOf(registration), 1);
    }
  },
);
