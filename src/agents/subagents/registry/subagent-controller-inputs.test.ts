import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../../../config/sessions/session-accessor.sqlite-entry.js";
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
import { reserveSubagentCompletionControllerSource as reserveCompletion } from "../announce/subagent-announce-controller-source.js";
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
