import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it } from "vitest";
import { createDeferred, withinTest } from "../../../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../../../config/sessions/session-accessor.sqlite-entry.js";
import { withSessionTurn } from "../../../sessions/session-controller.admission.js";
import { captureSessionTarget } from "../../../sessions/session-controller.lifecycle.js";
import {
  releaseSessionControllerClaim,
  reserveSessionControllerSource,
  retireSessionControllerInput,
  tryClaimSessionControllerTask,
  type SessionControllerInput,
} from "../../../sessions/session-controller.mailbox.js";
import { bindSessionControllerEntryTarget } from "../../../sessions/session-controller.state.js";
import { resetSessionControllerStateForTest } from "../../../sessions/session-lifecycle-admission.test-support.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import {
  reserveRestoredSubagentControllerSources,
  reserveSubagentCompletionControllerSource as reserveCompletion,
} from "../announce/subagent-announce-controller-source.js";
import {
  hasSubagentControllerInput as hasInput,
  retireSubagentControllerInputs as retireInputs,
} from "./subagent-controller-inputs.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const storePath = "/private/tmp/subagent-controller-inputs/main/sessions.json";
const requesterKey = "global";
const inputs: SessionControllerInput[] = [];

function pendingWake(batchRunIds: string[], rearmGeneration = 4) {
  return { status: "pending" as const, attemptCount: 0, batchRunIds, rearmGeneration };
}

function expectRetired(
  entry: SubagentRunRecord,
  selected: SessionControllerInput,
  ...untouched: SessionControllerInput[]
) {
  expect(hasInput(entry)).toBe(true);
  retireInputs(entry);
  expect(selected.abortSignal.aborted).toBe(true);
  untouched.forEach((input) => expect(input.abortSignal.aborted).toBe(false));
  expect(hasInput(entry)).toBe(false);
}

function child(overrides: Partial<SubagentRunRecord> = {}) {
  return createSubagentRunRecord({
    runId: "child-a",
    generation: 4,
    requesterSessionKey: requesterKey,
    requesterAgentId: "main",
    requesterStorePath: storePath,
    expectsCompletionMessage: true,
    ...overrides,
  });
}

function reserve(
  sourceTurnId: string,
  scope: { storePath?: string; sessionKey?: string; agentId?: string } = {},
) {
  const sessionKey = scope.sessionKey ?? requesterKey;
  const input = reserveSessionControllerSource(sessionKey, {
    sourceTurnId,
    policy: { mode: "followup" },
    target: captureSessionTarget({
      storeScope: scope.storePath ?? storePath,
      sessionKey,
      agentId: scope.agentId ?? "main",
      // Unrelated requester keys must not alias the same physical session.
      incarnation: `requester-session:${sessionKey}`,
    }),
  });
  inputs.push(input);
  return input;
}

afterEach(async () => {
  const claims = new Set(inputs.flatMap((input) => (input.claim ? [input.claim] : [])));
  claims.forEach((claim) => releaseSessionControllerClaim(claim));
  inputs.forEach((input) => retireSessionControllerInput(input));
  await Promise.all(inputs.map((input) => input.settlement.promise));
  inputs.length = 0;
  subagentRuns.clear();
  resetSessionControllerStateForTest();
});

it("retires only the exact legacy completion source in its physical requester", () => {
  const entry = child({ generation: undefined });
  const completionId = "subagent-completion:child-a:0";
  const unrelated = [
    reserve("subagent-completion:other-child:4"),
    reserve("subagent-completion:child-a:3"),
    reserve(completionId, { storePath: "/private/tmp/other/sessions.json" }),
    reserve(completionId, { sessionKey: "other-requester" }),
    reserve(completionId, { agentId: "research" }),
  ];
  expect(hasInput(entry)).toBe(false);

  const exact = reserve(completionId);
  expectRetired(entry, exact, ...unrelated);
});

it.each(["default", "custom", "memory"] as const)(
  "retires a real completion reservation with its %s requester store",
  async (layout) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sessionKey =
        layout === "memory" ? "agent:main:dashboard:incognito-completion" : "agent:main:main";
      const logicalStore =
        layout === "custom"
          ? state.path("custom", "sessions.json")
          : path.join(state.sessionsDir(), "sessions.json");
      const directory =
        layout === "custom" ? state.path("custom") : state.statePath("agents", "main", "agent");
      const databaseName =
        layout === "memory" ? "incognito-openclaw-agent.sqlite" : "openclaw-agent.sqlite";
      const physicalStore = path.join(directory, databaseName);
      setRuntimeConfigSnapshot(layout === "custom" ? { session: { store: logicalStore } } : {});
      await replaceSessionEntry(
        { agentId: "main", sessionKey, storePath: logicalStore },
        {
          sessionId: "requester-session",
          updatedAt: 1,
          ...(layout === "memory" ? { incognito: true } : {}),
        },
      );
      const entry = child({ requesterSessionKey: sessionKey, requesterStorePath: physicalStore });
      const input = expectDefined(await reserveCompletion(entry), "Requester reservation");
      inputs.push(input);
      try {
        expect(input.target?.storeScope).toBe(layout === "memory" ? physicalStore : logicalStore);
        expect(hasInput(entry)).toBe(true);
        const target = expectDefined(input.target, "Requester reservation target");
        // A later binding can change the mailbox observation, but not this source's store.
        bindSessionControllerEntryTarget(
          input.mailbox.owner,
          captureSessionTarget({ ...target, physicalStorePath: physicalStore + ".other" }),
        );
        expect(hasInput({ ...entry, requesterStorePath: physicalStore + ".other" })).toBe(false);
        expectRetired(entry, input);
      } finally {
        retireSessionControllerInput(input);
        await input.settlement.promise;
      }
    });
  },
);

const batchIds = ["child-a", "child-b", "child-c"];
it.each<[string, string, Partial<SubagentRunRecord> | undefined]>([
  ["explicit", "retired", undefined],
  ["explicit", "generation", { requesterSettleWake: pendingWake(batchIds, 5) }],
  ["explicit", "store", { requesterStorePath: "/private/tmp/other/sessions.json" }],
  ["explicit", "key", { requesterSessionKey: "other-requester" }],
  ["explicit", "agent", { requesterAgentId: "research" }],
  ["explicit", "no wake", { requesterSettleWake: undefined }],
  ["legacy", "retired", undefined],
])(
  "uses surviving %s batch members and excludes a member with different %s",
  (representation, _difference, overrides) => {
    const legacy = representation === "legacy";
    const requesterSessionKey = legacy ? "agent:main:global" : requesterKey;
    const requester = { requesterSessionKey, requesterAgentId: legacy ? undefined : "main" };
    const wake = pendingWake(batchIds);
    const entry = child({ ...requester, requesterSettleWake: wake });
    const sibling = child({ ...requester, runId: "child-b", requesterSettleWake: { ...wake } });
    subagentRuns.set(entry.runId, entry);
    subagentRuns.set(sibling.runId, sibling);
    if (overrides) {
      const excluded = child({
        ...requester,
        runId: "child-c",
        requesterSettleWake: { ...wake },
        ...overrides,
      });
      subagentRuns.set(excluded.runId, excluded);
    }
    const batchPrefix = `requester-settle:${legacy ? "unknown" : "main"}:${requesterSessionKey}`;
    const scope = { sessionKey: requesterSessionKey };
    const obsolete = reserve(`${batchPrefix}:child-a,child-b,child-c:yield-4`, scope);
    const foreignOnly = reserve(`${batchPrefix}:child-c:yield-4`, scope);
    expect(hasInput(entry)).toBe(false);

    const surviving = reserve(`${batchPrefix}:child-a,child-b:yield-4`, scope);
    expectRetired(entry, surviving, obsolete, foreignOnly);
  },
);

it("keeps a pause notice's singleton identity separate from its completion batch", () => {
  const wake = {
    ...pendingWake(["child-a", "child-b"]),
    pauseNotice: { acknowledgment: "Waiting for direction" },
  };
  const entry = child({ pauseReason: "sessions_yield", requesterSettleWake: wake });
  subagentRuns.set(entry.runId, entry);
  subagentRuns.set("child-b", child({ runId: "child-b", requesterSettleWake: { ...wake } }));
  const completionBatch = reserve("requester-settle:main:global:child-a,child-b:yield-4");
  const groupedPause = reserve("requester-settle:main:global:child-a,child-b:yield-4:pause");
  expect(hasInput(entry)).toBe(false);

  const pause = reserve("requester-settle:main:global:child-a:yield-4:pause");
  expectRetired(entry, pause, completionBatch, groupedPause);
});

it("retires unclaimed reservations while a selected turn retains its input", async () => {
  const entry = child();
  const selected = reserve("subagent-completion:child-a:4");
  const claim = expectDefined(tryClaimSessionControllerTask(selected), "controller claim");
  const queued = reserve("subagent-completion:child-a:4");

  retireInputs(entry);

  expect(selected.abortSignal.aborted).toBe(false);
  expect(queued.abortSignal.aborted).toBe(true);
  expect(hasInput(entry)).toBe(true);
  releaseSessionControllerClaim(claim);
  await claim.settlement.promise;
  expect(hasInput(entry)).toBe(false);
});

it.for(["child", "descendant"] as const)(
  "runs user input in FIFO order while a restored yielded cohort awaits a %s",
  { timeout: 5_000 },
  async (waitingFor, { signal }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      setRuntimeConfigSnapshot({});
      const sessionKey = "agent:main:main";
      const logicalStore = path.join(state.sessionsDir(), "sessions.json");
      await replaceSessionEntry(
        { agentId: "main", sessionKey, storePath: logicalStore },
        { sessionId: "requester-session", updatedAt: 1 },
      );
      const wake = { ...pendingWake(["child-a", "child-b"]), requesterYieldBatch: true as const };
      const now = Date.now();
      const completed = child({
        requesterSessionKey: sessionKey,
        requesterStorePath: path.join(
          state.statePath("agents", "main", "agent"),
          "openclaw-agent.sqlite",
        ),
        createdAt: now - 30,
        execution: { status: "terminal", endedAt: now - 10, outcome: { status: "ok" } },
        requesterSettleWake: wake,
      });
      const running = child({
        ...completed,
        runId: "child-b",
        childSessionKey: "agent:main:subagent:child-b",
        execution: { status: "running", startedAt: now - 20 },
        requesterSettleWake: { ...wake },
      });
      const rows = [completed, running];
      if (waitingFor === "descendant") {
        running.execution = completed.execution;
        rows.push(
          child({
            ...running,
            runId: "grandchild",
            childSessionKey: "agent:main:subagent:grandchild",
            requesterSessionKey: running.childSessionKey,
            execution: { status: "running", startedAt: now - 20 },
            requesterSettleWake: undefined,
          }),
        );
      }
      for (const entry of rows) {
        subagentRuns.set(entry.runId, entry);
      }
      inputs.push(...(await reserveRestoredSubagentControllerSources(rows)));

      const controller = new AbortController();
      const firstEntered = createDeferred();
      const releaseFirst = createDeferred();
      const order: string[] = [];
      const turn = {
        sessionKey,
        sessionId: "requester-session",
        storePath: logicalStore,
        agentId: "main",
        abortSignal: controller.signal,
      };
      const first = withSessionTurn(turn, async () => {
        order.push("first");
        firstEntered.resolve();
        await releaseFirst.promise;
      });
      const second = withSessionTurn(turn, async () => {
        order.push("second");
      });
      try {
        await withinTest(firstEntered.promise, signal);
        expect(order).toEqual(["first"]);
        releaseFirst.resolve();
        await withinTest(Promise.all([first, second]), signal);
        expect(order).toEqual(["first", "second"]);
        expect(completed.requesterSettleWake).toEqual(wake);
        expect(running.requesterSettleWake).toEqual(wake);
        const terminalRows = rows.map((entry) =>
          child({
            ...entry,
            execution: { status: "terminal", endedAt: Date.now(), outcome: { status: "ok" } },
            delivery: { status: "delivered" },
            cleanupCompletedAt: Date.now(),
          }),
        );
        for (const entry of terminalRows) {
          subagentRuns.set(entry.runId, entry);
        }
        const restored = await reserveRestoredSubagentControllerSources(terminalRows);
        inputs.push(...restored);
        const completion = expectDefined(restored[0], "ready completion reservation");
        await withSessionTurn({ ...turn, controllerInput: completion }, async () => {
          order.push("completion");
        });
        expect(order).toEqual(["first", "second", "completion"]);
      } finally {
        controller.abort();
        releaseFirst.resolve();
        for (const input of inputs) {
          retireSessionControllerInput(input);
        }
        await Promise.allSettled([first, second]);
      }
    });
  },
);

it("restores a ready continuation without reserving an interrupted predecessor's delivery", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    setRuntimeConfigSnapshot({});
    const sessionKey = "agent:main:main";
    const logicalStore = path.join(state.sessionsDir(), "sessions.json");
    await replaceSessionEntry(
      { agentId: "main", sessionKey, storePath: logicalStore },
      { sessionId: "requester-session", updatedAt: 1 },
    );
    const interrupted = child({
      runId: "interrupted-child",
      generation: 1,
      requesterSessionKey: sessionKey,
      requesterStorePath: state.statePath("agents", "main", "agent", "openclaw-agent.sqlite"),
      createdAt: 1,
      terminalOwner: "interrupted-recovery",
      execution: { status: "terminal", endedAt: 2, outcome: { status: "error" } },
      delivery: { status: "pending" },
      cleanupHandled: false,
    });
    const completed = child({
      ...interrupted,
      runId: "completed-child",
      generation: 2,
      createdAt: 3,
      terminalOwner: undefined,
      execution: { status: "terminal", endedAt: 4, outcome: { status: "ok" } },
      delivery: { status: "delivered" },
      cleanupHandled: true,
      cleanupCompletedAt: 4,
      requesterSettleWake: {
        ...pendingWake(["completed-child"]),
        requesterYieldBatch: true,
      },
    });
    const rows = [interrupted, completed];
    rows.forEach((entry) => subagentRuns.set(entry.runId, entry));
    const restored = await reserveRestoredSubagentControllerSources(rows);
    inputs.push(...restored);
    expect(restored).toHaveLength(1);
    const order: string[] = [];
    const turn = {
      sessionKey,
      sessionId: "requester-session",
      storePath: logicalStore,
      agentId: "main",
    };
    await Promise.all([
      withSessionTurn({ ...turn, controllerInput: restored[0] }, async () => {
        order.push("completion");
      }),
      withSessionTurn(turn, async () => {
        order.push("user");
      }),
    ]);
    expect(order).toEqual(["completion", "user"]);
    expect(interrupted.delivery).toEqual({ status: "pending" });
    expect(subagentRuns.get(interrupted.runId)).toBe(interrupted);
  });
});
