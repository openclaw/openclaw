// Covers startup recovery across delayed admission and topology/lifecycle publication.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/config.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import type { callGateway as CallGateway } from "../../gateway/call.js";
import {
  resetAgentEventsForTest,
  rotateAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import {
  createAgentDatabaseInspectionRefusal,
  recordAgentDatabaseAdmissions,
  preparePendingAgentDatabase,
} from "../../state/agent-database-admission.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { createRecoveryRuntimeFixture } from "./main-session-recovery-runtime.test-support.js";
import {
  createRestartRecoveryTranscriptFixture,
  readStore,
  runningSessionEntry,
  writeStore,
} from "./main-session-restart-recovery-fixture.test-support.js";
import * as recoveryMarking from "./main-session-restart-recovery-marking.js";
import { scheduleRestartAbortedMainSessionRecovery as scheduleRecovery } from "./main-session-restart-recovery.js";

// Inject the existing runtime fixture; this suite has no module mocks or hoisted policy.
const callGateway = vi.fn<typeof CallGateway>().mockResolvedValue({ runId: "run-resumed" });
let dispatchSettlement = createDeferred();
const mockRecoveryRuntime = createRecoveryRuntimeFixture({
  callGateway,
  getDispatchSettlement: () => dispatchSettlement.promise,
  sendRecoveryNotice: vi.fn(async () => ({ suppressed: false })),
});
const scheduleRestartAbortedMainSessionRecovery = (
  params: Omit<Parameters<typeof scheduleRecovery>[0], "gatewayRuntime">,
) => scheduleRecovery({ gatewayRuntime: mockRecoveryRuntime, ...params });
let tmpDir: string;
const transcriptFixture = createRestartRecoveryTranscriptFixture(readStore);
const { writeTranscript } = transcriptFixture;

beforeEach(async () => {
  vi.clearAllMocks();
  dispatchSettlement = createDeferred();
  callGateway.mockReset();
  callGateway.mockResolvedValue({ runId: "run-resumed" });
  resetAgentEventsForTest();
  resetGatewayWorkAdmission();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-main-restart-recovery-"));
});
afterEach(async () => {
  resetGatewayWorkAdmission();
  try {
    await transcriptFixture.reset(tmpDir);
  } finally {
    await cleanupSessionStateForTest({ stateDir: tmpDir });
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
async function makeSessionsDir(agentId = "main"): Promise<string> {
  const sessionsDir = path.join(tmpDir, "agents", agentId, "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  return sessionsDir;
}

describe("startup restart recovery admission publication", () => {
  it("recovers a startup orphan exactly once after delayed database admission", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    await writeStore(sessionsDir, {
      "agent:main:main": { ...runningSessionEntry("delayed-session"), updatedAt: 1 },
      "agent:main:fresh": {
        ...runningSessionEntry("fresh-session"),
        updatedAt: Date.now() + 60_000,
      },
    });
    await writeTranscript(sessionsDir, "delayed-session", [
      { role: "user", content: "resume delayed admitted work" },
      { role: "toolResult", content: "done" },
    ]);
    const env = { ...process.env, OPENCLAW_STATE_DIR: tmpDir };
    const refusal = createAgentDatabaseInspectionRefusal({
      agentId: "main",
      paths: [],
      reason: "background inspection",
      pending: true,
    });
    recordAgentDatabaseAdmissions([refusal], { env, source: "startup" });
    const scanned = createDeferred();
    const original = recoveryMarking.markStartupOrphanedMainSessionsForRecovery;
    const marking = vi.spyOn(recoveryMarking, "markStartupOrphanedMainSessionsForRecovery");
    // The actual first scan completes with no eligible stores, before admission publishes.
    marking.mockImplementationOnce(async (params) => {
      const result = await original(params);
      scanned.resolve();
      return result;
    });
    const recovery = scheduleRestartAbortedMainSessionRecovery({
      getConfig: () => ({}),
      delayMs: 0,
      stateDir: tmpDir,
    });
    try {
      await scanned.promise;
      expect(callGateway).not.toHaveBeenCalled();
      await preparePendingAgentDatabase(refusal, { env, assertCurrent: () => {} }, async () => {
        // Intermediate preparation writes also publish topology. The subscriber
        // must not mistake this scope's admission borrow for completed inspection.
        sessionChanges.emit({ all: true, scope: { agentId: "main", topology: true } });
        readStore(storePath);
      });
      sessionChanges.emit({ all: true, scope: { agentId: "main", topology: true } });
      await mockRecoveryRuntime.expectAdmission(1, recovery, {
        storePath,
        sessionKey: "agent:main:main",
      });
      expect(
        loadSessionEntry({ storePath, sessionKey: "agent:main:fresh" })?.abortedLastRun,
      ).toBeUndefined();
      expect(marking).toHaveBeenCalledTimes(2);
    } finally {
      await recovery.stop();
      marking.mockRestore();
    }
  });

  it.each(["stop", "rotation", "removed", "refused"] as const)(
    "does not recover delayed admission after %s",
    async (change) => {
      const sessionsDir = await makeSessionsDir();
      const storePath = path.join(sessionsDir, "sessions.json");
      await writeStore(sessionsDir, {
        "agent:main:main": { ...runningSessionEntry("delayed-session"), updatedAt: 1 },
      });
      await writeTranscript(sessionsDir, "delayed-session", [
        { role: "user", content: "do not dispatch from a retired owner" },
        { role: "toolResult", content: "done" },
      ]);
      const env = { ...process.env, OPENCLAW_STATE_DIR: tmpDir };
      const refusal = createAgentDatabaseInspectionRefusal({
        agentId: "main",
        paths: [],
        reason: "background inspection",
        pending: true,
      });
      recordAgentDatabaseAdmissions([refusal], { env, source: "startup" });
      const scanned = createDeferred();
      const original = recoveryMarking.markStartupOrphanedMainSessionsForRecovery;
      const marking = vi
        .spyOn(recoveryMarking, "markStartupOrphanedMainSessionsForRecovery")
        .mockImplementationOnce(async (params) => {
          const result = await original(params);
          scanned.resolve();
          return result;
        });
      let cfg: OpenClawConfig = {};
      const recovery = scheduleRestartAbortedMainSessionRecovery({
        getConfig: () => cfg,
        delayMs: 0,
        stateDir: tmpDir,
      });
      try {
        await scanned.promise;
        if (change === "stop") {
          await recovery.stop();
        } else if (change === "rotation") {
          rotateAgentEventLifecycleGeneration();
        } else if (change === "removed") {
          cfg = { agents: { entries: { work: {} } } };
        }
        if (change === "refused") {
          recordAgentDatabaseAdmissions(
            [
              createAgentDatabaseInspectionRefusal({
                agentId: "main",
                paths: [],
                reason: "inspection failed",
              }),
            ],
            { env, source: "startup" },
          );
          sessionChanges.emit({ all: true, scope: { agentId: "main", topology: true } });
        } else {
          await preparePendingAgentDatabase(
            refusal,
            { env, assertCurrent: () => {} },
            async () => {},
          );
        }
        await recovery.stop();
        expect(callGateway).not.toHaveBeenCalled();
        expect(
          loadSessionEntry({ storePath, sessionKey: "agent:main:main" })?.abortedLastRun,
        ).toBeUndefined();
      } finally {
        await recovery.stop();
        marking.mockRestore();
      }
    },
  );
});
