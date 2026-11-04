// #143821: prompt-build hook context must carry the turn's typed input provenance so
// plugins can distinguish inter-session deliveries from human messages.
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../config/runtime-snapshot.js";
import * as decisionDiagnostics from "../../../decisions/diagnostics.js";
import type { PluginHookBeforePromptBuildResult } from "../../../plugins/hook-before-agent-start.types.js";
import type { PluginHookAgentContext } from "../../../plugins/hook-types.js";
import { createHookRunner } from "../../../plugins/hooks.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import { forgetPromptBuildDrainCacheForRun } from "../../plugin-turn-context.js";
import {
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  testModel,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { createStubTool } from "../../test-helpers/agent-tool-stubs.js";
import { prepareEmbeddedAttemptPromptAssembly } from "./attempt-prompt-build.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type PromptAssemblyInput = Parameters<typeof prepareEmbeddedAttemptPromptAssembly>[0];

vi.mock("../../../plugins/host-hook-state.js", () => ({
  drainPluginNextTurnInjectionContext: vi.fn(async () => ({ queuedInjections: [] })),
}));

registerAgentSessionLoopTestLifecycle();

afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
});

async function assembleWithCapturedHookCtx({
  attempt: attemptOverrides = {},
  hookResult,
  requiresToolAuthority,
  ...promptPolicy
}: {
  attempt?: Partial<EmbeddedRunAttemptParams>;
  hookResult?: PluginHookBeforePromptBuildResult;
  applyPromptBuildToolsAllow?: PromptAssemblyInput["applyPromptBuildToolsAllow"];
  prepareSystemPrompt?: PromptAssemblyInput["prepareSystemPrompt"];
  requiresToolAuthority?: true;
} = {}) {
  const runId = "provenance-hook-test";
  const config = attemptOverrides.config ?? {};
  setRuntimeConfigSnapshot(config);
  const { session, sessionManager } = await createTestSession({
    customTools: [createStubTool("read")],
  });
  const admission = prepareSystemAgentRunAdmission(config, runId, "main", "provenance-hook-test");
  onTestFinished(() => {
    admission.close();
    forgetPromptBuildDrainCacheForRun(runId);
  });
  const attempt: PromptAssemblyInput["attempt"] = {
    admittedRunContext: await admission.admit("embedded"),
    config,
    model: testModel,
    provider: testModel.provider,
    prompt: "Handoff payload",
    transcriptPrompt: "Handoff payload",
    runId,
    sessionId: runId,
    sessionKey: `agent:main:${runId}`,
    sessionPersistence: "detached",
    trigger: "user",
    workspaceDir: "/tmp/provenance-hook-test",
    ...attemptOverrides,
  };
  const captured: PluginHookAgentContext[] = [];
  const prompts: string[] = [];
  const hookRunner = createHookRunner({
    hooks: [],
    plugins: [],
    typedHooks: [
      {
        pluginId: "provenance-hook-test",
        hookName: "before_prompt_build",
        source: "test",
        requiresToolAuthority,
        handler: async (event: { prompt: string }, ctx: PluginHookAgentContext) => {
          captured.push(ctx);
          prompts.push(event.prompt);
          return hookResult;
        },
      },
    ],
  });
  let systemPrompt = "";
  const priorMessages = structuredClone(session.messages);
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
    systemPromptText: "Base system prompt",
    runAbortSignal: new AbortController().signal,
    hasBaselineTools: () => session.getActiveToolNames().length > 0,
    applyPromptBuildToolsAllow: promptPolicy.applyPromptBuildToolsAllow ?? (() => []),
    prepareSystemPrompt: promptPolicy.prepareSystemPrompt,
    setActiveSessionSystemPrompt: (prompt) => {
      systemPrompt = prompt;
    },
  });
  expect(session.messages).toEqual(priorMessages);
  return { captured, prompts, systemPrompt };
}

describe("prompt-build hook context input provenance", () => {
  it("bounds plugin system context using the resolved attempt budget before assembly", async () => {
    const { systemPrompt } = await assembleWithCapturedHookCtx({
      attempt: { contextTokenBudget: 32_000 },
      hookResult: { prependSystemContext: "x".repeat(824_170) },
    });
    expect(systemPrompt).toContain("[Plugin system context truncated to fit the model budget.]");
    expect(systemPrompt).toContain("Base system prompt");
    expect(systemPrompt.length).toBeLessThan(33_000);
  });

  it("prepares the restricted prompt once before composing the original hook additions", async () => {
    const observeDecision = vi.spyOn(decisionDiagnostics, "logDecisionToolPrefilter");
    const order: string[] = [];
    const applyPolicy = vi.fn((names: string[] | undefined) => {
      order.push("policy");
      expect(names).toEqual(["read"]);
      return ["read"];
    });
    const prepareSystemPrompt = vi.fn(async (current: string) => {
      order.push("prompt");
      expect(current).toBe("Base system prompt");
      return "Filtered capability guidance";
    });
    const { captured, systemPrompt } = await assembleWithCapturedHookCtx({
      hookResult: {
        toolsAllow: ["read"],
        prependSystemContext: "Hook prefix",
        appendSystemContext: "Hook suffix",
      },
      applyPromptBuildToolsAllow: applyPolicy,
      prepareSystemPrompt,
    });
    expect(order).toEqual(["policy", "prompt"]);
    expect(observeDecision).toHaveBeenCalledExactlyOnceWith({ effect: "skipped" });
    expect(captured).toHaveLength(1);
    expect(systemPrompt).toContain("Filtered capability guidance");
    expect(systemPrompt).toContain("Hook prefix");
    expect(systemPrompt).toContain("Hook suffix");
    expect(systemPrompt).not.toContain("Base system prompt");
    expect(systemPrompt.match(/Hook prefix/g)).toHaveLength(1);
    expect(systemPrompt.match(/Hook suffix/g)).toHaveLength(1);
  });

  it.each([{ requiresToolAuthority: undefined }, { requiresToolAuthority: true }] as const)(
    "gates semantic prefilter admission for authority=$requiresToolAuthority",
    async ({ requiresToolAuthority }) => {
      const observeDecision = vi.spyOn(decisionDiagnostics, "logDecisionToolPrefilter");
      const applyPolicy = vi.fn(() => []);
      await assembleWithCapturedHookCtx({
        attempt: { supportsTurnScopedToolRestrictions: true },
        requiresToolAuthority,
        hookResult: { appendContext: "Answer warmly without tools." },
        applyPromptBuildToolsAllow: applyPolicy,
      });
      expect(observeDecision).toHaveBeenCalledExactlyOnceWith({ effect: "skipped" });
      expect(applyPolicy).toHaveBeenCalledExactlyOnceWith(undefined, false);
    },
  );

  it.each([{ requiresToolAuthority: undefined }, { requiresToolAuthority: true }] as const)(
    "shows prompt hooks the user's request on a reload continuation (authority=$requiresToolAuthority)",
    async ({ requiresToolAuthority }) => {
      const { prompts } = await assembleWithCapturedHookCtx({
        attempt: {
          prompt: "A plugin was reloaded while you were working. Continue.",
          pluginRuntimeRefreshUserPrompt: "Recall the Orion launch checklist",
          toolAuthorityFingerprint: "authority-test",
        },
        requiresToolAuthority,
      });
      expect(prompts).toEqual(["Recall the Orion launch checklist"]);
    },
  );

  it.each([
    undefined,
    {
      kind: "inter_session",
      sourceSessionKey: "agent:main:session-a",
      sourceTool: "sessions_send",
    },
  ] as const)("carries typed provenance into the prompt hook: %j", async (inputProvenance) => {
    const { captured } = await assembleWithCapturedHookCtx({
      attempt: { inputProvenance },
    });
    expect(captured).toMatchObject([{ trigger: "user", inputProvenance }]);
  });
});
