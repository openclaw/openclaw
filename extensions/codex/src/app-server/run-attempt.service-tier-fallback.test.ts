import { describe, expect, it } from "vitest";
import { CodexAppServerRpcError } from "./client.js";
import { turnCompleted } from "./protocol.test-helpers.js";
import {
  createTestParams,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  threadStartResult,
  turnStartResult,
} from "./run-attempt-test-harness.js";

setupRunAttemptTestHooks();

describe("Codex same-model service tier fallback", () => {
  it("tries Fast and standard on the same model before returning a premium-tier limit", async () => {
    const params = createTestParams();
    params.fastMode = "ultrafast";
    params.timeoutMs = 15_000;
    let starts = 0;
    const harness = createStartedThreadHarness(
      async (method, request) => {
        if (method === "model/list") {
          return {
            data: [
              {
                id: params.modelId,
                model: params.modelId,
                displayName: "Test model",
                description: "Test model",
                hidden: false,
                isDefault: true,
                supportedReasoningEfforts: [],
                defaultReasoningEffort: "medium",
                serviceTiers: [{ id: "ultrafast", name: "Ultrafast", description: "Faster" }],
              },
            ],
            nextCursor: null,
          };
        }
        if (method === "thread/resume") {
          return threadStartResult((request as { threadId: string }).threadId);
        }
        if (method === "turn/start") {
          starts++;
          if (starts < 3) {
            throw new CodexAppServerRpcError(
              {
                code: -32_000,
                message: "usage not included",
                data: { codexErrorInfo: "usageLimitExceeded" },
              },
              "turn/start",
            );
          }
          return turnStartResult("turn-3");
        }
        return undefined;
      },
      { persistedThreads: [] },
    );
    const run = runCodexAppServerAttempt(params);
    await run.waitForTurnAccepted();
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-3" });
    const result = await run;
    expect(result.terminal.kind).toBe("ok");
    const turns = harness.requests
      .filter((request) => request.method === "turn/start")
      .map((request) => request.params);
    expect(turns).toEqual([
      expect.objectContaining({ model: params.modelId, serviceTier: "ultrafast" }),
      expect.objectContaining({
        model: params.modelId,
        serviceTier: "ultrafast",
        serviceTierForTurn: "priority",
      }),
      expect.objectContaining({
        model: params.modelId,
        serviceTier: "ultrafast",
        serviceTierForTurn: "default",
      }),
    ]);
    expect(turns.map((turn) => (turn as { threadId: string }).threadId)).toEqual([
      "thread-1",
      "thread-1",
      "thread-1",
    ]);
  });

  it("recovers a failed accepted Fast turn at standard speed without changing the model", async () => {
    const params = createTestParams();
    params.fastMode = true;
    params.timeoutMs = 15_000;
    let starts = 0;
    let accepted = 0;
    const secondAccepted = Promise.withResolvers<void>();
    params.onExecutionPhase = (event) => {
      if (event.phase === "turn_accepted") {
        accepted++;
        if (accepted === 2) {
          secondAccepted.resolve();
        }
      }
    };
    const harness = createStartedThreadHarness(
      async (method, request) => {
        if (method === "thread/resume") {
          return threadStartResult((request as { threadId: string }).threadId);
        }
        if (method === "turn/start") {
          return turnStartResult(`turn-${++starts}`);
        }
        return undefined;
      },
      { persistedThreads: [] },
    );
    const run = runCodexAppServerAttempt(params);
    await run.waitForTurnAccepted();
    const recordUsage = (turnId: string, responseId: string, inputTokens: number) =>
      harness.notify({
        method: "rawResponse/completed",
        params: {
          threadId: "thread-1",
          turnId,
          responseId,
          usage: {
            inputTokens,
            cachedInputTokens: 0,
            outputTokens: 1,
            totalTokens: inputTokens + 1,
          },
        },
      });
    await recordUsage("turn-1", "response-1", 5);
    await harness.notify(
      turnCompleted({
        id: "turn-1",
        status: "failed",
        error: { message: "service overloaded", codexErrorInfo: "serverOverloaded" },
      }),
    );
    await secondAccepted.promise;
    await recordUsage("turn-2", "response-2", 7);
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-2" });
    const result = await run;
    expect(result.terminal.kind).toBe("ok");
    expect(result.modelIterations).toBe(2);
    expect(result.attemptUsage).toMatchObject({
      input: 12,
      output: 2,
      total: 14,
      contextUsage: { state: "available", promptTokens: 7, totalTokens: 8 },
    });
    expect(
      harness.requests
        .filter(({ method }) => method === "turn/start")
        .map(({ params: request }) => request),
    ).toEqual([
      expect.objectContaining({ model: params.modelId, serviceTier: "priority" }),
      expect.objectContaining({
        model: params.modelId,
        serviceTier: "priority",
        serviceTierForTurn: "default",
      }),
    ]);
  });
});
