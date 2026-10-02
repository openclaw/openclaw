import { Type } from "typebox";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { AgentDefaultsBaseSchema } from "../../../config/zod-schema.agent-defaults-base.js";
import type { DecisionProviderV1, ProviderDecisionOutcome } from "../../../decisions/types.js";
import * as operatorInvocation from "../../../gateway/operator-invocation-authority.js";
import type { Context, Model } from "../../../llm/types.js";
import { createHookRunnerWithRegistry } from "../../../plugins/hooks.test-fixtures.js";
import { runPluginRegisterSyncInRegistry } from "../../../plugins/loader-module-runtime.js";
import { createPluginRecord } from "../../../plugins/loader-records.js";
import { getPluginInstance } from "../../../plugins/plugin-instance-scope.js";
import { createTestPluginRegistry } from "../../../plugins/registry-runtime.test-helpers.js";
import {
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../../plugins/runtime.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import {
  createAssistant,
  createAssistantResultStream,
  streamMocks,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  testModel,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { leasePendingAgentSteeringItems } from "../../subagents/registry/subagent-registry.js";
import type { ToolSearchCatalogRef } from "../../tool-search.js";
import {
  clearEmbeddedSessionPromptStates,
  getEmbeddedSessionPromptState,
} from "../session-prompt-state.js";
import { prepareEmbeddedAttemptPromptAssembly } from "./attempt-prompt-build.js";
import { forgetPromptBuildDrainCacheForRun } from "./attempt-prompt-helpers.js";
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
function register(evaluate: DecisionProviderV1["evaluate"] = async () => result()) {
  const call = vi.fn(evaluate);
  const builder = createTestPluginRegistry();
  const record = createPluginRecord({
    id: "fixture",
    source: "/synthetic/prefilter.ts",
    origin: "global",
    enabled: true,
    configSchema: false,
    contracts: { decisionProviders: ["fixture"] },
  });
  const api = builder.createApi(record, { config: config() });
  runPluginRegisterSyncInRegistry(
    (registration) =>
      registration.registerDecisionProvider({ id: "fixture", contractVersion: 1, evaluate: call }),
    api,
    builder.registry,
    record.id,
  );
  builder.registry.plugins.push(record);
  setActivePluginRegistry(builder.registry);
  onTestFinished(async () => {
    await getPluginInstance(record)?.dispose();
  });
  return call;
}
let sequence = 0;
async function fixture(
  cfg = config(),
  mode: "structured" | "search" | "code" = "structured",
  agentId = "main",
  hookRunner: Parameters<typeof prepareEmbeddedAttemptPromptAssembly>[0]["hookRunner"] = null,
) {
  const runId = "prefilter-" + ++sequence;
  const tools = ["inspect_file", "message", "decision_evaluate"].map((name) => ({
    name,
    label: name,
    description: name,
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }),
  }));
  const controls = mode === "search" ? ["tool_search"] : mode === "code" ? ["exec"] : [];
  const controlTools = controls.map((name) => ({ ...tools[0]!, name }));
  const { session, sessionManager, modelRegistry } = await createTestSession({
    customTools: [...tools, ...controlTools],
  });
  session.setActiveToolsByName(
    mode === "structured" ? tools.map((t) => t.name) : [...controls, "message"],
  );
  const catalogRef: ToolSearchCatalogRef | undefined =
    mode === "structured"
      ? undefined
      : {
          current: {
            entries: tools
              .filter((t) => t.name !== "message")
              .map((tool) => ({
                id: tool.name,
                name: tool.name,
                source: "openclaw" as const,
                description: tool.description,
                tool,
              })),
            counterScope: runId,
            searchCount: 0,
            describeCount: 0,
            callCount: 0,
          },
        };
  const policy = createPromptBuildToolPolicy({
    session,
    readModelTools: () => session.agent.state.tools,
    effectiveTools: mode === "structured" ? tools : [...controlTools, tools[1]!],
    uncompactedEffectiveTools: tools,
    tools,
    catalogRef,
    codeModeControlsEnabled: mode === "code",
    forceToolNames: ["message", "denied"],
  });
  const admission = prepareSystemAgentRunAdmission(cfg, runId, agentId, "prefilter-test");
  onTestFinished(() => {
    admission.close();
    forgetPromptBuildDrainCacheForRun(runId);
    clearEmbeddedSessionPromptStates([runId]);
  });
  const controller = new AbortController();
  const attempt: EmbeddedRunAttemptParams = {
    admittedRunContext: await admission.admit("embedded"),
    authStorage: modelRegistry.authStorage,
    authProfileStore: { version: 1, profiles: {} },
    modelRegistry,
    config: cfg,
    model: testModel,
    modelId: testModel.id,
    provider: testModel.provider,
    thinkLevel: "off",
    prompt: "Hello",
    runId,
    sessionId: runId,
    sessionFile: "",
    sessionPersistence: "detached",
    trigger: "user",
    timeoutMs: 10_000,
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
      applyPromptBuildToolsAllow: (allow, decisionIsCurrent) =>
        policy.apply(allow, decisionIsCurrent).callableToolNames,
      setActiveSessionSystemPrompt: () => {},
      setLeasedSteering: () => {},
    });
  const submit = async (
    assembly: Awaited<ReturnType<typeof assemble>>,
    persistToolResultProjections: () => Promise<void>,
  ) => {
    const state = getEmbeddedSessionPromptState(runId);
    return submitEmbeddedAttemptPrompt({
      attempt,
      activeSession: session,
      contextTokenBudget: 8000,
      images: [],
      modelPrompt: assembly.effectivePrompt,
      transcriptPrompt: assembly.effectivePrompt,
      systemPrompt: session.agent.state.systemPrompt,
      runtimeOnly: false,
      sessionPromptState: state,
      toolResultPromptProjectionState: state.toolResults,
      toolResultMaxChars: 4000,
      toolResultAggregateMaxChars: 8000,
      transcriptLeafId: null,
      trajectoryRecorder: null,
      onFinalPromptText: () => {},
      onSteeringAcknowledged: () => {},
      assertHostActive: assembly.assertHostActive,
      persistToolResultProjections,
      preparePrimaryModelRequest: () =>
        policy.prepareForDispatch(async () => () => ({
          tools: session.agent.state.tools.slice(),
          systemPrompt: session.agent.state.systemPrompt,
        })),
      promptActiveSession: (prompt, options) => session.prompt(prompt, options),
    });
  };
  return { assemble, submit, session, policy, catalogRef, controller, admission, attempt };
}

describe("prompt assembly with registered Decision runtime", () => {
  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ] as const)("opt-in %s, model %s", async (enabled, selected) => {
    const call = register();
    const f = await fixture(config(enabled, selected));
    await f.assemble();
    expect(call).toHaveBeenCalledTimes(enabled && selected ? 1 : 0);
    expect(f.policy.current.tools.map((t) => t.name)).toEqual(
      enabled && selected ? ["message"] : ["inspect_file", "message", "decision_evaluate"],
    );
  });
  it.each([undefined, false])(
    "unknown/unsupported harness %s dispatches nothing",
    async (support) => {
      const call = register();
      const f = await fixture();
      await f.assemble({ supportsTurnScopedToolRestrictions: support });
      expect(call).not.toHaveBeenCalled();
      expect(f.policy.current.tools).toHaveLength(3);
    },
  );
  it.each(["structured", "search", "code"] as const)(
    "keeps admitted opt-out results but withdraws model changes at final %s dispatch",
    async (mode) => {
      for (const change of ["opt-out", "model-change"] as const) {
        register();
        const cfg = config();
        setRuntimeConfigSnapshot(cfg);
        const f = await fixture(cfg, mode);
        const baseline = f.session.agent.state.tools.map((t) => t.name);
        const assembly = await f.assemble();
        expect(f.session.getActiveToolNames()).toEqual(["message"]);
        const entered = createDeferredCore();
        const barrier = createDeferredCore();
        const captured: string[][] = [];
        streamMocks.streamSimple.mockImplementation((model: Model, context: Context) => {
          captured.push((context.tools ?? []).map((t) => t.name));
          return createAssistantResultStream(
            createAssistant(model, [{ type: "text", text: "done" }]),
          );
        });
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
        const expected = change === "opt-out" ? ["message"] : baseline;
        expect(captured).toEqual([expected]);
        expect(f.session.getActiveToolNames()).toEqual(expected);
        expect(f.policy.current.callableToolNames.includes("inspect_file")).toBe(
          change === "model-change",
        );
        expect(f.policy.current.callableToolNames).not.toContain("denied");
        expect(f.policy.current.tools.map((t) => t.name)).toContain("message");
        if (f.catalogRef) {
          expect(f.catalogRef.current?.entries.map((e) => e.name)).toEqual(
            change === "opt-out" ? [] : ["decision_evaluate", "inspect_file"],
          );
        }
      }
    },
  );

  it("keeps another agent's empty override independent", async () => {
    const call = register();
    const quiet = await fixture(config(), "structured", "quiet");
    await quiet.assemble();
    expect(call).not.toHaveBeenCalled();
    expect(quiet.policy.current.tools).toHaveLength(3);
  });
  it.each(["opt-out", "owner-close", "abort"])(
    "handles a pending evaluation after %s",
    async (change) => {
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const call = register(async () => {
        entered.resolve();
        await release.promise;
        return result();
      });
      const cfg = config();
      setRuntimeConfigSnapshot(cfg);
      const f = await fixture(cfg);
      const pending = f.assemble();
      await entered.promise;
      if (change === "opt-out") {
        setRuntimeConfigSnapshot(config(false));
      } else if (change === "owner-close") {
        f.admission.close();
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
    },
  );
  it("retains baseline on provider unavailability and skips continuation/fallback inference", async () => {
    const call = register(async () => ({ status: "unavailable", reason: "transport" }));
    const f = await fixture();
    await f.assemble();
    expect(f.policy.current.tools).toHaveLength(3);
    await f.assemble({ skipPreparedUserTurnMessage: true });
    await f.assemble({ fallbackActive: true });
    expect(f.policy.current.tools).toHaveLength(3);
    expect(call).toHaveBeenCalledTimes(1);
  });
  it.each(["steering", "operator"] as const)(
    "observes opt-out published while %s preparation awaits",
    async (boundary) => {
      let revoked = false;
      const call = register();
      const cfg = config();
      setRuntimeConfigSnapshot(cfg);
      const f = await fixture(cfg);
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
    },
  );

  it("preserves tools for approvals that depend on earlier assistant work", async () => {
    const call = register();
    const f = await fixture();
    f.session.agent.state.messages = [
      createAssistant(testModel, [{ type: "text", text: "Should I edit the file?" }]),
    ];
    await f.assemble({ prompt: "Go ahead." });
    expect(call).not.toHaveBeenCalled();
    expect(f.policy.current.tools).toHaveLength(3);
  });
  it.each(["structured", "search", "code"] as const)(
    "submits the second-turn restriction and next-action restoration in %s mode",
    async (mode) => {
      const call = register(async () => result(0.9));
      const hookFields = {
        prependContext: "  Operating guidance  ",
        appendSystemContext: "Guide suffix\n",
      };
      const { runner } = createHookRunnerWithRegistry([
        { hookName: "before_prompt_build", handler: () => hookFields },
      ]);
      const f = await fixture(config(), mode, "main", runner);
      const captures: Array<{ names: string[]; definitions: unknown[] }> = [];
      let reply = "Would you like an explanation?";
      streamMocks.streamSimple.mockImplementation((model: Model, context: Context) => {
        captures.push({
          names: (context.tools ?? []).map((tool) => tool.name),
          definitions: (context.tools ?? []).map(({ name, description, parameters }) => ({
            name,
            description,
            parameters,
          })),
        });
        return createAssistantResultStream(createAssistant(model, [{ type: "text", text: reply }]));
      });
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
      expect(captures[1]?.names).not.toContain("denied");
      expect(JSON.stringify(captures[1]?.definitions).length).toBeLessThan(
        JSON.stringify(captures[0]?.definitions).length,
      );
      call.mockResolvedValue(result(0.9));
      await submit("Read package.json now.");
      expect(call).toHaveBeenCalledTimes(3);
      expect(captures[2]?.names).toEqual(captures[0]?.names);
      expect(f.policy.current.callableToolNames).toContain("inspect_file");
      expect(f.policy.current.callableToolNames).not.toContain("denied");
    },
  );
});
