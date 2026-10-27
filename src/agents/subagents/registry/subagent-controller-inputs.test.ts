import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../../../config/sessions/session-accessor.sqlite-entry.js";
import { getAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
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
import * as stateWorker from "../../../state/openclaw-state-worker-store.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { reserveSubagentCompletionControllerSource as reserveCompletion } from "../announce/subagent-announce-controller-source.js";
import {
  hasSubagentControllerInput as hasInput,
  retireSubagentControllerInputs as retireInputs,
} from "./subagent-controller-inputs.js";
import { createLifecycleControllerFixture } from "./subagent-registry-lifecycle-controller.test-support.js";
import { SubagentLifecycleController } from "./subagent-registry-lifecycle.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { createSubagentSweeperHarness } from "./subagent-registry-sweeper.test-support.js";
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

it(
  "runs ordinary parent input after an ownerless live completion reservation expires",
  {
    timeout: 5_000,
  },
  async ({ signal }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      setRuntimeConfigSnapshot({});
      const sessionKey = "agent:main:main";
      const logicalStore = path.join(state.sessionsDir(), "sessions.json");
      await replaceSessionEntry(
        { agentId: "main", sessionKey, storePath: logicalStore },
        { sessionId: "requester-session", updatedAt: 1, status: "done" },
      );
      const now = Date.now();
      const entry = child({
        requesterSessionKey: sessionKey,
        requesterStorePath: state.statePath("agents", "main", "agent", "openclaw-agent.sqlite"),
        completionTarget: "parent",
        execution: {
          status: "terminal",
          startedAt: now - 2_000,
          endedAt: now - 1_000,
          lifecycleGeneration: getAgentEventLifecycleGeneration(),
        },
        delivery: { status: "pending", windowStartedAt: now - 1_000, deadlineAt: now - 1 },
        cleanupHandled: false,
      });
      subagentRuns.set(entry.runId, entry);
      const input = expectDefined(await reserveCompletion(entry), "live completion reservation");
      inputs.push(input);
      const entered = createDeferred();
      const controller = new AbortController();
      const turn = withSessionTurn(
        {
          sessionKey,
          sessionId: "requester-session",
          storePath: logicalStore,
          agentId: "main",
          abortSignal: controller.signal,
        },
        async () => entered.resolve(),
      );
      void turn.catch(() => {});
      try {
        const harness = createSubagentSweeperHarness(entry, subagentRuns);
        harness.discardTerminalDelivery.mockImplementation(
          SubagentLifecycleController.discardTerminalDelivery,
        );
        await harness.sweeper.sweepOnce();
        expect(subagentRuns.get(entry.runId)?.delivery?.status).toBe("discarded");
        expect(input.abortSignal.aborted).toBe(true);
        expect(harness.callGateway).not.toHaveBeenCalled();
        expect(harness.emitSubagentEndedHookForRun).not.toHaveBeenCalled();
        await withinTest(entered.promise, signal);
        await turn;
      } finally {
        controller.abort();
        retireSessionControllerInput(input);
        await turn.catch(() => {});
      }
    });
  },
);

