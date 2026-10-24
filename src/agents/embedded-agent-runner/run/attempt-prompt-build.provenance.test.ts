// #143821: prompt-build hook context must carry the turn's typed input provenance so
// plugins can distinguish inter-session deliveries from human messages.
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
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

beforeEach(() => {
  setRuntimeConfigSnapshot({});
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
});

async function assembleWithCapturedHookCtx(
  runId: string,
  attemptOverrides?: Partial<EmbeddedRunAttemptParams>,
  promptPolicy: {
    hookResult?: PluginHookBeforePromptBuildResult;
    applyPromptBuildToolsAllow?: PromptAssemblyInput["applyPromptBuildToolsAllow"];
    prepareSystemPrompt?: PromptAssemblyInput["prepareSystemPrompt"];
    requiresToolAuthority?: true;
  } = {},
) {
  const config = attemptOverrides?.config ?? {};
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
  const hookRunner = createHookRunner({
    hooks: [],
    plugins: [],
    typedHooks: [
      {
        pluginId: "provenance-hook-test",
        hookName: "before_prompt_build",
        source: "test",
        requiresToolAuthority: promptPolicy.requiresToolAuthority,
        handler: async (_event: unknown, ctx: PluginHookAgentContext) => {
          captured.push(ctx);
          return promptPolicy.hookResult;
        },
      },
    ],
  });
  const setSystemPrompt = vi.fn<(prompt: string) => void>();
  const priorMessages = structuredClone(session.messages);
  const prompt = await prepareEmbeddedAttemptPromptAssembly({
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
    setActiveSessionSystemPrompt: setSystemPrompt,
  });
  expect(session.messages).toEqual(priorMessages);
  return { captured, prompt, setSystemPrompt };
}

describe("prompt-build hook context input provenance", () => {
  it("bounds plugin system context using the resolved attempt budget before assembly", async () => {
    const { setSystemPrompt } = await assembleWithCapturedHookCtx(
      "bounded-plugin-system-context",
      { contextTokenBudget: 32_000 },
      { hookResult: { prependSystemContext: "x".repeat(824_170) } },
    );
    const finalPrompt = setSystemPrompt.mock.calls.at(-1)?.[0] ?? "";
    expect(finalPrompt).toContain("[Plugin system context truncated to fit the model budget.]");
    expect(finalPrompt).toContain("Base system prompt");
    expect(finalPrompt.length).toBeLessThan(33_000);
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
    const { captured, setSystemPrompt } = await assembleWithCapturedHookCtx(
      "prompt-policy-composition",
      undefined,
      {
        hookResult: {
          toolsAllow: ["read"],
          prependSystemContext: "Hook prefix",
          appendSystemContext: "Hook suffix",
        },
        applyPromptBuildToolsAllow: applyPolicy,
        prepareSystemPrompt,
      },
    );
    expect(order).toEqual(["policy", "prompt"]);
    expect(observeDecision).toHaveBeenCalledExactlyOnceWith({ effect: "skipped" });
    expect(captured).toHaveLength(1);
    expect(prepareSystemPrompt).toHaveBeenCalledOnce();
    const finalPrompt = setSystemPrompt.mock.calls.at(-1)?.[0] ?? "";
    expect(finalPrompt).toContain("Filtered capability guidance");
    expect(finalPrompt).toContain("Hook prefix");
    expect(finalPrompt).toContain("Hook suffix");
    expect(finalPrompt).not.toContain("Base system prompt");
    expect(finalPrompt.match(/Hook prefix/g)).toHaveLength(1);
    expect(finalPrompt.match(/Hook suffix/g)).toHaveLength(1);
  });

  it.each([{ requiresToolAuthority: undefined }, { requiresToolAuthority: true }] as const)(
    "gates semantic prefilter admission for authority=$requiresToolAuthority",
    async ({ requiresToolAuthority }) => {
      const observeDecision = vi.spyOn(decisionDiagnostics, "logDecisionToolPrefilter");
      const applyPolicy = vi.fn(() => []);
      await assembleWithCapturedHookCtx(
        "hook-prefilter-admission",
        { supportsTurnScopedToolRestrictions: true },
        {
          requiresToolAuthority,
          hookResult: { appendContext: "Answer warmly without tools." },
          applyPromptBuildToolsAllow: applyPolicy,
        },
      );
      expect(observeDecision).toHaveBeenCalledExactlyOnceWith({ effect: "skipped" });
      expect(applyPolicy).toHaveBeenCalledExactlyOnceWith(undefined, false);
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
    const { captured } = await assembleWithCapturedHookCtx("provenance-hook-turn", {
      inputProvenance,
    });
    expect(captured).toMatchObject([{ trigger: "user", inputProvenance }]);
  });
});
