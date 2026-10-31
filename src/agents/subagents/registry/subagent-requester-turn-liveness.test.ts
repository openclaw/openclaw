import { afterEach, expect, it } from "vitest";
import { resetSessionControllerStateForTest } from "../../../sessions/session-lifecycle-admission.test-support.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { startControlProducer } from "./subagent-control-native.test-support.js";
import { isClaimedByLiveRequesterTurn } from "./subagent-requester-turn-liveness.js";

const storePath = "/private/tmp/requester-turn-liveness/main/sessions.json";
const turns: ReturnType<typeof startControlProducer>[] = [];

afterEach(async () => {
  await Promise.all(turns.map((turn) => turn.finish()));
  turns.length = 0;
  resetSessionControllerStateForTest();
});

function requesterTurn() {
  const turn = startControlProducer(
    "global",
    "requester-session",
    storePath,
    undefined,
    "requester-turn",
  );
  turn.operation.setPhase("running");
  turns.push(turn);
  return turn;
}

function child(overrides: Partial<ReturnType<typeof createSubagentRunRecord>> = {}) {
  return createSubagentRunRecord({
    runId: "liveness-child",
    childSessionKey: "agent:main:subagent:liveness-child",
    requesterSessionKey: "global",
    requesterAgentId: "main",
    requesterStorePath: storePath,
    requesterTurnRunId: "requester-turn",
    expectsCompletionMessage: true,
    ...overrides,
  });
}

it("keeps the physical requester live through backend detach and yield until its turn settles", () => {
  const { operation, backend } = requesterTurn();
  const entry = child();
  expect(isClaimedByLiveRequesterTurn(entry)).toBe(true);
  operation.detachBackend(backend);
  expect(isClaimedByLiveRequesterTurn(entry)).toBe(true);
  operation.yield();
  expect(isClaimedByLiveRequesterTurn(entry)).toBe(true);
  operation.complete();
  expect(isClaimedByLiveRequesterTurn(entry)).toBe(false);
});

it.each([
  ["store", { requesterStorePath: "/private/tmp/requester-turn-liveness/other/sessions.json" }],
  ["key", { requesterSessionKey: "other-requester" }],
  ["agent", { requesterAgentId: "research" }],
  ["turn", { requesterTurnRunId: "other-turn" }],
  ["missing turn", { requesterTurnRunId: undefined }],
  ["no obligation", { expectsCompletionMessage: false }],
] as const)(
  "does not borrow live requester ownership across a different %s",
  (_difference, overrides) => {
    requesterTurn();
    expect(isClaimedByLiveRequesterTurn(child(overrides))).toBe(false);
  },
);
