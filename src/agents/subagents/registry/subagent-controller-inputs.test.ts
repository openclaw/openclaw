import path from "node:path";
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
import { reserveSubagentCompletionControllerSource } from "../announce/subagent-announce-controller-source.js";
import {
  hasSubagentControllerInput,
  retireSubagentControllerInputs,
  subagentCompletionSourceId,
} from "./subagent-controller-inputs.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const storePath = "/private/tmp/subagent-controller-inputs/main/sessions.json";
const requesterKey = "global";
const inputs: SessionControllerInput[] = [];

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
  for (const claim of claims) {
    releaseSessionControllerClaim(claim);
  }
  for (const input of inputs) {
    retireSessionControllerInput(input);
  }
  await Promise.all(inputs.map((input) => input.settlement.promise));
  inputs.length = 0;
  subagentRuns.clear();
  resetSessionControllerStateForTest();
});

it.each([
  { generation: undefined, expected: "subagent-completion:child-a:0" },
  { generation: 4, expected: "subagent-completion:child-a:4" },
])("keeps the completion reservation identity exact ($generation)", ({ generation, expected }) => {
  expect(subagentCompletionSourceId(child({ generation }))).toBe(expected);
});

it("finds and retires only the exact completion source in its physical requester", () => {
  const entry = child();
  const unrelated = [
    reserve("subagent-completion:other-child:4"),
    reserve("subagent-completion:child-a:3"),
    reserve("subagent-completion:child-a:4", { storePath: "/private/tmp/other/sessions.json" }),
    reserve("subagent-completion:child-a:4", { sessionKey: "other-requester" }),
    reserve("subagent-completion:child-a:4", { agentId: "research" }),
  ];
  expect(hasSubagentControllerInput(entry)).toBe(false);

  const exact = reserve("subagent-completion:child-a:4");
  expect(hasSubagentControllerInput(entry)).toBe(true);
  retireSubagentControllerInputs(entry);

  expect(exact.abortSignal.aborted).toBe(true);
  expect(hasSubagentControllerInput(entry)).toBe(false);
  for (const input of unrelated) {
    expect(input.abortSignal.aborted).toBe(false);
  }
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
      const physicalStore =
        layout === "custom"
          ? state.path("custom", "openclaw-agent.sqlite")
          : state.statePath(
              "agents",
              "main",
              "agent",
              layout === "memory" ? "incognito-openclaw-agent.sqlite" : "openclaw-agent.sqlite",
            );
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
      const input = await reserveSubagentCompletionControllerSource(entry);
      expect(input).toBeDefined();
      if (!input) {
        throw new Error("Requester reservation was not created");
      }
      inputs.push(input);
      try {
        expect(input.target?.storeScope).toBe(layout === "memory" ? physicalStore : logicalStore);
        expect(hasSubagentControllerInput(entry)).toBe(true);
        const target = input.target;
        if (!target) {
          throw new Error("Requester reservation has no target");
        }
        // A later binding can change the mailbox observation, but not this source's store.
        bindSessionControllerEntryTarget(
          input.mailbox.owner,
          captureSessionTarget({ ...target, physicalStorePath: physicalStore + ".other" }),
        );
        expect(hasSubagentControllerInput(entry)).toBe(true);
        expect(
          hasSubagentControllerInput({ ...entry, requesterStorePath: physicalStore + ".other" }),
        ).toBe(false);
        retireSubagentControllerInputs(entry);
        expect(input.abortSignal.aborted).toBe(true);
      } finally {
        retireSessionControllerInput(input);
        await input.settlement.promise;
      }
    });
  },
);

it.each(
  [
    {
      representation: "explicit",
      requesterSessionKey: requesterKey,
      requesterAgentId: "main",
      batchAgentId: "main",
    },
    {
      representation: "legacy",
      requesterSessionKey: "agent:main:global",
      requesterAgentId: undefined,
      batchAgentId: "unknown",
    },
  ].flatMap((requester) =>
    (["retired", "generation", "store", "key", "agent", "no wake"] as const).map((difference) =>
      Object.assign({}, requester, { difference }),
    ),
  ),
)(
  "uses surviving $representation batch members and excludes a member with different $difference",
  ({ requesterSessionKey, requesterAgentId, batchAgentId, difference }) => {
    const wake = {
      status: "pending" as const,
      attemptCount: 0,
      batchRunIds: ["child-a", "child-b", "child-c", "retired-child"],
      rearmGeneration: 4,
    };
    const requester = { requesterSessionKey, requesterAgentId };
    const entry = child({ ...requester, requesterSettleWake: wake });
    const sibling = child({ ...requester, runId: "child-b", requesterSettleWake: { ...wake } });
    subagentRuns.set(entry.runId, entry);
    subagentRuns.set(sibling.runId, sibling);
    if (difference !== "retired") {
      subagentRuns.set(
        "child-c",
        child({
          ...requester,
          runId: "child-c",
          requesterSettleWake:
            difference === "no wake"
              ? undefined
              : { ...wake, rearmGeneration: difference === "generation" ? 5 : 4 },
          ...(difference === "store"
            ? { requesterStorePath: "/private/tmp/other/sessions.json" }
            : {}),
          ...(difference === "key" ? { requesterSessionKey: "other-requester" } : {}),
          ...(difference === "agent" ? { requesterAgentId: "research" } : {}),
        }),
      );
    }
    const batchPrefix = `requester-settle:${batchAgentId}:${requesterSessionKey}`;
    const scope = { sessionKey: requesterSessionKey };
    const obsolete = reserve(`${batchPrefix}:child-a,child-b,child-c,retired-child:yield-4`, scope);
    const foreignOnly = reserve(`${batchPrefix}:child-c:yield-4`, scope);
    expect(hasSubagentControllerInput(entry)).toBe(false);

    const surviving = reserve(`${batchPrefix}:child-a,child-b:yield-4`, scope);
    expect(hasSubagentControllerInput(entry)).toBe(true);
    retireSubagentControllerInputs(entry);

    expect(surviving.abortSignal.aborted).toBe(true);
    expect(obsolete.abortSignal.aborted).toBe(false);
    expect(foreignOnly.abortSignal.aborted).toBe(false);
    expect(hasSubagentControllerInput(entry)).toBe(false);
  },
);

it("keeps a pause notice's singleton identity separate from its completion batch", () => {
  const wake = {
    status: "pending" as const,
    attemptCount: 0,
    batchRunIds: ["child-a", "child-b"],
    rearmGeneration: 4,
    pauseNotice: { acknowledgment: "Waiting for direction" },
  };
  const entry = child({ pauseReason: "sessions_yield", requesterSettleWake: wake });
  subagentRuns.set(entry.runId, entry);
  subagentRuns.set("child-b", child({ runId: "child-b", requesterSettleWake: { ...wake } }));
  const completionBatch = reserve("requester-settle:main:global:child-a,child-b:yield-4");
  const groupedPause = reserve("requester-settle:main:global:child-a,child-b:yield-4:pause");
  expect(hasSubagentControllerInput(entry)).toBe(false);

  const pause = reserve("requester-settle:main:global:child-a:yield-4:pause");
  expect(hasSubagentControllerInput(entry)).toBe(true);
  retireSubagentControllerInputs(entry);

  expect(pause.abortSignal.aborted).toBe(true);
  expect(completionBatch.abortSignal.aborted).toBe(false);
  expect(groupedPause.abortSignal.aborted).toBe(false);
});

it("retires unclaimed reservations while a selected turn retains its input", async () => {
  const entry = child();
  const selected = reserve("subagent-completion:child-a:4");
  const claim = tryClaimSessionControllerTask(selected);
  expect(claim).toBeDefined();
  if (!claim) {
    throw new Error("Expected a controller claim");
  }
  const queued = reserve("subagent-completion:child-a:4");

  retireSubagentControllerInputs(entry);

  expect(selected.abortSignal.aborted).toBe(false);
  expect(queued.abortSignal.aborted).toBe(true);
  expect(hasSubagentControllerInput(entry)).toBe(true);
  releaseSessionControllerClaim(claim);
  await claim.settlement.promise;
  expect(hasSubagentControllerInput(entry)).toBe(false);
});
