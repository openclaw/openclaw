// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { runSubagentStateWorkerOperation, useSubagentControlFixture } from "./subagent-control.test-support.js";
import { afterEach, expect, it, vi, type Mock } from "vitest";
import { getRuntimeConfig } from "../../../config/config.js";
import { abortControlledSubagents } from "../../../gateway/server-methods/chat-abort-descendants.js";
import { emitAgentEvent } from "../../../infra/agent-events.js";
import { resetSystemEventsForTest } from "../../../infra/system-events.js";
import { isSubagentRegistryWriteCommand } from "../../subagent-test-fixtures.test-helpers.js";
import {
  setSubagentAnnounceDeliveryDepsForTest,
  type SubagentAnnounceDeliveryTestDeps,
} from "../announce/subagent-announce-overrides.test-support.js";
import { killSessionSubagentRuns } from "./subagent-control-kill.js";
import type * as ControlRuntime from "./subagent-control.runtime.js";
import { adoptSubagentProgressDraft } from "./subagent-progress-draft.js";
import {
  childKey,
  requesterKey,
  useSubagentProgressCohort,
} from "./subagent-progress-draft.test-support.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { adoptPausedSubagentRunForFollowUp } from "./subagent-registry.js";
import { rowToSubagentRunRecord } from "./subagent-registry.store.codec.js";
import { testing as registryTesting } from "./subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const fixture = useSubagentControlFixture();
const yieldCohort = useSubagentProgressCohort(fixture);

const runtime = vi.hoisted(() => ({ childRunStaysActive: false }));

vi.mock("./subagent-control.runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ControlRuntime>();
  return {
    ...actual,
    isEmbeddedAgentRunActive: (...args: Parameters<typeof actual.isEmbeddedAgentRunActive>) =>
      runtime.childRunStaysActive || actual.isEmbeddedAgentRunActive(...args),
  };
});

const CHILD_RESULT = "Private child result marker.";

type Dispatch = SubagentAnnounceDeliveryTestDeps["dispatchGatewayMethodInProcess"];
type DispatchParams = Parameters<Dispatch>[1];

afterEach(() => {
  setSubagentAnnounceDeliveryDepsForTest();
  resetSystemEventsForTest();
  runtime.childRunStaysActive = false;
});

function rejectRegistryWrites(reject: (row: SubagentRunRecord) => boolean, message: string) {
  fixture.worker.mockImplementation((context, operation, options) =>
    runSubagentStateWorkerOperation(
      context,
      (scope) =>
        operation({
          execute: async (command, executeOptions) => {
            if (
              isSubagentRegistryWriteCommand(command) &&
              command.input.values.some((value) => {
                const row = rowToSubagentRunRecord(value);
                return row !== null && reject(row);
              })
            ) {
              throw new Error(message);
            }
            return scope.execute(command, executeOptions);
          },
        }),
      options,
    ),
  );
}

async function endRun(runId: string, data: Record<string, unknown> = {}) {
  fixture.capture.mockResolvedValue(CHILD_RESULT);
  emitAgentEvent({
    runId,
    sessionKey: subagentRuns.get(runId)!.childSessionKey,
    stream: "lifecycle",
    data: {
      phase: "end",
      endedAt: Date.now(),
      terminalReply: { disposition: "visible", text: CHILD_RESULT },
      ...data,
    },
  });
  await fixture.settle();
}

/** Each requester wake turn answers with the next reply; `onWake` runs inside that turn. */
function answerWakes(
  draft: TestDraft,
  replies: readonly string[],
  onWake?: (params: DispatchParams) => Promise<void>,
) {
  const wakes: Array<{ runId: string; retiredBefore: number }> = [];
  const dispatch: Dispatch = async <T>(...args: Parameters<Dispatch>): Promise<T> => {
    const [, params, options] = args;
    wakes.push({
      runId: String(params?.idempotencyKey),
      retiredBefore: draft.retire.mock.calls.length,
    });
    options?.onExecutionStarted?.();
    if (wakes.length === 1) {
      await onWake?.(params);
    }
    return {
      status: "ok",
      inputProcessingCompleted: true,
      result: { payloads: [{ text: replies[wakes.length - 1] }], meta: {} },
    } as T;
  };
  setSubagentAnnounceDeliveryDepsForTest({ dispatchGatewayMethodInProcess: dispatch });
  return wakes;
}

type TestDraft = { push: Mock; retire: Mock };
const newDraft = (): TestDraft => ({ push: vi.fn(), retire: vi.fn() });

function expectNoChildResultPushed(draft: TestDraft) {
  expect(JSON.stringify(draft.push.mock.calls)).not.toContain(CHILD_RESULT);
}

it.each([
  ["a visible answer", ["The delegated work is done."]],
  ["a silent attempt and a visible retry", ["NO_REPLY", "The delegated work is done."]],
  ["exhausted silent attempts", ["NO_REPLY", "NO_REPLY", "NO_REPLY"]],
] as const)(
  "retires the card once, after the cohort's requester wake settles through %s",
  async (_name, replies) => {
    const spawns = await yieldCohort("parent-turn", ["a", "b"]);
    const draft = newDraft();
    expect(adoptSubagentProgressDraft(spawns, draft)).toBe(true);
    const wakes = answerWakes(draft, replies);

    await endRun("a");
    expect(wakes).toEqual([]);
    expect(draft.retire).not.toHaveBeenCalled();

    await endRun("b");
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      // A yielded requester owes a visible answer, so silence retries the same wake.
      for (const retryDelayMs of [30_000, 120_000].slice(0, replies.length - 1)) {
        expect(draft.retire).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(retryDelayMs);
        await registryTesting.sweepOnceForTests();
        await fixture.settle();
      }
    } finally {
      vi.useRealTimers();
    }
    expect(wakes.map(({ retiredBefore }) => retiredBefore)).toEqual(replies.map(() => 0));
    expect(draft.retire).toHaveBeenCalledOnce();
    expect(draft.push).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: "b", kind: "subagent", status: "completed" }),
    );
    expectNoChildResultPushed(draft);
  },
);

it("does not adopt a card for a cohort whose completion was already delivered", async () => {
  const spawns = await yieldCohort("parent-turn", ["a", "b"]);
  answerWakes(newDraft(), ["The delegated work is done."]);
  await endRun("a");
  await endRun("b");
  expect(subagentRuns.get("b")?.requesterSettleWake).toBeUndefined();

  const stale = newDraft();
  expect(adoptSubagentProgressDraft(spawns, stale)).toBe(false);
  expect(stale.push).not.toHaveBeenCalled();
});

it.each([
  ["killSessionSubagentRuns", "running", "committed"],
  ["abortControlledSubagents", "completed", "committed"],
  ["killSessionSubagentRuns", "running", "rejected"],
  ["abortControlledSubagents", "completed", "rejected"],
] as const)(
  "retires the card only when %s commits stop of a completed and a %s child (%s)",
  async (stop, sibling, write) => {
    const spawns = await yieldCohort("parent-turn", ["a", "b"]);
    const draft = newDraft();
    expect(adoptSubagentProgressDraft(spawns, draft)).toBe(true);
    // Completed children still owe their pending requester wake when Stop arrives.
    fixture.wake.mockResolvedValue(false);
    await endRun("a");
    if (sibling === "completed") {
      await endRun("b");
    }
    expect(subagentRuns.get("a")?.requesterSettleWake?.status).toBe("pending");
    if (write === "rejected") {
      rejectRegistryWrites(
        (row) => Boolean(row.killIntent) || row.suppressCompletionDelivery === true,
        "stop write rejected",
      );
    }

    const params = { cfg: getRuntimeConfig(), sessionKey: requesterKey, agentId: "main" };
    const result =
      stop === "killSessionSubagentRuns"
        ? await killSessionSubagentRuns(params)
        : await abortControlledSubagents(params);
    await fixture.settle();

    expect(result?.status).toBe(write === "rejected" ? "error" : "ok");
    if (write === "rejected") {
      expect(draft.retire).not.toHaveBeenCalled();
    } else {
      expect(draft.retire).toHaveBeenCalledOnce();
    }
    expectNoChildResultPushed(draft);
  },
);

it("keeps the card when stop cannot interrupt a child that is still finishing", async () => {
  const spawns = await yieldCohort("parent-turn", ["a"]);
  const draft = newDraft();
  expect(adoptSubagentProgressDraft(spawns, draft)).toBe(true);
  // The child's run stays active through the abort, so its kill claim is released.
  runtime.childRunStaysActive = true;

  await killSessionSubagentRuns({
    cfg: getRuntimeConfig(),
    sessionKey: requesterKey,
    agentId: "main",
  });
  await fixture.settle();

  const child = subagentRuns.get("a");
  expect(child?.killIntent).toBeUndefined();
  expect(child?.execution.status).toBe("running");
  expect(child?.requesterSettleWake).toBeDefined();
  expect(draft.retire).not.toHaveBeenCalled();
});

it("follows a child's resumed execution and retires after the replacement settles", async () => {
  const spawns = await yieldCohort("parent-turn", ["a", "b"]);
  const draft = newDraft();
  expect(adoptSubagentProgressDraft(spawns, draft)).toBe(true);
  const wakes = answerWakes(draft, ["The delegated work is done."]);

  // The child yields to its own children and is resumed as a new execution of the same task.
  await endRun("a", { yielded: true, terminalReply: undefined });
  expect(
    await adoptPausedSubagentRunForFollowUp({
      childSessionKey: childKey("a"),
      runId: "a-resumed",
      task: "Continue delegated a",
    }),
  ).toBe(true);
  await fixture.settle();
  expect(subagentRuns.get("a-resumed")?.taskRunId).toBe("a");
  expect(draft.retire).not.toHaveBeenCalled();

  for (const [runId, name] of [
    ["a", "replaced_exec"],
    ["a-resumed", "exec"],
  ] as const) {
    emitAgentEvent({ runId, stream: "item", data: { kind: "tool", name, status: "running" } });
  }
  expect(draft.push).toHaveBeenCalledWith({
    itemId: "a:tool",
    kind: "tool",
    name: "exec",
    phase: "update",
    status: "running",
  });
  expect(JSON.stringify(draft.push.mock.calls)).not.toContain("replaced_exec");

  await endRun("a-resumed");
  await endRun("b");
  expect(wakes).toEqual([{ runId: expect.any(String), retiredBefore: 0 }]);
  expect(draft.retire).toHaveBeenCalledOnce();
  expectNoChildResultPushed(draft);
});

it("keeps the card for the resumed requester's re-yield cohort until that cohort settles", async () => {
  const spawns = await yieldCohort("parent-turn", ["a", "b"]);
  const draft = newDraft();
  expect(adoptSubagentProgressDraft(spawns, draft)).toBe(true);
  const wakes = answerWakes(
    draft,
    ["Waiting for the follow-up checks.", "Everything is verified."],
    async (params) => {
      await yieldCohort(String(params?.idempotencyKey), ["c", "d"]);
    },
  );

  await endRun("a");
  await endRun("b");
  expect(wakes).toHaveLength(1);
  expect(draft.retire).not.toHaveBeenCalled();
  for (const itemId of ["c", "d"]) {
    expect(draft.push).toHaveBeenCalledWith(
      expect.objectContaining({ itemId, kind: "subagent", status: "running" }),
    );
  }

  await endRun("c");
  await endRun("d");
  expect(wakes).toHaveLength(2);
  expect(wakes[1]).toEqual({ runId: expect.any(String), retiredBefore: 0 });
  expect(wakes[1]!.runId).not.toBe(wakes[0]!.runId);
  expect(draft.retire).toHaveBeenCalledOnce();
  expectNoChildResultPushed(draft);
});
