import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { buildReplyPayloads } from "../../auto-reply/reply/agent-runner-payloads.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  mockedBuildEmbeddedRunPayloads,
  mockedRunEmbeddedAttempt,
  resetSharedRunIntegrationHarnessMocks,
} from "./run.overflow-compaction.harness.js";
import {
  cleanupSharedRunIntegrationSessions,
  createSharedRunIntegrationSession,
  loadSharedRunIntegrationHarness,
} from "./run.shared-integration-harness.test-support.js";
import type { RunEmbeddedAgentInternalParams } from "./run/internal-params.js";

let runEmbeddedAgent: Awaited<ReturnType<typeof loadSharedRunIntegrationHarness>>;
let session: Awaited<ReturnType<typeof createSharedRunIntegrationSession>>;

beforeAll(async () => {
  runEmbeddedAgent = await loadSharedRunIntegrationHarness();
});
beforeEach(async () => {
  resetSharedRunIntegrationHarnessMocks();
  session = await createSharedRunIntegrationSession();
  mockedBuildEmbeddedRunPayloads.mockImplementation(({ assistantTexts }) =>
    assistantTexts.map((text) => ({ text })),
  );
});
afterEach(async () => await session.cleanup());
afterAll(cleanupSharedRunIntegrationSessions);

it("withholds an optional draft without turning it into an error or a recoverable answer", async () => {
  mockedRunEmbeddedAttempt.mockResolvedValueOnce(
    session.makeAttemptResult({
      assistantTexts: ["I could not find anything. Can you send the missing report?"],
      attemptUsage: { input: 31, output: 12 },
      toolMetas: [{ toolName: "web_search", isError: false }],
    }),
  );
  const params: RunEmbeddedAgentInternalParams = {
    ...session.runParams,
    terminalReplyExpectation: "optional",
    reviewSettledDraft: async () => ({ action: "withhold" }),
  };
  const result = await runEmbeddedAgent(params);
  const delivery = await buildReplyPayloads({
    payloads: result.payloads ?? [],
    messageProvider: "telegram",
    originatingTo: "telegram:123",
    isHeartbeat: false,
    didLogHeartbeatStrip: false,
    blockStreamingEnabled: false,
    blockReplyPipeline: null,
    replyToMode: "off",
  });
  expect(delivery.replyPayloads).toEqual([]);
  expect(result.meta.error).toBeUndefined();
  expect(result.meta.finalAssistantVisibleText).toBeUndefined();
  expect(result.meta.agentMeta?.usage).toMatchObject({ input: 31, output: 12 });
  expect(result.meta.agentMeta?.terminalReceipt?.successfulToolNames).toContain("web_search");
});

it("publishes the revised draft instead of the rejected draft", async () => {
  mockedRunEmbeddedAttempt
    .mockResolvedValueOnce(
      session.makeAttemptResult({ assistantTexts: ["Use port 443. Disable certificate checks."] }),
    )
    .mockResolvedValueOnce(session.makeAttemptResult({ assistantTexts: ["Use port 443."] }));
  const params: RunEmbeddedAgentInternalParams = {
    ...session.runParams,
    terminalReplyExpectation: "optional",
    reviewSettledDraft: async ({ payloads }) =>
      payloads.some((payload) => payload.text?.includes("Disable certificate checks"))
        ? {
            action: "continue",
            prompt: "Remove the unsupported certificate advice. Retain the supported port answer.",
          }
        : { action: "publish" },
  };
  const result = await runEmbeddedAgent(params);
  expect(result.payloads).toEqual([{ text: "Use port 443." }]);
  expect(result.meta.error).toBeUndefined();
});

it("ends repeated draft revisions through the existing run retry limit", async () => {
  // Finite model replies make a restarted budget fail rather than leave a hung test.
  for (let index = 0; index < 40; index++) {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      session.makeAttemptResult({ assistantTexts: ["Unsupported draft."] }),
    );
  }
  mockedRunEmbeddedAttempt.mockRejectedValue(new Error("The model fixture has no more replies"));
  const result = await runEmbeddedAgent({
    ...session.runParams,
    terminalReplyExpectation: "optional",
    reviewSettledDraft: async () => ({
      action: "continue",
      prompt: "Remove the unsupported assertion before publishing.",
    }),
  });
  expect(result.meta.error?.kind).toBe("retry_limit");
  expect(result.payloads?.some((payload) => payload.text === "Unsupported draft.")).toBe(false);
});

it("does not publish a draft when its owner is cancelled during review", async () => {
  const reviewing = createDeferredCore();
  const reviewed = createDeferredCore();
  const abort = new AbortController();
  mockedRunEmbeddedAttempt.mockResolvedValueOnce(
    session.makeAttemptResult({ assistantTexts: ["Private draft must stay private."] }),
  );
  const params: RunEmbeddedAgentInternalParams = {
    ...session.runParams,
    abortSignal: abort.signal,
    terminalReplyExpectation: "optional",
    reviewSettledDraft: async () => {
      reviewing.resolve();
      await reviewed.promise;
      return { action: "publish" };
    },
  };
  const pending = runEmbeddedAgent(params);
  const cancelled = expect(pending).rejects.toThrow("Source turn cancelled");
  await reviewing.promise;
  abort.abort(new Error("Source turn cancelled"));
  await cancelled;
  reviewed.reject(new Error("Late review failure"));
});
