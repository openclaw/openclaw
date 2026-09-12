/**
 * The compaction-provider failure boundary: what a session is left with when a
 * registered provider's summarize() throws. Split out of agent-session-compaction.test.ts
 * to keep both files under the max-lines cap; this half owns the provider-failure
 * outcomes and the degraded-fallback contract.
 */
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

/** The structured artifact the safeguard commits when quality validation is exhausted. */
const DEGRADED_FALLBACK_SUMMARY = [
  "## Decisions",
  "No prior history.",
  "",
  "## Open TODOs",
  "None.",
  "",
  "## Constraints/Rules",
  "None.",
  "",
  "## Pending user asks",
  "None.",
  "",
  "## Exact identifiers",
  "None captured.",
].join("\n");

describe("AgentSession compaction provider boundary", () => {
  // A provider throw never cancels on its own: it is caught and retried through the
  // built-in summarizer. What the session ends up with is decided by that summary --
  // "recovered" when it passes the quality audit, "degraded" when it is produced but
  // fails the audit, and "cancelled" only when the caller aborts.
  it.each([
    {
      name: "provider timeout",
      errorName: "TimeoutError",
      cancelCaller: false,
      outcome: "degraded",
    },
    {
      name: "provider timeout recovery",
      errorName: "TimeoutError",
      cancelCaller: false,
      outcome: "recovered",
    },
    {
      name: "ordinary provider failure",
      errorName: "Error",
      cancelCaller: false,
      outcome: "degraded",
    },
    {
      name: "provider-side abort",
      errorName: "AbortError",
      cancelCaller: false,
      outcome: "recovered",
    },
    {
      name: "caller cancellation",
      errorName: "AbortError",
      cancelCaller: true,
      outcome: "cancelled",
    },
  ] as const)(
    "preserves the safeguard boundary after $name",
    async ({ errorName, cancelCaller, outcome }) => {
      const recovers = outcome === "recovered";
      // A synthetic API plus the registered stream keep both real summarizers offline.
      const model = {
        ...testModel,
        api: "compaction-test-api",
        contextWindow: 4_096,
        maxTokens: 128,
      };
      const summary = recovers
        ? [
            "## Decisions\nThe old prompt was answered.",
            "## Open TODOs\nNone.",
            "## Constraints/Rules\nPreserve the session history.",
            "## Pending user asks\nNone.",
            "## Exact identifiers\nNone.",
          ].join("\n\n")
        : "Core summary without required safeguard headings";
      const recoveredSummary = [
        "## Latest user request context",
        JSON.stringify("old prompt"),
        "",
        summary,
      ].join("\n");
      const sessionManager = SessionManager.inMemory();
      sessionManager.appendMessage({ role: "user", content: "old prompt", timestamp: 1 });
      sessionManager.appendMessage({
        ...createAssistant(model, [{ type: "text", text: "old answer" }]),
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
              createAssistant(
                activeModel,
                [{ type: "text", text: summary }],
                options?.signal?.aborted ? "aborted" : "stop",
              ),
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

        const observation = {
          providerCalls: summarize.mock.calls.length,
          callerAbortedAtProviderEntry,
          callerAborted: callerSignal?.aborted,
          result,
          outcomes: compactionEnds.map((event) => event.outcome.status),
          appended,
        };
        expect(subscription.getUsageTotals()?.total ?? 0).toBe(
          streamMocks.streamSimple.mock.calls.length * 2,
        );
        subscription.unsubscribe();
        const expectedCommit =
          outcome === "recovered"
            ? recoveredSummary
            : outcome === "degraded"
              ? DEGRADED_FALLBACK_SUMMARY
              : undefined;
        expect.soft(observation).toMatchObject({
          providerCalls: 1,
          callerAbortedAtProviderEntry: false,
          callerAborted: cancelCaller,
          result: expectedCommit
            ? { status: "resolved", summary: expectedCommit }
            : { status: "rejected" },
          outcomes: [expectedCommit ? "completed" : "aborted"],
          appended: expectedCommit
            ? [
                {
                  summary: expectedCommit,
                  fromHook: true,
                  // The degraded commit records itself on the boundary it produced, so
                  // "was this degraded?" never has to be read back out of summary prose.
                  qualityDegraded: outcome === "degraded" ? true : undefined,
                },
              ]
            : [],
        });
        // The guarded pipeline may chunk the history; do not pin its request count.
        if (!cancelCaller) {
          expect(streamMocks.streamSimple).toHaveBeenCalled();
        }
        // Only a cancelled compaction leaves history untouched. A degraded one commits a
        // boundary on purpose: that is the whole point of degrading instead of cancelling.
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
