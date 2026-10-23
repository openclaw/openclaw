import { Type } from "typebox";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { AgentDefaultsBaseSchema } from "../../../config/zod-schema.agent-defaults-base.js";
import { registered } from "../../../decisions/runtime.test-support.js";
import type { DecisionProviderV1, ProviderDecisionOutcome } from "../../../decisions/types.js";
import * as operatorInvocation from "../../../gateway/operator-invocation-authority.js";
import type { Context, Model } from "../../../llm/types.js";
import { createHookRunnerWithRegistry } from "../../../plugins/hooks.test-fixtures.js";
import { resetPluginRuntimeStateForTest } from "../../../plugins/runtime.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import { forgetPromptBuildDrainCacheForRun } from "../../plugin-turn-context.js";
import {
  createAssistant,
  createAssistantResultStream,
  streamMocks,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  testModel,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { leasePendingAgentSteeringItems } from "../../subagents/registry/subagent-registry.js";
import {
  createToolSearchCatalogRef,
  registerHeadlessToolSearchCatalog,
} from "../../tool-search-catalog.js";
import { createToolResultPromptProjectionState } from "../session-prompt-state.js";
import { prepareEmbeddedAttemptPromptAssembly } from "./attempt-prompt-build.js";
import { submitEmbeddedAttemptPrompt } from "./attempt-prompt-submit.js";
import { createPromptBuildToolPolicy } from "./attempt-prompt-support.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

vi.mock("../../../plugins/host-hook-state.js", () => ({
  drainPluginNextTurnInjectionContext: vi.fn(async () => ({ queuedInjections: [] })),
}));
vi.mock("../../subagents/registry/subagent-registry.js", () => ({
  leasePendingAgentSteeringItems: vi.fn(async () => undefined),
  prependAgentSteeringPrompt: ({ prompt }: { prompt: string }) => prompt,
}));
registerAgentSessionLoopTestLifecycle();
afterEach(() => {
  resetPluginRuntimeStateForTest();
  clearRuntimeConfigSnapshot();
});
const result = (probabilityTrue = 0.1): ProviderDecisionOutcome => ({
  status: "ok",
  result: {
    model: "model",
    answers: {
      missing_request_context: { type: "boolean", probabilityTrue: 0.1 },
      next_response_needs_tools: { type: "boolean", probabilityTrue },
    },
  },
});
function config(enabled = true, selected = true): OpenClawConfig {
  return {
    agents: {
      defaults: AgentDefaultsBaseSchema.parse({
        experimental: { decisionAssistance: enabled },
        ...(selected ? { decisionModel: "fixture/model" } : {}),
      }),
      entries: { main: {}, quiet: { decisionModel: "" } },
    },
  };
}
function captureRequests(reply = () => "done") {
  const captures: Array<{ names: string[]; definitionChars: number }> = [];
  streamMocks.streamSimple.mockImplementation((model: Model, context: Context) => {
    captures.push({
      names: (context.tools ?? []).map((tool) => tool.name),
      definitionChars: JSON.stringify(context.tools ?? []).length,
    });
    return createAssistantResultStream(createAssistant(model, reply()));
  });
  return captures;
}
const modes = ["structured", "search", "code"] as const;
const authorityChanges = ["opt-out", "owner-close", "abort"] as const;
const preparationBoundaries = ["steering", "operator"] as const;
let sequence = 0;
async function fixture(
  cfg = config(),
  mode: "structured" | "search" | "code" = "structured",
  agentId = "main",
  hookRunner: Parameters<typeof prepareEmbeddedAttemptPromptAssembly>[0]["hookRunner"] = null,
  toolSurface: { names?: string[]; forceToolNames?: string[]; clientOnly?: boolean } = {},
) {
  const call = vi.fn<DecisionProviderV1["evaluate"]>(async () => result());
  registered(call);
  const runId = "prefilter-" + ++sequence;
  const tools = (toolSurface.names ?? ["inspect_file", "message", "decision_evaluate"]).map(
    (name) => ({
      name,
      label: name,
      description: name,
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }),
    }),
  );
  const controls = mode === "search" ? ["tool_search"] : mode === "code" ? ["exec"] : [];
  const controlTools = controls.map((name) => ({ ...tools[0]!, name }));
  const { session, sessionManager } = await createTestSession({
    customTools: [...tools, ...controlTools],
  });
  session.setActiveToolsByName(
    mode === "structured" ? tools.map((t) => t.name) : [...controls, "message"],
  );
  const catalogRef = mode === "structured" ? undefined : createToolSearchCatalogRef();
  if (catalogRef) {
    registerHeadlessToolSearchCatalog({
      catalogRef,
      tools: tools.filter((tool) => tool.name !== "message"),
    });
  }
  const policy = createPromptBuildToolPolicy({
    session,
    effectiveTools: toolSurface.clientOnly
      ? []
      : mode === "structured"
        ? tools
        : [...controlTools, tools[1]!],
    uncompactedEffectiveTools: toolSurface.clientOnly ? [] : tools,
    tools: toolSurface.clientOnly ? [] : tools,
    catalogRef,
    codeModeControlsEnabled: mode === "code",
    forceToolNames: toolSurface.forceToolNames ?? ["message", "denied"],
  });
  const owner = prepareSystemAgentRunAdmission(cfg, runId, agentId, "prefilter-test");
  const toolResultPromptProjectionState = createToolResultPromptProjectionState();
  onTestFinished(() => {
    owner.close();
    forgetPromptBuildDrainCacheForRun(runId);
  });
  const controller = new AbortController();
  const attempt: Parameters<typeof prepareEmbeddedAttemptPromptAssembly>[0]["attempt"] = {
    admittedRunContext: await owner.admit("embedded"),
    config: cfg,
    model: testModel,
    provider: testModel.provider,
    prompt: "Hello",
    runId,
    sessionId: runId,
    sessionPersistence: "detached",
    trigger: "user",
    workspaceDir: "/synthetic",
    abortSignal: controller.signal,
    supportsTurnScopedToolRestrictions: true,
  };
  const assemble = (overrides: Partial<EmbeddedRunAttemptParams> = {}) =>
    prepareEmbeddedAttemptPromptAssembly({
      attempt: { ...attempt, ...overrides },
      activeSession: session,
      sessionManager,
      hookRunner,
      hookAgentId: agentId,
      diagnosticTrace: { traceId: "11111111111111111111111111111111" },
      isRawModelRun: false,
      sessionAgentId: agentId,
      runtimeModel: testModel.id,
      systemPromptText: "System",
      hasBaselineTools: policy.hasBaselineTools,
      applyPromptBuildToolsAllow: (allow, pruneForDecision) =>
        policy.apply(allow, pruneForDecision).callableToolNames,
      setActiveSessionSystemPrompt: () => {},
      setLeasedSteering: () => {},
    });
  const submit = async (
    assembly: Awaited<ReturnType<typeof assemble>>,
    persistToolResultProjections: () => Promise<void>,
  ) =>
    submitEmbeddedAttemptPrompt({
      attempt,
      activeSession: session,
      contextTokenBudget: 8000,
      images: [],
      modelPrompt: assembly.effectivePrompt,
      transcriptPrompt: assembly.effectivePrompt,
      systemPrompt: session.agent.state.systemPrompt,
      runtimeOnly: false,
      toolResultPromptProjectionState,
      toolResultMaxChars: 4000,
      toolResultAggregateMaxChars: 8000,
      transcriptLeafId: null,
      trajectoryRecorder: null,
      onFinalPromptText: () => {},
      onSteeringAcknowledged: () => {},
      assertHostActive: assembly.assertHostActive,
      persistToolResultProjections,
      promptActiveSession: (prompt, options) => session.prompt(prompt, options),
    });
  return { call, assemble, submit, session, policy, catalogRef, controller, owner, attempt, tools };
}

describe("prompt assembly with registered Decision runtime", () => {
  it("evaluates the next turn after a Decision removes every model-facing tool", async () => {
    const { call, ...f } = await fixture(config(), "structured", "main", null, {
      names: ["inspect_file"],
      forceToolNames: [],
    });
    await f.assemble();
    expect(f.policy.current.effectiveTools).toEqual([]);
    expect(f.session.getActiveToolNames()).toEqual([]);

    call.mockResolvedValue(result(0.9));
    await f.assemble({ prompt: "Read package.json now." });

    expect(call).toHaveBeenCalledTimes(2);
    expect(f.session.getActiveToolNames()).toEqual(["inspect_file"]);
  });

  it("reads the permission baseline after preparation awaits and admits a later nonempty generation", async () => {
    const { call, ...f } = await fixture();
    const tools = f.tools.slice();
    vi.mocked(leasePendingAgentSteeringItems).mockImplementationOnce(async () => {
      f.tools.splice(0);
      f.session.setActiveToolsByName([]);
      f.policy.refresh();
      return undefined;
    });
    await f.assemble({ sessionKey: "agent:main:tools-revoked" });
    expect(f.attempt.disableTools).toBeUndefined();
    expect(call).not.toHaveBeenCalled();
    expect(f.session.getActiveToolNames()).toEqual([]);

    f.tools.push(...tools);
    f.session.setActiveToolsByName(tools.map((tool) => tool.name));
    f.policy.refresh();
    await f.assemble();
    expect(call).toHaveBeenCalledOnce();
  });

  it("keeps client-only model tools eligible for Decision inference", async () => {
    const { call, ...f } = await fixture(config(), "structured", "main", null, {
      names: ["client_lookup"],
      clientOnly: true,
    });
    call.mockResolvedValue(result(0.9));
    expect(f.policy.current.effectiveTools).toEqual([]);
    await f.assemble();
    expect(call).toHaveBeenCalledOnce();
    expect(f.session.getActiveToolNames()).toEqual(["client_lookup"]);
  });

  it.each<[string, OpenClawConfig, string, boolean | undefined, boolean]>([
    ["missing referent", config(), "main", true, false],
    ["disabled", config(false), "main", true, false],
    ["no model", config(true, false), "main", true, false],
    ["enabled", config(), "main", true, true],
    ["unknown harness", config(), "main", undefined, false],
    ["unsupported harness", config(), "main", false, false],
    ["agent opt-out", config(), "quiet", true, false],
  ])("gates Decision inference: %s", async (name, cfg, agentId, support, prune) => {
    const missingReferent = name === "missing referent";
    const { call, ...f } = await fixture(cfg, "structured", agentId);
    if (missingReferent) {
      f.session.agent.state.messages = [createAssistant(testModel, "Should I edit the file?")];
    }
    await f.assemble({
      supportsTurnScopedToolRestrictions: support,
      ...(missingReferent ? { prompt: "Go ahead." } : {}),
    });
    expect(call).toHaveBeenCalledTimes(prune ? 1 : 0);
    expect(f.policy.current.tools.map((t) => t.name)).toEqual(
      prune ? ["message"] : ["inspect_file", "message", "decision_evaluate"],
    );
  });
  it.each(modes)("keeps the admitted Decision result for final %s dispatch", async (mode) => {
    for (const change of ["opt-out", "model-change"] as const) {
      const cfg = config();
      setRuntimeConfigSnapshot(cfg);
      const f = await fixture(cfg, mode);
      const assembly = await f.assemble();
      expect(f.session.getActiveToolNames()).toEqual(["message"]);
      const entered = createDeferredCore();
      const barrier = createDeferredCore();
      const captured = captureRequests();
      const pending = f.submit(assembly, async () => {
        entered.resolve();
        await barrier.promise;
      });
      await entered.promise;
      expect(captured).toEqual([]);
      const next = config(change !== "opt-out");
      if (change === "model-change") {
        next.agents!.defaults!.decisionModel = "fixture/replacement";
      }
      setRuntimeConfigSnapshot(next);
      barrier.resolve();
      await pending;
      const expected = ["message"];
      expect(captured.map(({ names }) => names)).toEqual([expected]);
      expect(f.session.getActiveToolNames()).toEqual(expected);
      expect(f.policy.current.callableToolNames).not.toContain("inspect_file");
      expect(f.policy.current.callableToolNames).not.toContain("denied");
      expect(f.policy.current.tools.map((t) => t.name)).toContain("message");
      if (f.catalogRef) {
        expect(f.catalogRef.current?.entries).toEqual([]);
      }
    }
  });

  it.each(authorityChanges)("handles a pending evaluation after %s", async (change) => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const cfg = config();
    setRuntimeConfigSnapshot(cfg);
    const { call, ...f } = await fixture(cfg);
    call.mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return result();
    });
    const pending = f.assemble();
    await entered.promise;
    if (change === "opt-out") {
      setRuntimeConfigSnapshot(config(false));
    } else if (change === "owner-close") {
      f.owner.close();
    } else {
      f.controller.abort(new Error("cancelled"));
    }
    release.resolve();
    if (change === "opt-out") {
      await pending;
      expect(f.policy.current.tools.map((tool) => tool.name)).toEqual(["message"]);
      // The admitted evaluation survives, but a later turn must not invoke it.
      await f.assemble({ config: config(false) });
      expect(call).toHaveBeenCalledTimes(1);
    } else {
      await expect(pending).rejects.toThrow();
    }
    expect(f.policy.current.tools).toHaveLength(3);
  });
  it("retains baseline on provider unavailability and skips continuation/fallback inference", async () => {
    const { call, ...f } = await fixture();
    call.mockResolvedValue({ status: "unavailable", reason: "transport" });
    await f.assemble();
    expect(f.policy.current.tools).toHaveLength(3);
    await f.assemble({ skipPreparedUserTurnMessage: true });
    await f.assemble({ fallbackActive: true });
    expect(f.policy.current.tools).toHaveLength(3);
    expect(call).toHaveBeenCalledTimes(1);
  });
  it.each(preparationBoundaries)("observes opt-out across %s preparation", async (boundary) => {
    let revoked = false;
    const cfg = config();
    setRuntimeConfigSnapshot(cfg);
    const { call, ...f } = await fixture(cfg);
    if (boundary === "steering") {
      vi.mocked(leasePendingAgentSteeringItems).mockImplementationOnce(async () => {
        setRuntimeConfigSnapshot(config(false));
        revoked = true;
        return undefined;
      });
    } else {
      const original = operatorInvocation.captureAmbientGatewayOperatorAuthority;
      const capture = vi
        .spyOn(operatorInvocation, "captureAmbientGatewayOperatorAuthority")
        .mockImplementationOnce(async (params) => {
          const authority = await original(params);
          expect(call.mock.calls.length, "operator barrier must precede provider I/O").toBe(0);
          setRuntimeConfigSnapshot(config(false));
          revoked = true;
          return authority;
        });
      onTestFinished(() => capture.mockRestore());
    }
    await f.assemble({ sessionKey: "agent:main:consent-transition" });
    expect(revoked).toBe(true);
    expect(call).not.toHaveBeenCalled();
    expect(f.policy.current.tools).toHaveLength(3);
  });

  it.each(modes)("submits second-turn restriction and restoration in %s", async (mode) => {
    const hookFields = {
      prependContext: "  Operating guidance  ",
      appendSystemContext: "Guide suffix\n",
    };
    const { runner } = createHookRunnerWithRegistry([
      { hookName: "before_prompt_build", handler: () => hookFields },
    ]);
    const { call, ...f } = await fixture(config(), mode, "main", runner);
    call.mockResolvedValue(result(0.9));
    let reply = "Would you like an explanation?";
    const captures = captureRequests(() => reply);
    const submit = async (prompt: string) => {
      await f.assemble({ prompt });
      await f.session.prompt(prompt);
    };
    await submit("Help me understand this example.");
    call.mockResolvedValue(result(0.1));
    reply = "Here is the explanation.";
    await submit("Yes");
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[1]?.[0].state).toMatchObject({
      latestRequest: "Yes",
      beforePromptBuild: hookFields,
      recentConversation: [
        { user: "Help me understand this example.", assistant: "Would you like an explanation?" },
      ],
    });
    expect(captures[1]?.names).toEqual(["message"]);
    expect(captures[1]?.definitionChars).toBeLessThan(captures[0]?.definitionChars ?? 0);
    call.mockResolvedValue(result(0.9));
    await submit("Read package.json now.");
    expect(call).toHaveBeenCalledTimes(3);
    expect(captures[2]?.names).toEqual(captures[0]?.names);
    expect(f.policy.current.callableToolNames).toContain("inspect_file");
    expect(f.policy.current.callableToolNames).not.toContain("denied");
  });
});
