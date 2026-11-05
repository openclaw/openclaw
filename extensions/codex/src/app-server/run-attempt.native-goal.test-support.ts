import type { AgentHarnessNativeGoal } from "openclaw/plugin-sdk/agent-harness-runtime";
import { expect, vi } from "vitest";
import { createCodexTestHostCapabilities } from "./host-capability.test-support.js";
import { isJsonObject, type CodexThreadGoal } from "./protocol.js";
import {
  createStartedThreadHarness,
  createTestParams,
  runCodexAppServerAttempt,
} from "./run-attempt-test-harness.js";

export function createNativeGoalFixture(
  initial: CodexThreadGoal | null = null,
  respond: Parameters<typeof createStartedThreadHarness>[0] = async () => undefined,
  harnessOptions: Parameters<typeof createStartedThreadHarness>[1] = {},
) {
  let stored = initial;
  let goalAtTurnStart: CodexThreadGoal | null | undefined;
  const updates: Array<{ status: string; reason?: string }> = [];
  const revocation = new AbortController();
  const capability: AgentHarnessNativeGoal = {
    version: 1,
    id: "host-goal",
    objective: "Finish the fixture goal",
    signal: revocation.signal,
    assertCurrent: vi.fn(() => revocation.signal.throwIfAborted()),
    onStatus: async (update) => {
      updates.push(update);
    },
  };
  const harness = createStartedThreadHarness(async (method, params, options) => {
    if (method === "turn/start") {
      goalAtTurnStart = stored;
    }
    const response = await respond(method, params, options);
    if (response !== undefined) {
      return response;
    }
    if (method === "mcpServerStatus/list") {
      return { data: [], nextCursor: null };
    }
    if (method === "thread/goal/get") {
      return { goal: stored };
    }
    if (method === "thread/goal/set") {
      if (!isJsonObject(params)) {
        throw new Error("Invalid fixture goal params");
      }
      const requestedStatus = params.status as CodexThreadGoal["status"];
      const tokenBudget = Object.hasOwn(params, "tokenBudget")
        ? (params.tokenBudget as number | null)
        : (stored?.tokenBudget ?? null);
      stored = {
        threadId: "thread-1",
        objective: capability.objective,
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: 1,
        updatedAt: 1,
        ...stored,
        ...(typeof params.objective === "string" ? { objective: params.objective } : {}),
        ...(Object.hasOwn(params, "tokenBudget")
          ? { tokenBudget: params.tokenBudget as number | null }
          : {}),
        // Official goals.rs preserves budgetLimited on Pause/Block even when
        // this same write increases or clears the cap. Only Active resumes it.
        status:
          stored?.status === "budgetLimited" &&
          (params.status === "paused" || params.status === "blocked")
            ? "budgetLimited"
            : requestedStatus === "active" &&
                tokenBudget !== null &&
                (stored?.tokensUsed ?? 0) >= tokenBudget
              ? "budgetLimited"
              : requestedStatus,
      };
      return { goal: stored };
    }
    return undefined;
  }, harnessOptions);
  const params = createTestParams();
  const { createToolSurfaceAsync: _createToolSurfaceAsync, ...host } = params.hostCapabilities;
  params.hostCapabilities = createCodexTestHostCapabilities({
    ...host,
    prepareNativeGoal: async () => capability,
  });
  const run = (options?: Parameters<typeof runCodexAppServerAttempt>[1]) =>
    runCodexAppServerAttempt(params, options);
  const started = async (attempt: ReturnType<typeof run>) => {
    // Startup rejection must fail the test, not strand a method-only waiter.
    await attempt.waitForTurnAccepted();
    await vi.waitFor(() => expect(updates).toContainEqual({ status: "active" }));
  };
  const finish = async (status: CodexThreadGoal["status"] = "complete") => {
    if (!stored) {
      throw new Error("No fixture goal");
    }
    stored = { ...stored, status };
    await harness.notify({
      method: "thread/goal/updated",
      params: { threadId: "thread-1", goal: stored },
    });
  };
  return {
    harness,
    params,
    run,
    updates,
    started,
    finish,
    capability,
    revocation,
    readStoredGoal: () => stored,
    readGoalAtTurnStart: () => goalAtTurnStart,
  };
}
