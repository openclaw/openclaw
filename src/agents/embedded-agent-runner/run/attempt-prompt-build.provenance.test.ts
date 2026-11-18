// #143821: prompt-build hook context must carry the turn's typed input provenance so
// plugins can distinguish inter-session deliveries from human messages.
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../config/runtime-snapshot.js";
import * as decisionDiagnostics from "../../../decisions/diagnostics.js";
import type {
  PluginHookBeforePromptBuildEvent,
  PluginHookBeforePromptBuildResult,
} from "../../../plugins/hook-before-agent-start.types.js";
import type { PluginHookAgentContext } from "../../../plugins/hook-types.js";
import { createHookRunner } from "../../../plugins/hooks.js";
import { setPluginToolMeta } from "../../../plugins/tool-metadata.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import { createAgentHarnessToolSurfaceRuntimeCore } from "../../harness/tool-surface-bridge.js";
import { forgetPromptBuildDrainCacheForRun } from "../../plugin-turn-context.js";
import {
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  testModel,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { createStubTool } from "../../test-helpers/agent-tool-stubs.js";
import { prepareEmbeddedAttemptPromptAssembly } from "./attempt-prompt-build.js";
import { createPromptBuildToolPolicy } from "./attempt-prompt-support.js";
import { applyEmbeddedAttemptToolsAllow } from "./attempt-tool-construction-plan.js";
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
  toolSearch,
  narrowToolsAllow,
  ...promptPolicy
}: {
  attempt?: Partial<EmbeddedRunAttemptParams>;
  hookResult?: PluginHookBeforePromptBuildResult;
  applyPromptBuildToolsAllow?: PromptAssemblyInput["applyPromptBuildToolsAllow"];
  prepareSystemPrompt?: PromptAssemblyInput["prepareSystemPrompt"];
  requiresToolAuthority?: true;
  toolSearch?: boolean;
  narrowToolsAllow?: string[];
} = {}) {
  const runId = "provenance-hook-test";
  const config = attemptOverrides.config ?? {};
  setRuntimeConfigSnapshot(config);
  const toolSurface =
    toolSearch === undefined
      ? undefined
      : createAgentHarnessToolSurfaceRuntimeCore({
          config: {
            tools: { codeMode: false, toolSearch: { enabled: toolSearch, mode: "tools" } },
          },
          modelToolsEnabled: true,
        });
  onTestFinished(() => toolSurface?.cleanup());
  const remote = createStubTool("mcp_notes_lookup");
  const deniedRemote = createStubTool("mcp_notes_delete");
  for (const tool of [remote, deniedRemote]) {
    setPluginToolMeta(tool, {
      pluginId: "notes",
      optional: false,
      mcp: {
        serverName: "notes",
        safeServerName: "notes",
        toolName: tool.name,
        operation: "tool",
      },
    });
  }
  const tools = applyEmbeddedAttemptToolsAllow(
    [createStubTool("read"), remote, deniedRemote],
    attemptOverrides.toolsAllow,
  );
  const compactedTools = toolSurface?.compactTools(tools).tools;
  const { session, sessionManager } = await createTestSession({
    customTools: compactedTools ?? [createStubTool("read")],
  });
  const toolPolicy = createPromptBuildToolPolicy({
    session,
    effectiveTools: compactedTools ?? [],
    uncompactedEffectiveTools: tools,
    tools,
    catalogRef: toolSurface?.toolSearchCatalogRef,
    codeModeControlsEnabled: false,
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
  const continuities: unknown[] = [];
  const events: PluginHookBeforePromptBuildEvent[] = [];
  const hookRunner = createHookRunner({
    hooks: [],
    plugins: [],
    typedHooks: [
      ...(narrowToolsAllow !== undefined
        ? [
            {
              pluginId: "narrowing-hook-test",
              hookName: "before_prompt_build" as const,
              source: "test",
              priority: 10,
              handler: () => ({ toolsAllow: narrowToolsAllow }),
            },
          ]
        : []),
      {
        pluginId: "provenance-hook-test",
        hookName: "before_prompt_build",
        source: "test",
        requiresToolAuthority,
        handler: async (event: PluginHookBeforePromptBuildEvent, ctx: PluginHookAgentContext) => {
          captured.push(ctx);
          prompts.push(event.prompt);
          continuities.push(event.continuity);
          events.push(event);
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
    toolSearchCatalogRef: toolSurface?.toolSearchCatalogRef,
    runAbortSignal: new AbortController().signal,
    hasBaselineTools: () => session.getActiveToolNames().length > 0,
    applyPromptBuildToolsAllow:
      promptPolicy.applyPromptBuildToolsAllow ??
      ((allow) => toolPolicy.apply(allow).callableToolNames),
    prepareSystemPrompt: promptPolicy.prepareSystemPrompt,
    setActiveSessionSystemPrompt: (prompt) => {
      systemPrompt = prompt;
    },
  });
  expect(session.messages).toEqual(priorMessages);
  return {
    captured,
    prompts,
    continuities,
    systemPrompt,
    events,
    catalogNames: toolSurface?.toolSearchCatalogRef?.current?.entries.map((entry) => entry.name),
    activeToolNames: session.getActiveToolNames(),
  };
}

describe("prompt-build tool scope", () => {
  it.each([
    { allow: undefined, toolSearch: false, deferred: [] },
    {
      allow: undefined,
      toolSearch: true,
      deferred: ["mcp_notes_delete", "mcp_notes_lookup"],
    },
    { allow: [], toolSearch: true, deferred: [] },
    { allow: ["read", "mcp_notes_lookup"], toolSearch: false, deferred: [] },
    { allow: ["read", "mcp_notes_lookup"], toolSearch: true, deferred: ["mcp_notes_lookup"] },
  ])(
    "reports incoming $allow with Tool Search=$toolSearch",
    async ({ allow, toolSearch, deferred }) => {
      const { events, activeToolNames } = await assembleWithCapturedHookCtx({
        attempt: { toolsAllow: allow },
        toolSearch,
      });
      expect(events).toHaveLength(1);
      if (allow === undefined) {
        expect(events[0]).not.toHaveProperty("toolsAllow");
      } else {
        expect(events[0]?.toolsAllow).toEqual(allow);
        expect(events[0]?.toolsAllow).not.toBe(allow);
      }
      expect(events[0]?.deferredToolNames).toEqual(deferred);
      if (allow !== undefined) {
        expect(activeToolNames).not.toContain("mcp_notes_delete");
      }
      if (deferred.length && allow !== undefined) {
        expect(activeToolNames).toContain("tool_search");
        expect(activeToolNames).not.toContain("mcp_notes_lookup");
      }
    },
  );

  it.each([undefined, true] as const)(
    "keeps the incoming snapshot after narrowing for authority=%s",
    async (requiresToolAuthority) => {
      const allow = ["read", "mcp_notes_lookup"];
      const { events, catalogNames } = await assembleWithCapturedHookCtx({
        attempt: { toolsAllow: allow, toolAuthorityFingerprint: "tool-scope-test" },
        toolSearch: true,
        narrowToolsAllow: ["read", "mcp_notes_delete"],
        requiresToolAuthority,
      });
      expect(events[0]?.toolsAllow).toEqual(allow);
      expect(events[0]?.deferredToolNames).toEqual(["mcp_notes_lookup"]);
      expect(catalogNames).toEqual(["read"]);
      expect(allow).toEqual(["read", "mcp_notes_lookup"]);
    },
  );
});

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

  it("reports a fresh embedded session to authorized prompt enrichment", async () => {
    const { continuities } = await assembleWithCapturedHookCtx({
      attempt: { toolAuthorityFingerprint: "authority-test" },
      requiresToolAuthority: true,
    });
    expect(continuities).toEqual([{ state: "fresh", history: "none" }]);
  });

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
