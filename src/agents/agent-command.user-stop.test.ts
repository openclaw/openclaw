/** Tests that an `agent` RPC turn, which never reaches reply admission, states a user's Stop. */
import { expect, it } from "vitest";
import {
  agentCommandFromGatewayIngress,
  compactionTestRuntime,
  compactionTestState as state,
  GATEWAY_INGRESS_ARGS,
  makeCompactionResult,
  registerAgentCommandCompactionTestHooks,
  requireCompactionStorePath,
} from "./agent-command.compaction.test-support.js";

registerAgentCommandCompactionTestHooks();

it.each([
  { name: "says the Stop on an agent turn", modelRun: false, says: true },
  { name: "keeps the Stop past a raw model run", modelRun: true, says: false },
])("$name", async ({ modelRun, says }) => {
  const sessionId = "stopped-session";
  const target = { sessionKey: "agent:main:rpc-stop", storePath: requireCompactionStorePath() };
  const stop = { userStoppedAt: 5, userStoppedSessionId: sessionId };
  await compactionTestRuntime.replaceSessionEntry(target, { sessionId, updatedAt: 1, ...stop });
  state.runAgentAttemptMock.mockResolvedValueOnce(makeCompactionResult({ sessionId, text: "ok" }));

  await agentCommandFromGatewayIngress(
    { ...target, sessionId, message: "next ask", allowModelOverride: false, modelRun },
    ...GATEWAY_INGRESS_ARGS,
  );

  const attempt = state.runAgentAttemptMock.mock.calls[0]?.[0];
  expect(attempt?.body.startsWith("Note: The user stopped the previous agent run.")).toBe(says);
  expect(attempt?.body.endsWith("next ask")).toBe(true);
  expect(attempt?.transcriptBody).toBe("next ask");
  // A turn that says the Stop retires it; one that cannot leaves it for the next.
  expect(compactionTestRuntime.loadSessionEntry(target)?.userStoppedAt).toBe(says ? undefined : 5);
});
