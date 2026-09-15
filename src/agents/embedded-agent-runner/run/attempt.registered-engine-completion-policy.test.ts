// A context engine resolved through the real plugin registry carries its
// owning plugin id into every minted completion capability, so the plugin's
// completion allowlist applies to engine-initiated completions during recall.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerContextEngineForOwner,
  resolveContextEngine,
  resolveContextEngineOwnerPluginId,
} from "../../../context-engine/registry.js";
import type { ContextEngine, ContextEngineRuntimeContext } from "../../../context-engine/types.js";
import { clearMemoryPluginState } from "../../../plugins/memory-state.test-fixtures.js";
import { projectAgentRunAttemptTerminal } from "../../agent-run-terminal-outcome.js";
import type { AttemptContextEngine } from "./attempt-context-engine-helpers.js";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  preloadRunEmbeddedAttemptForTests,
  resetEmbeddedAttemptHarness,
} from "./attempt-spawn-workspace.test-support.js";

const completionRuntimeHoisted = vi.hoisted(() => ({
  acquireSimpleCompletionModelForAgent: vi.fn(),
  completeWithPreparedSimpleCompletionModel: vi.fn(),
  resolveSimpleCompletionSelectionForAgent: vi.fn(),
}));

vi.mock("../../simple-completion-runtime.js", () => ({
  acquireSimpleCompletionModelForAgent:
    completionRuntimeHoisted.acquireSimpleCompletionModelForAgent,
  completeWithPreparedSimpleCompletionModel:
    completionRuntimeHoisted.completeWithPreparedSimpleCompletionModel,
  resolveSimpleCompletionSelectionForAgent:
    completionRuntimeHoisted.resolveSimpleCompletionSelectionForAgent,
}));

const engineId = "test-policy-context-engine";
const ownerPluginId = "test-policy-plugin";
const allowedModel = "openai/allowed-model";
const forbiddenModel = "openai/forbidden-model";

type CompletionObservation = {
  model: string;
  denied: boolean;
  message?: string;
};

type RecallObservation = {
  senderIds: unknown[];
  completions: CompletionObservation[];
};

function createPreparedCompletionModel() {
  return {
    async [Symbol.asyncDispose]() {},
    selection: {
      provider: "openai",
      modelId: "allowed-model",
      agentDir: "/tmp/openclaw-agent",
    },
    model: {
      provider: "openai",
      id: "allowed-model",
      name: "allowed-model",
      api: "openai",
      baseUrl: "https://fixture.invalid/v1",
      input: ["text"],
      reasoning: false,
      contextWindow: 128_000,
      maxTokens: 4096,
      cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
    },
  };
}

function makePolicyProbingContextEngine(recall: RecallObservation): ContextEngine {
  const probe = async (
    runtimeContext: ContextEngineRuntimeContext | undefined,
    model: string,
  ): Promise<void> => {
    const complete = runtimeContext?.llm?.complete;
    if (!complete) {
      throw new Error("runtimeContext exposed no llm completion capability");
    }
    try {
      await complete({
        model,
        messages: [{ role: "user", content: "recall probe" }],
      } as never);
      recall.completions.push({ model, denied: false });
    } catch (error) {
      recall.completions.push({ model, denied: true, message: (error as Error).message });
    }
  };
  return {
    info: {
      id: engineId,
      name: "Test Policy Context Engine",
      version: "0.0.1",
    },
    assemble: async (rawParams) => {
      const params = rawParams as {
        messages: Parameters<AttemptContextEngine["assemble"]>[0]["messages"];
        runtimeContext?: ContextEngineRuntimeContext;
      };
      recall.senderIds.push(params.runtimeContext?.senderId);
      await probe(params.runtimeContext, forbiddenModel);
      await probe(params.runtimeContext, allowedModel);
      return { messages: params.messages, estimatedTokens: 1 };
    },
    ingest: async () => ({ ingested: true }),
    compact: async () => ({ ok: true, compacted: false }),
  };
}

describe("registered context engine completion policy", () => {
  const sessionKey = "agent:main:guildchat:channel:test-policy-engine";
  const tempPaths: string[] = [];
  const configPatch = {
    agents: {
      defaults: {
        model: allowedModel,
      },
    },
    plugins: {
      slots: { contextEngine: engineId },
      entries: {
        [ownerPluginId]: {
          llm: {
            allowedCompletionModels: [allowedModel],
            // The probe requests explicit models; override authority is a
            // separate plugin grant from the completion allowlist.
            allowModelOverride: true,
          },
        },
      },
    },
  };

  beforeAll(async () => {
    await preloadRunEmbeddedAttemptForTests();
  });

  beforeEach(() => {
    resetEmbeddedAttemptHarness();
    clearMemoryPluginState();
    completionRuntimeHoisted.acquireSimpleCompletionModelForAgent.mockReset();
    completionRuntimeHoisted.completeWithPreparedSimpleCompletionModel.mockReset();
    completionRuntimeHoisted.resolveSimpleCompletionSelectionForAgent.mockReset();
    completionRuntimeHoisted.acquireSimpleCompletionModelForAgent.mockResolvedValue({
      async [Symbol.asyncDispose]() {},
      selection: {
        provider: "openai",
        modelId: "allowed-model",
        agentDir: "/tmp/openclaw-agent",
      },
      model: {
        provider: "openai",
        id: "allowed-model",
        name: "allowed-model",
        api: "openai",
        baseUrl: "https://fixture.invalid/v1",
        input: ["text"],
        reasoning: false,
        contextWindow: 128_000,
        maxTokens: 4096,
        cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
      },
    });
    completionRuntimeHoisted.completeWithPreparedSimpleCompletionModel.mockResolvedValue({
      content: [{ type: "text", text: "probe-ok" }],
      responseModel: "allowed-model",
      stopReason: "stop",
      usage: {
        input: 11,
        output: 7,
        cacheRead: 5,
        cacheWrite: 2,
        total: 25,
        cost: { total: 0.0042 },
      },
    });
    completionRuntimeHoisted.resolveSimpleCompletionSelectionForAgent.mockImplementation(
      (params: { modelRef?: string }) => {
        const modelRef = params.modelRef ?? allowedModel;
        const slash = modelRef.indexOf("/");
        return {
          provider: slash > 0 ? modelRef.slice(0, slash) : "openai",
          modelId: slash > 0 ? modelRef.slice(slash + 1) : modelRef,
        };
      },
    );
  });

  afterEach(async () => {
    await cleanupTempPaths(tempPaths);
    clearMemoryPluginState();
    vi.restoreAllMocks();
  });

  it("binds recall completions to the owning plugin allowlist and sender identity", async () => {
    const recall: RecallObservation = { senderIds: [], completions: [] };
    const registration = registerContextEngineForOwner(
      engineId,
      async () => makePolicyProbingContextEngine(recall),
      `plugin:${ownerPluginId}`,
      { allowSameOwnerRefresh: true },
    );
    expect(registration.ok).toBe(true);

    const resolved = await resolveContextEngine(configPatch as never);
    // The registry-resolved engine exposes its owning plugin, which is what
    // binds the minted capability to the plugin's completion policy.
    expect(resolveContextEngineOwnerPluginId(resolved)).toBe(ownerPluginId);

    const result = await createContextEngineAttemptRunner({
      // The helper rebuilds its contextEngine param from own enumerable keys,
      // which drops registry-wrapper methods (inherited through the Proxy
      // target's prototype); override the assembled attempt with the same
      // resolved engine so the runner exercises the real wrapper.
      contextEngine: resolved as unknown as AttemptContextEngine,
      sessionKey,
      tempPaths,
      attemptOverrides: {
        senderId: "user-42",
        contextEngine: resolved as unknown as AttemptContextEngine,
      },
      configPatch,
    });

    expect(projectAgentRunAttemptTerminal(result.terminal).promptError).toBeNull();
    expect(recall.senderIds.length).toBeGreaterThan(0);
    expect(recall.senderIds[0]).toBe("user-42");

    // The policy-excluded model is denied by the owning plugin's completion
    // allowlist before acquisition; the allowlisted model completes.
    const denied = recall.completions.find((entry) => entry.model === forbiddenModel);
    expect(denied?.denied).toBe(true);
    expect(denied?.message).toContain("is not allowlisted");
    expect(denied?.message).toContain(`for plugin "${ownerPluginId}"`);
    const allowed = recall.completions.find((entry) => entry.model === allowedModel);
    expect(allowed).toEqual({ model: allowedModel, denied: false });
    expect(completionRuntimeHoisted.acquireSimpleCompletionModelForAgent).toHaveBeenCalledTimes(1);
    expect(
      completionRuntimeHoisted.acquireSimpleCompletionModelForAgent.mock.calls[0]?.[0],
    ).toMatchObject({
      agentId: "main",
      modelRef: allowedModel,
    });
  });

  it("revokes a suspended recall completion when the run aborts during preparation", async () => {
    // The capability assertion passes at entry, but the run can abort while
    // the retained completion is suspended on model acquisition. The minted
    // capability must not dispatch to the provider with revoked authority.
    let releaseAcquisition: ((value: unknown) => void) | undefined;
    completionRuntimeHoisted.acquireSimpleCompletionModelForAgent.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseAcquisition = resolve;
        }),
    );
    const abortController = new AbortController();
    const recall: RecallObservation = { senderIds: [], completions: [] };
    const registration = registerContextEngineForOwner(
      engineId,
      async () => {
        const engine = makePolicyProbingContextEngine(recall);
        return {
          ...engine,
          assemble: async (rawParams: Parameters<AttemptContextEngine["assemble"]>[0]) => {
            const params = rawParams as {
              messages: Parameters<AttemptContextEngine["assemble"]>[0]["messages"];
              runtimeContext?: ContextEngineRuntimeContext;
            };
            recall.senderIds.push(params.runtimeContext?.senderId);
            const complete = params.runtimeContext?.llm?.complete;
            if (!complete) {
              throw new Error("runtimeContext exposed no llm completion capability");
            }
            const pending = complete({
              model: allowedModel,
              messages: [{ role: "user", content: "suspension probe" }],
            } as never);
            await vi.waitFor(
              () => {
                expect(releaseAcquisition).toBeDefined();
              },
              { timeout: 15_000 },
            );
            // Abort while the completion is suspended on acquisition, then
            // let the acquisition settle as it would after a real selection.
            abortController.abort();
            releaseAcquisition?.(createPreparedCompletionModel());
            try {
              await pending;
              recall.completions.push({ model: allowedModel, denied: false });
            } catch (error) {
              recall.completions.push({
                model: allowedModel,
                denied: true,
                message: (error as Error).message,
              });
            }
            return { messages: params.messages, estimatedTokens: 1 };
          },
        };
      },
      `plugin:${ownerPluginId}`,
      { allowSameOwnerRefresh: true },
    );
    expect(registration.ok).toBe(true);

    const resolved = await resolveContextEngine(configPatch as never);
    const result = await createContextEngineAttemptRunner({
      contextEngine: resolved as unknown as AttemptContextEngine,
      sessionKey,
      tempPaths,
      attemptOverrides: {
        abortSignal: abortController.signal,
        contextEngine: resolved as unknown as AttemptContextEngine,
      },
      configPatch,
    });

    // The abort aborts the attempt itself; the suspended capability must not
    // have reached the provider.
    expect(projectAgentRunAttemptTerminal(result.terminal).promptError).toBeDefined();
    const suspended = recall.completions.find((entry) => entry.model === allowedModel);
    expect(suspended?.denied).toBe(true);
    expect(suspended?.message).toContain("no longer active");
    expect(
      completionRuntimeHoisted.completeWithPreparedSimpleCompletionModel,
    ).not.toHaveBeenCalled();
  });
});
