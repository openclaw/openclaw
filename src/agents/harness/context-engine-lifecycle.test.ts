import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { assert, describe, expect, it, onTestFinished, vi } from "vitest";
import { buildMemorySystemPromptAddition } from "../../context-engine/delegate.js";
import { OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST } from "../../context-engine/host-compat.js";
import {
  registerContextEngineForOwner,
  resolveContextEngine,
} from "../../context-engine/registry.js";
import { buildContextEngineRuntimeSettings } from "../../context-engine/runtime-settings.js";
import type {
  ContextEngine,
  ContextEngineRuntimeContext,
  ContextEngineRuntimeSettings,
} from "../../context-engine/types.js";
import {
  clearMemoryPluginState,
  registerMemoryPromptPreparation,
  registerTestMemoryPromptBuilder,
  type MemoryPromptSectionParams,
} from "../../plugins/memory-state.test-fixtures.js";
import { compactContextEngineWithSafetyTimeout } from "../embedded-agent-runner/compaction-safety-timeout.js";
import { limitHistoryTurns } from "../embedded-agent-runner/history.js";
import { OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE } from "../internal-runtime-context.js";
import {
  assembleHarnessContextEngine,
  bootstrapHarnessContextEngine,
  finalizeHarnessContextEngineTurn,
  prepareHarnessContextEnginePrompt,
} from "./context-engine-lifecycle.js";
import {
  createContextEngine,
  sessionParams,
  textMessage,
} from "./context-engine-lifecycle.test-support.js";
import { createContextEngineLogicalTurnLease } from "./context-engine-logical-turn.js";

const { sessionId, sessionIdUsed, sessionKey, sessionFile } = sessionParams;

function registerTestContextEngine(
  id: string,
  factory: Parameters<typeof registerContextEngineForOwner>[1],
) {
  return registerContextEngineForOwner(id, factory, `test:${id}`, {
    allowSameOwnerRefresh: true,
  });
}

function runtimeContextMessage(content: string, timestamp: number): AgentMessage {
  return {
    role: "custom",
    customType: OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE,
    content,
    display: false,
    timestamp,
  } as AgentMessage;
}

let configuredProofEngineIdCounter = 0;
const uniqueConfiguredProofEngineId = () =>
  `configured-runtime-settings-proof-${++configuredProofEngineIdCounter}`;
async function configuredEngineLease(
  assemble: ContextEngine["assemble"],
  maxActiveTranscriptBytes = 1024,
) {
  const id = uniqueConfiguredProofEngineId();
  await registerTestContextEngine(id, () =>
    createContextEngine({ info: { id, name: id }, assemble }),
  );
  const lease = await createContextEngineLogicalTurnLease({
    identity: { runId: id, sessionId },
    config: {
      plugins: { slots: { contextEngine: id } },
      agents: { defaults: { compaction: { maxActiveTranscriptBytes } } },
    },
  });
  onTestFinished(() => lease.dispose());
  return lease;
}

const assemblySession = {
  sessionId,
  sessionKey,
};
const unchangedMaintenance = { changed: false, bytesFreed: 0, rewrittenEntries: 0 };
const finalizationSession = {
  promptError: false,
  aborted: false,
  yieldAborted: false,
  sessionIdUsed,
  sessionKey,
  sessionFile,
  warn: () => {},
};
const promptDefaults = {
  ...sessionParams,
  modelId: "test-model",
  promptBudget: {
    contextTokens: 100_000,
    reserveTokens: 0,
    systemPrompt: "Required instructions",
    prompt: "next",
  },
  repairToolUseResultPairing: true,
  isOpenAIResponsesApi: true,
};
function toolCallMessage(id: string, timestamp: number) {
  const message = textMessage("assistant", "", timestamp);
  assert(message.role === "assistant");
  message.content = [{ type: "toolCall", id, name: "exec", arguments: {} }];
  return message;
}

describe("harness context engine lifecycle", () => {
  it.each([true, false])(
    "repairs the final tool conversation (context engine=%s)",
    async (withEngine) => {
      const currentRequest = textMessage("user", "Current request", 4);
      const output = toolCallMessage(withEngine ? "engine_call" : "call_fixture", 6);
      const messages: AgentMessage[] = withEngine
        ? [
            textMessage("user", "Old request", 1),
            toolCallMessage("evicted_call", 2),
            textMessage("user", "Middle request", 3),
            currentRequest,
            {
              role: "toolResult",
              toolCallId: "evicted_call",
              toolName: "exec",
              content: [{ type: "text", text: "Late result from evicted history" }],
              isError: false,
              timestamp: 5,
            },
          ]
        : [currentRequest, output];
      const original = JSON.stringify(messages);
      const windowed = withEngine ? limitHistoryTurns(messages, 1) : messages;
      if (withEngine) {
        expect(windowed).toEqual(messages.slice(3));
      }
      const assemble = vi.fn(
        async ({ messages: input }: Parameters<ContextEngine["assemble"]>[0]) => {
          expect(input).toEqual([currentRequest]);
          return {
            messages: [...input, output],
            estimatedTokens: 0,
            promptAuthority: "preassembly_may_overflow" as const,
          };
        },
      );
      const warn = vi.fn();
      const result = await prepareHarnessContextEnginePrompt({
        ...promptDefaults,
        messages: windowed,
        contextEngine: withEngine ? createContextEngine({ assemble }) : undefined,
        warn,
      });
      expect(assemble).toHaveBeenCalledTimes(withEngine ? 1 : 0);
      expect(warn).not.toHaveBeenCalled();
      if (withEngine) {
        expect(result.unwindowedContextEngineMessagesForPrecheck).toEqual([currentRequest]);
        expect(windowed).toEqual(messages.slice(3));
      }
      expect(result.messages).toHaveLength(3);
      expect(result.messages[2]).toMatchObject({
        role: "toolResult",
        toolCallId: withEngine ? "engine_call" : "call_fixture",
        toolName: "exec",
        isError: true,
        content: [{ type: "text", text: "aborted" }],
      });
      expect(JSON.stringify(messages)).toBe(original);
    },
  );

  it.each(["repair", "bounding"] as const)(
    "falls back when plugin output fails during %s",
    async (phase) => {
      const messages = [textMessage("user", "Valid pipeline history", 1)];
      const original = JSON.stringify(messages);
      const malformed = textMessage("assistant", "Malformed plugin output", 2);
      if (phase === "repair") {
        Object.defineProperty(malformed, "content", {
          get: () => {
            throw new Error("synthetic repair failure");
          },
        });
      } else {
        const argumentsWithCycle: Record<string, unknown> = {};
        argumentsWithCycle.self = argumentsWithCycle;
        assert(malformed.role === "assistant");
        malformed.content = [
          { type: "toolCall", id: "cyclic_fixture", name: "exec", arguments: argumentsWithCycle },
        ];
      }
      const lease = await configuredEngineLease(async () => ({
        messages: [malformed],
        estimatedTokens: 0,
        systemPromptAddition: "Invalid plugin instructions",
      }));
      const warn = vi.fn();
      const result = await prepareHarnessContextEnginePrompt({
        ...promptDefaults,
        contextEngine: lease.engine,
        messages,
        warn,
      });
      expect(result.messages).toEqual(messages);
      expect(Buffer.byteLength(JSON.stringify(result.messages))).toBeLessThanOrEqual(1024);
      expect(JSON.stringify(messages)).toBe(original);
      expect(result.systemPrompt).toBe("Required instructions");
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("context engine assemble failed, using pipeline messages:"),
      );
    },
  );

  it.each([false, true])(
    "counts synthetic tool results in the byte cap (engine throws=%s)",
    async (throws) => {
      const messages: AgentMessage[] = [
        textMessage("user", "old history ".repeat(500), 1),
        textMessage("user", "Run the tools", 2),
        {
          role: "assistant",
          content: Array.from({ length: 6 }, (_, index) => ({
            type: "toolCall",
            id: `call_fixture_${index}`,
            name: "exec",
            arguments: {},
          })),
          timestamp: 3,
        } as AgentMessage,
        textMessage("user", "Current surviving request", 4),
      ];
      const original = JSON.stringify(messages);
      const cap = Buffer.byteLength(JSON.stringify(messages.slice(1))) + 1;
      const lease = await configuredEngineLease(async ({ messages: input }) => {
        if (throws) {
          throw new Error("fixture assembly failure");
        }
        return { messages: input, estimatedTokens: 0 };
      }, cap);
      const bounded = await prepareHarnessContextEnginePrompt({
        ...promptDefaults,
        contextEngine: lease.engine,
        messages,
        warn: vi.fn(),
      });
      expect(bounded.messages).toEqual(messages.slice(3));
      expect(Buffer.byteLength(JSON.stringify(bounded.messages))).toBeLessThanOrEqual(cap);
      expect(JSON.stringify(messages)).toBe(original);
    },
  );

  it("bounds oversized assembly without changing stored messages", async () => {
    const messages = [
      textMessage("user", "old history ".repeat(500), 1),
      textMessage("assistant", "old answer", 2),
      textMessage("user", "recent ask", 3),
      textMessage("assistant", "recent answer", 4),
    ];
    const original = JSON.stringify(messages);
    const lease = await configuredEngineLease(async ({ messages: input }) => ({
      messages: input,
      estimatedTokens: 10_000,
      systemPromptAddition: "Required engine instructions",
    }));
    const contextEngine = lease.engine;
    const params = {
      ...sessionParams,
      contextEngine,
      messages,
      modelId: "test-model",
      tokenBudget: 2000,
    };
    const bounded = await prepareHarnessContextEnginePrompt({
      ...params,
      promptBudget: {
        contextTokens: 4000,
        reserveTokens: 1000,
        systemPrompt: "Required system instructions",
        prompt: "Current request",
      },
      repairToolUseResultPairing: true,
      isOpenAIResponsesApi: false,
      warn: vi.fn(),
    });
    expect(bounded.messages).toEqual(messages.slice(2));
    expect(bounded.systemPrompt).toContain("Required system instructions");
    expect(Buffer.byteLength(JSON.stringify(bounded.messages))).toBeLessThanOrEqual(1024);
    expect(JSON.stringify(messages)).toBe(original);
    const first = await assembleHarnessContextEngine(params);
    const second = await assembleHarnessContextEngine(params);
    expect(first?.contextProjection?.mode).toBe("thread_bootstrap");
    expect(first?.contextProjection).toEqual(second?.contextProjection);
    expect(first?.systemPromptAddition).toBe("Required engine instructions");
  });

  it("isolates prepared memory tools across sandboxed non-legacy turns", async () => {
    onTestFinished(() => clearMemoryPluginState());
    const prepare = vi.fn(async (params: MemoryPromptSectionParams) => {
      const tools = [...params.availableTools].join(",");
      params.availableTools.add("preparer-only");
      await Promise.resolve();
      return ["## Prepared Memory", `sandboxed=${params.sandboxed}; tools=${tools}`, ""];
    });
    registerTestMemoryPromptBuilder(({ availableTools }) => {
      availableTools.add("builder-only");
      return ["## Memory Recall", ""];
    });
    registerMemoryPromptPreparation("memory-wiki", prepare);
    const assemble = vi.fn(async (params: Parameters<ContextEngine["assemble"]>[0]) => ({
      messages: params.messages,
      estimatedTokens: 0,
      systemPromptAddition: buildMemorySystemPromptAddition({
        availableTools: params.availableTools ?? new Set(),
        citationsMode: params.citationsMode,
      }),
    }));

    for (const toolNames of [undefined, [], ["wiki_search"], ["memory_search"]]) {
      const availableTools = toolNames ? new Set(toolNames) : undefined;
      const result = await assembleHarnessContextEngine({
        contextEngine: createContextEngine({ assemble }),
        sessionId,
        sessionKey: "global",
        agentId: "support",
        messages: [textMessage("user", "visible ask", 1)],
        availableTools,
        citationsMode: "on",
        sandboxed: true,
        modelId: "gpt-test",
      });

      expect(result?.systemPromptAddition).toBe(
        `## Memory Recall\n\n## Prepared Memory\nsandboxed=true; tools=${(toolNames ?? []).join(",")}`,
      );
      expect([...(availableTools ?? [])]).toEqual(toolNames ?? []);
      expect(prepare).toHaveBeenLastCalledWith(
        expect.objectContaining({
          agentId: "support",
          agentSessionKey: "global",
          sandboxed: true,
        }),
      );
    }
    expect(buildMemorySystemPromptAddition({ availableTools: new Set() })).toBe("## Memory Recall");
  });

  it("keeps persisted runtime-context carriers in place for append-only replay policies", async () => {
    // Prefix-bound thinking (Anthropic family) is signed over every earlier message,
    // including the carrier that followed its user turn; assembly must not drop it.
    const visibleUser = textMessage("user", "visible ask", 1);
    const persistedCarrier = runtimeContextMessage("persisted runtime context", 2);
    const visibleAssistant = textMessage("assistant", "visible answer", 3);
    const assemble = vi.fn(async (params: Parameters<ContextEngine["assemble"]>[0]) => ({
      messages: params.messages,
      estimatedTokens: 0,
    }));

    await assembleHarnessContextEngine({
      contextEngine: createContextEngine({ assemble }),
      ...assemblySession,
      appendOnlyRuntimeContext: true,
      messages: [visibleUser, persistedCarrier, visibleAssistant],
      modelId: "claude-test",
    });

    const assembleParams = assemble.mock.calls.at(0)?.[0];
    expect(assembleParams?.messages).toEqual([visibleUser, persistedCarrier, visibleAssistant]);
  });

  it("preserves the authoritative history when assembly mutates then throws", async () => {
    const first = textMessage("user", "first", 1);
    const second = textMessage("assistant", "second", 2);
    const messages = [first, second];
    const contextEngine = createContextEngine({
      assemble: vi.fn(async ({ messages: workingMessages }) => {
        workingMessages.reverse();
        workingMessages.pop();
        throw new Error("assembly failed after windowing");
      }),
    });

    await expect(
      assembleHarnessContextEngine({
        contextEngine,
        ...assemblySession,
        messages,
        modelId: "gpt-test",
      }),
    ).rejects.toThrow("assembly failed after windowing");

    expect(messages).toEqual([first, second]);
    expect(messages[0]).toBe(first);
    expect(messages[1]).toBe(second);
  });

  it("passes runtime settings through a configured context engine across lifecycle hooks", async () => {
    const engineId = uniqueConfiguredProofEngineId();
    type Hook = "bootstrap" | "assemble" | "afterTurn" | "maintain" | "compact";
    const captured: Array<{
      hook: Hook;
      runtimeContext?: ContextEngineRuntimeContext;
      runtimeSettings?: ContextEngineRuntimeSettings;
      sessionTarget?: ContextEngineRuntimeContext["sessionTarget"];
    }> = [];
    const sessionTarget = {
      agentId: "main",
      sessionId,
      sessionKey,
      storePath: "/tmp/state/openclaw.sqlite",
    };
    const bootstrapRuntimeContext = {
      transcriptStorage: { kind: "sqlite" as const },
      sessionTarget,
      promptCache: { observation: { broke: true } },
    } satisfies ContextEngineRuntimeContext;
    const observe = <T extends Omit<(typeof captured)[number], "hook">, R>(
      hook: Hook,
      result: (params: T) => R,
    ) =>
      vi.fn(async (params: T) => {
        captured.push({ hook, ...params });
        return result(params);
      });
    const engine = createContextEngine({
      info: {
        id: engineId,
        name: "Configured runtime settings proof engine",
        acceptedHostParams: ["runtimeSettings", "runtimeContext", "sessionTarget"],
      },
      bootstrap: observe("bootstrap", () => ({ bootstrapped: true })),
      assemble: observe("assemble", (params: Parameters<ContextEngine["assemble"]>[0]) => ({
        messages: params.messages,
        estimatedTokens: 0,
      })),
      afterTurn: observe("afterTurn", () => undefined),
      maintain: observe("maintain", () => unchangedMaintenance),
      compact: observe("compact", () => ({ ok: true, compacted: false })),
    });
    await registerTestContextEngine(engineId, () => engine);
    const configuredEngine = await resolveContextEngine({
      plugins: { slots: { contextEngine: engineId } },
    });

    const lifecycleParams = {
      ...assemblySession,
      contextEngine: configuredEngine,
      providerId: "openai",
      requestedModelId: "openai/gpt-5.5",
      modelId: "anthropic/claude-sonnet-4-6",
      fallbackReason: "primary_provider_5xx",
      runtimeContext: bootstrapRuntimeContext,
      tokenBudget: 2048,
    };
    await bootstrapHarnessContextEngine({
      ...lifecycleParams,
      hadSessionFile: true,
      sessionTarget,
      sessionFile,
      warn: () => {},
    });

    await assembleHarnessContextEngine({
      ...lifecycleParams,
      messages: [textMessage("user", "visible ask", 1)],
    });

    await finalizeHarnessContextEngineTurn({
      ...lifecycleParams,
      ...finalizationSession,
      sessionTarget,
      messagesSnapshot: [textMessage("assistant", "new answer", 4)],
      prePromptMessageCount: 0,
    });

    const compactRuntimeSettings = buildContextEngineRuntimeSettings({
      contextEngineHost: OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
      provider: "openai",
      requestedModel: "openai/gpt-5.5",
      resolvedModel: "anthropic/claude-sonnet-4-6",
      selectedContextEngineId: engineId,
      contextEngineSelectionSource: "configured",
      promptTokenBudget: 2048,
      fallbackReason: "primary_provider_5xx",
    });
    await compactContextEngineWithSafetyTimeout(
      configuredEngine,
      {
        sessionId,
        sessionKey,
        sessionTarget: assemblySession,
        tokenBudget: 2048,
        runtimeSettings: compactRuntimeSettings,
      },
      100,
    );

    expect(new Set(captured.map((entry) => entry.hook))).toEqual(
      new Set(["bootstrap", "assemble", "afterTurn", "maintain", "compact"]),
    );
    const capturedFor = (hook: Hook) => captured.find((entry) => entry.hook === hook);
    for (const hook of ["bootstrap", "afterTurn"] as const) {
      const capturedHook = capturedFor(hook);
      expect(capturedHook?.runtimeContext).toEqual(bootstrapRuntimeContext);
      expect(capturedHook?.sessionTarget).toEqual(sessionTarget);
    }
    expect(capturedFor("maintain")?.sessionTarget).toEqual(sessionTarget);
    expect(capturedFor("maintain")?.runtimeContext?.sessionTarget).toEqual(sessionTarget);
    for (const entry of captured) {
      expect(entry.runtimeSettings).toMatchObject({
        schemaVersion: 1,
        limits: { promptTokenBudget: 2048 },
        runtime: { mode: "fallback" },
        model: {
          requested: "openai/gpt-5.5",
          resolved: "anthropic/claude-sonnet-4-6",
          provider: "openai",
          family: null,
        },
        contextEngineSelection: { selectedId: engineId, source: "configured" },
        diagnostics: { fallbackReason: "provider_unavailable" },
      });
    }
  });

  // #75541: malformed plugin results must fail before poisoning activeSession.messages.
  it.each([
    { result: undefined, error: /context engine "broken-engine"[\s\S]*messages/ },
    { result: { messages: null, estimatedTokens: 0 }, error: /messages of type null/ },
  ])("rejects malformed assemble results: $error", async ({ result, error }) => {
    await expect(
      assembleHarnessContextEngine({
        contextEngine: createContextEngine({
          info: { id: "broken-engine", name: "Broken engine" },
          assemble: vi.fn(async () => result as never),
        }),
        ...assemblySession,
        messages: [textMessage("user", "ping", 1)],
        modelId: "gpt-test",
      }),
    ).rejects.toThrow(error);
  });

  it.each(["batch", "message"] as const)(
    "forwards heartbeat and visible turn messages to %s ingestion",
    async (mode) => {
      const turnUser = textMessage("user", "new ask", 4);
      const turnAssistant = textMessage("assistant", "new answer", 6);
      const ingest = vi.fn<NonNullable<ContextEngine["ingest"]>>(async () => ({ ingested: true }));
      const ingestBatch = vi.fn<NonNullable<ContextEngine["ingestBatch"]>>(async () => ({
        ingestedCount: 2,
      }));

      await finalizeHarnessContextEngineTurn({
        contextEngine: createContextEngine({
          ingest,
          ingestBatch: mode === "batch" ? ingestBatch : undefined,
        }),
        ...finalizationSession,
        messagesSnapshot:
          mode === "batch"
            ? [
                textMessage("user", "old ask", 1),
                runtimeContextMessage("old hidden context", 2),
                textMessage("assistant", "old answer", 3),
                turnUser,
                runtimeContextMessage("new hidden context", 5),
                turnAssistant,
              ]
            : [turnUser, turnAssistant],
        prePromptMessageCount: mode === "batch" ? 3 : 0,
        tokenBudget: 2048,
        runtimeContext: {},
        runMaintenance: async () => undefined,
        isHeartbeat: true,
      });

      if (mode === "batch") {
        expect(ingestBatch.mock.calls[0]?.[0].messages).toEqual([turnUser, turnAssistant]);
      }
      const calls = mode === "batch" ? ingestBatch.mock.calls : ingest.mock.calls;
      expect(calls).toHaveLength(mode === "batch" ? 1 : 2);
      for (const [params] of calls) {
        expect(params).toMatchObject({ isHeartbeat: true, sessionKey });
      }
    },
  );

  it.each(["afterTurn", "ingestBatch"] as const)(
    "skips turn maintenance when %s fails",
    async (failingHook) => {
      const runMaintenance = vi.fn(async () => undefined);
      const contextEngine = createContextEngine({
        afterTurn: undefined,
        ingestBatch: undefined,
        [failingHook]: vi.fn(async () => {
          throw new Error(`${failingHook} failed`);
        }),
      });

      await finalizeHarnessContextEngineTurn({
        contextEngine,
        ...finalizationSession,
        messagesSnapshot: [textMessage("assistant", "done", 1)],
        prePromptMessageCount: 0,
        runMaintenance,
      });

      expect(runMaintenance).not.toHaveBeenCalled();
    },
  );

  it("runs bootstrap maintenance for existing sessions without bootstrap()", async () => {
    const runMaintenance = vi.fn(async () => undefined);

    await bootstrapHarnessContextEngine({
      hadSessionFile: true,
      contextEngine: createContextEngine({
        bootstrap: undefined,
        maintain: vi.fn(async () => unchangedMaintenance),
      }),
      ...assemblySession,
      sessionFile,
      runMaintenance,
      warn: () => {},
    });

    expect(runMaintenance).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "bootstrap",
        sessionKey,
      }),
    );
  });

  it("does not advance context ingestion for yielded turns", async () => {
    const afterTurn = vi.fn(async () => {});
    const ingest = vi.fn(async () => ({ ingested: true }));
    const ingestBatch = vi.fn(async () => ({ ingestedCount: 0 }));
    const maintain = vi.fn(async () => unchangedMaintenance);

    await finalizeHarnessContextEngineTurn({
      contextEngine: createContextEngine({ afterTurn, ingest, ingestBatch, maintain }),
      ...finalizationSession,
      yieldAborted: true,
      messagesSnapshot: [textMessage("user", "failed", 1)],
      prePromptMessageCount: 0,
    });

    expect(afterTurn).not.toHaveBeenCalled();
    expect(ingest).not.toHaveBeenCalled();
    expect(ingestBatch).not.toHaveBeenCalled();
    expect(maintain).not.toHaveBeenCalled();
  });
});
