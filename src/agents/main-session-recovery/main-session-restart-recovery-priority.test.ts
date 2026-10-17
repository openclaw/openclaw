import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { admitReplyTurn } from "../../auto-reply/reply/reply-turn-admission.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/io.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import { createContext as createGatewayTestContext } from "../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { resetAgentEventsForTest } from "../../infra/agent-events.js";
import {
  enqueueCommandInLane,
  getQueueSize,
  setCommandLaneConcurrency,
} from "../../process/command-queue.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import { CommandLane } from "../../process/lanes.js";
import { consumeSessionWorkAdmissionHandoff } from "../../sessions/session-lifecycle-admission.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { waitForFast } from "../subagent-test-fixtures.test-helpers.js";
import { createRecoveryRuntimeFixture } from "./main-session-recovery-runtime.test-support.js";
import {
  createRestartRecoveryStoreFixture,
  mainSessionEntry,
} from "./main-session-restart-recovery-fixture.test-support.js";
import { makeUserMessage } from "./main-session-restart-recovery-transcript.test-support.js";
import { retryRestartAbortedMainSessionRecovery } from "./main-session-restart-recovery.js";

let tmpDir: string;
let dispatchSettlement = createDeferred();
const callGateway = vi.fn(async () => ({ runId: "run-resumed" }));
const mockRecoveryRuntime = createRecoveryRuntimeFixture({
  callGateway,
  getDispatchSettlement: () => dispatchSettlement.promise,
  sendRecoveryNotice: async () => ({ suppressed: false }),
});
const { makeSessionsDir, writeStore, writeTranscript } = createRestartRecoveryStoreFixture(
  () => tmpDir,
);
beforeEach(async () => {
  callGateway.mockClear();
  dispatchSettlement = createDeferred();
  resetAgentEventsForTest();
  resetGatewayWorkAdmission();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-recovery-priority-"));
  setRuntimeConfigSnapshot({});
});
afterEach(async () => {
  resetGatewayWorkAdmission();
  await cleanupSessionStateForTest({ stateDir: tmpDir });
  await fs.rm(tmpDir, { recursive: true, force: true });
  clearRuntimeConfigSnapshot();
});

describe("demand-triggered restart recovery", () => {
  it("admits visible input recovery without waiting for unrelated background work", async ({
    signal,
  }) => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionKey = "agent:main:main";
    await writeStore(sessionsDir, { [sessionKey]: mainSessionEntry() });
    await writeTranscript(sessionsDir, "main-session", [
      makeUserMessage("finish the interrupted task"),
    ]);
    const backgroundStarted = createDeferred();
    const releaseBackground = createDeferred();
    const finishRecovery = createDeferred();
    const background = enqueueCommandInLane("background", async () => {
      backgroundStarted.resolve();
      await releaseBackground.promise;
    });
    await backgroundStarted.promise;
    let dispatches = 0;
    let recoveryExecution: Promise<unknown> | undefined;
    const runtime: GatewayRecoveryRuntime = {
      ...mockRecoveryRuntime,
      dispatchAgent: <T>(
        request: Parameters<GatewayRecoveryRuntime["dispatchAgent"]>[0],
        _timeout?: number,
        options?: Parameters<GatewayRecoveryRuntime["dispatchAgent"]>[2],
      ) => {
        dispatches++;
        expect(request.lane).toBe("main");
        if (!request.internalRuntimeHandoffId) {
          throw new Error("Recovery dispatch omitted its session admission handoff");
        }
        const lease = consumeSessionWorkAdmissionHandoff({
          handoffId: request.internalRuntimeHandoffId,
          scope: storePath,
          identities: [sessionKey, "main-session"],
        });
        if (!lease) {
          throw new Error("Recovery dispatch did not transfer its session admission");
        }
        let executionStarted = false;
        options?.onStartOwner?.({
          observe: () => ({ executionStarted, expiresAtMs: Date.now() + 60_000 }),
          abort: () => false,
        });
        options?.onAccepted?.({ runId: request.idempotencyKey });
        const execution = enqueueCommandInLane(request.lane ?? "main", async () => {
          executionStarted = true;
          options?.onExecutionStarted?.();
          await finishRecovery.promise;
          return { runId: request.idempotencyKey, status: "ok" } as T;
        }).finally(() => lease.release());
        recoveryExecution = execution;
        return execution;
      },
    };
    const context = createGatewayTestContext();
    context.recoveryRuntime = runtime;
    const input = admitReplyTurn({
      agentId: "main",
      sessionKey,
      sessionId: "main-session",
      storePath,
      kind: "visible",
      resetTriggered: false,
      waitForActive: false,
      resolveGatewayContext: () => context,
      upstreamAbortSignal: signal,
    });
    let admitted: Awaited<typeof input> | undefined;
    try {
      admitted = await withinTest(input, signal);
      expect(admitted.status).toBe("owned");
      expect(dispatches).toBe(1);
      expect(loadSessionEntry({ storePath, sessionKey })?.abortedLastRun).toBe(false);
      expect(getQueueSize("background")).toBe(1);
    } finally {
      finishRecovery.resolve();
      releaseBackground.resolve();
      if (admitted?.status === "owned") {
        admitted.operation.complete();
      }
      const settled = await input.catch(() => undefined);
      if (settled?.status === "owned") {
        settled.operation.complete();
      }
      await Promise.all([background, recoveryExecution]);
    }
  });

  it.each([false, true])(
    "respects main capacity before recovery ownership (replaced=%s)",
    async (replaced) => {
      const sessionsDir = await makeSessionsDir();
      const storePath = path.join(sessionsDir, "sessions.json");
      const sessionKey = "agent:main:main";
      await writeStore(sessionsDir, { [sessionKey]: mainSessionEntry() });
      await writeTranscript(sessionsDir, "main-session", [
        makeUserMessage("finish interrupted work"),
      ]);
      setCommandLaneConcurrency("main", 1);
      const entered = createDeferred();
      const release = createDeferred();
      const blocker = enqueueCommandInLane("main", async () => {
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      const recovery = retryRestartAbortedMainSessionRecovery({
        agentId: "main",
        sessionKey,
        storePath,
        expectedSessionId: "main-session",
        lane: CommandLane.Main,
        gatewayRuntime: mockRecoveryRuntime,
      });
      try {
        await waitForFast(() => expect(getQueueSize("main")).toBe(2));
        expect(callGateway).not.toHaveBeenCalled();
        expect(loadSessionEntry({ storePath, sessionKey })?.mainRestartRecovery).toMatchObject({
          chargedAttempts: 0,
        });
        expect(
          loadSessionEntry({ storePath, sessionKey })?.mainRestartRecovery?.reservation,
        ).toBeUndefined();
        if (replaced) {
          await replaceSessionEntry(
            { storePath, sessionKey },
            mainSessionEntry({ sessionId: "replacement-session" }),
          );
        }
        release.resolve();
        await expect(recovery).resolves.toMatchObject({ started: replaced ? 0 : 1 });
        expect(callGateway).toHaveBeenCalledTimes(replaced ? 0 : 1);
        expect(loadSessionEntry({ storePath, sessionKey })?.sessionId).toBe(
          replaced ? "replacement-session" : "main-session",
        );
      } finally {
        release.resolve();
        dispatchSettlement.resolve();
        await Promise.allSettled([blocker, recovery]);
      }
    },
  );
});
