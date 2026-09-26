import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import type { ExtensionAPI, ExtensionContext } from "openclaw/plugin-sdk/agent-sessions";
import type { Model } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompactionProvider } from "../../plugins/compaction-provider.js";
import {
  resetPluginRuntimeStateForTest,
  requireActivePluginRegistry,
} from "../../plugins/runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { summarizeInStages } from "../compaction.js";
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
    const startedBarrier = createDeferredCore<void>();
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

  it.each(
    [false, true].flatMap((registeredProvider) =>
      [
        { agentId: undefined, persisted: false },
        { agentId: "inherited", persisted: true },
        { agentId: "specialist", persisted: true },
        { agentId: "disabled", persisted: true },
        { agentId: "specialist", persisted: false },
        { agentId: "disabled", persisted: false },
      ].map(({ agentId, persisted }) => ({ registeredProvider, agentId, persisted })),
    ),
  )(
    "preserves output and owner decisions (registered provider=$registeredProvider, agent=$agentId, persisted=$persisted)",
    async ({ registeredProvider, agentId, persisted }) => {
      const { config, builder, requests } = installDecisionFixture();
      mockSummarizeInStages.mockReset();
      mockSummarizeInStages.mockResolvedValue("The report remains pending.");
      if (registeredProvider) {
        installCompactionProviderForTest({
          id: "summary-fixture",
          label: "Summary fixture",
          summarize: async () => "The report remains pending.",
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
      expect(compactionLogger.info).toHaveBeenCalledWith(
        expect.stringContaining(
          `Compaction semantic shadow${agentId === "disabled" ? " unavailable" : ""}:`,
        ),
      );
      expect(compactionLogger.info).toHaveBeenCalledWith(
        expect.stringContaining(
          `Compaction semantic fidelity${agentId === "disabled" ? " unavailable" : ""}:`,
        ),
      );
      expect(builder.registry.decisionProviders[0]?.host.inspect(config)).toMatchObject({
        successCount: agentId === "disabled" ? 0 : 2,
        activeRequests: 0,
      });
      expect(requests).toEqual(
        agentId === "disabled"
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
