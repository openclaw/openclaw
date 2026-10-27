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
import { createStubTool } from "../../test-helpers/agent-tool-stubs.js";
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
function config(enabled = true): OpenClawConfig {
  return {
    agents: {
      defaults: AgentDefaultsBaseSchema.parse({
        experimental: { decisionAssistance: enabled },
        decisionModel: "fixture/model",
      }),
    },
  };
}
function captureRequests(reply = () => "done") {
  const captures: string[][] = [];
  streamMocks.streamSimple.mockImplementation((model, context) => {
    captures.push((context.tools ?? []).map((tool) => tool.name));
    return createAssistantResultStream(createAssistant(model, reply()));
  });
  return captures;
}
const modes = ["structured", "search", "code"] as const;
const authorityChanges = ["opt-out", "owner-close", "abort"] as const;
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
    createStubTool,
  );
  const controls = mode === "search" ? ["tool_search"] : mode === "code" ? ["exec"] : [];
  const controlTools = controls.map((name) => ({ ...tools[0]!, name }));
  const { session, sessionManager } = await createTestSession({
    customTools: [...tools, ...controlTools],
  });
  session.setActiveToolsByName(
    mode === "structured" ? tools.map((t) => t.name) : [...controls, "message"],
  );
  const offeredToolNames = session.getActiveToolNames();
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
      toolResultPromptProjectionState: createToolResultPromptProjectionState(),
      toolResultMaxChars: 4000,
      toolResultAggregateMaxChars: 8000,
      transcriptLeafId: null,
      trajectoryRecorder: null,
      onFinalPromptText: () => {},
      assertHostActive: assembly.assertHostActive,
      persistToolResultProjections,
      promptActiveSession: (prompt, options) => session.prompt(prompt, options),
    });
  return {
    call,
    assemble,
    submit,
    session,
    policy,
    catalogRef,
    controller,
    owner,
    attempt,
    tools,
    offeredToolNames,
  };
}

describe("prompt assembly with registered Decision runtime", () => {
  it.each([false, true])(
    "evaluates tools after an empty host surface (client-only=%s)",
    async (clientOnly) => {
      const names = [clientOnly ? "client_lookup" : "inspect_file"];
      const { call, ...f } = await fixture(config(), "structured", "main", null, {
        names,
        forceToolNames: clientOnly ? undefined : [],
        clientOnly,
      });
      if (!clientOnly) {
        await f.assemble();
        expect(f.policy.current.callableToolNames).toEqual([]);
      }
      expect(f.session.getActiveToolNames()).toEqual(names);
      expect(f.policy.current.effectiveTools).toEqual(clientOnly ? [] : f.tools);
      call.mockResolvedValue(result(0.9));
      await f.assemble();
      expect(call).toHaveBeenCalledTimes(clientOnly ? 1 : 2);
      expect(f.session.getActiveToolNames()).toEqual(names);
    },
  );

  it("retains tools when the harness does not support turn-scoped restrictions", async () => {
    const { call, ...f } = await fixture();
    await f.assemble({ supportsTurnScopedToolRestrictions: false });
    expect(call).not.toHaveBeenCalled();
    expect(f.session.getActiveToolNames()).toEqual([
      "inspect_file",
      "message",
      "decision_evaluate",
    ]);
  });
  it.each(modes)("keeps the admitted Decision result for final %s dispatch", async (mode) => {
    for (const change of ["opt-out", "model-change"] as const) {
      const cfg = config();
      setRuntimeConfigSnapshot(cfg);
      const f = await fixture(cfg, mode);
      const assembly = await f.assemble();
      expect(f.session.getActiveToolNames()).toEqual(f.offeredToolNames);
      expect(f.policy.current.callableToolNames).toEqual(["message"]);
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
      expect(captured).toEqual([f.offeredToolNames]);
      expect(f.policy.current.callableToolNames).not.toContain("denied");
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
  it("observes opt-out across operator preparation", async () => {
    let revoked = false;
    const cfg = config();
    setRuntimeConfigSnapshot(cfg);
    const { call, ...f } = await fixture(cfg);
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
    expect(call.mock.calls[1]?.[0].state).toMatchObject({
      latestRequest: "Yes",
      beforePromptBuild: hookFields,
      recentConversation: [
        { user: "Help me understand this example.", assistant: "Would you like an explanation?" },
      ],
    });
    expect(captures[1]).toEqual(captures[0]);
    expect(f.policy.current.callableToolNames).toEqual(["message"]);
    call.mockResolvedValue(result(0.9));
    await submit("Read package.json now.");
    expect(captures[2]).toEqual(captures[0]);
    expect(f.policy.current.callableToolNames).toContain("inspect_file");
    expect(f.policy.current.callableToolNames).not.toContain("denied");
  });
});
