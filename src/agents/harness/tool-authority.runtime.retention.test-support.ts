import assert from "node:assert/strict";
import { createReplyOperation } from "../../sessions/session-controller.js";
import { testing } from "../../sessions/session-controller.test-support.js";
import { collectForRetentionCheck } from "../../test-utils/retention.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../admitted-run-context.js";
import { getGatewayToolCallerIdentity } from "../tools/gateway-caller-context.js";
import { withPreparedEmbeddedRunToolAuthority } from "./tool-authority.runtime.js";

const sessionId = "authority-retention";
const sessionKey = "agent:main:authority-retention";
const runId = "authority-retention";

async function completeAttempt(source: "receipt" | "watchdog") {
  const continuation = { messages: [{ role: "user", content: "completed synthetic turn" }] };
  const internalContinuation = { prompt: "internal completed synthetic turn" };
  const admission = prepareAgentRunAdmission({
    cfg: {},
    operationalRunInstance: createOperationalRunInstanceRef(runId),
    facts: {
      agentId: "main",
      runId,
      ingress: { kind: "system", state: "present", boundary: "retention" },
    },
  });
  try {
    const admittedRunContext = await admission.admit("embedded", "retention");
    const replyOperation = createReplyOperation({ sessionId, sessionKey, resetTriggered: false });
    try {
      const internal = { admittedRunContext, replyOperation, continuation: internalContinuation };
      const retainedAssertion = await withPreparedEmbeddedRunToolAuthority(
        internal,
        {
          sessionId,
          sessionKey,
          runId,
          agentId: "main",
          config: {},
          sessionFile: "authority-retention.jsonl",
          workspaceDir: process.cwd(),
          provider: "openai",
          modelId: "synthetic-model",
          sandboxSessionKey: sessionKey,
          senderIsOwner: true,
          messageProvider: "webchat",
          senderId: "synthetic-requester",
          continuation,
        },
        undefined,
        async () => {
          const caller = getGatewayToolCallerIdentity();
          const watchdog = caller?.watchdogAttempt;
          return source === "receipt"
            ? caller?.receiptAuthority
            : watchdog?.isCurrent.bind(watchdog);
        },
      );
      assert.ok(retainedAssertion);
      return {
        continuation: new WeakRef(continuation),
        internalContinuation: new WeakRef(internalContinuation),
        retainedAssertion,
      };
    } finally {
      replyOperation.complete();
    }
  } finally {
    admission.close();
  }
}

for (const source of ["receipt", "watchdog"] as const) {
  const completed = [];
  for (let count = 0; count < 10; count++) {
    completed.push(await completeAttempt(source));
  }
  testing.resetSessionControllerForTest();
  await collectForRetentionCheck(`authority-${source}`);
  assert.equal(
    completed.filter(({ continuation }) => continuation.deref()).length,
    0,
    `${source} retained the attempt`,
  );
  assert.equal(
    completed.filter(({ internalContinuation }) => internalContinuation.deref()).length,
    0,
    `${source} retained internal run input`,
  );
  assert.equal(completed[0]!.retainedAssertion(), false, "Retained authority must remain closed");
}
process.stdout.write(
  JSON.stringify({ attemptsReleased: true, internalInputsReleased: true, closed: true }),
);
