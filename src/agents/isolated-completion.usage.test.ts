import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { runHostPreparedIsolatedCompletion } from "./host-prepared-isolated-completion.js";
import type { IsolatedCompletionPurpose } from "./isolated-completion-purpose.js";
import * as fixtures from "./isolated-completion.test-support.js";
const mocks = fixtures.isolatedCompletionMocks;
const completePrepared = vi.hoisted(() => vi.fn());
// mock-isolation: Supply returned provider messages; keep the host result and authority fences real.
vi.mock("./simple-completion-execution.js", () => ({
  completeWithPreparedSimpleCompletionModel: completePrepared,
}));
let work: AsyncWorkScope;
let events: Extract<DiagnosticEventPayload, { type: "model.usage" }>[];
let stop: () => void;

beforeEach(() => {
  fixtures.resetIsolatedCompletionTestState();
  resetDiagnosticEventsForTest();
  completePrepared.mockReset();
  work = new AsyncWorkScope();
  events = [];
  stop = onTrustedInternalDiagnosticEvent((event) => {
    if (event.type === "model.usage") {
      events.push(event);
    }
  });
});
afterEach(async () => {
  await work.drain();
  stop();
});
const cliUsage = { input: 10, output: 462, cacheRead: 0, cacheWrite: 4111, total: 4583 };
type UsageCase = "cli" | "diagnostic-cli" | "harness" | "empty-harness";

async function collectUsage(kind: UsageCase, purpose?: IsolatedCompletionPurpose) {
  if (kind === "cli" || kind === "diagnostic-cli") {
    mocks.isCliRuntimeAliasForProvider.mockReturnValue(true);
    const usage = kind === "cli" ? cliUsage : { input: 1, output: 1 };
    const agentMeta = {
      usage,
      ...(kind === "diagnostic-cli" ? { diagnosticUsage: cliUsage } : {}),
    };
    const payloads = [{ text: "done" }];
    mocks.runCliAgent.mockResolvedValue({ payloads, meta: { agentMeta } });
  } else {
    const assistant = fixtures.isolatedAssistant([{ type: "text", text: "done" }]);
    if (kind === "empty-harness") {
      assistant.usage = { ...assistant.usage, input: 0, output: 0, totalTokens: 0 };
    }
    fixtures.registerIsolatedHarness({ runIsolatedCompletionV2: async () => ({ assistant }) });
  }
  await fixtures.runIsolatedCompletion({ ...fixtures.isolatedRequest(), purpose });
  return events;
}

it.each([
  ["cli", "session-activity-summary", { input: 10, output: 462, cacheWrite: 4111, total: 4583 }],
  ["harness", undefined, { input: 1, output: 1, total: 2 }],
] as const)("reports completed %s usage", async (runtimeKind, purpose, usage) => {
  expect(await collectUsage(runtimeKind, purpose)).toMatchObject([
    {
      agentId: "main",
      provider: "openai",
      model: "gpt-test",
      purpose: purpose ?? "isolated-completion",
      runtimeKind,
      usage,
    },
  ]);
});

it("reports terminal CLI turn usage", async () => {
  expect(await collectUsage("diagnostic-cli")).toMatchObject([
    { usage: { output: 462, total: 4583 } },
  ]);
});

it("retains rejected CLI output's cumulative usage without accepting the output", async () => {
  mocks.isCliRuntimeAliasForProvider.mockReturnValue(true);
  mocks.runCliAgent.mockResolvedValue({
    payloads: [{ text: "rejected", isError: true }],
    meta: { agentMeta: { usage: { input: 1 }, diagnosticUsage: cliUsage } },
  });
  await expect(fixtures.runIsolatedCompletion(fixtures.isolatedRequest())).rejects.toMatchObject({
    code: "output-rejected",
  });
  expect(events).toMatchObject([{ usage: { input: 10, output: 462, total: 4583 } }]);
});

it("keeps plugin completion accounting with its existing owner", async () => {
  expect(await collectUsage("cli", "plugin-completion")).toEqual([]);
});

it("does not turn default-zero usage into a measured zero", async () => {
  expect(await collectUsage("empty-harness")).toMatchObject([
    { usage: {}, usageReport: { state: "unavailable" } },
  ]);
});

it.each([
  "rejected",
  "aborted",
  "empty",
  "tool",
  "unavailable",
  "measured-zero",
  "thrown",
] as const)(
  "accounts once for a dispatched %s result without accepting rejected output",
  async (outcome) => {
    const assistant = fixtures.isolatedAssistant(
      [{ type: "text", text: "result" }],
      outcome === "aborted" ? "aborted" : outcome === "rejected" ? "error" : "stop",
    );
    if (outcome === "empty") {
      assistant.content = [];
    } else if (outcome === "tool") {
      assistant.content = [{ type: "toolCall", id: "fixture-call", name: "read", arguments: {} }];
    }
    if (outcome === "unavailable" || outcome === "measured-zero") {
      assistant.usage = {
        ...assistant.usage,
        input: 0,
        output: 0,
        totalTokens: 0,
        usageReport: { state: outcome === "unavailable" ? "unavailable" : "available" },
      };
    }
    fixtures.registerIsolatedHarness({
      runIsolatedCompletionV2: async () => {
        if (outcome === "thrown") {
          throw new Error("fixture transport failed");
        }
        return { assistant };
      },
    });
    const pending = work.run(() => fixtures.runIsolatedCompletion(fixtures.isolatedRequest()));
    if (["rejected", "aborted", "empty", "tool", "thrown"].includes(outcome)) {
      await expect(pending).rejects.toThrow();
    } else {
      await expect(pending).resolves.toMatchObject({ text: "result" });
    }
    await work.drain();
    const unavailable = outcome === "unavailable" || outcome === "thrown";
    expect(events).toMatchObject([
      {
        completionId: expect.any(String),
        attemptId: expect.any(String),
        usage: unavailable ? {} : { input: outcome === "measured-zero" ? 0 : 1 },
        ...(unavailable ? { usageReport: { state: "unavailable" } } : {}),
      },
    ]);
    if (unavailable) {
      expect(events[0]).not.toHaveProperty("costUsd");
    }
  },
);

it("keeps disabled diagnostics out of completion acceptance and cleanup", async () => {
  Object.assign(fixtures.preparedModelRuntime, { config: { diagnostics: { enabled: false } } });
  fixtures.registerIsolatedHarness({
    runIsolatedCompletionV2: async () => fixtures.isolatedReply(),
  });
  await expect(
    work.run(() => fixtures.runIsolatedCompletion(fixtures.isolatedRequest())),
  ).resolves.toMatchObject({ text: "done" });
  await work.drain();
  expect(events).toEqual([]);
  expect(fixtures.releaseRuntimeLease).toHaveBeenCalledOnce();
});

it.each(["accepted", "retired", "aborted"] as const)(
  "retains the host's returned usage exactly once when its caller is %s",
  async (outcome) => {
    const controller = new AbortController();
    const failure = new Error("fixture caller retired");
    let current = true;
    completePrepared.mockImplementation(async () => {
      if (outcome === "aborted") {
        controller.abort(failure);
      }
      current = outcome !== "retired";
      return fixtures.isolatedReply().assistant;
    });
    fixtures.registerIsolatedHarness({
      runIsolatedCompletionV2: runHostPreparedIsolatedCompletion,
    });
    const pending = work.run(() =>
      fixtures.runIsolatedCompletion(
        fixtures.isolatedRequest({
          purpose: "session-activity-summary",
          sessionId: "fixture-session",
          sessionKey: "agent:main:fixture",
          abortSignal: controller.signal,
          assertCurrent: () => {
            if (!current) {
              throw failure;
            }
          },
        }),
      ),
    );
    if (outcome === "accepted") {
      await expect(pending).resolves.toMatchObject({ text: "done" });
    } else {
      await expect(pending).rejects.toBe(failure);
    }
    await work.drain();
    expect(events).toMatchObject([
      {
        purpose: "session-activity-summary",
        sessionId: "fixture-session",
        sessionKey: "agent:main:fixture",
        usage: { input: 1, output: 1, total: 2 },
      },
    ]);
  },
);

it("retains each profile attempt rather than deduplicating the whole completion", async () => {
  fixtures.prepareQuotaProfiles();
  let attempts = 0;
  fixtures.registerIsolatedHarness({
    authBootstrap: "harness",
    runIsolatedCompletionV2: async () =>
      ++attempts === 1
        ? fixtures.isolatedErrorReply("429 Too many requests")
        : fixtures.isolatedReply(),
  });
  await fixtures.runIsolatedCompletion(fixtures.isolatedRequest());
  expect(events).toHaveLength(2);
  expect(events[0]).toMatchObject({ completionId: events[1]?.completionId, usage: { total: 2 } });
  expect(events[0]?.attemptId).not.toBe(events[1]?.attemptId);
});

it("does not finalize an abort before its admitted runtime returns usage", async () => {
  const started = createDeferredCore();
  const finish = createDeferredCore();
  const controller = new AbortController();
  fixtures.registerIsolatedHarness({
    runIsolatedCompletionV2: async () => {
      started.resolve();
      await finish.promise;
      return fixtures.isolatedReply();
    },
  });
  const pending = work.run(() =>
    fixtures.runIsolatedCompletion(fixtures.isolatedRequest({ abortSignal: controller.signal })),
  );
  const rejected = expect(pending).rejects.toThrow("fixture abort");
  await started.promise;
  controller.abort(new Error("fixture abort"));
  try {
    await rejected;
    expect(events).toEqual([]);
  } finally {
    finish.resolve();
    await work.drain();
  }
  expect(events).toMatchObject([{ usage: { total: 2 } }]);
});
