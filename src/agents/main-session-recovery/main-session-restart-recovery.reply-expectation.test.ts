import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/io.js";
import { createMockGatewayRecoveryRuntime } from "../../gateway/server-recovery-runtime.test-support.js";
import { resetAgentEventsForTest } from "../../infra/agent-events.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { createRestartRecoveryStoreFixture } from "./main-session-restart-recovery-fixture.test-support.js";
import { makeUserMessage } from "./main-session-restart-recovery-transcript.test-support.js";
import { retryRestartAbortedMainSessionRecovery } from "./main-session-restart-recovery.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let tmpDir: string;
const { makeMainSessionFixture, writeTranscript } = createRestartRecoveryStoreFixture(() => tmpDir);

it.each(["required", "optional", "result-required", undefined] as const)(
  "preserves %s reply expectation in host-owned recovery dispatch",
  async (replyExpectation) => {
    tmpDir = tempDirs.make("openclaw-recovery-empty-success-");
    resetAgentEventsForTest();
    resetGatewayWorkAdmission();
    setRuntimeConfigSnapshot({});
    try {
      const sourceRunId = "slack-source-156814";
      const recoveryRunId = "slack-recovery-156814";
      const { sessionsDir, storePath, sessionKey, readEntry } = await makeMainSessionFixture({
        sessionKey: "agent:main:slack:channel:c_synthetic",
        restartRecoveryDeliveryRunId: recoveryRunId,
        restartRecoveryDeliverySourceRunId: sourceRunId,
        restartRecoverySourceIngress: "channel",
        restartRecoveryReplyExpectation: replyExpectation,
        restartRecoverySourceReplyDeliveryMode: "automatic",
        restartRecoveryDeliveryContext: { channel: "slack", to: "channel:C_SYNTHETIC" },
      });
      await writeTranscript(sessionsDir, "main-session", [
        makeUserMessage("Return the synthetic requested answer.", {
          provenance: { kind: "external_user" },
        }),
      ]);
      const gatewayRuntime = createMockGatewayRecoveryRuntime();
      vi.mocked(gatewayRuntime.dispatchAgent).mockResolvedValue({
        runId: recoveryRunId,
        status: "ok",
        summary: "completed",
        result: {
          payloads: [{ text: "Restored answer" }],
          meta: { durationMs: 0 },
        },
      });

      const result = await retryRestartAbortedMainSessionRecovery({
        agentId: "main",
        storePath,
        sessionKey,
        expectedSessionId: "main-session",
        stateDir: tmpDir,
        cfg: {},
        gatewayRuntime,
      });

      expect(result).toEqual({ started: 0, settled: 1, failed: 0, skipped: 0 });
      expect(gatewayRuntime.dispatchAgent).toHaveBeenCalledOnce();
      expect(vi.mocked(gatewayRuntime.dispatchAgent).mock.calls[0]?.[0]).toMatchObject({
        channel: "slack",
        to: "channel:C_SYNTHETIC",
        deliver: true,
        inputProvenance: { kind: "internal_system" },
      });
      const dispatch = vi.mocked(gatewayRuntime.dispatchAgent).mock.calls[0];
      expect(dispatch?.[2]?.replyExpectation).toBe(replyExpectation);
      expect(dispatch?.[0]).not.toHaveProperty("replyExpectation");
      expect(readEntry()).toMatchObject({ status: "done", abortedLastRun: false });
      expect(readEntry()?.mainRestartRecovery).toBeUndefined();
      expect(readEntry()?.restartRecoveryTerminalRunIds).toEqual(
        expect.arrayContaining([sourceRunId, recoveryRunId]),
      );
      expect(readEntry()?.restartRecoveryReplyExpectation).toBeUndefined();
    } finally {
      await cleanupSessionStateForTest({ stateDir: tmpDir });
      resetGatewayWorkAdmission();
      resetAgentEventsForTest();
      clearRuntimeConfigSnapshot();
    }
  },
);
