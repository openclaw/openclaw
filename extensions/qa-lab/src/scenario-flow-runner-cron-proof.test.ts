import assert from "node:assert/strict";
import { syncBuiltinESMExports } from "node:module";
import timersPromises from "node:timers/promises";
import { promisify } from "node:util";
import { buildAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nestedToolHistoryFixture } from "../test/nested-tool-activity-fixture.js";
import { createQaBusState } from "./bus-state.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";
import { waitForAgentHistory } from "./suite-runtime-agent-process.js";

const now = Date.parse("2026-09-28T12:00:00.000Z");
const suffix = "00000000";
type HistoryShape = "direct" | "nested";
type Job = {
  id: string;
  name: string;
  schedule: { kind: string; at?: string; everyMs?: number };
  payload: { kind: string; message: string; toolsAllow?: string[] };
  sessionTarget: string;
  delivery: { mode: string };
  enabled: boolean;
  deleteAfterRun?: boolean;
  state: { nextRunAtMs: number };
};
type ToolCall = { action: string; job?: Job; jobId?: string; includeDisabled?: boolean };

function historyMessages(
  calls: ToolCall[],
  shape: HistoryShape,
  errorCallIndexes: readonly number[] = [],
) {
  const messages = calls.flatMap<Record<string, unknown>>((input, index) => {
    const id = `automation-${index}`;
    if (shape === "nested") {
      return [
        nestedToolHistoryFixture({
          toolName: "automations",
          toolCallId: id,
          input,
          text: JSON.stringify(input.job ? { id: input.job.id } : { ok: true }),
          isError: errorCallIndexes.includes(index),
        }),
      ];
    }
    return [
      {
        role: "assistant",
        content: [{ type: "toolCall", id, name: "automations", arguments: input }],
      },
    ];
  });
  if (shape === "nested") {
    messages.unshift({
      role: "assistant",
      content: [
        { type: "toolCall", id: "exec-qa", name: "exec", arguments: { code: "automations" } },
      ],
    });
  }
  return messages;
}

function job(name: string, index: number): Job {
  return {
    id: `job-${index}`,
    name,
    schedule: { kind: "every", everyMs: 3_600_000 },
    payload: { kind: "agentTurn", message: "", toolsAllow: ["*"] },
    sessionTarget: "isolated",
    delivery: { mode: "none" },
    enabled: false,
    state: { nextRunAtMs: now + 20_000 },
  };
}

async function runSchedulingFixture(
  kind: "authority" | "recurring",
  shape: HistoryShape,
  options: {
    historyError?: Error;
    persistentHistoryError?: boolean;
    onHistoryRead?: () => void;
    initialHistoryCallCount?: number;
    mutateCalls?: (calls: ToolCall[]) => void;
    errorCallIndexes?: readonly number[];
    mutateJobs?: (jobs: Job[]) => void;
    mutateRestartedJobs?: (jobs: Job[]) => void;
    oneShotRunCount?: number;
  } = {},
) {
  const state = createQaBusState();
  const jobs =
    kind === "authority"
      ? ["omitted", "wildcard", "overbroad", "empty"].map((policy, index) => {
          const entry = job(`qa-authority-${policy}-${suffix}`, index);
          entry.payload.message = `${policy} authority`;
          if (index < 2) {
            entry.schedule = { kind: "at", at: new Date(now + 86_400_000).toISOString() };
          } else {
            entry.payload.toolsAllow = index === 2 ? ["read", "skills_read"] : [];
          }
          return entry;
        })
      : ["at", "every"].map((schedule, index) => {
          const entry = job(`qa-model-${schedule}-${suffix}`, index);
          entry.enabled = true;
          entry.schedule =
            index === 0
              ? { kind: "at", at: new Date(now + 240_000).toISOString() }
              : { kind: "every", everyMs: 20_000 };
          entry.deleteAfterRun = index === 0;
          entry.payload.message = `Reply exactly QA-MODEL-${schedule.toUpperCase()}-PAYLOAD-${suffix}`;
          return entry;
        });
  const calls: ToolCall[] = structuredClone(jobs).map((entry, index) => {
    if (kind === "recurring" || index === 0) {
      delete entry.payload.toolsAllow;
    } else {
      entry.payload.toolsAllow = index === 1 ? ["*"] : index === 2 ? ["read", "exec"] : [];
    }
    return { action: "add", job: entry };
  });
  options.mutateCalls?.(calls);
  options.mutateJobs?.(jobs);
  const history = historyMessages(calls, shape, options.errorCallIndexes);
  let restarted = false;
  let recurringReads = 0;
  let historyReads = 0;
  const removed: string[] = [];
  const call = vi.fn(async (method: string, params: { id?: string; sessionKey?: string }) => {
    if (method === "chat.history") {
      historyReads += 1;
      options.onHistoryRead?.();
      if (options.historyError && (historyReads === 1 || options.persistentHistoryError)) {
        throw options.historyError;
      }
      expect(params.sessionKey).toBe(
        kind === "authority"
          ? "agent:qa:qa-channel:group:group:qa-cron-authority"
          : `agent:qa:qa-channel:direct:dm:cron-model-author-${suffix}`,
      );
      return {
        messages:
          historyReads === 1 && options.initialHistoryCallCount !== undefined
            ? historyMessages(calls.slice(0, options.initialHistoryCallCount), shape)
            : history,
      };
    }
    if (method === "sessions.list") {
      return {
        sessions: [
          { key: "agent:qa:qa-channel:group:group:qa-cron-authority", hasActiveRun: false },
        ],
      };
    }
    if (method === "cron.list") {
      const visible = structuredClone(jobs);
      if (restarted && kind === "recurring") {
        visible.splice(0, 1);
        assert.ok(visible[0]);
        visible[0].state.nextRunAtMs = now + 100_000;
      }
      if (restarted) {
        options.mutateRestartedJobs?.(visible);
      }
      return { jobs: [...visible, job("background-maintenance", 99)] };
    }
    if (method === "cron.runs") {
      if (params.id === "job-0") {
        return {
          entries: Array.from({ length: options.oneShotRunCount ?? 1 }, (_, index) => ({
            jobId: "job-0",
            ts: now + index + 1,
            status: "ok",
          })),
        };
      }
      expect(params.id).toBe("job-1");
      recurringReads += 1;
      return {
        entries: [
          { jobId: "job-1", ts: now + 2, status: "ok" },
          { jobId: "job-1", ts: now + 3, status: "ok" },
          ...(recurringReads >= 3 ? [{ jobId: "job-1", ts: now + 4, status: "ok" }] : []),
        ],
      };
    }
    if (method === "cron.remove") {
      removed.push(params.id!);
      return { removed: true };
    }
    throw new Error(`unexpected fixture Gateway method: ${method}`);
  });
  // Gateway responses are inputs to the YAML verifier, not scheduler/authority product proof.
  const pending = runLoadedScenarioFlow(
    kind === "authority"
      ? "cron-model-created-explicit-authority"
      : "cron-model-created-one-shot-recurring",
    {
      state,
      onWaitForOutboundMessage: () => {
        state.addOutboundMessage({
          accountId: "qa-channel",
          to: `dm:cron-model-author-${suffix}`,
          text: "CRON-MODEL-AUTHOR-OK",
          toolCalls: [
            ...calls.map((arguments_) => ({ name: "automations", arguments: arguments_ })),
            ...(shape === "nested" ? [{ name: "exec", arguments: { code: "automations" } }] : []),
          ],
        });
      },
      api: {
        waitForAgentHistory,
        buildAgentSessionKey,
        env: {
          providerMode: "live-frontier",
          cfg: { session: { dmScope: "per-channel-peer" } },
          gateway: {
            call,
            baseUrl: "http://127.0.0.1:19001",
            restartAfterStateMutation: async (mutate: (ctx: unknown) => Promise<unknown>) => {
              await mutate({});
              restarted = true;
            },
          },
        },
        waitForCronRunCompletion: async (params: { jobId: string }) => {
          expect(params.jobId).toBe("job-0");
          return { jobId: "job-0", ts: now + 1, status: "ok" };
        },
      },
    },
  );
  const result = pending.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await vi.runAllTimersAsync();
  const outcome = await result;
  if ("error" in outcome) {
    throw outcome.error;
  }
  return { result: outcome.value, restarted, removed, historyReads };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.spyOn(timersPromises, "setTimeout").mockImplementation(promisify(setTimeout));
  syncBuiltinESMExports();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  syncBuiltinESMExports();
});

describe("scheduling YAML canonical tool proof", () => {
  it("admits canonical history after a typed transient storage failure", async () => {
    const historyError = Object.assign(new Error("session history admission unavailable"), {
      gatewayCode: "UNAVAILABLE",
      retryable: true,
      retryAfterMs: 250,
      details: { method: "chat.history" },
    });
    const { result, historyReads } = await runSchedulingFixture("authority", "nested", {
      historyError: new Error("gateway call failed", { cause: historyError }),
    });
    expect(result.status).toBe("pass");
    expect(historyReads).toBeGreaterThan(1);
    expect(Date.now()).toBe(now + 250);
  });
  it("accepts read-derived skill authority without admitting unrelated tools", async () => {
    const { result, restarted, removed } = await runSchedulingFixture("authority", "nested", {
      mutateJobs: (jobs) => {
        const overbroad = jobs[2];
        assert.ok(overbroad);
        overbroad.payload.toolsAllow = ["skills_read", "read"];
      },
    });
    expect(result.status).toBe("pass");
    expect(restarted).toBe(true);
    expect(removed).toEqual(["job-0", "job-1", "job-2", "job-3"]);
  });

  it.each(["authority", "recurring"] as const)(
    "ignores a rejected %s add attempt before successful mutations",
    async (kind) => {
      const { result, restarted, removed } = await runSchedulingFixture(kind, "nested", {
        mutateCalls: (calls) => {
          assert.ok(calls[0]);
          calls.unshift(structuredClone(calls[0]));
        },
        errorCallIndexes: [0],
      });
      expect(result.status).toBe("pass");
      expect(restarted).toBe(true);
      expect(removed).toEqual(
        kind === "authority" ? ["job-0", "job-1", "job-2", "job-3"] : ["job-1"],
      );
    },
  );

  it.each(["direct", "nested"] as const)(
    "allows %s read-only introspection around two adds",
    async (shape) => {
      const { result, restarted, removed } = await runSchedulingFixture("recurring", shape, {
        mutateCalls: (calls) => {
          calls.unshift({ action: "list", includeDisabled: true });
          calls.push(...["status", "get", "runs"].map((action) => ({ action, jobId: "job-0" })));
        },
      });
      expect(result.status).toBe("pass");
      expect(restarted).toBe(true);
      expect(removed).toEqual(["job-1"]);
    },
  );

  it.each(["direct", "nested"] as const)(
    "waits for the second add after list plus the first add in %s history",
    async (shape) => {
      const { result, historyReads } = await runSchedulingFixture("recurring", shape, {
        mutateCalls: (calls) => calls.unshift({ action: "list", includeDisabled: true }),
        initialHistoryCallCount: 2,
      });
      expect(result.status).toBe("pass");
      expect(historyReads).toBe(2);
      expect(Date.now()).toBe(now + 250);
    },
  );

  it("rejects an unrequested mutation alongside read-only introspection and two adds", async () => {
    await expect(
      runSchedulingFixture("recurring", "nested", {
        mutateCalls: (calls) => {
          calls.unshift({ action: "list", includeDisabled: true });
          calls.push({ action: "run", jobId: "job-0" });
        },
      }),
    ).rejects.toThrow(/expected exactly two/);
  });

  it.each([
    { code: "UNAVAILABLE", retryable: false, method: "chat.history" },
    { code: "INVALID_REQUEST", retryable: true, method: "chat.history" },
    { code: "UNAVAILABLE", retryable: true, method: undefined },
  ])("propagates history error $code/$retryable/$method without retry", async (input) => {
    const historyError = Object.assign(new Error("fixture history failure"), {
      gatewayCode: input.code,
      retryable: input.retryable,
      details: { method: input.method },
    });
    const onHistoryRead = vi.fn();
    await expect(
      runSchedulingFixture("authority", "direct", { historyError, onHistoryRead }),
    ).rejects.toBe(historyError);
    expect(onHistoryRead).toHaveBeenCalledTimes(1);
    expect(Date.now()).toBe(now);
  });

  it("keeps the existing admission deadline and final typed error when storage stays unavailable", async () => {
    const historyError = Object.assign(new Error("persistent history admission failure"), {
      gatewayCode: "UNAVAILABLE",
      retryable: true,
      retryAfterMs: 250,
      details: { method: "chat.history" },
    });
    const onHistoryRead = () => {
      expect(Date.now()).toBeLessThan(now + 240_000);
    };
    await expect(
      runSchedulingFixture("authority", "direct", {
        historyError,
        persistentHistoryError: true,
        onHistoryRead,
      }),
    ).rejects.toMatchObject({ message: "timed out after 240000ms", cause: historyError });
    expect(Date.now()).toBe(now + 240_000);
  });

  it.each([
    ["omitted", 0, ["automations", "read"], /omitted policy/],
    ["wildcard", 1, ["automations", "read"], /wildcard policy/],
    ["overbroad", 2, ["read", "skills_read", "exec"], /overbroad policy/],
    ["overbroad duplicate", 2, ["read", "skills_read", "skills_read"], /overbroad policy/],
    ["empty", 3, ["read"], /empty policy/],
  ] as const)("rejects incorrect persisted %s authority", async (_label, index, tools, message) => {
    await expect(
      runSchedulingFixture("authority", "nested", {
        mutateJobs: (jobs) => {
          const target = jobs[index];
          assert.ok(target);
          target.payload.toolsAllow = [...tools];
        },
      }),
    ).rejects.toThrow(message);
  });

  it.each(["authority", "recurring"] as const)("rejects extra %s add calls", async (kind) => {
    await expect(
      runSchedulingFixture(kind, "nested", {
        mutateCalls: (calls) => {
          assert.ok(calls[0]);
          calls.push(structuredClone(calls[0]));
          if (kind === "recurring") {
            calls.unshift({ action: "list", includeDisabled: true });
          }
        },
      }),
    ).rejects.toThrow(/expected exactly (four|two)/);
  });

  it.each(["authority", "recurring"] as const)("rejects a non-add %s action", async (kind) => {
    await expect(
      runSchedulingFixture(kind, "direct", {
        mutateCalls: (calls) => {
          assert.ok(calls[0]);
          calls[0].action = "run";
        },
      }),
    ).rejects.toThrow(/(omitted-policy|exactly two)/);
  });

  it.each([
    [
      "schedule",
      (jobs: Job[]) => {
        assert.ok(jobs[0]);
        jobs[0].schedule.at = new Date(now + 1).toISOString();
      },
      /schedule/,
    ],
    [
      "payload",
      (jobs: Job[]) => {
        assert.ok(jobs[0]);
        jobs[0].payload.message = "wrong payload";
      },
      /payload/,
    ],
  ] as const)("rejects a persisted one-shot %s mismatch", async (_label, mutateJobs, message) => {
    await expect(runSchedulingFixture("recurring", "nested", { mutateJobs })).rejects.toThrow(
      message,
    );
  });

  it.each(["authority", "recurring"] as const)(
    "rejects changed permissions across restart in the %s flow",
    async (kind) => {
      await expect(
        runSchedulingFixture(kind, "nested", {
          mutateRestartedJobs: (jobs) => {
            assert.ok(jobs[0]);
            jobs[0].payload.toolsAllow = ["read"];
          },
        }),
      ).rejects.toThrow(/authority changed across restart/);
    },
  );

  it("rejects a recurring job with a different identity after restart", async () => {
    await expect(
      runSchedulingFixture("recurring", "nested", {
        mutateRestartedJobs: (jobs) => {
          assert.ok(jobs[0]);
          jobs[0].id = "replacement-job";
        },
      }),
    ).rejects.toThrow(/recurring job did not remain scheduled/);
  });

  it("rejects a replayed one-shot job with a new identity", async () => {
    await expect(
      runSchedulingFixture("recurring", "nested", {
        mutateRestartedJobs: (jobs) => {
          jobs.push(job(`qa-model-at-${suffix}`, 98));
        },
      }),
    ).rejects.toThrow(/unexpected scenario cron jobs/);
  });

  it("rejects a recurring job whose next execution does not advance", async () => {
    await expect(
      runSchedulingFixture("recurring", "nested", {
        mutateRestartedJobs: (jobs) => {
          assert.ok(jobs[0]);
          jobs[0].state.nextRunAtMs = now + 20_000;
        },
      }),
    ).rejects.toThrow(/recurring next run did not advance/);
  });

  it("rejects a duplicate natural one-shot execution after restart", async () => {
    await expect(
      runSchedulingFixture("recurring", "nested", { oneShotRunCount: 2 }),
    ).rejects.toThrow(/expected exactly one one-off run/);
  });
});
