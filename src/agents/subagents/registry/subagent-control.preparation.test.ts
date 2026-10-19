// Preserve fixture setup before the runtime modules that consume it.
// oxfmt-ignore
import { useSubagentControlFixture } from "./subagent-control.test-support.js";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../../test/helpers/promise.js";
import * as replyConfig from "../../../auto-reply/reply/agent-runner-utils.js";
import { createQueueTestRun } from "../../../auto-reply/reply/queue.test-helpers.js";
import { prepareReplyAgentTurn } from "../../../auto-reply/reply/reply-agent-turn-preparation.js";
import { createTypingController } from "../../../auto-reply/reply/typing.js";
import { getRuntimeConfig } from "../../../config/config.js";
import {
  releaseSessionControllerClaim,
  submitSessionControllerInput,
} from "../../../sessions/session-controller.mailbox.js";
import { killSubagentRunAdmin } from "./subagent-control.js";
import { registerSubagentRun } from "./subagent-registry.js";
import { writeSubagentSessionEntry } from "./subagent-registry.persistence.test-support.js";

const fixture = useSubagentControlFixture();

it("cancels a selected preparation source and retains its actual return before completing child Stop", async ({
  signal,
}) => {
  const sessionKey = "agent:main:subagent:preparing-stop";
  const sessionId = "preparing-stop-session";
  const lifecycleRevision = "preparing-stop-lifecycle";
  const runId = "preparing-stop-run";
  const storePath = await writeSubagentSessionEntry({
    stateDir: fixture.stateDir,
    agentId: "main",
    sessionKey,
    defaultSessionId: sessionId,
    lifecycleRevision,
  });
  await registerSubagentRun({
    runId,
    childSessionKey: sessionKey,
    childAgentId: "main",
    sessionEntry: { sessionId, lifecycleRevision },
    requesterSessionKey: "agent:main:main",
    requesterAgentId: "main",
    requesterDisplayKey: "main",
    task: "preparing source cancellation",
    cleanup: "keep",
    expectsCompletionMessage: false,
  });
  const cfg = getRuntimeConfig();
  const upstream = new AbortController();
  const queued = createQueueTestRun({ prompt: "do not execute after Stop" });
  queued.abortSignal = upstream.signal;
  queued.run = { ...queued.run, config: cfg, agentId: "main", sessionKey, sessionId };
  submitSessionControllerInput(
    sessionKey,
    queued,
    { mode: "followup" },
    {
      protocolRunId: runId,
      storePath,
    },
  );
  const entered = createDeferred();
  const finishPreparation = createDeferred();
  vi.spyOn(replyConfig, "resolveQueuedReplyExecutionConfig").mockImplementation(async (config) => {
    entered.resolve();
    await finishPreparation.promise;
    return config;
  });
  const typing = createTypingController({});
  const preparation = prepareReplyAgentTurn({
    queued,
    defaults: { typing, typingMode: "never", defaultModel: "gpt-test", sessionKey, storePath },
  });
  let stopping: ReturnType<typeof killSubagentRunAdmin> | undefined;
  try {
    await withinTest(
      awaitGateBeforeSettlement(
        entered.promise,
        preparation,
        "Preparation settled before entering its retained config phase",
      ),
      signal,
    );
    const input = queued.controllerInput;
    const claim = input?.claim;
    if (!input || !claim) {
      throw new Error("Preparation did not retain its selected source");
    }
    const interrupted = createDeferred();
    claim.abortController.signal.addEventListener("abort", () => interrupted.resolve(), {
      once: true,
    });
    let stopped = false;
    stopping = killSubagentRunAdmin({ cfg, sessionKey, expectedRunId: runId }).finally(() => {
      stopped = true;
    });
    await withinTest(
      awaitGateBeforeSettlement(
        interrupted.promise,
        stopping,
        "Child Stop settled before interrupting the selected preparation",
      ),
      signal,
    );
    expect(input.abortSignal.aborted).toBe(true);
    expect(claim.operation).toBeUndefined();
    expect(claim.released).toBe(false);
    expect(stopped).toBe(false);
    finishPreparation.resolve();
    expect(await withinTest(preparation, signal)).toMatchObject({
      kind: "skipped",
      reason: "aborted",
    });
    expect(await withinTest(stopping, signal)).toMatchObject({ found: true, killed: true });
    await withinTest(input.settlement.promise, signal);
    expect(claim.operation).toBeUndefined();
  } finally {
    upstream.abort();
    finishPreparation.resolve();
    const result = await preparation.catch(() => undefined);
    if (result?.kind === "admitted") {
      result.turn.operation.complete();
    } else if (result?.kind === "skipped") {
      result.operation?.complete();
    }
    const claim = queued.controllerInput?.claim;
    if (claim) {
      releaseSessionControllerClaim(claim);
    }
    await Promise.allSettled([claim?.settlement.promise, stopping]);
    typing.cleanup();
  }
});
