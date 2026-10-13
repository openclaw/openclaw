import type { AgentMessage, CompactionPreparation } from "openclaw/plugin-sdk/agent-core";
import type { ExtensionAPI, ExtensionContext } from "openclaw/plugin-sdk/agent-sessions";
import type { Model } from "openclaw/plugin-sdk/llm";
import { expect, vi } from "vitest";
import type { summarizeCompactionHistory } from "../compaction.js";
import { castAgentMessage } from "../test-helpers/agent-message-fixtures.js";
import { setCompactionSafeguardRuntime } from "./compaction-safeguard-runtime.js";
import compactionSafeguardExtension from "./compaction-safeguard.js";

type CompactionSafeguardTestApi = {
  setSummarizeCompactionHistoryForTest(next?: typeof summarizeCompactionHistory): void;
  collectToolFailures: CallableFunction;
  formatToolFailuresSection: CallableFunction;
  splitPreservedRecentTurns: CallableFunction;
  buildPreservedTurnsSection: CallableFunction;
  buildCompactionStructureInstructions: CallableFunction;
  resolveRecentTurnsPreserve: CallableFunction;
  resolveQualityGuardMaxRetries: CallableFunction;
  extractOpaqueIdentifiers: CallableFunction;
  auditSummaryQuality: CallableFunction;
  capCompactionSummary: CallableFunction;
  formatFileOperations: CallableFunction;
  MAX_FILE_OPS_SECTION_CHARS: number;
  budgetCompactionSummary: CallableFunction;
  MAX_COMPACTION_SUMMARY_CHARS: number;
  SUMMARY_TRUNCATED_MARKER: string;
  CONTEXT_TRUNCATED_MARKER: string;
  MAX_SPLIT_TURN_CONTEXT_CHARS: number;
};

function getTestApi(): CompactionSafeguardTestApi {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.compactionSafeguardTestApi")
  ];
  if (!api) {
    throw new Error("compaction safeguard test API is unavailable");
  }
  return api as CompactionSafeguardTestApi;
}

export const testing = getTestApi();

export function structuredSummary(
  values: Partial<Record<"decisions" | "todos" | "rules" | "asks" | "identifiers", string>> = {},
): string {
  return [
    "## Decisions",
    values.decisions ?? "Keep current flow.",
    "## Open TODOs",
    values.todos ?? "None.",
    "## Constraints/Rules",
    values.rules ?? "Preserve exact context.",
    "## Pending user asks",
    values.asks ?? "None.",
    "## Exact identifiers",
    values.identifiers ?? "None.",
  ].join("\n");
}
export function stubSessionManager(): ExtensionContext["sessionManager"] {
  return {
    getCwd: () => "/stub",
    getSessionId: () => "stub-id",
    getSessionTarget: () => undefined,
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
}

export function createAnthropicModelFixture(overrides: Partial<Model> = {}): Model {
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

type SafeguardRuntime = NonNullable<Parameters<typeof setCompactionSafeguardRuntime>[1]>;

export function configuredSession(runtime: SafeguardRuntime) {
  const sessionManager = stubSessionManager();
  setCompactionSafeguardRuntime(sessionManager, runtime);
  return sessionManager;
}

export function modelSession(runtime: SafeguardRuntime = {}) {
  return configuredSession({ model: createAnthropicModelFixture(), ...runtime });
}

export function toolResultMessage(
  toolCallId: string,
  text: string,
  overrides: Partial<
    Pick<
      Extract<AgentMessage, { role: "toolResult" }>,
      "toolName" | "timestamp" | "isError" | "details"
    >
  > = {},
): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "read",
    content: [{ type: "text", text }],
    timestamp: 1,
    isError: false,
    ...overrides,
  };
}

export function userMessage(content: string, timestamp: number): AgentMessage {
  return { role: "user", content, timestamp };
}

export function toolCallMessage(id: string, name: string, timestamp: number): AgentMessage {
  return castAgentMessage({
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: {} }],
    timestamp,
  });
}

export function createQualityGuardSessionManager(
  overrides: SafeguardRuntime = {},
): ExtensionContext["sessionManager"] {
  return modelSession({
    recentTurnsPreserve: 0,
    qualityGuardEnabled: true,
    qualityGuardMaxRetries: 1,
    ...overrides,
  });
}

type CompactionHandler = (event: unknown, ctx: unknown) => Promise<unknown>;
export const createCompactionHandler = () => {
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

export const createCompactionEvent = (
  params: {
    messageText?: string;
    tokensBefore?: number;
    preparation?: Partial<Omit<CompactionPreparation, "fileOps" | "settings">> & {
      settings?: { reserveTokens: number };
    };
    customInstructions?: string;
    signal?: AbortSignal;
  } = {},
) => ({
  preparation: {
    messagesToSummarize: [
      { role: "user", content: params.messageText ?? "summarize me", timestamp: Date.now() },
    ] as AgentMessage[],
    turnPrefixMessages: [] as AgentMessage[],
    firstKeptEntryId: "entry-1",
    tokensBefore: params.tokensBefore ?? 1_500,
    fileOps: {
      read: [],
      edited: [],
      written: [],
    },
    settings: { reserveTokens: 4_000 },
    isSplitTurn: false,
    ...params.preparation,
  },
  customInstructions: params.customInstructions ?? "",
  signal: params.signal ?? new AbortController().signal,
});

export const createCompactionContext = (params: {
  sessionManager: ExtensionContext["sessionManager"];
  getApiKeyAndHeadersMock: ReturnType<typeof vi.fn>;
}) => ({
  model: undefined,
  sessionManager: params.sessionManager,
  modelRegistry: { getApiKeyAndHeaders: params.getApiKeyAndHeadersMock },
});

type CompactionEvent = ReturnType<typeof createCompactionEvent>;

function withLatestUnresolvedUserRequest(event: CompactionEvent): CompactionEvent {
  const { preparation } = event;
  if ("latestUnresolvedUserRequest" in preparation) {
    return event;
  }
  const latestUser = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages]
    .toReversed()
    .find((message) => message.role === "user");
  const latestUnresolvedUserRequest =
    typeof latestUser?.content === "string" ? latestUser.content.trim() : "";
  return {
    ...event,
    preparation: {
      ...preparation,
      ...(latestUnresolvedUserRequest ? { latestUnresolvedUserRequest } : {}),
    },
  };
}

export async function runCompactionScenario(
  sessionManager: ExtensionContext["sessionManager"],
  event: CompactionEvent,
  {
    apiKey = "test-key",
    latestUnresolvedUserRequest = false,
  }: { apiKey?: string | null; latestUnresolvedUserRequest?: boolean } = {},
) {
  const getApiKeyAndHeadersMock = vi
    .fn()
    .mockResolvedValue(
      apiKey !== null ? { ok: true, apiKey } : { ok: false, error: "missing auth" },
    );
  const result = (await createCompactionHandler()(
    latestUnresolvedUserRequest ? withLatestUnresolvedUserRequest(event) : event,
    createCompactionContext({ sessionManager, getApiKeyAndHeadersMock }),
  )) as {
    cancel?: boolean;
    compaction?: { summary: string; firstKeptEntryId: string; tokensBefore: number };
  };
  return { result, getApiKeyAndHeadersMock };
}

export function expectCompactionResult(result: {
  cancel?: boolean;
  compaction?: {
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
  };
}) {
  expect(result.cancel).not.toBe(true);
  if (!result.compaction) {
    throw new Error("Expected compaction result");
  }
  return result.compaction;
}
