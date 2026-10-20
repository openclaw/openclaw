// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useSubagentControlFixture } from "./subagent-control.test-support.js";
import { afterEach, beforeEach, expect, it, vi, type Mock } from "vitest";
import { captureRuntimeConfigAsyncReader, getRuntimeConfig } from "../../../config/config.js";
import { resolveSessionStorePathCore } from "../../../config/sessions.js";
import { upsertSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import { abortControlledSubagents } from "../../../gateway/server-methods/chat-abort-descendants.js";
import { emitAgentEvent } from "../../../infra/agent-events.js";
import { resetSystemEventsForTest } from "../../../infra/system-events.js";
import { prepareAgentRunTerminalReply } from "../../agent-run-terminal-reply.js";
import {
  clearTestEmbeddedRun as detachRun,
  registerTestEmbeddedRun as attachRun,
  createEmbeddedRunHandle,
} from "../../embedded-agent-runner/runs.test-support.js";
import {
  setSubagentAnnounceDeliveryDepsForTest,
  type SubagentAnnounceDeliveryTestDeps,
} from "../announce/subagent-announce-overrides.test-support.js";
import { killSessionSubagentRuns } from "./subagent-control-kill.js";
import { adoptSubagentProgressDraft } from "./subagent-progress-draft.js";
import {
  childKey,
  requesterKey,
  useSubagentProgressCohort,
} from "./subagent-progress-draft.test-support.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { adoptPausedSubagentRunForFollowUp } from "./subagent-registry.js";
import { testing as registryTesting } from "./subagent-registry.test-helpers.js";

const fixture = useSubagentControlFixture();
beforeEach(async () => {
  await captureRuntimeConfigAsyncReader()();
});
const yieldCohort = useSubagentProgressCohort(fixture);

const CHILD_RESULT = "Private child result marker.";
const DONE = "Done.";
const stops = { killSessionSubagentRuns, abortControlledSubagents };

type Dispatch = SubagentAnnounceDeliveryTestDeps["dispatchGatewayMethodInProcess"];
type DispatchParams = Parameters<Dispatch>[1];

afterEach(() => {
  setSubagentAnnounceDeliveryDepsForTest();
  resetSystemEventsForTest();
});

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
    const terminal = prepareAgentRunTerminalReply({ rawText: replies[wakes.length - 1] ?? "" });
    return {
      status: "ok",
      inputProcessingCompleted: true,
      result: {
        payloads: terminal.text ? [{ text: terminal.text }] : [],
        meta: { terminalReply: terminal.terminalReply },
        ...(terminal.terminalReply.disposition === "silent" && {
          deliveryStatus: {
            status: "suppressed",
            succeeded: true,
            reason: "no_visible_payload",
            resultCount: 0,
          },
        }),
      },
    } as T;
  };
  setSubagentAnnounceDeliveryDepsForTest({ dispatchGatewayMethodInProcess: dispatch });
  return wakes;
}

type TestDraft = { push: Mock; retire: Mock };
const newDraft = (): TestDraft => ({ push: vi.fn(), retire: vi.fn() });

async function adoptCohort(children = ["a", "b"], origin?: Parameters<typeof yieldCohort>[2]) {
  const spawns = await yieldCohort("parent-turn", children, origin);
  const draft = newDraft();
  expect(adoptSubagentProgressDraft(spawns, draft)).toBe(true);
  return draft;
}

const stopParams = () => ({ cfg: getRuntimeConfig(), sessionKey: requesterKey, agentId: "main" });
const storePath = () =>
  resolveSessionStorePathCore(getRuntimeConfig().session?.store, { agentId: "main" });

function expectCard(draft: TestDraft, retireCount = 1) {
  expect(draft.retire).toHaveBeenCalledTimes(retireCount);
  expect(JSON.stringify(draft.push.mock.calls)).not.toContain(CHILD_RESULT);
}

it.each([
  ["a visible answer", [DONE], true],
  ["intentional external silence", ["NO_REPLY"], true],
  ["required internal result", ["NO_REPLY"], false],
] as const)("settles the progress card according to %s", async (name, replies, retired) => {
  const requesterOrigin =
    name === "intentional external silence"
      ? { channel: "telegram", to: "12345", accountId: "default" }
      : undefined;
  if (requesterOrigin) {
    const { channel, to, accountId } = requesterOrigin;
    await upsertSessionEntryCore(
      { storePath: storePath(), sessionKey: requesterKey },
      {
        delivery: {
          kind: "external",
          route: { channel, accountId, target: { to } },
          context: requesterOrigin,
          origin: { provider: channel, to, accountId },
        },
      },
    );
  }
  const draft = await adoptCohort(["a", "b"], requesterOrigin);
  const wakes = answerWakes(draft, replies);

  await endRun("a");
  expect(wakes).toEqual([]);
  expect(draft.retire).not.toHaveBeenCalled();

  await endRun("b");
  expect(wakes.map(({ retiredBefore }) => retiredBefore)).toEqual(replies.map(() => 0));
  expectCard(draft, retired ? 1 : 0);
  expect(draft.push).toHaveBeenCalledWith(
    expect.objectContaining({ itemId: "b", kind: "subagent", status: "completed" }),
  );
});

it("rejects a delivered cohort without any prior card", async () => {
  const spawns = await yieldCohort("parent-turn", ["a", "b"]);
  answerWakes(newDraft(), [DONE]);
  await endRun("a");
  await endRun("b");
  expect(subagentRuns.get("b")?.requesterSettleWake).toBeUndefined();
  const stale = newDraft();
  expect(adoptSubagentProgressDraft(spawns, stale)).toBe(false);
  expect(stale.push).not.toHaveBeenCalled();
});

it.each(["visible result", "exhausted"] as const)(
  "recovers a known missing required result through periodic admission: %s",
  async (outcome) => {
    const draft = await adoptCohort(["a"]);
    const wakes = answerWakes(draft, [
      "NO_REPLY",
      outcome === "visible result" ? DONE : "NO_REPLY",
      "NO_REPLY",
    ]);
    await endRun("a");
    expect(wakes).toHaveLength(1);
    expect(draft.retire).not.toHaveBeenCalled();
    expect(subagentRuns.get("a")?.requesterSettleWake).toMatchObject({
      status: "pending",
      attemptCount: 1,
    });
    await registryTesting.sweepOnceForTests();
    await fixture.settle();
    expect(wakes).toHaveLength(1);

    using clock = vi.spyOn(Date, "now");
    for (let attempt = 1; attempt < (outcome === "visible result" ? 2 : 3); attempt++) {
      const due = subagentRuns.get("a")?.requesterSettleWake?.nextAttemptAt;
      expect(due).toBeTypeOf("number");
      clock.mockReturnValue(due!);
      await registryTesting.sweepOnceForTests();
      await fixture.settle();
      expect(wakes).toHaveLength(attempt + 1);
      expect(wakes[attempt]?.runId).toBe(`${wakes[0]!.runId}:retry-${attempt}`);
    }
    expect(draft.retire).toHaveBeenCalledOnce();
    expect(subagentRuns.get("a")?.requesterSettleWake).toBeUndefined();
    await registryTesting.sweepOnceForTests();
    await fixture.settle();
    expect(wakes).toHaveLength(outcome === "visible result" ? 2 : 3);
  },
);

it.each([
  ["killSessionSubagentRuns", "running", "committed"],
  ["abortControlledSubagents", "completed", "committed"],
  ["killSessionSubagentRuns", "running", "rejected"],
  ["abortControlledSubagents", "completed", "rejected"],
] as const)(
  "retires the card only when %s commits stop of a completed and a %s child (%s)",
  async (stop, sibling, write) => {
    const draft = await adoptCohort();
    // Completed children still owe their pending requester wake when Stop arrives.
    fixture.wake.mockResolvedValue(false);
    await endRun("a");
    if (sibling === "completed") {
      await endRun("b");
    }
    expect(subagentRuns.get("a")?.requesterSettleWake?.status).toBe("pending");
    if (write === "rejected") {
      fixture.rejectRegistryWrites(
        (row) => Boolean(row.killIntent) || row.suppressCompletionDelivery === true,
        "stop write rejected",
      );
    }

    const result = await stops[stop](stopParams());
    await fixture.settle();

    expect(result?.status).toBe(write === "rejected" ? "error" : "ok");
    expectCard(draft, write === "rejected" ? 0 : 1);
  },
);

it("keeps the card until an uninterruptible child finishes", async () => {
  const draft = await adoptCohort(["a"]);
  const handle = createEmbeddedRunHandle({ runId: "a", isAbortable: false });
  attachRun("a-session", handle, childKey("a"), undefined, "main", undefined, undefined, {
    storeScope: storePath(),
  });
  try {
    await killSessionSubagentRuns(stopParams());
    await fixture.settle();

    const child = subagentRuns.get("a");
    expect(child).toMatchObject({ killIntent: undefined, execution: { status: "running" } });
    expect(child?.requesterSettleWake).toBeDefined();
    expect(draft.retire).not.toHaveBeenCalled();
  } finally {
    detachRun("a-session", handle, childKey("a"));
  }
  answerWakes(draft, [DONE]);
  await endRun("a");
  expect(draft.retire).toHaveBeenCalledOnce();
});

it("follows replacement execution until it settles", async () => {
  const draft = await adoptCohort();
  const wakes = answerWakes(draft, [DONE]);

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
  expectCard(draft);
});

it("keeps the card through requester re-yield", async () => {
  const draft = await adoptCohort();
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
  expectCard(draft);
});
