import { getAiTransportHost } from "@openclaw/ai";
import { describe, expect, it } from "vitest";
import "../../llm/ai-transport-host.js";
import {
  observeProviderTransportLogicalCallFinalized,
  observeProviderTransportLogicalCallSettled,
  observeProviderTransportLogicalCallStarted,
} from "../provider-transport-accounting.js";
import {
  resolveAgentCommandRunAccounting,
  runWithAgentCommandAccounting,
} from "./run-accounting.js";
import type { RunAccountingAccumulator } from "./run-accounting.types.js";

const OPENAI_ROUTE = {
  provider: "openai",
  model: "gpt-test",
  api: "openai-responses",
} as const;

function startCall(callId: string): void {
  observeProviderTransportLogicalCallStarted({ callId, ...OPENAI_ROUTE });
}

function emitAttempt(params: {
  callId: string;
  eventId: string;
  ordinal: number;
  reason: "initial" | "retry";
  outcome: "completed" | "failed";
}): void {
  getAiTransportHost().observeModelTransportEvent({
    type: "attempt",
    ...params,
    ...OPENAI_ROUTE,
    transport: "http",
  });
}

function recordPricedUsage(accounting: RunAccountingAccumulator): void {
  const candidate = accounting.beginCandidate({ provider: "openai", model: "gpt-test" });
  candidate.selectRuntime("embedded");
  candidate.observeEmbeddedAttempt({
    provider: "openai",
    model: "gpt-test",
    config: {
      models: {
        providers: {
          openai: {
            models: [
              {
                id: "gpt-test",
                cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
    } as never,
    usage: {
      input: 1_000_000,
      output: 1_000_000,
      cacheRead: 0,
      cacheWrite: 0,
      reasoningTokens: 0,
      total: 2_000_000,
    },
    assistantTurns: 1,
    assistantTurnsObserved: true,
    toolSummary: { calls: 0, tools: [] },
    toolsObserved: true,
    codeModeLifecycleObserved: false,
  });
  candidate.settle("returned");
}

function expectExactUsageAndCost(snapshot: ReturnType<RunAccountingAccumulator["project"]>): void {
  expect(snapshot).toMatchObject({
    usage: { input: 1_000_000, output: 1_000_000, total: 2_000_000 },
    costUsd: 3,
    coverage: {
      usage: { state: "complete" },
      usageBuckets: {
        input: { state: "complete" },
        output: { state: "complete" },
        cacheRead: { state: "complete" },
        cacheWrite: { state: "complete" },
        reasoningTokens: { state: "complete" },
        total: { state: "complete" },
      },
      cost: { state: "complete" },
    },
  });
}

describe("command provider transport accounting", () => {
  it("projects host events through the active command collector", async () => {
    const snapshot = await runWithAgentCommandAccounting(async (accounting) => {
      observeProviderTransportLogicalCallStarted({
        callId: "call-command",
        provider: "openai",
        model: "gpt-test",
        api: "openai-responses",
      });
      getAiTransportHost().observeModelTransportEvent({
        type: "attempt",
        eventId: "attempt-command",
        callId: "call-command",
        provider: "openai",
        model: "gpt-test",
        api: "openai-responses",
        transport: "http",
        ordinal: 1,
        reason: "initial",
        outcome: "completed",
      });
      observeProviderTransportLogicalCallSettled("call-command", "completed");
      observeProviderTransportLogicalCallFinalized("call-command");
      return accounting.project();
    });

    expect(snapshot).toMatchObject({
      providerTransport: {
        logicalCalls: { total: 1, completed: 1, failed: 0, aborted: 0 },
        attempts: { total: 1, initial: 1, retries: 0 },
        connections: { total: 0 },
        fallbacks: { total: 0 },
      },
      coverage: { providerTransport: { state: "complete" } },
    });
  });

  it("attaches zero-submission accounting to command failures", async () => {
    const failure = new Error("provider exploded");

    await expect(
      runWithAgentCommandAccounting(async () => {
        observeProviderTransportLogicalCallStarted({
          callId: "call-thrown",
          provider: "openai",
          model: "gpt-test",
          api: "openai-responses",
        });
        getAiTransportHost().observeModelTransportEvent({
          type: "submission",
          eventId: "submission-thrown",
          callId: "call-thrown",
          provider: "openai",
          model: "gpt-test",
          api: "openai-responses",
          transport: "http",
          total: 0,
          outcome: "failed",
          reason: "failed_before_submission",
        });
        observeProviderTransportLogicalCallSettled("call-thrown", "failed");
        observeProviderTransportLogicalCallFinalized("call-thrown");
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(resolveAgentCommandRunAccounting(failure)).toMatchObject({
      providerTransport: {
        logicalCalls: { total: 1, completed: 0, failed: 1, aborted: 0 },
        attempts: { total: 0 },
        zeroSubmissions: { total: 1, failed: 1, aborted: 0 },
      },
      coverage: { providerTransport: { state: "complete" } },
    });
  });

  it("keeps terminal usage lower-bound when one logical call retries", async () => {
    const snapshot = await runWithAgentCommandAccounting(async (accounting) => {
      startCall("call-retry-usage");
      emitAttempt({
        eventId: "attempt-retry-usage-1",
        callId: "call-retry-usage",
        ordinal: 1,
        reason: "initial",
        outcome: "failed",
      });
      emitAttempt({
        eventId: "attempt-retry-usage-2",
        callId: "call-retry-usage",
        ordinal: 2,
        reason: "retry",
        outcome: "completed",
      });
      observeProviderTransportLogicalCallSettled("call-retry-usage", "completed");
      observeProviderTransportLogicalCallFinalized("call-retry-usage");
      recordPricedUsage(accounting);
      return accounting.project();
    });

    expect(snapshot).toMatchObject({
      usage: { input: 1_000_000, output: 1_000_000, total: 2_000_000 },
      costUsd: 3,
      coverage: {
        usage: {
          state: "partial",
          reasons: ["provider_attempt_usage_unattributed"],
        },
        usageBuckets: {
          input: {
            state: "partial",
            reasons: ["provider_attempt_usage_unattributed"],
          },
          output: {
            state: "partial",
            reasons: ["provider_attempt_usage_unattributed"],
          },
          cacheRead: {
            state: "partial",
            reasons: ["provider_attempt_usage_unattributed"],
          },
          cacheWrite: {
            state: "partial",
            reasons: ["provider_attempt_usage_unattributed"],
          },
          reasoningTokens: {
            state: "partial",
            reasons: ["provider_attempt_usage_unattributed"],
          },
          total: {
            state: "partial",
            reasons: ["provider_attempt_usage_unattributed"],
          },
        },
        cost: {
          state: "partial",
          reasons: ["provider_attempt_usage_unattributed"],
        },
      },
    });
  });

  it("keeps usage exact for one physical attempt", async () => {
    const snapshot = await runWithAgentCommandAccounting(async (accounting) => {
      startCall("call-single-attempt");
      emitAttempt({
        eventId: "attempt-single",
        callId: "call-single-attempt",
        ordinal: 1,
        reason: "initial",
        outcome: "completed",
      });
      observeProviderTransportLogicalCallSettled("call-single-attempt", "completed");
      observeProviderTransportLogicalCallFinalized("call-single-attempt");
      recordPricedUsage(accounting);
      return accounting.project();
    });

    expectExactUsageAndCost(snapshot);
  });

  it("keeps usage exact after zero submission then one dispatch", async () => {
    const snapshot = await runWithAgentCommandAccounting(async (accounting) => {
      startCall("call-preflight-recovery");
      getAiTransportHost().observeModelTransportEvent({
        type: "submission",
        eventId: "submission-preflight-recovery",
        callId: "call-preflight-recovery",
        ...OPENAI_ROUTE,
        transport: "http",
        total: 0,
        outcome: "failed",
        reason: "failed_before_submission",
      });
      emitAttempt({
        eventId: "attempt-preflight-recovery",
        callId: "call-preflight-recovery",
        ordinal: 1,
        reason: "retry",
        outcome: "completed",
      });
      observeProviderTransportLogicalCallSettled("call-preflight-recovery", "completed");
      observeProviderTransportLogicalCallFinalized("call-preflight-recovery");
      recordPricedUsage(accounting);
      return accounting.project();
    });

    expectExactUsageAndCost(snapshot);
  });

  it("does not conflate reused public call ids with retries", async () => {
    const snapshot = await runWithAgentCommandAccounting(async (accounting) => {
      startCall("call-reused");
      emitAttempt({
        eventId: "attempt-reused-1",
        callId: "call-reused",
        ordinal: 1,
        reason: "initial",
        outcome: "completed",
      });
      observeProviderTransportLogicalCallSettled("call-reused", "completed");
      observeProviderTransportLogicalCallFinalized("call-reused");

      startCall("call-reused");
      emitAttempt({
        eventId: "attempt-reused-2",
        callId: "call-reused",
        ordinal: 1,
        reason: "initial",
        outcome: "completed",
      });
      observeProviderTransportLogicalCallSettled("call-reused", "completed");
      observeProviderTransportLogicalCallFinalized("call-reused");
      recordPricedUsage(accounting);
      return accounting.project();
    });

    expectExactUsageAndCost(snapshot);
  });
});
