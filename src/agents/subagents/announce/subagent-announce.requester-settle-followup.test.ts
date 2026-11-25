import "./subagent-announce.requester-settle-dispatch-mocks.test-support.js";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../config/runtime-snapshot.js";
import {
  SessionFollowupCompletion,
  readFollowupSuccessor,
} from "../completion/session-followup-completion.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import {
  createRequesterSettleContext as createContext,
  deliver,
  REQUESTER_KEY,
  registryRead,
  settledChild,
  useRequesterSettleDispatchFixture,
  wakeParams,
  withGateway,
} from "./subagent-announce.requester-settle-dispatch.test-support.js";
import { maybeWakeRequesterAfterAllChildrenSettled } from "./subagent-announce.requester-settle-wake.js";

type Wake = Parameters<typeof maybeWakeRequesterAfterAllChildrenSettled>[0];

useRequesterSettleDispatchFixture();
beforeEach(() => setRuntimeConfigSnapshot({}));
afterEach(() => clearRuntimeConfigSnapshot());

it("continues a followup only with the partition that leaves no cohort member working", async () => {
  const context = createContext();
  const batchRunIds = ["running-child", "settled-child"];
  const done = settledChild();
  done.delivery = { status: "pending" };
  done.requesterSettleWake = { ...done.requesterSettleWake!, batchRunIds };
  const running: SubagentRunRecord = {
    ...settledChild(),
    runId: "running-child",
    childSessionKey: "agent:main:subagent:running-child",
    execution: { status: "running", startedAt: 2_000 },
    delivery: { status: "pending" },
    requesterSettleWake: { ...done.requesterSettleWake },
  };
  registryRead.listSubagentRunsForRequester.mockReturnValue([running, done]);
  const completeBatch = vi.fn<Wake["completeBatch"]>((batch) => {
    for (const entry of batch) {
      entry.requesterSettleWake = undefined;
    }
  });
  const owner = SessionFollowupCompletion.bind({
    runId: "followup-before-yield",
    requesterSessionKey: "agent:main:original-requester",
    requesterSessionId: "original-requester",
    requesterAgentId: "main",
    targetAgentId: "main",
    targetSessionKey: REQUESTER_KEY,
    custody: {
      signal: new AbortController().signal,
      release() {},
      assertCurrent() {},
      run: (run) => run(),
    },
  });
  onTestFinished(() => owner.close());
  owner.promoteYield("followup-before-yield", [running, done], 1);
  owner.finishExecution("followup-before-yield");
  const successors: boolean[] = [];
  deliver.mockImplementation(async (request) => {
    successors.push(
      readFollowupSuccessor(request.directIdempotencyKey!, REQUESTER_KEY) !== undefined,
    );
    await request.onBeforeDispatch?.();
    return { delivered: true, path: "direct" };
  });
  const wake = (settledEntry: SubagentRunRecord) =>
    withGateway(context, () =>
      maybeWakeRequesterAfterAllChildrenSettled(wakeParams(settledEntry, completeBatch)),
    );
  // The ready result wakes the requester as an ordinary turn; the caller keeps waiting.
  await expect(wake(done)).resolves.toBe(true);
  expect(completeBatch.mock.calls.map(([batch]) => batch.map((entry) => entry.runId))).toEqual([
    ["settled-child"],
  ]);
  running.execution = {
    status: "terminal",
    startedAt: 2_000,
    endedAt: 5_000,
    outcome: { status: "ok" },
  };
  await expect(wake(running)).resolves.toBe(true);
  expect(successors).toEqual([false, true]);
});
