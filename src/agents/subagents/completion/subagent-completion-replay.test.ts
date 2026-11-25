import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../../test/helpers/promise.js";
import { createTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import * as config from "../../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { throwCollectedErrors } from "../../../infra/error-graph-internal.js";
import { resolvePreferredOpenClawTmpDir } from "../../../infra/tmp-openclaw-dir.js";
import { getActiveGatewayRootWorkCount } from "../../../process/gateway-work-admission.js";
import { closeOpenClawAgentDatabasesAsync } from "../../../state/openclaw-agent-db.js";
import * as stateDb from "../../../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { loadSubagentRegistryFromSqlite } from "../registry/subagent-registry-state.fixture.test-support.js";
import { settleSubagentRegistryPersistenceWork } from "../registry/subagent-registry.persistence.test-support.js";
import {
  records,
  reopenCompletionFixtureOwners,
  requesterWakeDriver,
  seedSubagentCompletionOwner,
} from "./subagent-completion-admission.test-helpers.js";

const tempDirs = createTempDirTracker();

const env = captureEnv(["OPENCLAW_STATE_DIR"]);
const settle = settleSubagentRegistryPersistenceWork;
beforeEach(() => {
  // Failed resource cleanup retains the capture; retired directories only need removal retry.
  if (tempDirs.dirs.size > 0) {
    throw new Error("Previous completion replay fixture cleanup is incomplete");
  }
  setTestEnvValue(
    "OPENCLAW_STATE_DIR",
    tempDirs.make("openclaw-completion-replay-", resolvePreferredOpenClawTmpDir()),
  );
  config.setRuntimeConfigSnapshot({});
});

afterEach(async () => {
  const failures: unknown[] = [];
  const collect = async (work: () => unknown) => {
    try {
      await work();
    } catch (error) {
      failures.push(error);
    }
  };
  await collect(settle);
  // Preserve stores and their environment while detached delivery still owns them.
  if (getActiveGatewayRootWorkCount() === 0) {
    await collect(async () => {
      for (const dir of tempDirs.dirs) {
        await closeOpenClawAgentDatabasesAsync(dir);
      }
      await stateDb.closeOpenClawStateDatabaseAsync();
      subagentRuns.clear();
      stateDb.closeOpenClawStateDatabaseForTest();
      config.clearRuntimeConfigSnapshot();
      // Keep failed removals tracked without retaining the retired fixture's environment.
      await collect(tempDirs.cleanup);
      env.restore();
    });
  }
  throwCollectedErrors(failures, "Subagent completion replay cleanup failed");
});

async function reopenOwners() {
  await settle();
  await reopenCompletionFixtureOwners();
}

async function runningOwner(signal: AbortSignal) {
  const input = records();
  const { requesterAgentId: agentId, requesterSessionKey: sessionKey } = input.subagent;
  const scope = {
    agentId,
    sessionKey,
    storePath: resolveSessionStorePathCore(undefined, { agentId }),
    sessionId: "requester-session",
  };
  await replaceSessionEntry(scope, { sessionId: "requester-session", updatedAt: Date.now() });
  input.subagent.execution = { status: "running", startedAt: input.subagent.createdAt };
  input.subagent.completion = { required: true };
  input.subagent.delivery = { status: "pending", generation: 1 };
  input.subagent.retainAttachmentsOnKeep = true;
  seedSubagentCompletionOwner(input);
  const driver = requesterWakeDriver([input]);
  const reported = createDeferred();
  driver.controller.options.runSubagentAnnounceFlow = vi.fn<
    typeof driver.controller.options.runSubagentAnnounceFlow
  >(async (params) => {
    await params.onDeliveryResult?.({
      delivered: false,
      path: "direct",
      error: "requester aborted before consuming the child result",
    });
    reported.resolve(undefined);
    return "undelivered";
  });
  const complete = (triggerCleanup: boolean) =>
    withinTest(
      driver.controller.completeSubagentRun({
        runId: input.subagent.runId,
        endedAt: Date.now(),
        outcome: { status: "ok" },
        reason: "subagent-complete",
        terminalReply: { disposition: "visible", text: "canonical result" },
        triggerCleanup,
      }),
      signal,
    );
  const close = async () => {
    driver.controller.clearRuntimeState();
    await settle();
  };
  return { input, driver, reported, complete, close, scope };
}

it("does not replay an announcement settled in requester history", async ({ signal }) => {
  const { input, driver, reported, complete, close, scope } = await runningOwner(signal);
  const expectedDelivery = {
    status: "delivered",
    disposition: "delivered",
    generation: 1,
  };
  try {
    await complete(true);
    await withinTest(reported.promise, signal);
    await settle();
    const stored = loadSubagentRegistryFromSqlite().get(input.subagent.runId)!;
    expect(stored.execution).toMatchObject({ status: "terminal", outcome: { status: "ok" } });
    expect(stored.delivery).toMatchObject(expectedDelivery);
    expect(stored.delivery?.payload).toBeUndefined();
    const history = (await loadTranscriptEvents(scope)).filter(
      (event) =>
        isRecord(event) &&
        event.type === "custom_message" &&
        event.customType === "subagent-completion",
    );
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      display: false,
      content: expect.stringContaining("canonical result"),
      details: { childRunIds: [input.subagent.runId] },
    });
    expect(history[0]).not.toHaveProperty("excludeFromContext");
    expect(stored.requesterSettleWake).toBeUndefined();
    expect(stored.suppressCompletionDelivery).not.toBe(true);
    expect(driver.wake).not.toHaveBeenCalled();
  } finally {
    await close();
  }
  await reopenOwners();
  input.subagent = subagentRuns.get(input.subagent.runId)!;
  const retained = structuredClone(input.subagent);
  const restored = requesterWakeDriver([input]);
  try {
    restored.controller.resumeRequesterSettleWake(input.subagent.runId, input.subagent);
    await settle();
    expect(restored.wake).not.toHaveBeenCalled();
    expect(input.subagent).toEqual(retained);
  } finally {
    restored.controller.clearRuntimeState();
    await settle();
  }
});
