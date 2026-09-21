import { createHook } from "node:async_hooks";
import { setImmediate } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { ModelCompatConfig } from "openclaw/plugin-sdk/provider-model-types";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawStateDatabaseAsync,
  drainSessionDiskBudgetWorkers,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createStartedThreadHarness,
  createTestParams,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  threadStartResult,
  turnStartResult,
} from "./run-attempt-test-harness.js";

beforeAll(() => {
  let allocatedWorkers = 0;
  const pendingWorkers = new Map<number, string>();
  const observer = createHook({
    init(id, type) {
      if (type === "WORKER") {
        allocatedWorkers++;
        pendingWorkers.set(id, new Error("WORKER allocated here").stack ?? "WORKER");
      }
    },
    destroy(id) {
      pendingWorkers.delete(id);
    },
  }).enable();
  // The scan pool is shared across cases; verify its file owner after all fixture cleanup.
  return async () => {
    try {
      await setImmediate();
      expect(allocatedWorkers).toBeGreaterThan(0);
      expect(
        pendingWorkers.size,
        `WORKER resources surviving Codex fixture teardown:\n${[...pendingWorkers.values()].join("\n")}`,
      ).toBe(0);
    } finally {
      observer.disable();
      await drainSessionDiskBudgetWorkers();
      await closeOpenClawAgentDatabasesAsync();
      await closeOpenClawStateDatabaseAsync();
    }
  };
});

setupRunAttemptTestHooks();

describe("Codex reasoning effort across completed turns", () => {
  it.each([
    {
      metadata: "Platform",
      supported: ["none", "low", "medium", "high", "xhigh", "max"],
      expectedOff: "none",
    },
    {
      metadata: "subscription",
      supported: ["low", "medium", "high", "xhigh", "max"],
      expectedOff: null,
    },
    { metadata: "unknown", supported: undefined, expectedOff: null },
  ] as const)(
    "changes high to off on the same thread with $metadata metadata",
    async ({ metadata, supported, expectedOff }) => {
      let turnCount = 0;
      let turnStarted = createDeferred<void>();
      const harness = createStartedThreadHarness(async (method) => {
        if (method === "thread/resume") {
          return threadStartResult();
        }
        if (method === "turn/start") {
          const result = turnStartResult(`turn-${++turnCount}`);
          turnStarted.resolve();
          return result;
        }
        return undefined;
      });
      const params = createTestParams();
      const compat: ModelCompatConfig = {
        supportsTools: false,
        ...(supported ? { supportedReasoningEfforts: [...supported] } : {}),
      };
      params.provider = "openai";
      params.modelId = "gpt-5.6-luna";
      params.model = {
        ...params.model,
        provider: "openai",
        id: params.modelId,
        api: metadata === "subscription" ? "openai-chatgpt-responses" : "openai-responses",
        baseUrl:
          metadata === "subscription"
            ? "https://chatgpt.com/backend-api/codex"
            : "https://api.openai.com/v1",
        compat,
      };

      for (const [index, thinkLevel] of (["high", "off"] as const).entries()) {
        turnStarted = createDeferred<void>();
        const run = runCodexAppServerAttempt({
          ...params,
          thinkLevel,
          runId: `run-${index + 1}`,
        });
        await Promise.race([turnStarted.promise, run]);
        expect(turnCount).toBe(index + 1);
        await harness.completeTurn({ threadId: "thread-1", turnId: `turn-${index + 1}` });
        await run;
      }

      expect(harness.requests.filter(({ method }) => method === "thread/start")).toHaveLength(1);
      const turnRequests = harness.requests.filter(({ method }) => method === "turn/start");
      expect(turnRequests.map(({ params: request }) => request)).toMatchObject([
        {
          threadId: "thread-1",
          effort: "high",
          collaborationMode: { settings: { reasoning_effort: "high" } },
        },
        {
          threadId: "thread-1",
          effort: expectedOff,
          collaborationMode: { settings: { reasoning_effort: expectedOff } },
        },
      ]);
    },
  );
});
