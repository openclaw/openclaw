import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { admitReplyTurn } from "../../../auto-reply/reply/reply-turn-admission.js";
import { replaceSessionEntry } from "../../../config/sessions/session-accessor.sqlite-entry.js";
import type { ReplyOperation } from "../../../sessions/session-controller.contracts.js";
import { captureSessionTarget } from "../../../sessions/session-controller.lifecycle.js";
import { createReplyOperation } from "../../../sessions/session-controller.operation.js";
import { resetSessionControllerStateForTest } from "../../../sessions/session-lifecycle-admission.test-support.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { isClaimedByLiveRequesterTurn } from "./subagent-requester-turn-liveness.js";

const storePath = "/private/tmp/requester-turn-liveness/main/sessions.json";
const operations: ReplyOperation[] = [];

afterEach(async () => {
  for (const operation of operations) {
    operation.complete();
  }
  await Promise.all(operations.map((operation) => operation.ownerSettlement));
  operations.length = 0;
  resetSessionControllerStateForTest();
});

function requesterTurn() {
  const operation = createReplyOperation({
    sessionKey: "global",
    sessionId: "requester-session",
    agentId: "main",
    resetTriggered: false,
    target: captureSessionTarget({
      storeScope: storePath,
      sessionKey: "global",
      incarnation: "requester-session",
      agentId: "main",
    }),
  });
  operations.push(operation);
  operation.setPhase("running");
  const backend = { kind: "embedded" as const, runId: "requester-turn", cancel: () => {} };
  operation.attachBackend(backend);
  return { operation, backend };
}

function child() {
  return createSubagentRunRecord({
    runId: "liveness-child",
    childSessionKey: "agent:main:subagent:liveness-child",
    requesterSessionKey: "global",
    requesterAgentId: "main",
    requesterStorePath: storePath,
    requesterTurnRunId: "requester-turn",
    expectsCompletionMessage: true,
  });
}

function settleRequester(
  { operation, backend }: ReturnType<typeof requesterTurn>,
  entry: ReturnType<typeof child>,
) {
  expect(isClaimedByLiveRequesterTurn(entry)).toBe(true);
  operation.detachBackend(backend);
  expect(isClaimedByLiveRequesterTurn(entry)).toBe(true);
  operation.yield();
  expect(isClaimedByLiveRequesterTurn(entry)).toBe(true);
}

it("keeps the physical requester live through backend detach and yield until its turn settles", () => {
  const turn = requesterTurn();
  const entry = child();
  settleRequester(turn, entry);
  turn.operation.complete();
  expect(isClaimedByLiveRequesterTurn(entry)).toBe(false);
});

it.each([
  ["store", { requesterStorePath: "/private/tmp/requester-turn-liveness/other/sessions.json" }],
  ["key", { requesterSessionKey: "other-requester" }],
  ["agent", { requesterAgentId: "research" }],
  ["turn", { requesterTurnRunId: "other-turn" }],
  ["no obligation", { expectsCompletionMessage: false }],
] as const)(
  "does not borrow live requester ownership across a different %s",
  (_difference, overrides) => {
    requesterTurn();
    expect(isClaimedByLiveRequesterTurn({ ...child(), ...overrides })).toBe(false);
  },
);

it("does not retain a claim when the recorded requester turn is absent", () => {
  const entry = child();
  expect(isClaimedByLiveRequesterTurn(entry)).toBe(false);

  requesterTurn();
  entry.requesterTurnRunId = undefined;
  expect(isClaimedByLiveRequesterTurn(entry)).toBe(false);
});

it.each(["default", "custom"] as const)(
  "retains a real requester admitted through its %s logical store locator",
  async (layout) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sessionKey = "agent:main:main";
      const logicalStore =
        layout === "custom"
          ? state.path("custom", "sessions.json")
          : path.join(state.sessionsDir(), "sessions.json");
      const physicalStore =
        layout === "custom"
          ? state.path("custom", "openclaw-agent.sqlite")
          : state.statePath("agents", "main", "agent", "openclaw-agent.sqlite");
      await replaceSessionEntry(
        { agentId: "main", sessionKey, storePath: logicalStore },
        { sessionId: "requester-session", updatedAt: 1 },
      );
      const admitted = await admitReplyTurn({
        agentId: "main",
        sessionKey,
        sessionId: "requester-session",
        storePath: logicalStore,
        kind: "visible",
        resetTriggered: false,
      });
      if (admitted.status !== "owned") {
        throw new Error("Requester did not acquire its turn");
      }
      const operation = admitted.operation;
      const backend = { kind: "embedded" as const, runId: "requester-turn", cancel() {} };
      operation.attachBackend(backend);
      const entry = {
        ...child(),
        requesterSessionKey: sessionKey,
        requesterStorePath: physicalStore,
      };
      try {
        expect(
          isClaimedByLiveRequesterTurn({ ...entry, requesterStorePath: physicalStore + ".other" }),
        ).toBe(false);
        settleRequester({ operation, backend }, entry);
      } finally {
        operation.complete();
        await operation.ownerSettlement;
      }
      expect(isClaimedByLiveRequesterTurn(entry)).toBe(false);
    });
  },
);
