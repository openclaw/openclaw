// Preserve fixture setup before the runtime modules that consume it.
// oxfmt-ignore
import { useSubagentControlFixture } from "./subagent-control.test-support.js";
import { expect, it } from "vitest";
import * as sync from "../../../../test/helpers/promise.js";
import { createQueueTestRun } from "../../../auto-reply/reply/queue.test-helpers.js";
import { prepareReplyAgentTurn } from "../../../auto-reply/reply/reply-agent-turn-preparation.js";
import { createTypingController } from "../../../auto-reply/reply/typing.js";
import { getRuntimeConfig } from "../../../config/config.js";
import * as mailbox from "../../../sessions/session-controller.mailbox.js";
import { createSubagentRunParams } from "../../subagent-test-fixtures.test-helpers.js";
import { killSubagentRunAdmin } from "./subagent-control.js";
import { registerSubagentRun } from "./subagent-registry.js";
import { writeSubagentSessionEntry } from "./subagent-registry.persistence.test-support.js";

const fixture = useSubagentControlFixture();

it("waits for the cancelled preparation's actual return before Stop completes", async ({
  signal,
}) => {
  const wait = <T>(work: PromiseLike<T>) => sync.withinTest(work, signal);
  const gate = (ready: PromiseLike<unknown>, work: PromiseLike<unknown>) =>
    wait(sync.awaitGateBeforeSettlement(ready, work, "Settled before selected-source gate"));
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
  const registration = createSubagentRunParams({
    runId,
    childSessionKey: sessionKey,
    sessionEntry: { sessionId, lifecycleRevision },
    requesterAgentId: "main",
    expectsCompletionMessage: false,
  });
  await registerSubagentRun(registration);
  const cfg = getRuntimeConfig();
  const upstream = new AbortController();
  const queued = createQueueTestRun({ prompt: "do not execute after Stop" });
  queued.abortSignal = upstream.signal;
  queued.run = { ...queued.run, config: cfg, agentId: "main", sessionKey, sessionId };
  const selection = { protocolRunId: runId, storePath };
  mailbox.submitSessionControllerInput(sessionKey, queued, { mode: "followup" }, selection);
  const entered = sync.createDeferred();
  const finishPreparation = sync.createDeferred();
  const typing = createTypingController({});
  const preparation = prepareReplyAgentTurn({
    queued,
    defaults: { typing, typingMode: "never", defaultModel: "gpt-test", sessionKey, storePath },
    claimSource: async () => {
      const claim = await mailbox.claimSessionControllerInput(queued);
      entered.resolve();
      await finishPreparation.promise;
      return claim;
    },
  });
  let stopping: ReturnType<typeof killSubagentRunAdmin> | undefined;
  try {
    await gate(entered.promise, preparation);
    const input = queued.controllerInput;
    const claim = input?.claim;
    if (!input || !claim) {
      throw new Error("Preparation did not retain its selected source");
    }
    const interrupted = sync.createDeferred();
    claim.abortController.signal.addEventListener("abort", () => interrupted.resolve(), {
      once: true,
    });
    let stopped = false;
    stopping = killSubagentRunAdmin({ cfg, sessionKey, expectedRunId: runId }).finally(() => {
      stopped = true;
    });
    await gate(interrupted.promise, stopping);
    expect(input.abortSignal.aborted).toBe(true);
    expect(claim.operation).toBeUndefined();
    expect(claim.released).toBe(false);
    expect(stopped).toBe(false);
    finishPreparation.resolve();
    expect(await wait(preparation)).toMatchObject({ kind: "skipped", reason: "aborted" });
    expect(await wait(stopping)).toMatchObject({ found: true, killed: true });
    await wait(input.settlement.promise);
    expect(claim.operation).toBeUndefined();
  } finally {
    upstream.abort();
    finishPreparation.resolve();
    const result = await preparation.catch(() => undefined);
    (result?.kind === "admitted" ? result.turn.operation : result?.operation)?.complete();
    const claim = queued.controllerInput?.claim;
    if (claim) {
      mailbox.releaseSessionControllerClaim(claim);
    }
    await Promise.allSettled([claim?.settlement.promise, stopping]);
    typing.cleanup();
  }
});
