import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { InternalSessionEntry } from "../../config/sessions.js";
import {
  appendTranscriptMessage,
  loadSessionEntry as loadSessionEntryRaw,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { callGateway } from "../../gateway/call.js";
import { resetAgentEventsForTest } from "../../infra/agent-events.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import {
  getSessionWorkAdmissionOwnerRelease,
  interruptSessionWorkAdmissions,
  runExclusiveSessionLifecycleMutation,
} from "../../sessions/session-lifecycle-admission.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { waitForFast } from "../subagent-test-fixtures.test-helpers.js";
import { MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER } from "./main-session-recovery-admission.js";
import { createMainSessionRecoveryCapacity } from "./main-session-recovery-capacity.js";
import { createRecoveryRuntimeFixture } from "./main-session-recovery-runtime.test-support.js";
import {
  recoverRestartAbortedMainSessions as recoverRestartAbortedMainSessionsBase,
  retryRestartAbortedMainSessionRecovery,
} from "./main-session-restart-recovery.js";

vi.mock("../../gateway/call.js", () => ({
  callGateway: vi.fn(async () => ({ runId: "run-resumed" })),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let dispatchSettlement = createDeferred();
const gatewayRuntime = createRecoveryRuntimeFixture({
  callGateway,
  getDispatchSettlement: () => dispatchSettlement.promise,
  sendRecoveryNotice: async () => ({ suppressed: false }),
});

function loadSessionEntry(scope: Parameters<typeof loadSessionEntryRaw>[0]) {
  return loadSessionEntryRaw(scope) as InternalSessionEntry | undefined;
}

const recoverRestartAbortedMainSessions = (
  params: Omit<Parameters<typeof recoverRestartAbortedMainSessionsBase>[0], "gatewayRuntime">,
) => recoverRestartAbortedMainSessionsBase({ ...params, gatewayRuntime });

function gatewayParams() {
  return vi.mocked(callGateway).mock.calls[0]?.[0].params;
}

describe("startup recovery admission", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    dispatchSettlement = createDeferred();
    resetAgentEventsForTest();
    resetGatewayWorkAdmission();
    tmpDir = tempDirs.make("openclaw-recovery-admission-");
  });

  afterEach(async () => {
    resetGatewayWorkAdmission();
    await cleanupSessionStateForTest({ stateDir: tmpDir });
  });

  async function makeMainSessionFixture() {
    const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionKey = "agent:main:main";
    await fs.mkdir(sessionsDir, { recursive: true });
    await replaceSessionEntry(
      { sessionKey, storePath },
      {
        sessionId: "main-session",
        permissionMode: "guarded",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
      },
    );
    return { sessionsDir, storePath, sessionKey };
  }

  async function writeCompletedToolTranscript(sessionsDir: string) {
    for (const message of [
      { role: "user", content: "run the tool" },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "exec" }] },
      { role: "toolResult", content: "done" },
    ]) {
      await appendTranscriptMessage(
        {
          sessionId: "main-session",
          sessionKey: "agent:main:main",
          storePath: path.join(sessionsDir, "sessions.json"),
        },
        { message, cwd: sessionsDir },
      );
    }
  }

  it("skips a recovery target replaced while its admission waits", async () => {
    const { storePath, sessionKey } = await makeMainSessionFixture();
    const mutationEntered = createDeferred();
    const releaseMutation = createDeferred();
    const mutation = runExclusiveSessionLifecycleMutation({
      scope: storePath,
      identities: [sessionKey, "main-session"],
      run: async () => {
        mutationEntered.resolve();
        await releaseMutation.promise;
        await replaceSessionEntry(
          { storePath, sessionKey },
          { sessionId: "replacement-session", updatedAt: Date.now(), status: "done" },
        );
      },
    });
    await mutationEntered.promise;
    const recovery = retryRestartAbortedMainSessionRecovery({
      expectedSessionId: "main-session",
      storePath,
      sessionKey,
      gatewayRuntime,
    });
    try {
      await waitForFast(() =>
        expect(
          getSessionWorkAdmissionOwnerRelease({
            scope: storePath,
            identities: [sessionKey, "main-session"],
            owner: MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER,
          }),
        ).toBeDefined(),
      );
      releaseMutation.resolve();
      await mutation;
      await expect(recovery).resolves.toEqual({ started: 0, settled: 0, failed: 0, skipped: 1 });
      expect(callGateway).not.toHaveBeenCalled();
      expect(loadSessionEntry({ storePath, sessionKey })).toMatchObject({
        sessionId: "replacement-session",
        status: "done",
      });
    } finally {
      releaseMutation.resolve();
      await Promise.allSettled([mutation, recovery]);
    }
  });

  it.each(["resume", "interrupt"] as const)(
    "owns startup recovery while waiting for capacity and releases on %s",
    async (action) => {
      const { sessionsDir, storePath, sessionKey } = await makeMainSessionFixture();
      await writeCompletedToolTranscript(sessionsDir);
      const capacity = createMainSessionRecoveryCapacity({ limit: 1 });
      const releaseCapacity = await capacity.acquire(() => true);
      let keepRunning = true;
      const recovery = recoverRestartAbortedMainSessions({
        stateDir: tmpDir,
        recoveryCapacity: capacity,
        shouldContinue: () => keepRunning,
      });
      try {
        await waitForFast(() =>
          expect(
            loadSessionEntry({ sessionKey, storePath })?.mainRestartRecovery?.reservation,
          ).toBeDefined(),
        );
        const ownerReleased = getSessionWorkAdmissionOwnerRelease({
          scope: storePath,
          identities: [sessionKey, "main-session"],
          owner: MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER,
        });
        expect(ownerReleased).toBeDefined();
        expect(callGateway).not.toHaveBeenCalled();

        if (action === "interrupt") {
          await expect(
            interruptSessionWorkAdmissions({
              scope: storePath,
              identities: [sessionKey, "main-session"],
            }),
          ).resolves.toBe(true);
          await expect(recovery).resolves.toMatchObject({ started: 0, failed: 0, skipped: 1 });
          expect(callGateway).not.toHaveBeenCalled();
          expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
            abortedLastRun: true,
            mainRestartRecovery: { chargedAttempts: 0 },
          });
          expect(
            loadSessionEntry({ sessionKey, storePath })?.mainRestartRecovery?.reservation,
          ).toBeUndefined();
        } else {
          releaseCapacity?.();
          await expect(recovery).resolves.toMatchObject({ started: 1, failed: 0 });
          expect(callGateway).toHaveBeenCalledOnce();
          expect(gatewayParams()).toMatchObject({ internalRuntimeHandoffId: expect.any(String) });
          expect(loadSessionEntry({ sessionKey, storePath })?.abortedLastRun).toBe(false);
        }
        await ownerReleased;
        expect(
          getSessionWorkAdmissionOwnerRelease({
            scope: storePath,
            identities: [sessionKey, "main-session"],
            owner: MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER,
          }),
        ).toBeUndefined();
      } finally {
        keepRunning = false;
        releaseCapacity?.();
        dispatchSettlement.resolve();
        await recovery;
      }
    },
  );
});
