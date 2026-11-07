import type { AgentHarnessNativeGoal } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexAppServerClient } from "./client.js";
import type { CodexThreadGoal } from "./protocol.js";

/** Read before resume: Codex restores and starts active goals during thread/resume. */
export async function prepareCodexNativeGoalResume(
  client: CodexAppServerClient,
  threadId: string,
  goal: AgentHarnessNativeGoal,
  assertCurrent: () => void,
  signal?: AbortSignal,
) {
  const assertGoalCurrent = () => {
    assertCurrent();
    goal.assertCurrent();
  };
  const existing = await client.request(
    "thread/goal/get",
    { threadId },
    { signal, assertCurrent: assertGoalCurrent },
  );
  assertCodexNativeGoalMatches(existing.goal, goal);
  if (existing.goal?.status === "active") {
    await client.request(
      "thread/goal/set",
      { threadId, status: "paused", origin: "automatic" },
      { signal, assertCurrent: assertGoalCurrent },
    );
  }
  return existing.goal;
}

export function assertCodexNativeGoalMatches(
  existing: CodexThreadGoal | null,
  goal: Pick<AgentHarnessNativeGoal, "objective">,
) {
  if (!goal.objective.trim()) {
    throw new Error("Native Codex goal objective must not be empty");
  }
  // Codex exposes no client goal id. The exact bound thread and objective are
  // the available native identity; never replace a different persisted goal.
  if (existing && existing.objective !== goal.objective.trim()) {
    throw new Error("The bound Codex thread has a different native goal; it was not replaced");
  }
}

/** Reconcile host remaining allowance with native lifetime accounting while paused. */
export async function reconcileCodexNativeGoalBudget(
  client: CodexAppServerClient,
  threadId: string,
  goal: AgentHarnessNativeGoal,
  existing: CodexThreadGoal | null,
  assertCurrent: () => void,
  signal: AbortSignal,
): Promise<CodexThreadGoal> {
  assertCodexNativeGoalMatches(existing, goal);
  const used = existing?.tokensUsed ?? 0;
  const remaining = goal.tokenBudget;
  const budget = remaining === undefined ? null : used + remaining;
  if (
    !Number.isSafeInteger(used) ||
    used < 0 ||
    (remaining !== undefined && (!Number.isSafeInteger(remaining) || remaining <= 0)) ||
    (budget !== null && !Number.isSafeInteger(budget))
  ) {
    throw new Error("Native Codex goal allowance cannot be represented exactly");
  }
  await client.request(
    "thread/goal/set",
    {
      threadId,
      ...(!existing ? { objective: goal.objective } : {}),
      status: "paused",
      origin: "automatic",
      // Omission means Keep upstream; null explicitly requests unlimited.
      tokenBudget: budget,
    },
    { assertCurrent, signal },
  );
  const { goal: accepted } = await client.request(
    "thread/goal/get",
    { threadId },
    { assertCurrent, signal },
  );
  assertCurrent();
  signal.throwIfAborted();
  assertCodexNativeGoalMatches(accepted, goal);
  // Managed caps can clamp unlimited to a finite value. Do not silently accept
  // a different allowance, nor reset native counters to work around that cap.
  if (
    !accepted ||
    // Codex goals.rs keeps budgetLimited sticky on Pause/Block, including a
    // simultaneous cap increase/clear. This is still non-runnable; activate only
    // after the caller's initial turn has been admitted.
    (accepted.status !== "paused" &&
      !(existing?.status === "budgetLimited" && accepted.status === "budgetLimited")) ||
    accepted.tokensUsed !== used ||
    accepted.tokenBudget !== budget
  ) {
    throw new Error(
      "Native Codex goal budget reconciliation was not accepted exactly (managed cap or accounting changed)",
    );
  }
  return accepted;
}
