import { describe, expect, it, vi } from "vitest";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { makeRegistryRun, useSubagentRegistryFixture } from "./subagent-registry-live.test-support.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  appendTranscriptMessage,
  loadExactSessionEntry,
  loadTranscriptEvents,
  patchSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import {
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../../../process/gateway-work-admission.js";
import { prepareInternalSessionEffectsSession } from "../../internal-session-effects.js";
import { writeSubagentSessionEntry } from "./subagent-registry.persistence.test-support.js";
import {
  addSubagentRunForTests,
  replaceSubagentRunAfterSteerCore,
} from "./subagent-registry.test-helpers.js";

describe("subagent steer cleanup", () => {
  const fixture = useSubagentRegistryFixture({ reuseDatabaseWorkers: true });

  it.each([false, true])(
    "keeps replaced hidden-session cleanup admitted until deletion completes (restart fenced: %s)",
    async (restartFenced) => {
      const runId = "run-held-hidden-cleanup";
      const childSessionKey = "agent:main:subagent:held-hidden-cleanup";
      const sessionId = "sess-held-hidden-cleanup";
      const lifecycleRevision = "held-hidden-cleanup-revision";
      const nextRunId = "held-hidden-cleanup-successor";
      const storePath = await writeSubagentSessionEntry({
        stateDir: fixture.stateDir,
        agentId: "main",
        sessionKey: childSessionKey,
        defaultSessionId: sessionId,
        lifecycleRevision,
      });
      const visible = { agentId: "main", storePath, sessionKey: childSessionKey, sessionId };
      const retired = await prepareInternalSessionEffectsSession({
        agentId: "main",
        runId,
        source: visible,
        storePath,
      });
      await appendTranscriptMessage(retired, {
        message: {
          role: "assistant",
          content: "Retained child progress",
          timestamp: Date.now(),
        },
      });
      const successor = await prepareInternalSessionEffectsSession({
        agentId: "main",
        runId: nextRunId,
        source: retired,
        storePath,
      });
      await addSubagentRunForTests(
        makeRegistryRun({
          runId,
          childSessionKey,
          childSessionIdentity: { sessionId, lifecycleRevision },
          expectsCompletionMessage: false,
          execution: { status: "running", startedAt: Date.now(), transcriptTarget: retired },
        }),
      );
      await fixture.settle();
      const parent = tryBeginGatewayRootWorkAdmission("test:replacement");
      if (!parent) {
        throw new Error("expected an admitted replacement parent");
      }
      const entered = createDeferred();
      const released = createDeferred();
      // Hold the real FIFO without leaving a SQLite transaction open.
      const blocker = patchSessionEntryCore(
        visible,
        async () => {
          entered.resolve();
          await released.promise;
          return null;
        },
        { skipMaintenance: true },
      );
      try {
        await entered.promise;
        await parent.run(async () => {
          if (restartFenced) {
            markGatewayRestartDraining();
          }
          expect(
            await replaceSubagentRunAfterSteerCore({
              previousRunId: runId,
              nextRunId,
              transcriptTarget: successor,
            }),
          ).toBe(true);
        });
        parent.release();
        expect(loadExactSessionEntry(retired)?.entry.sessionId).toBe(retired.sessionId);
        expect(getActiveGatewayRootWorkCount()).toBe(1);
      } finally {
        parent.release();
        released.resolve();
        try {
          await blocker;
          await fixture.settle();
          // Settle the original untracked deletion too when the ownership assertion fails.
          await vi.waitFor(() => expect(loadExactSessionEntry(retired)).toBeUndefined());
        } finally {
          if (getActiveGatewayRootWorkCount() === 0) {
            resetGatewayWorkAdmission();
          }
        }
      }
      expect(loadExactSessionEntry(successor)?.entry.sessionId).toBe(successor.sessionId);
      expect(loadExactSessionEntry(visible)?.entry.sessionId).toBe(sessionId);
      expect(await loadTranscriptEvents(successor)).toContainEqual(
        expect.objectContaining({
          type: "message",
          message: expect.objectContaining({ content: "Retained child progress" }),
        }),
      );
    },
  );
});
