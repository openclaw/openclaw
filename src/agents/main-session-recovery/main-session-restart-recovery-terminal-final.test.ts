import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { withinTest } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/io.js";
import { loadSessionEntry, loadTranscriptEvents } from "../../config/sessions/session-accessor.js";
import {
  resetAgentEventsForTest,
  rotateAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { createRecoveryRuntimeFixture } from "./main-session-recovery-runtime.test-support.js";
import { createRestartRecoveryStoreFixture } from "./main-session-restart-recovery-fixture.test-support.js";
import { textContent } from "./main-session-restart-recovery-transcript.test-support.js";
import { recoverRestartAbortedMainSessions } from "./main-session-restart-recovery.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let tmpDir: string;
const callGateway = vi.fn();
const gatewayRuntime = createRecoveryRuntimeFixture({
  callGateway,
  getDispatchSettlement: async () => {},
  sendRecoveryNotice: async () => ({ suppressed: false }),
});
const { makeMainSessionFixture, writeTranscript } = createRestartRecoveryStoreFixture(() => tmpDir);

beforeEach(() => {
  callGateway.mockReset();
  resetAgentEventsForTest();
  resetGatewayWorkAdmission();
  tmpDir = tempDirs.make("openclaw-recovery-terminal-final-");
  setRuntimeConfigSnapshot({});
});

afterEach(async () => {
  resetGatewayWorkAdmission();
  await cleanupSessionStateForTest({ stateDir: tmpDir });
  clearRuntimeConfigSnapshot();
});

it("settles a terminally failed legacy pending final once across boots", async ({ signal }) => {
  const { sessionsDir, storePath } = await makeMainSessionFixture({
    pendingFinalDelivery: {
      kind: "replayable",
      text: "The saved answer is 42.",
      createdAt: Date.now() - 5_000,
      context: { channel: "discord", to: "discord:dm:123" },
    },
  });
  await writeTranscript(sessionsDir, "main-session", [
    { role: "user", content: "calculate the answer" },
  ]);
  callGateway.mockResolvedValueOnce({
    runId: "run-resumed",
    status: "error",
    error: "non-retryable provider 400",
    endedAt: Date.now(),
  });

  await expect(
    recoverRestartAbortedMainSessions({ stateDir: tmpDir, gatewayRuntime }),
  ).resolves.toEqual({ started: 0, settled: 1, failed: 0, skipped: 0 });

  expect(callGateway).toHaveBeenCalledOnce();
  const settled = loadSessionEntry({ sessionKey: "agent:main:main", storePath });
  expect(settled).toMatchObject({ status: "failed", abortedLastRun: false });
  expect(settled?.pendingFinalDelivery).toBeUndefined();
  const loadTranscript = () =>
    loadTranscriptEvents({
      sessionId: "main-session",
      sessionKey: "agent:main:main",
      storePath,
    });
  const transcript = await withinTest(loadTranscript(), signal);
  expect(transcript.at(-1)).toMatchObject({
    message: {
      role: "assistant",
      content: textContent(
        expect.stringContaining("Saved reply (delivery unconfirmed):\nThe saved answer is 42."),
      ),
    },
  });

  resetAgentEventsForTest();
  rotateAgentEventLifecycleGeneration();
  await expect(
    recoverRestartAbortedMainSessions({ stateDir: tmpDir, gatewayRuntime }),
  ).resolves.toEqual({ started: 0, settled: 0, failed: 0, skipped: 0 });

  expect(callGateway).toHaveBeenCalledOnce();
  expect(await loadTranscript()).toEqual(transcript);
});
