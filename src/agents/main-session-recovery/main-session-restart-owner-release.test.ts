import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/io.js";
import type { callGateway as gatewayCall } from "../../gateway/call.js";
import { resetAgentEventsForTest } from "../../infra/agent-events.js";
import * as gatewayWorkAdmission from "../../process/gateway-work-admission.js";
import {
  beginSessionEffect,
  captureSessionControllerSettlement,
  captureSessionTarget,
} from "../../sessions/session-controller.lifecycle.js";
import {
  reserveSessionControllerSource,
  retireSessionControllerInput,
} from "../../sessions/session-controller.mailbox.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  createRecoveryRuntimeFixture,
  observeRecoveryRoots,
} from "./main-session-recovery-runtime.test-support.js";
import {
  createRestartRecoveryStoreFixture,
  readStore,
  runningSessionEntry,
} from "./main-session-restart-recovery-fixture.test-support.js";
import * as recoveryMarking from "./main-session-restart-recovery-marking.js";
import {
  makeToolResultMessage,
  makeUserMessage,
} from "./main-session-restart-recovery-transcript.test-support.js";
import { scheduleRestartAbortedMainSessionRecovery as scheduleRecovery } from "./main-session-restart-recovery.js";

let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
let dispatchSettlement = createDeferred();
const callGateway = vi.fn<(params: Parameters<typeof gatewayCall>[0]) => Promise<unknown>>();
const gatewayRuntime = createRecoveryRuntimeFixture({
  callGateway,
  getDispatchSettlement: () => dispatchSettlement.promise,
  sendRecoveryNotice: vi.fn(async () => ({ suppressed: false })),
});
const { makeSessionsDir, writeStore, writeTranscript } = createRestartRecoveryStoreFixture(
  () => state.root,
);
const scheduleRestartAbortedMainSessionRecovery = () =>
  scheduleRecovery({
    stateDir: state.root,
    getConfig: () => ({}),
    gatewayRuntime,
  });
const gatewayParams = () => callGateway.mock.calls[0]?.[0].params;

beforeEach(async () => {
  state = await createOpenClawTestState({ scenario: "minimal" });
  callGateway.mockReset();
  dispatchSettlement = createDeferred();
  resetAgentEventsForTest();
  gatewayWorkAdmission.resetGatewayWorkAdmission();
  setRuntimeConfigSnapshot({});
});
afterEach(async () => {
  gatewayWorkAdmission.resetGatewayWorkAdmission();
  clearRuntimeConfigSnapshot();
  await state.cleanup();
});

it.for(["abandoned", "completed", "replaced", "stopped"] as const)(
  "revisits a startup orphan after its temporary controller owner releases (%s)",
  async (outcome, { signal }) => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionKey = "agent:main:main";
    await writeStore(sessionsDir, {
      [sessionKey]: { ...runningSessionEntry("main-session"), abortedLastRun: false },
    });
    await writeTranscript(sessionsDir, "main-session", [
      makeUserMessage("finish the interrupted task"),
      makeToolResultMessage("already completed effect"),
    ]);
    const owner = await beginSessionEffect({
      scope: storePath,
      identities: [sessionKey, "main-session"],
      assertAllowed: () => {},
    });
    const firstPass = observeRecoveryRoots("main-session:startup-recovery", 1);
    const dispatched = createDeferred();
    vi.mocked(callGateway).mockImplementationOnce(async () => {
      dispatched.resolve();
      return { runId: "run-resumed" };
    });
    const recovery = scheduleRestartAbortedMainSessionRecovery();
    try {
      await withinTest(firstPass.completed, signal);
      expect(callGateway).not.toHaveBeenCalled();
      expect(readStore(storePath)[sessionKey]?.abortedLastRun).toBe(false);
      firstPass.restore();
      const nextPass = observeRecoveryRoots("main-session:startup-recovery", 1);
      try {
        if (outcome === "completed") {
          await writeStore(sessionsDir, {
            [sessionKey]: { sessionId: "main-session", updatedAt: Date.now(), status: "done" },
          });
        } else if (outcome === "replaced") {
          await writeStore(sessionsDir, {
            [sessionKey]: {
              ...runningSessionEntry("replacement-session"),
              updatedAt: Date.now() + 60_000,
            },
          });
        } else if (outcome === "stopped") {
          await withinTest(recovery.stop(), signal);
        }
        owner.release();
        if (outcome === "abandoned") {
          await withinTest(dispatched.promise, signal);
          expect(callGateway).toHaveBeenCalledOnce();
          expect(gatewayParams()).toMatchObject({ sessionKey });
        } else {
          if (outcome !== "stopped") {
            await withinTest(nextPass.completed, signal);
          }
          expect(callGateway).not.toHaveBeenCalled();
        }
      } finally {
        nextPass.restore();
      }
    } finally {
      owner.release();
      dispatchSettlement.resolve();
      await recovery.stop();
      firstPass.restore();
    }
  },
);

it("observes rejected duplicate startup owner settlement captures", async () => {
  const captured = createDeferred();
  const stale = new Error("Session reader validation is no longer current");
  const unhandled: unknown[] = [];
  const captures: Promise<void>[] = [];
  const listener = (reason: unknown) => unhandled.push(reason);
  const target = {
    agentId: "main",
    storePath: path.join(state.root, "agents", "main", "sessions", "sessions.json"),
    sessionKey: "agent:main:main",
    sessionId: "main-session",
  };
  const source = reserveSessionControllerSource(target.sessionKey, {
    target: captureSessionTarget({
      storeScope: target.storePath,
      sessionKey: target.sessionKey,
      incarnation: target.sessionId,
    }),
    policy: { mode: "followup" },
    adapter: {
      onSettled() {
        throw stale;
      },
    },
  });
  using marker = vi.spyOn(recoveryMarking, "markStartupOrphanedMainSessionsForRecovery");
  marker.mockImplementationOnce(async (params) => {
    // Repeated scans capture distinct receipts for the same still-live source.
    for (let index = 0; index < 2; index++) {
      const settled = captureSessionControllerSettlement({
        scope: target.storePath,
        identities: [target.sessionKey, target.sessionId],
      });
      expect(settled).toBeDefined();
      captures.push(settled!);
      params.onOwnerPending?.(target, settled!);
    }
    captured.resolve();
    return { marked: 0, skipped: 0 };
  });
  process.on("unhandledRejection", listener);
  const recovery = scheduleRestartAbortedMainSessionRecovery();
  try {
    await captured.promise;
    await recovery.stop();
    retireSessionControllerInput(source);
    await expect(source.settlement.promise).rejects.toBe(stale);
    await expect(captures[0]).rejects.toBe(stale);
    await nextTurn();
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", listener);
    retireSessionControllerInput(source);
    await recovery.stop();
  }
});
