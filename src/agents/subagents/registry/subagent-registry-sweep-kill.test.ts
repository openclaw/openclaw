import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { captureRuntimeConfigAsyncReader, getRuntimeConfig } from "../../../config/config.js";
import { resolveSessionStorePathCore as storePath } from "../../../config/sessions.js";
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
import { createSubagentKillFixture } from "./subagent-registry-sweeper-kill-custody.test-support.js";

vi.mock("./subagent-control-session.js", { spy: true });

beforeEach(async () => {
  await captureRuntimeConfigAsyncReader()();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

it("bounds durable kill reconciliation when an accepted live source never settles", async () => {
  const { entry, childLookup, completeSubagentRunWithRecovery, warn, reconcile } =
    createSubagentKillFixture();
  const identity = { sessionId: "session-id", lifecycleRevision: "session-revision" };
  const target = captureSessionTarget({
    storeScope: storePath(getRuntimeConfig().session?.store, { agentId: "main" }),
    sessionKey: entry.childSessionKey,
    incarnation: identity.sessionId,
  });
  vi.mocked(prepareSubagentKillSession).mockImplementation(async (_cfg, _key, assertOwner) => {
    assertOwner();
    return {
      agentId: "main",
      storePath: target.storeScope,
      entry: { ...identity, updatedAt: Date.now() },
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
  const result = vi.fn();
  const reconciliation = reconcile().then(result);
  onTestFinished(async () => {
    releaseSessionControllerClaim(claim);
    retireSessionControllerInput(source);
    await Promise.all([source.settlement.promise, reconciliation]);
    childLookup.mockRestore();
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
