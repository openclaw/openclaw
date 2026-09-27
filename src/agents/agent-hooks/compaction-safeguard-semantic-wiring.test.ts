import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import type { ExtensionAPI, ExtensionContext } from "openclaw/plugin-sdk/agent-sessions";
import type { Model } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import { createRuntimeConfigReader } from "../../config/runtime-snapshot.js";
import * as decisionRuntime from "../../decisions/runtime.js";
import { DecisionConsumerClosedError } from "../../decisions/validation.js";
import type { CompactionProvider } from "../../plugins/compaction-provider.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  bindPluginRegistryResourceOwner,
  markPluginRegistryActive,
  markPluginRegistryRetired,
} from "../../plugins/registry-lifecycle.js";
import {
  resetPluginRuntimeStateForTest,
  requireActivePluginRegistry,
} from "../../plugins/runtime.js";
import {
  withPluginRuntimeGatewayRequestScope,
  withPluginRuntimeRegistryScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { summarizeInStages } from "../compaction.js";
import { isDecisionAssistanceEligible } from "../decision-assistance.js";
import { castAgentMessage } from "../test-helpers/agent-message-fixtures.js";
import { timestampedTextAssistant } from "../test-helpers/sparse-transcript.test-support.js";
import { setCompactionSafeguardRuntime } from "./compaction-safeguard-runtime.js";
import { installDecisionFixture } from "./compaction-safeguard-semantic.test-support.js";
import compactionSafeguardExtension from "./compaction-safeguard.js";
import { testing } from "./compaction-safeguard.test-support.js";

const { compactionLogger } = vi.hoisted(() => {
  const logger = {
    subsystem: "compaction-safeguard",
    isEnabled: vi.fn(() => false),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    raw: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  return { compactionLogger: logger };
});

vi.mock("../../logging/subsystem.js", async () => {
  const actual = await vi.importActual<typeof import("../../logging/subsystem.js")>(
    "../../logging/subsystem.js",
  );
  return { ...actual, createSubsystemLogger: () => compactionLogger };
});

const mockSummarizeInStages = vi.fn<typeof summarizeInStages>();
beforeEach(() => {
  testing.setSummarizeInStagesForTest(mockSummarizeInStages);
  compactionLogger.warn.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  testing.setSummarizeInStagesForTest();
  resetPluginRuntimeStateForTest();
});

function installCompactionProviderForTest(provider: CompactionProvider): void {
  requireActivePluginRegistry().compactionProviders.push({ provider });
}

function stubSessionManager(agentId?: string): ExtensionContext["sessionManager"] {
  const stub: ExtensionContext["sessionManager"] = {
    getCwd: () => "/stub",
    getSessionId: () => "stub-id",
    getSessionTarget: () =>
      agentId
        ? {
            agentId,
            sessionId: "stub-id",
            sessionKey: `agent:${agentId}:stub`,
            storePath: "/stub/sessions",
          }
        : undefined,
    getLeafId: () => null,
    getAppendParentId: () => null,
    getAppendMode: () => undefined,
    getLeafEntry: () => undefined,
    getEntry: () => undefined,
    getLabel: () => undefined,
    getBranch: () => [],
    getHeader: () => null,
    getEntries: () => [],
    getTree: () => [],
    getSessionName: () => undefined,
  };
  return stub;
}

function createAnthropicModelFixture(overrides: Partial<Model> = {}): Model {
  return {
    id: "claude-opus-4-5",
    name: "Claude Opus 4.5",
    provider: "anthropic",
    api: "anthropic" as const,
    baseUrl: "https://api.anthropic.com",
    contextWindow: 200000,
    maxTokens: 4096,
    reasoning: false,
    input: ["text"] as const,
    cost: { input: 15, output: 75, cacheRead: 0, cacheWrite: 0 },
    ...overrides,
  };
}

type CompactionHandler = (event: unknown, ctx: unknown) => Promise<unknown>;
const createCompactionHandler = () => {
  let compactionHandler: CompactionHandler | undefined;
  const mockApi = {
    on: vi.fn((event: string, handler: CompactionHandler) => {
      if (event === "session_before_compact") {
        compactionHandler = handler;
      }
    }),
  } as unknown as ExtensionAPI;
  compactionSafeguardExtension(mockApi);
  if (!compactionHandler) {
    throw new Error("Expected compaction safeguard to register a handler.");
  }
  return compactionHandler;
};

const createCompactionEvent = (params: { messageText: string; tokensBefore: number }) => ({
  preparation: {
    messagesToSummarize: [
      { role: "user", content: params.messageText, timestamp: Date.now() },
    ] as AgentMessage[],
    turnPrefixMessages: [] as AgentMessage[],
    firstKeptEntryId: "entry-1",
    tokensBefore: params.tokensBefore,
    fileOps: {
      read: [],
      edited: [],
      written: [],
    },
  },
  customInstructions: "",
  signal: new AbortController().signal,
});

const createCompactionContext = (params: {
  sessionManager: ExtensionContext["sessionManager"];
  getApiKeyAndHeadersMock?: ReturnType<typeof vi.fn>;
  getApiKeyMock?: ReturnType<typeof vi.fn>;
}) =>
  ({
    model: undefined,
    sessionManager: params.sessionManager,
    modelRegistry: {
      getApiKeyAndHeaders:
        params.getApiKeyAndHeadersMock ??
        vi.fn(async (model) => {
          const legacyGetApiKey = params.getApiKeyMock as
            | undefined
            | ((model: NonNullable<ExtensionContext["model"]>) => Promise<string | undefined>);
          const apiKey = await legacyGetApiKey?.(model);
          return apiKey !== undefined ? { ok: true, apiKey } : { ok: false, error: "missing auth" };
        }),
    },
  }) as unknown as Partial<ExtensionContext>;

async function runCompactionScenario(params: {
  sessionManager: ExtensionContext["sessionManager"];
  event: unknown;
  apiKey: string | null;
}) {
  const compactionHandler = createCompactionHandler();
  const getApiKeyAndHeadersMock = vi
    .fn()
    .mockResolvedValue(
      params.apiKey !== null
        ? { ok: true, apiKey: params.apiKey }
        : { ok: false, error: "missing auth" },
    );
  const mockContext = createCompactionContext({
    sessionManager: params.sessionManager,
    getApiKeyAndHeadersMock,
  });
  const event = params.event;
  const result = (await compactionHandler(event, mockContext)) as {
    cancel?: boolean;
    compaction?: {
      summary: string;
      firstKeptEntryId: string;
      tokensBefore: number;
    };
  };
  return { result, getApiKeyAndHeadersMock };
}

describe("compaction semantic observer wiring", () => {
  it("joins both Decision requests before propagating caller cancellation", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const abortError = new Error("cancel asymmetric semantic observation");
    let started = 0;
    const startedBarrier = createDeferredCore();
    let releaseSlowRequest: (() => void) | undefined;
    const slowRequest = new Promise<void>((resolve) => {
      releaseSlowRequest = resolve;
    });
    const { config, builder } = installDecisionFixture("preserved", async (_batch, context) => {
      started += 1;
      if (started === 2) {
        startedBarrier.resolve();
      }
      if (started === 1) {
        await new Promise<never>((_resolve, reject) => {
          context.signal.addEventListener(
            "abort",
            () => {
              reject(
                context.signal.reason instanceof Error
                  ? context.signal.reason
                  : new Error("semantic observation aborted"),
              );
            },
            { once: true },
          );
        });
      }
      await slowRequest;
    });
    mockSummarizeInStages.mockReset();
    mockSummarizeInStages.mockResolvedValue("The report remains pending.");
    const sessionManager = stubSessionManager("specialist");
    setCompactionSafeguardRuntime(sessionManager, {
      agentId: "specialist",
      model: createAnthropicModelFixture(),
      recentTurnsPreserve: 0,
      semanticCurationMode: "shadow",
    });
    const event = createCompactionEvent({ messageText: "Finish the report.", tokensBefore: 100 });
    event.preparation.messagesToSummarize.push(
      castAgentMessage(timestampedTextAssistant("Unrelated old discussion.", 2)),
    );
    const eventWithSignal = {
      ...event,
      signal: controller.signal,
      preparation: { ...event.preparation, settings: { reserveTokens: 4000 } },
    };
    const completion = runCompactionScenario({
      sessionManager,
      event: eventWithSignal,
      apiKey: "test-key",
    }).then(
      () => ({ status: "resolved" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );

    let settled = false;
    void completion.then(() => {
      settled = true;
    });
    try {
      await startedBarrier.promise;
      controller.abort(abortError);
      // Flush all queued promise reactions without racing a wall-clock timer.
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      expect(builder.registry.decisionProviders[0]?.host.inspect(config).activeRequests).toBe(1);
    } finally {
      // Failed settlement assertions must still let provider disposal finish.
      releaseSlowRequest?.();
      await completion;
    }
    await expect(completion).resolves.toEqual({ status: "rejected", error: abortError });
    expect(builder.registry.decisionProviders[0]?.host.inspect(config).activeRequests).toBe(0);
  });

  it.each(["off", "revoked", "allowed", "during-preparation"])(
    "gates registered-hook provider dispatch when Labs is %s",
    async (consent) => {
      const { config, requests } = installDecisionFixture();
      config.agents ??= {};
      config.agents.defaults ??= {};
      config.agents.defaults.experimental = { decisionAssistance: consent !== "off" };
      setRuntimeConfigSnapshot(config);
      const readConfig = createRuntimeConfigReader(config);
      const sessionManager = stubSessionManager("specialist");
      setCompactionSafeguardRuntime(sessionManager, {
        agentId: "specialist",
        model: createAnthropicModelFixture(),
        recentTurnsPreserve: 0,
        semanticCurationMode: "shadow",
        semanticCurationEligible: () => isDecisionAssistanceEligible(readConfig(), "specialist"),
      });
      mockSummarizeInStages.mockReset();
      mockSummarizeInStages.mockImplementation(async () => {
        if (consent === "revoked") {
          const disabled = {
            ...config,
            agents: {
              ...config.agents,
              defaults: { ...config.agents?.defaults, experimental: { decisionAssistance: false } },
            },
          };
          setRuntimeConfigSnapshot(disabled);
        }
        return "The report remains pending.";
      });
      const event = createCompactionEvent({ messageText: "Finish the report.", tokensBefore: 100 });
      event.preparation.messagesToSummarize.push(
        castAgentMessage(timestampedTextAssistant("Unrelated old discussion.", 2)),
      );
      const original = structuredClone(event.preparation.messagesToSummarize);
      const run = () =>
        runCompactionScenario({
          sessionManager,
          event: {
            ...event,
            preparation: { ...event.preparation, settings: { reserveTokens: 4000 } },
          },
          apiKey: "test-key",
        });
      if (consent === "during-preparation") {
        await withPluginRuntimeGatewayRequestScope(
          {
            isWebchatConnect: () => false,
            resolveGatewayContext: () => {
              queueMicrotask(() => {
                setRuntimeConfigSnapshot({
                  ...config,
                  agents: {
                    ...config.agents,
                    defaults: {
                      ...config.agents?.defaults,
                      experimental: { decisionAssistance: false },
                    },
                  },
                });
              });
              return undefined;
            },
          },
          run,
        );
      } else {
        await run();
      }
      expect(requests).toHaveLength(consent === "allowed" ? 2 : 0);
      expect(event.preparation.messagesToSummarize).toEqual(original);
      expect(mockSummarizeInStages).toHaveBeenCalledOnce();
    },
  );

  it.each(
    [false, true].flatMap((registeredProvider) =>
      [
        { agentId: undefined, persisted: false },
        { agentId: undefined, persisted: false, noGlobalModel: true },
        { agentId: "inherited", persisted: true },
        { agentId: "specialist", persisted: true },
        { agentId: "disabled", persisted: true },
        { agentId: "specialist", persisted: false },
        { agentId: "disabled", persisted: false },
      ].map(({ agentId, persisted, noGlobalModel }) => ({
        registeredProvider,
        agentId,
        persisted,
        noGlobalModel,
      })),
    ),
  )(
    "preserves output and owner decisions (registered provider=$registeredProvider, agent=$agentId, persisted=$persisted, no global model=$noGlobalModel)",
    async ({ registeredProvider, agentId, persisted, noGlobalModel }) => {
      const { config, builder, requests } = installDecisionFixture();
      if (noGlobalModel) {
        delete config.agents?.defaults?.decisionModel;
        setRuntimeConfigSnapshot(config);
      }
      mockSummarizeInStages.mockReset();
      mockSummarizeInStages.mockResolvedValue("The report remains pending.");
      const registeredInputs: unknown[] = [];
      if (registeredProvider) {
        installCompactionProviderForTest({
          id: "summary-fixture",
          label: "Summary fixture",
          summarize: async (input) => {
            registeredInputs.push(structuredClone(input));
            return "The report remains pending.";
          },
        });
      }
      const sessionManager = stubSessionManager(persisted ? agentId : undefined);
      const settings = {
        agentId: persisted ? "ambient" : agentId,
        model: createAnthropicModelFixture(),
        recentTurnsPreserve: 0,
        ...(registeredProvider ? { provider: "summary-fixture" } : {}),
      };
      const event = {
        ...createCompactionEvent({ messageText: "Finish the report.", tokensBefore: 100 }),
      };
      event.preparation.messagesToSummarize.push(
        castAgentMessage(timestampedTextAssistant("Unrelated old discussion.", 2)),
      );
      const preparedEvent = {
        ...event,
        preparation: { ...event.preparation, settings: { reserveTokens: 4000 } },
      };
      const sourceBefore = structuredClone(event.preparation.messagesToSummarize);
      setCompactionSafeguardRuntime(sessionManager, settings);
      const baseline = await runCompactionScenario({
        sessionManager,
        event: preparedEvent,
        apiKey: "test-key",
      });
      expect(builder.registry.decisionProviders[0]?.host.inspect(config).successCount).toBe(0);
      setCompactionSafeguardRuntime(sessionManager, {
        ...settings,
        semanticCurationMode: "shadow",
      });
      compactionLogger.info.mockClear();
      const observed = await runCompactionScenario({
        sessionManager,
        event: preparedEvent,
        apiKey: "test-key",
      });

      expect(observed.result).toEqual(baseline.result);
      expect(event.preparation.messagesToSummarize).toEqual(sourceBefore);
      if (registeredProvider) {
        expect(registeredInputs).toHaveLength(2);
        expect(registeredInputs[1]).toEqual(registeredInputs[0]);
      } else {
        expect(mockSummarizeInStages).toHaveBeenCalledTimes(2);
        expect(mockSummarizeInStages.mock.calls[1]?.[0].messages).toEqual(
          mockSummarizeInStages.mock.calls[0]?.[0].messages,
        );
      }
      expect(compactionLogger.info).toHaveBeenCalledWith(
        expect.stringContaining(
          `Compaction semantic shadow${agentId === "disabled" || noGlobalModel ? " unavailable" : ""}:`,
        ),
      );
      expect(compactionLogger.info).toHaveBeenCalledWith(
        expect.stringContaining(
          `Compaction semantic fidelity${agentId === "disabled" || noGlobalModel ? " unavailable" : ""}:`,
        ),
      );
      expect(builder.registry.decisionProviders[0]?.host.inspect(config)).toMatchObject({
        successCount: agentId === "disabled" || noGlobalModel ? 0 : 2,
        activeRequests: 0,
      });
      expect(requests).toEqual(
        agentId === "disabled" || noGlobalModel
          ? []
          : Array.from({ length: 2 }, () => ({
              agentId,
              model: agentId === "specialist" ? "owner-v1" : "default-v1",
            })),
      );
      expect(compactionLogger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining("semantic observation failed"),
      );
    },
  );
});

const validSummary = [
  "## Decisions",
  "No decisions.",
  "## Open TODOs",
  "Finish the report.",
  "## Constraints/Rules",
  "Keep all existing behavior.",
  "## Pending user asks",
  "Finish the report.",
  "## Exact identifiers",
  "None.",
].join("\n");

function activeScenario() {
  const sessionManager = stubSessionManager();
  setCompactionSafeguardRuntime(sessionManager, {
    model: createAnthropicModelFixture(),
    semanticCurationMode: "apply",
    recentTurnsPreserve: 0,
    qualityGuardEnabled: true,
    qualityGuardMaxRetries: 0,
  });
  const base = createCompactionEvent({
    messageText: "Keep all existing behavior.",
    tokensBefore: 100,
  });
  base.preparation.messagesToSummarize.push(
    castAgentMessage(timestampedTextAssistant("Unrelated old discussion.", 2)),
    { role: "user", content: "Finish the report.", timestamp: 3 },
  );
  const event = {
    ...base,
    preparation: { ...base.preparation, settings: { reserveTokens: 4000 } },
  };
  return { sessionManager, event, apiKey: "test-key" };
}

describe("active curation through the registered compaction hook", () => {
  it.each([
    { modelSelection: "absent" as const, registeredProvider: false },
    { modelSelection: "absent" as const, registeredProvider: true },
    { modelSelection: "agent-empty" as const, registeredProvider: false },
    { modelSelection: "agent-empty" as const, registeredProvider: true },
  ])(
    "uses one original-source summary when the decision model is $modelSelection (registered provider=$registeredProvider)",
    async ({ modelSelection, registeredProvider }) => {
      const { config, requests } = installDecisionFixture();
      if (modelSelection === "absent") {
        delete config.agents?.defaults?.decisionModel;
        setRuntimeConfigSnapshot(config);
      }
      if (registeredProvider) {
        installCompactionProviderForTest({
          id: "summary-fixture",
          label: "Summary fixture",
          summarize: async () => validSummary,
        });
      }
      const scenario = activeScenario();
      if (modelSelection === "agent-empty") {
        scenario.sessionManager = stubSessionManager("disabled");
        setCompactionSafeguardRuntime(scenario.sessionManager, {
          agentId: "disabled",
          model: createAnthropicModelFixture(),
          semanticCurationMode: "apply",
          recentTurnsPreserve: 0,
          qualityGuardEnabled: true,
          qualityGuardMaxRetries: 0,
          ...(registeredProvider ? { provider: "summary-fixture" } : {}),
        });
      } else if (registeredProvider) {
        setCompactionSafeguardRuntime(scenario.sessionManager, {
          model: createAnthropicModelFixture(),
          semanticCurationMode: "apply",
          recentTurnsPreserve: 0,
          qualityGuardEnabled: true,
          qualityGuardMaxRetries: 0,
          provider: "summary-fixture",
        });
      }
      const original = structuredClone(scenario.event.preparation.messagesToSummarize);
      mockSummarizeInStages.mockReset();
      mockSummarizeInStages.mockResolvedValue(validSummary);

      const { result } = await runCompactionScenario(scenario);

      expect(result.cancel).not.toBe(true);
      expect(mockSummarizeInStages).toHaveBeenCalledTimes(registeredProvider ? 0 : 1);
      if (!registeredProvider) {
        expect(mockSummarizeInStages.mock.calls[0]?.[0].messages).toEqual(original);
      }
      expect(requests).toEqual([]);
      expect(scenario.event.preparation.messagesToSummarize).toEqual(original);
    },
  );

  it.each(["off", "shadow", "apply"] as const)(
    "rejects late cancellation in %s mode",
    async (mode) => {
      installDecisionFixture();
      const scenario = activeScenario();
      scenario.event.preparation.messagesToSummarize.splice(1, 1);
      setCompactionSafeguardRuntime(scenario.sessionManager, {
        model: createAnthropicModelFixture(),
        semanticCurationMode: mode,
        recentTurnsPreserve: 0,
      });
      const controller = new AbortController();
      scenario.event.signal = controller.signal;
      const reason = new Error("Compaction owner cancelled");
      mockSummarizeInStages.mockReset();
      mockSummarizeInStages.mockImplementationOnce(async () => {
        controller.abort(reason);
        return validSummary;
      });
      await expect(runCompactionScenario(scenario)).rejects.toBe(reason);
      expect(mockSummarizeInStages).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["selection", "fidelity"])(
    "recovers from an unexpected %s provider error using the original source",
    async (stage) => {
      installDecisionFixture();
      const originalEvaluate = decisionRuntime.evaluateDecision;
      const evaluate = vi.spyOn(decisionRuntime, "evaluateDecision");
      const scenario = activeScenario();
      const original = structuredClone(scenario.event.preparation.messagesToSummarize);
      mockSummarizeInStages.mockReset();
      mockSummarizeInStages.mockResolvedValue(validSummary);
      evaluate.mockImplementation((batch, options) => {
        const failSelection =
          stage === "selection" && options.purpose === "compaction-shadow-curation";
        const failFidelity = stage === "fidelity" && options.purpose === "compaction-fidelity";
        if (failSelection || failFidelity) {
          throw new Error("provider transport escaped its boundary");
        }
        return originalEvaluate(batch, options);
      });
      const { result } = await runCompactionScenario(scenario);
      expect(result.cancel).not.toBe(true);
      expect(mockSummarizeInStages).toHaveBeenCalledTimes(stage === "fidelity" ? 2 : 1);
      expect(mockSummarizeInStages.mock.calls.at(-1)?.[0].messages).toEqual(original);
    },
  );

  it.each(["selection", "fidelity"])("does not recover after %s authority loss", async (stage) => {
    installDecisionFixture();
    const originalEvaluate = decisionRuntime.evaluateDecision;
    const evaluate = vi.spyOn(decisionRuntime, "evaluateDecision");
    mockSummarizeInStages.mockReset();
    mockSummarizeInStages.mockResolvedValue(validSummary);
    evaluate.mockImplementation((batch, options) => {
      const failSelection =
        stage === "selection" && options.purpose === "compaction-shadow-curation";
      const failFidelity =
        stage === "fidelity" &&
        options.purpose === "compaction-fidelity" &&
        mockSummarizeInStages.mock.calls.length > 0;
      if (failSelection || failFidelity) {
        throw new DecisionConsumerClosedError();
      }
      return originalEvaluate(batch, options);
    });
    const { result } = await runCompactionScenario(activeScenario());
    expect(result).toEqual({ cancel: true });
    expect(mockSummarizeInStages).toHaveBeenCalledTimes(stage === "fidelity" ? 1 : 0);
  });

  it.each(["selection", "fidelity"])(
    "does not summarize again after a scoped registry retires during %s",
    async (stage) => {
      let requestCount = 0;
      const { builder } = installDecisionFixture("preserved", async (_batch, { signal }) => {
        requestCount += 1;
        if (stage === "selection" || requestCount === 2) {
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          signal.throwIfAborted();
        }
      });
      const target = createEmptyPluginRegistry();
      target.plugins.push({ ...builder.registry.plugins[0]! });
      target.decisionProviders.push(builder.registry.decisionProviders[0]!);
      const scoped = bindPluginRegistryResourceOwner(target, target);
      markPluginRegistryActive(target);
      mockSummarizeInStages.mockReset();
      mockSummarizeInStages.mockResolvedValue(validSummary);
      const pending = withPluginRuntimeRegistryScope(scoped, () =>
        runCompactionScenario(activeScenario()),
      );
      await vi.waitFor(() => expect(requestCount).toBe(stage === "selection" ? 1 : 2));
      markPluginRegistryRetired(target);
      const { result } = await pending;
      expect(result).toEqual({ cancel: true });
      expect(mockSummarizeInStages).toHaveBeenCalledTimes(stage === "selection" ? 0 : 1);
    },
  );

  it("protects older user instructions while applying a reduced summarizer input", async () => {
    installDecisionFixture();
    const scenario = activeScenario();
    const original = structuredClone(scenario.event.preparation.messagesToSummarize);
    mockSummarizeInStages.mockReset();
    mockSummarizeInStages.mockResolvedValue(validSummary);
    const { result } = await runCompactionScenario(scenario);
    expect(result.cancel).not.toBe(true);
    expect(result.compaction?.summary).toContain("Keep all existing behavior.");
    expect(mockSummarizeInStages).toHaveBeenCalledTimes(1);
    expect(mockSummarizeInStages.mock.calls[0]?.[0].messages).toEqual([original[0], original[2]]);
    expect(scenario.event.preparation.messagesToSummarize).toEqual(original);
  });

  it.each(["generation", "audit", "fidelity"])(
    "tries exactly one audited original-source recovery after %s failure",
    async (failure) => {
      installDecisionFixture(failure === "fidelity" ? "missing" : "preserved");
      const scenario = activeScenario();
      mockSummarizeInStages.mockReset();
      if (failure === "generation") {
        mockSummarizeInStages.mockRejectedValueOnce(new Error("Curated generation failed"));
      } else {
        mockSummarizeInStages.mockResolvedValueOnce(
          failure === "audit" ? "Invalid summary" : validSummary,
        );
      }
      mockSummarizeInStages.mockResolvedValueOnce(validSummary);
      const { result } = await runCompactionScenario(scenario);
      expect(result.cancel).not.toBe(true);
      expect(result.compaction?.summary).toContain("Keep all existing behavior.");
      expect(mockSummarizeInStages).toHaveBeenCalledTimes(2);
      expect(mockSummarizeInStages.mock.calls[1]?.[0].messages).toEqual(
        scenario.event.preparation.messagesToSummarize,
      );
    },
  );

  it("cancels when the single original-source recovery also fails its audit", async () => {
    installDecisionFixture();
    const scenario = activeScenario();
    mockSummarizeInStages.mockReset();
    mockSummarizeInStages.mockResolvedValue("Invalid summary");
    const { result } = await runCompactionScenario(scenario);
    expect(result).toEqual({ cancel: true });
    expect(mockSummarizeInStages).toHaveBeenCalledTimes(2);
  });

  it("does not start recovery after caller cancellation", async () => {
    installDecisionFixture();
    const scenario = activeScenario();
    const controller = new AbortController();
    scenario.event.signal = controller.signal;
    const reason = new Error("Compaction owner cancelled");
    mockSummarizeInStages.mockReset();
    mockSummarizeInStages.mockImplementationOnce(async () => {
      controller.abort(reason);
      throw new Error("Transport ended");
    });
    await expect(runCompactionScenario(scenario)).rejects.toBe(reason);
    expect(mockSummarizeInStages).toHaveBeenCalledTimes(1);
  });

  it("rechecks mode after awaited fidelity before accepting a curated candidate", async () => {
    const scenario = activeScenario();
    installDecisionFixture("preserved", (batch) => {
      if (
        Object.values(batch.questions).some(
          (question) => question.type === "choice" && "preserved" in question.criteria,
        )
      ) {
        setCompactionSafeguardRuntime(scenario.sessionManager, {
          model: createAnthropicModelFixture(),
          semanticCurationMode: "off",
        });
      }
    });
    mockSummarizeInStages.mockReset();
    mockSummarizeInStages.mockResolvedValue(validSummary);
    const { result } = await runCompactionScenario(scenario);
    expect(result.cancel).not.toBe(true);
    expect(mockSummarizeInStages).toHaveBeenCalledTimes(2);
    expect(mockSummarizeInStages.mock.calls[1]?.[0].messages).toEqual(
      scenario.event.preparation.messagesToSummarize,
    );
  });

  it("keeps the full source when Decision assistance consent is withdrawn during selection", async () => {
    const scenario = activeScenario();
    let consent = true;
    setCompactionSafeguardRuntime(scenario.sessionManager, {
      model: createAnthropicModelFixture(),
      semanticCurationMode: "apply",
      semanticCurationEligible: () => consent,
      recentTurnsPreserve: 0,
      qualityGuardEnabled: true,
      qualityGuardMaxRetries: 0,
    });
    const { requests } = installDecisionFixture("preserved", () => {
      consent = false;
    });
    const original = structuredClone(scenario.event.preparation.messagesToSummarize);
    mockSummarizeInStages.mockReset();
    mockSummarizeInStages.mockResolvedValue(validSummary);

    const { result } = await runCompactionScenario(scenario);

    expect(result.cancel).not.toBe(true);
    expect(requests).toHaveLength(1);
    expect(mockSummarizeInStages).toHaveBeenCalledTimes(1);
    expect(mockSummarizeInStages.mock.calls[0]?.[0].messages).toEqual(original);
  });

  it("keeps the full source when the saved apply mode becomes off during selection", async () => {
    const scenario = activeScenario();
    let savedMode: "off" | "apply" = "apply";
    setCompactionSafeguardRuntime(scenario.sessionManager, {
      model: createAnthropicModelFixture(),
      semanticCurationMode: "apply",
      semanticCurationModeReader: () => savedMode,
      recentTurnsPreserve: 0,
      qualityGuardEnabled: true,
      qualityGuardMaxRetries: 0,
    });
    const { requests } = installDecisionFixture("preserved", () => {
      savedMode = "off";
    });
    const original = structuredClone(scenario.event.preparation.messagesToSummarize);
    mockSummarizeInStages.mockReset();
    mockSummarizeInStages.mockResolvedValue(validSummary);

    const { result } = await runCompactionScenario(scenario);

    expect(result.cancel).not.toBe(true);
    expect(requests).toHaveLength(1);
    expect(mockSummarizeInStages).toHaveBeenCalledTimes(1);
    expect(mockSummarizeInStages.mock.calls[0]?.[0].messages).toEqual(original);
  });
});
