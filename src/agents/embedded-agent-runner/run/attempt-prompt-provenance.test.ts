import { describe, expect, it, vi } from "vitest";
import { createHookRunner } from "../../../plugins/hooks.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import {
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  testModel,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { prepareEmbeddedAttemptPromptAssembly } from "./attempt-prompt-build.js";
import { forgetPromptBuildDrainCacheForRun } from "./attempt-prompt-helpers.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

registerAgentSessionLoopTestLifecycle();

describe("prompt hook input provenance", () => {
  it.each(["sessions_send", "subagent_settle"])(
    "preserves %s origin through the authorized prompt hook boundary",
    async (sourceTool) => {
      const { session, sessionManager, modelRegistry } = await createTestSession();
      const runId = `provenance-${sourceTool}`;
      const admission = prepareSystemAgentRunAdmission({}, runId, "main", "provenance-test");
      const inputProvenance = { kind: "inter_session" as const, sourceTool };
      const handler = vi.fn(async () => undefined);
      const hookRunner = createHookRunner({
        hooks: [],
        plugins: [],
        typedHooks: [
          {
            pluginId: "provenance-test",
            hookName: "before_prompt_build",
            source: "test",
            requiresToolAuthority: true,
            handler,
          },
        ],
      });
      try {
        const attempt: EmbeddedRunAttemptParams = {
          admittedRunContext: await admission.admit("embedded"),
          authStorage: modelRegistry.authStorage,
          authProfileStore: { version: 1, profiles: {} },
          modelRegistry,
          config: {},
          model: testModel,
          modelId: testModel.id,
          provider: testModel.provider,
          thinkLevel: "off",
          prompt: "Delivery payload",
          runId,
          sessionId: runId,
          sessionKey: `agent:main:webchat:${runId}`,
          sessionFile: "",
          sessionPersistence: "detached",
          trigger: "user",
          inputProvenance,
          timeoutMs: 10_000,
          workspaceDir: "/tmp/provenance-test",
          toolAuthorityFingerprint: "provenance-authority",
        };
        await prepareEmbeddedAttemptPromptAssembly({
          attempt,
          activeSession: session,
          sessionManager,
          hookRunner,
          hookAgentId: "main",
          diagnosticTrace: { traceId: "11111111111111111111111111111111" },
          isRawModelRun: false,
          sessionAgentId: "main",
          runtimeModel: testModel.id,
          systemPromptText: "System",
          applyPromptBuildToolsAllow: () => ["memory_search"],
          setActiveSessionSystemPrompt: vi.fn(),
          setLeasedSteering: vi.fn(),
        });
        expect(handler).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ prompt: "Delivery payload" }),
          expect.objectContaining({ trigger: "user", inputProvenance }),
        );
      } finally {
        admission.close();
        forgetPromptBuildDrainCacheForRun(runId);
      }
    },
  );
});
