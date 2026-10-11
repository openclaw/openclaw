import assert from "node:assert/strict";
import { syncBuiltinESMExports } from "node:module";
import timersPromises from "node:timers/promises";
import { promisify } from "node:util";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitForQaTransportCondition } from "./qa-transport.js";
import { readQaScenarioById } from "./scenario-catalog.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";

const monitor = {
  id: "qa-monitor",
  agentId: "qa",
  payload: { kind: "heartbeat" },
  declarationKey: "heartbeat:qa",
  enabled: true,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.spyOn(timersPromises, "setTimeout").mockImplementation(promisify(setTimeout));
  syncBuiltinESMExports();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  syncBuiltinESMExports();
});

async function runStartup(listJobs: () => readonly unknown[]) {
  const scenario = readQaScenarioById("heartbeat-shared-runtime-live-contract");
  const step = scenario.execution.flow?.steps[0];
  assert.ok(step);
  const phaseIndex = step.actions.findIndex((action) => isRecord(action) && "forEach" in action);
  assert.ok(phaseIndex > 0);
  const call = vi.fn(async (method: string) => {
    assert.equal(method, "cron.list");
    return { jobs: listJobs() };
  });
  const pending = runLoadedScenarioFlow(scenario.id, {
    // Execute the shipped readiness actions; model/delivery phases stay in the live lane.
    flow: {
      steps: [
        {
          name: step.name,
          actions: step.actions.slice(0, phaseIndex),
          detailsExpr: "JSON.stringify(monitor)",
        },
      ],
    },
    api: {
      env: { providerMode: "live-frontier", gateway: { call } },
      waitForCondition: waitForQaTransportCondition,
    },
  }).then(
    (result) => ({ result, error: undefined }),
    (error: unknown) => ({ result: undefined, error }),
  );
  await vi.runAllTimersAsync();
  return { ...(await pending), call };
}

describe("heartbeat scenario scheduled-service startup convergence", () => {
  it.each([0, 750, 29_750])(
    "accepts the enabled monitor appearing after %i ms",
    async (delayMs) => {
      const { result, error, call } = await runStartup(() =>
        Date.now() >= delayMs ? [monitor] : [],
      );
      expect(error).toBeUndefined();
      expect(result?.status).toBe("pass");
      expect(result?.steps[0]?.details).toBe(JSON.stringify(monitor));
      expect(Date.now()).toBe(delayMs);
      expect(call.mock.calls.length).toBe(delayMs / 250 + 1);
    },
  );

  it.each([
    ["absent", []],
    ["wrong agent", [{ ...monitor, agentId: "other" }]],
    ["wrong payload", [{ ...monitor, payload: { kind: "agentTurn" } }]],
    ["wrong declaration", [{ ...monitor, declarationKey: "heartbeat:other" }]],
    ["disabled", [{ ...monitor, enabled: false }]],
    ["missing identity", [{ ...monitor, id: "" }]],
  ] as const)("fails within the readiness budget when the monitor is %s", async (_label, jobs) => {
    const { result, error, call } = await runStartup(() => jobs);
    expect(result).toBeUndefined();
    expect(String(error)).toContain("timed out after 30000ms");
    expect(Date.now()).toBe(30_000);
    expect(call).toHaveBeenCalledTimes(120);
  });
});
