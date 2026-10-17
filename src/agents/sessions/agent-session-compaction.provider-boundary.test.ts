import type { Context, Model, SimpleStreamOptions } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { CompactionProvider } from "../../plugins/compaction-provider.js";
import { requireActivePluginRegistry } from "../../plugins/runtime.js";
import { setCompactionSafeguardRuntime } from "../agent-hooks/compaction-safeguard-runtime.js";
import compactionSafeguardExtension from "../agent-hooks/compaction-safeguard.js";
import { subscribeEmbeddedAgentSession } from "../embedded-agent-subscribe.js";
import {
  collectCompactionEnds,
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";
import { createResourceLoader } from "./agent-session-loop-resource-loader.test-support.js";
import { createEventBus } from "./event-bus.js";
import { loadExtensionFromFactory } from "./extensions/loader.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

registerAgentSessionLoopTestLifecycle();

describe("AgentSession compaction provider boundary", () => {
  // Provider errors fall back to the built-in summarizer; only caller abort cancels.
  it.each([
    ["provider timeout", "TimeoutError", false, "degraded"],
    ["provider timeout recovery", "TimeoutError", false, "recovered"],
    ["ordinary provider failure", "Error", false, "degraded"],
    ["provider-side abort", "AbortError", false, "recovered"],
    ["caller cancellation", "AbortError", true, "cancelled"],
  ] as const)(
    "preserves the safeguard boundary after %s",
    async (_name, errorName, cancelCaller, outcome) => {
      // A synthetic API plus the registered stream keep both real summarizers offline.
      const model = {
        ...testModel,
        api: "compaction-test-api",
        contextWindow: 4_096,
        maxTokens: 128,
      };
      const summary =
        outcome === "recovered"
          ? [
              "## Decisions\nThe old prompt was answered.",
              "## Open TODOs\nNone.",
              "## Constraints/Rules\nPreserve the session history.",
              "## Pending user asks\nNone.",
              "## Exact identifiers\nNone.",
            ].join("\n\n")
          : "Core summary without required safeguard headings";
      const sessionManager = SessionManager.inMemory();
      sessionManager.appendMessage({ role: "user", content: "old prompt", timestamp: 1 });
      sessionManager.appendMessage({
        ...createAssistant(model, "old answer"),
        timestamp: 2,
      });
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
      setCompactionSafeguardRuntime(sessionManager, {
        provider: registration.provider.id,
        model,
        recentTurnsPreserve: 0,
        qualityGuardEnabled: true,
        qualityGuardMaxRetries: 0,
      });
      const network = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("Unexpected network request in compaction test"));
      const eventBus = createEventBus();
      try {
        const resourceLoader = createResourceLoader();
        const extensions = resourceLoader.getExtensions();
        extensions.extensions.push(
          await loadExtensionFromFactory(
            compactionSafeguardExtension,
            sessionManager.getCwd(),
            eventBus,
            extensions.runtime,
          ),
        );
        streamMocks.streamSimple.mockImplementation(
          (activeModel: Model, _context: Context, options?: SimpleStreamOptions) =>
            createAssistantResultStream(
              createAssistant(activeModel, summary, options?.signal?.aborted ? "aborted" : "stop"),
            ),
        );
        const { session } = await createTestSession({
          model,
          sessionManager,
          resourceLoader,
          settingsManager: SettingsManager.inMemory({
            compaction: { enabled: false, reserveTokens: 64, keepRecentTokens: 1 },
            retry: { enabled: false },
          }),
        });
        const subscription = subscribeEmbeddedAgentSession({
          session,
          runId: "run-safeguard-summary-usage",
        });
        const entriesBefore = structuredClone(sessionManager.getEntries());
        const messagesBefore = structuredClone(session.messages);
        const compactionEnds = collectCompactionEnds(session);
        const compaction = session.compact().then(
          (result) => ({ status: "resolved", summary: result.summary }),
          (error: unknown) => ({
            status: "rejected",
            error: error instanceof Error ? error.message : String(error),
          }),
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
        const appended = sessionManager
          .getEntries()
          .filter((entry) => entry.type === "compaction")
          .map(({ summary: text, fromHook, details }) => ({
            summary: text,
            fromHook,
            qualityDegraded: (details as { qualityDegraded?: true } | undefined)?.qualityDegraded,
          }));

        expect
          .soft({
            providerCalls: summarize.mock.calls.length,
            callerAbortedAtProviderEntry,
            callerAborted: callerSignal?.aborted,
            result,
            outcomes: compactionEnds.map((event) => event.outcome.status),
            appended,
          })
          .toMatchObject({
            providerCalls: 1,
            callerAbortedAtProviderEntry: false,
            callerAborted: cancelCaller,
            result: !cancelCaller
              ? { status: "resolved", summary: expect.stringContaining(summary) }
              : { status: "rejected" },
            outcomes: [cancelCaller ? "aborted" : "completed"],
            appended: cancelCaller
              ? []
              : [
                  {
                    summary: expect.stringContaining(summary),
                    fromHook: true,
                    qualityDegraded: outcome === "degraded" ? true : undefined,
                  },
                ],
          });
        expect(subscription.getUsageTotals()?.total ?? 0).toBe(
          streamMocks.streamSimple.mock.calls.length * 2,
        );
        subscription.unsubscribe();
        if (!cancelCaller) {
          expect(streamMocks.streamSimple).toHaveBeenCalled();
          expect(appended[0]?.summary).toContain("old prompt");
        }
        if (outcome === "cancelled") {
          expect.soft(sessionManager.getEntries()).toEqual(entriesBefore);
          expect.soft(session.messages).toEqual(messagesBefore);
        } else {
          expect.soft(sessionManager.getEntries()).not.toEqual(entriesBefore);
        }
        expect(network.mock.calls.length).toBe(0);
      } finally {
        releaseProvider.resolve();
        setCompactionSafeguardRuntime(sessionManager, null);
        registry.compactionProviders.splice(registry.compactionProviders.indexOf(registration), 1);
        eventBus.clear();
        network.mockRestore();
      }
    },
  );
});
