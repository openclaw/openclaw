import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { captureRuntimeConfigAsyncReader, getRuntimeConfig } from "../../../config/config.js";
import { resolveSessionStorePathCore } from "../../../config/sessions.js";
import { getAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import {
  captureSessionTarget,
  SESSION_CONTROLLER_DRAIN_TIMEOUT_MS,
} from "../../../sessions/session-controller.lifecycle.js";
import { releaseSessionControllerClaim } from "../../../sessions/session-controller.mailbox-claim.js";
import {
  claimSessionControllerTask,
  reserveSessionControllerSource,
  retireSessionControllerInput,
} from "../../../sessions/session-controller.mailbox.js";
import { prepareSubagentKillSession } from "./subagent-control-session.js";
import { reconcileDurableSubagentKillIntent } from "./subagent-registry-sweep-kill.js";
import {
  createSubagentSweeperChildLookup,
  createSubagentSweeperRun,
} from "./subagent-registry-sweeper.test-support.js";

vi.mock("./subagent-control-session.js", { spy: true });

beforeEach(async () => {
  await captureRuntimeConfigAsyncReader()();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

it("bounds durable kill reconciliation when an accepted live source never settles", async () => {
  const entry = createSubagentSweeperRun();
  entry.killIntent = {
    requestedAt: Date.now(),
    reason: "killed",
    sessionId: "session-id",
    lifecycleGeneration: getAgentEventLifecycleGeneration(),
    sessionLifecycleRevision: "session-revision",
  };
  const runs = new Map([[entry.runId, entry]]);
  const target = captureSessionTarget({
    storeScope: resolveSessionStorePathCore(getRuntimeConfig().session?.store, {
      agentId: "main",
    }),
    sessionKey: entry.childSessionKey,
    incarnation: "session-id",
  });
  vi.mocked(prepareSubagentKillSession).mockImplementation(async (_cfg, _key, assertOwner) => {
    assertOwner();
    return {
      agentId: "main",
      storePath: target.storeScope,
      entry: {
        sessionId: "session-id",
        lifecycleRevision: "session-revision",
        updatedAt: Date.now(),
      },
      assertCurrent: assertOwner,
      prepareRead: () => undefined,
      withPublication: async (publish) => await publish(),
      release: () => {},
    };
  });
  const source = reserveSessionControllerSource(target.sessionKey, {
    target,
    policy: { mode: "followup" },
  });
  const claim = await claimSessionControllerTask(source, () => {});
  const cancelled = new Promise<void>((resolve) => {
    source.abortSignal.addEventListener("abort", () => resolve(), { once: true });
  });
  const completeSubagentRunWithRecovery = vi.fn(async () => {});
  const warn = vi.fn();
  const result = vi.fn();
  const reconciliation = reconcileDurableSubagentKillIntent({
    runId: entry.runId,
    entry,
    runs,
    getRunsForChildSession: createSubagentSweeperChildLookup(runs),
    completeSubagentRunWithRecovery,
    retireSupersededRun: vi.fn(),
    retireObligations: vi.fn(async () => {}),
    warn,
  }).then(result);
  onTestFinished(async () => {
    releaseSessionControllerClaim(claim);
    retireSessionControllerInput(source);
    await Promise.all([source.settlement.promise, reconciliation]);
  });

  await cancelled;
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(SESSION_CONTROLLER_DRAIN_TIMEOUT_MS);

  expect(result).toHaveBeenCalledExactlyOnceWith(false);
  expect(source.abortSignal.aborted).toBe(true);
  expect(claim.released).toBe(false);
  expect(completeSubagentRunWithRecovery).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledWith(
    "failed to finish durable subagent kill intent",
    expect.objectContaining({
      error: expect.objectContaining({ message: expect.stringMatching(/settle.*deadline/i) }),
      runId: entry.runId,
    }),
  );
});
