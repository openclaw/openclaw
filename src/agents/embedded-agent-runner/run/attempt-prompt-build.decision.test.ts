import { createServer } from "node:http";
import { Type } from "typebox";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { AgentDefaultsBaseSchema } from "../../../config/zod-schema.agent-defaults-base.js";
import type { DecisionProviderV1, ProviderDecisionOutcome } from "../../../decisions/types.js";
import { validateDecisionResult } from "../../../decisions/validation.js";
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
import { getPluginRegistryForContext } from "../../../plugins/runtime/gateway-request-scope.js";
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
import { createDecisionTool } from "../../tools/decision-tool.js";
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
    if (enabled && selected) {
      expect(call.mock.calls[0]).toEqual([
        expect.objectContaining({
          state: {
            recentConversation: [],
            latestRequest: "Hello",
            omittedContext: { olderConversation: false, toolPayloads: false },
          },
          questions: {
            missing_request_context: expect.objectContaining({
              type: "boolean",
              instructions: expect.stringContaining("`latestRequest`"),
            }),
            next_response_needs_tools: expect.objectContaining({
              criteria: { true: expect.any(String), false: expect.any(String) },
            }),
          },
        }),
        expect.objectContaining({
          agentId: "main",
          model: "model",
          signal: expect.any(AbortSignal),
          deadlineMonotonicMs: expect.any(Number),
        }),
      ]);
    }
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
    "narrows %s schema/catalog/callability and restores next turn",
    async (mode) => {
      const call = register();
      const f = await fixture(config(), mode);
      await f.assemble();
      expect(f.policy.current.tools.map((t) => t.name)).toEqual(["message"]);
      expect(f.session.getActiveToolNames()).toEqual(["message"]);
      expect(f.catalogRef?.current?.entries ?? []).toEqual([]);
      expect(f.policy.current.callableToolNames).not.toContain("denied");
      call.mockResolvedValue(result(0.9));
      await f.assemble({ prompt: "Read package.json" });
      expect(f.policy.current.tools.map((t) => t.name)).toEqual([
        "inspect_file",
        "message",
        "decision_evaluate",
      ]);
      expect(f.policy.current.callableToolNames).toContain("inspect_file");
    },
  );
  it.each(["structured", "search", "code"] as const)(
    "withdraws the Decision cap at final %s dispatch after a late config change",
    async (mode) => {
      for (const change of ["opt-out", "model-change"] as const) {
        register();
        const cfg = config();
        setRuntimeConfigSnapshot(cfg);
        const f = await fixture(cfg, mode);
        const baseline = f.session.agent.state.tools.map((t) => t.name);
        const assembly = await f.assemble();
        expect(f.session.getActiveToolNames()).toEqual(["message"]);
        let entered!: () => void;
        let release!: () => void;
        const waiting = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const barrier = new Promise<void>((resolve) => {
          release = resolve;
        });
        const captured: string[][] = [];
        streamMocks.streamSimple.mockImplementation((model: Model, context: Context) => {
          captured.push((context.tools ?? []).map((t) => t.name));
          return createAssistantResultStream(
            createAssistant(model, [{ type: "text", text: "done" }]),
          );
        });
        const pending = f.submit(assembly, async () => {
          entered();
          await barrier;
        });
        await waiting;
        expect(captured).toEqual([]);
        const next = config(change !== "opt-out");
        if (change === "model-change") {
          next.agents!.defaults!.decisionModel = "fixture/replacement";
        }
        setRuntimeConfigSnapshot(next);
        release();
        await pending;
        expect(captured).toEqual([baseline]);
        expect(f.session.getActiveToolNames()).toEqual(baseline);
        expect(f.policy.current.callableToolNames).toContain("inspect_file");
        expect(f.policy.current.callableToolNames).not.toContain("denied");
        expect(f.policy.current.tools.map((t) => t.name)).toContain("message");
        if (f.catalogRef) {
          expect(f.catalogRef.current?.entries.map((e) => e.name)).toEqual([
            "decision_evaluate",
            "inspect_file",
          ]);
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
    "fences a pending result after %s",
    async (change) => {
      let release!: () => void;
      let started!: () => void;
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      register(async () => {
        started();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return result();
      });
      const cfg = config();
      setRuntimeConfigSnapshot(cfg);
      const f = await fixture(cfg);
      const pending = f.assemble();
      await entered;
      if (change === "opt-out") {
        setRuntimeConfigSnapshot(config(false));
      } else if (change === "owner-close") {
        f.admission.close();
      } else {
        f.controller.abort(new Error("cancelled"));
      }
      release();
      if (change === "opt-out") {
        await pending;
      } else {
        await expect(pending).rejects.toThrow();
      }
      expect(f.policy.current.tools).toHaveLength(3);
    },
  );
  it("retains baseline on provider unavailability and skips continuations", async () => {
    const call = register(async () => ({ status: "unavailable", reason: "transport" }));
    const f = await fixture();
    await f.assemble();
    expect(f.policy.current.tools).toHaveLength(3);
    await f.assemble({ skipPreparedUserTurnMessage: true });
    expect(call).toHaveBeenCalledTimes(1);
  });
  it("observes opt-out published while prompt preparation awaits steering", async () => {
    const call = register();
    const cfg = config();
    setRuntimeConfigSnapshot(cfg);
    const f = await fixture(cfg);
    vi.mocked(leasePendingAgentSteeringItems).mockImplementationOnce(async () => {
      setRuntimeConfigSnapshot(config(false));
      return undefined;
    });
    await f.assemble({ sessionKey: "agent:main:consent-transition" });
    expect(call).not.toHaveBeenCalled();
    expect(f.policy.current.tools).toHaveLength(3);
  });

  it("joins the real runtime deadline and preserves the normal tool surface", async () => {
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const call = register(async (_batch, { signal }) => {
      started();
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return result();
    });
    const f = await fixture();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      const pending = f.assemble();
      await entered;
      await vi.advanceTimersByTimeAsync(500);
      await pending;
      expect(call).toHaveBeenCalledOnce();
      expect(f.policy.current.tools).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });
  it("keeps explicit decision_evaluate available on the same host after three optional budgets expire", async () => {
    const starts: Array<() => void> = [];
    const entered = Array.from(
      { length: 3 },
      (_, i) =>
        new Promise<void>((resolve) => {
          starts[i] = resolve;
        }),
    );
    let calls = 0;
    const call = register(async (_batch, { signal }) => {
      const i = calls++;
      if (i < starts.length) {
        starts[i]!();
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      return result();
    });
    const cfg = config();
    setRuntimeConfigSnapshot(cfg);
    const f = await fixture(cfg);
    const host = getPluginRegistryForContext()!.decisionProviders[0]!.host;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      for (let i = 0; i < starts.length; i++) {
        const pending = f.assemble();
        await entered[i];
        await vi.advanceTimersByTimeAsync(500);
        const assembly = await pending;
        expect(assembly.decisionPrefilter).toMatchObject({
          status: "unavailable",
          reason: "deadline",
        });
        expect(f.session.getActiveToolNames()).toEqual([
          "inspect_file",
          "message",
          "decision_evaluate",
        ]);
      }
      const tool = createDecisionTool("main", { config: cfg });
      expect(tool).not.toBeNull();
      const explicit = await tool!.execute(
        "explicit-after-prefilter-deadlines",
        {
          state: "Hello",
          questions: {
            missing_request_context: { type: "boolean" },
            next_response_needs_tools: { type: "boolean" },
          },
        },
        f.controller.signal,
      );
      expect(explicit.details).toMatchObject({ status: "ok" });
      expect(call).toHaveBeenCalledTimes(4);
      expect(getPluginRegistryForContext()!.decisionProviders[0]!.host).toBe(host);
      expect(host.inspect(cfg)).toMatchObject({
        activeRequests: 0,
        callable: true,
        reasons: { deadline: 3 },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("carries rubric 9 and hook evidence over real HTTP while preserving explicit and final-dispatch availability", async () => {
    const requests: unknown[] = [];
    let holdResponses = true;
    let serverFailure: unknown;
    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.from(chunk));
        }
        requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        if (holdResponses) {
          return; // The real fetch is aborted by the caller's 500 ms budget.
        }
        response.writeHead(200, { "Content-Type": "application/json" });
        const outcome = result();
        if (outcome.status !== "ok") {
          throw new Error("expected deterministic fixture result");
        }
        response.end(JSON.stringify(outcome.result));
      })().catch((error: unknown) => {
        serverFailure = error;
        response.destroy(error instanceof Error ? error : undefined);
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    onTestFinished(async () => {
      const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      server.closeAllConnections();
      await closed;
      expect(serverFailure).toBeUndefined();
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected loopback TCP address");
    }
    const call = register(async (batch, { signal }) => {
      const response = await fetch("http://127.0.0.1:" + address.port + "/decision", {
        method: "POST",
        body: JSON.stringify(batch),
        signal,
      });
      const value: unknown = await response.json();
      if (!validateDecisionResult(batch, value)) {
        throw new Error("invalid fixture wire result");
      }
      return { status: "ok", result: value };
    });
    const cfg = config();
    setRuntimeConfigSnapshot(cfg);
    const hookFields = { prependContext: "Fixture operating guidance for this greeting." };
    const { runner } = createHookRunnerWithRegistry([
      { hookName: "before_prompt_build", handler: () => hookFields },
    ]);
    const f = await fixture(cfg, "structured", "main", runner);
    const host = getPluginRegistryForContext()!.decisionProviders[0]!.host;
    for (let index = 0; index < 3; index++) {
      const assembly = await f.assemble();
      expect(assembly.decisionPrefilter).toMatchObject({
        status: "unavailable",
        reason: "deadline",
      });
      expect(f.session.getActiveToolNames()).toEqual([
        "inspect_file",
        "message",
        "decision_evaluate",
      ]);
    }
    expect(requests).toHaveLength(3);
    expect(requests[0]).toMatchObject({
      state: { latestRequest: "Hello", beforePromptBuild: hookFields },
      questions: {
        next_response_needs_tools: { instructions: expect.stringContaining("beforePromptBuild") },
      },
    });
    holdResponses = false;
    const explicit = await createDecisionTool("main", { config: cfg })!.execute(
      "http-explicit",
      {
        state: "Hello",
        questions: {
          missing_request_context: { type: "boolean" },
          next_response_needs_tools: { type: "boolean" },
        },
      },
      f.controller.signal,
    );
    expect(explicit.details).toMatchObject({ status: "ok" });
    expect(host.inspect(cfg)).toMatchObject({
      activeRequests: 0,
      callable: true,
      reasons: { deadline: 3 },
    });
    const assembly = await f.assemble();
    expect(assembly.decisionPrefilter.restrictionApplied).toBe(true);
    expect(f.session.getActiveToolNames()).toEqual(["message"]);
    const captured: string[][] = [];
    streamMocks.streamSimple.mockImplementation((model: Model, context: Context) => {
      captured.push((context.tools ?? []).map((tool) => tool.name));
      return createAssistantResultStream(createAssistant(model, [{ type: "text", text: "done" }]));
    });
    await f.submit(assembly, async () => {
      setRuntimeConfigSnapshot(config(false));
    });
    expect(captured).toEqual([["inspect_file", "message", "decision_evaluate"]]);
    expect(call).toHaveBeenCalledTimes(5);
    expect(getPluginRegistryForContext()!.decisionProviders[0]!.host).toBe(host);
    expect(requests).toHaveLength(5);
  });

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
      const f = await fixture(config(), mode);
      f.session.agent.state.messages = [];
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
  it.each([
    ["Help me fix this", "Should I apply the patch?", "Yes", 0.9, false],
    ["Help me understand this", "Would you like an explanation?", "Yes", 0.1, true],
    ["Apply the patch", "The action failed; no changes were made.", "Try again", 0.9, false],
    ["Apply the patch", "The action finished successfully.", "Thanks", 0.1, true],
    [
      "Tell me something interesting",
      "Here is an interesting fact.",
      "Now read package.json",
      0.9,
      false,
    ],
  ] as const)(
    "carries context for %s / %s / %s through the real prompt boundary",
    async (priorUser, priorAssistant, latest, probability, prune) => {
      const call = register(async () => result(0.9));
      const f = await fixture();
      f.session.agent.state.messages = [];
      streamMocks.streamSimple.mockImplementation((model: Model) =>
        createAssistantResultStream(
          createAssistant(model, [{ type: "text", text: priorAssistant }]),
        ),
      );
      await f.assemble({ prompt: priorUser });
      await f.session.prompt(priorUser);
      call.mockResolvedValue(result(probability));
      const submitted: string[][] = [];
      streamMocks.streamSimple.mockImplementation((model: Model, context: Context) => {
        submitted.push((context.tools ?? []).map((tool) => tool.name));
        return createAssistantResultStream(
          createAssistant(model, [{ type: "text", text: "Final response" }]),
        );
      });
      await f.assemble({ prompt: latest });
      await f.session.prompt(latest);
      expect(call).toHaveBeenCalledTimes(2);
      expect(call.mock.calls[1]?.[0].state).toMatchObject({
        latestRequest: latest,
        recentConversation: [{ user: priorUser, assistant: priorAssistant }],
      });
      expect(submitted).toEqual([
        prune ? ["message"] : ["inspect_file", "message", "decision_evaluate"],
      ]);
    },
  );
  it("does not re-evaluate on primary-model fallback", async () => {
    const call = register();
    const f = await fixture();
    await f.assemble();
    await f.assemble({ fallbackActive: true });
    expect(call).toHaveBeenCalledOnce();
    expect(f.policy.current.tools.map((tool) => tool.name)).toEqual([
      "inspect_file",
      "message",
      "decision_evaluate",
    ]);
  });
});
