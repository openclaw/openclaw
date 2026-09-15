import { describe, expect, it, vi } from "vitest";
import type { ContextEngine } from "../../../context-engine/types.js";
import { getAgentRunLifecycleGeneration } from "../../../infra/agent-run-registry.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { createEmbeddedRunCompactionRuntime } from "./compaction-runtime.js";
import { createEmbeddedRunSessionPromptState } from "./session-prompt-state.js";

describe("compaction recovery caller authorization", () => {
  it("blocks recovery assertions after caller visibility is revoked", async () => {
    const admission = prepareSystemAgentRunAdmission(
      {},
      "run-compaction-caller-revoke",
      "main",
      "compaction-authz-test",
    );
    const admitted = await admission.admit("embedded");
    try {
      const sessionManager = SessionManager.inMemory("/tmp/workspace");
      const sessionId = sessionManager.getSessionId();
      const target = {
        agentId: "main",
        sessionId,
        sessionKey: "agent:main:session-1",
        storePath: "/tmp/compaction-authz-unused.sqlite",
      };
      const runParams = {
        admittedRunContext: admitted,
        runId: "run-compaction-caller-revoke",
        sessionId,
        sessionKey: target.sessionKey,
        sessionFile: target.sessionKey,
        sessionTarget: target,
        sessionManager,
        config: {},
        workspaceDir: "/tmp/workspace",
        prompt: "continue",
        timeoutMs: 1_000,
        assertRunAuthorization: () => {
          if (!callerAuthorized) {
            throw callerError;
          }
        },
      };
      const sessionPromptState = createEmbeddedRunSessionPromptState({
        runParams,
        sessionAgentId: "main",
        resolvedSessionKey: target.sessionKey,
        lifecycleGeneration: getAgentRunLifecycleGeneration(),
      });
      const compact = vi.fn();
      const ingest = vi.fn();
      const assemble = vi.fn();
      const contextEngine = {
        info: { id: "fixture", name: "Fixture engine" },
        ingest,
        assemble,
        compact,
      } as unknown as ContextEngine;

      let callerAuthorized = true;
      const callerError = new Error("caller visibility revoked");

      const runtime = createEmbeddedRunCompactionRuntime({
        runParams,
        contextEngine,
        hookRunner: null,
        hookContext: {
          agentId: "main",
          sessionId,
          sessionKey: target.sessionKey,
          workspaceDir: runParams.workspaceDir,
        },
        sessionPromptState,
      });

      expect(() => runtime.assertRecoveryActive()).not.toThrow();

      callerAuthorized = false;
      expect(() => runtime.assertRecoveryActive()).toThrow(callerError);
      expect(() => runtime.assertRecoveryActive()).toThrow(callerError);
      expect(ingest).not.toHaveBeenCalled();
      expect(assemble).not.toHaveBeenCalled();
      expect(compact).not.toHaveBeenCalled();
    } finally {
      admission.close();
    }
  });
});
