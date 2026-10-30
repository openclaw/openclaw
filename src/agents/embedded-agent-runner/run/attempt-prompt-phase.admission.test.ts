import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { resolveDefaultSessionStorePath } from "../../../config/sessions/paths.js";
import { upsertSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { runOpenClawAgentWorkerWrite } from "../../../state/openclaw-agent-write-admission.js";
import { useSessionStoreTempDirs } from "../../../test-utils/session-state-cleanup.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { createToolResultPromptProjectionState } from "../session-prompt-state.js";
import { runEmbeddedAttemptPromptPhase } from "./attempt-prompt-phase.js";
import type { PromptSubmissionCall } from "./attempt-prompt-phase.test-support.js";

// Register the shared module mocks before importing any runtime dependency.
const { createFixture, mocks } = await vi.hoisted(
  async () => await import("./attempt-prompt-phase.test-support.js"),
);
const tempStateDirs = useSessionStoreTempDirs(afterAll, "openclaw-prompt-projection-admission-");

afterEach(() => vi.unstubAllEnvs());

it.each([false, true])(
  "admits projection persistence before provider dispatch and rechecks cancellation (abort: %s)",
  async (abort) => {
    vi.clearAllMocks();
    mocks.applyPromptToolsAllow.mockReset();
    vi.stubEnv("OPENCLAW_STATE_DIR", tempStateDirs.make());
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:projection-admission",
      sessionId: "projection-admission",
      storePath: resolveDefaultSessionStorePath("main"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const manager = SessionManager.open(scope);
    const { input, promptState } = createFixture();
    input.prepared.sessionRuntime.sessionManager = manager;
    const projection = createToolResultPromptProjectionState();
    projection.frozen.add("tool-result");
    projection.sourceHashByKey.set("tool-result", "source");
    projection.replacements.set("tool-result", {
      content: [{ type: "text", text: "bounded result" }],
    });
    input.prepared.sessionRuntime.toolResultPromptProjectionState = projection;
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const requested = createDeferredCore();
    const worker = runOpenClawAgentWorkerWrite({ agentId: scope.agentId }, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    let dispatched = false;
    mocks.submitPrompt.mockImplementation(async (submission: PromptSubmissionCall) => {
      requested.resolve();
      await submission.persistToolResultProjections();
      dispatched = true;
    });
    const markers = () => manager.getEntries().filter((entry) => entry.type === "custom");
    const phase = runEmbeddedAttemptPromptPhase(input, promptState);
    try {
      await requested.promise;
      await yieldToEventLoop();
      expect([markers(), dispatched]).toEqual([[], false]);
      const reason = new Error("attempt cancelled while waiting for database");
      if (abort) {
        input.runAbortController.abort(reason);
      }
      release.resolve();
      await Promise.all([worker, phase]);
      expect(dispatched).toBe(!abort);
      expect(markers()).toMatchObject(abort ? [] : [{ customType: "openclaw.cache-ttl" }]);
      if (abort) {
        expect(mocks.handlePromptError).toHaveBeenCalledWith(
          expect.objectContaining({ error: reason }),
        );
      } else {
        expect(mocks.handlePromptError).not.toHaveBeenCalled();
      }
    } finally {
      release.resolve();
      await Promise.allSettled([worker, phase]);
    }
  },
);
