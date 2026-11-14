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
  splitPreservedRecentTurns: CallableFunction;
  buildPreservedTurnsSection: CallableFunction;
  buildCompactionStructureInstructions: CallableFunction;
  resolveRecentTurnsPreserve: CallableFunction;
  resolveQualityGuardMaxRetries: CallableFunction;
  extractOpaqueIdentifiers: CallableFunction;
  auditSummaryQuality: CallableFunction;
  capCompactionSummary: CallableFunction;
  budgetCompactionSummary: CallableFunction;
  MAX_COMPACTION_SUMMARY_CHARS: number;
  SUMMARY_TRUNCATED_MARKER: string;
  CONTEXT_TRUNCATED_MARKER: string;
};

export const testing = (globalThis as Record<PropertyKey, unknown>)[
  Symbol.for("openclaw.compactionSafeguardTestApi")
] as CompactionSafeguardTestApi;
if (!testing) {
  throw new Error("compaction safeguard test API is unavailable");
}

export function structuredSummary(
  values: Partial<Record<"decisions" | "todos" | "rules" | "asks" | "identifiers", string>> = {},
): string {
  return [
    `## Decisions\n${values.decisions ?? "Keep current flow."}`,
    `## Open TODOs\n${values.todos ?? "None."}`,
    `## Constraints/Rules\n${values.rules ?? "Preserve exact context."}`,
    `## Pending user asks\n${values.asks ?? "None."}`,
    `## Exact identifiers\n${values.identifiers ?? "None."}`,
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

export const createAnthropicModelFixture = (overrides: Partial<Model> = {}): Model => ({
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
});

type SafeguardRuntime = NonNullable<Parameters<typeof setCompactionSafeguardRuntime>[1]>;
type ToolResult = Extract<AgentMessage, { role: "toolResult" }>;

export function configuredSession(runtime: SafeguardRuntime) {
  const sessionManager = stubSessionManager();
  setCompactionSafeguardRuntime(sessionManager, runtime);
  return sessionManager;
}

export const modelSession = (runtime: SafeguardRuntime = {}) =>
  configuredSession({ model: createAnthropicModelFixture(), ...runtime });

export const toolResultMessage = (
  toolCallId: string,
  text: string,
  overrides: Partial<Pick<ToolResult, "toolName" | "timestamp" | "isError" | "details">> = {},
): AgentMessage => ({
  role: "toolResult",
  toolCallId,
  toolName: "read",
  content: [{ type: "text", text }],
  timestamp: 1,
  isError: false,
  ...overrides,
});

export function userMessage(content: string, timestamp: number): AgentMessage {
  return { role: "user", content, timestamp };
}

export const toolCallMessage = (id: string, name: string, timestamp: number): AgentMessage =>
  castAgentMessage({
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: {} }],
    timestamp,
  });

export const createQualityGuardSessionManager = (overrides: SafeguardRuntime = {}) =>
  modelSession({
    recentTurnsPreserve: 0,
    qualityGuardEnabled: true,
    qualityGuardMaxRetries: 1,
    ...overrides,
  });

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
    messagesToSummarize: [userMessage(params.messageText ?? "summarize me", Date.now())],
    turnPrefixMessages: [] as AgentMessage[],
    firstKeptEntryId: "entry-1",
    tokensBefore: params.tokensBefore ?? 1_500,
    fileOps: { read: [], edited: [], written: [] },
    settings: { reserveTokens: 4_000 },
    isSplitTurn: false,
    ...params.preparation,
  },
  customInstructions: params.customInstructions ?? "",
  signal: params.signal ?? new AbortController().signal,
});

type CompactionEvent = ReturnType<typeof createCompactionEvent>;
type CompactionResult = {
  cancel?: boolean;
  compaction?: { summary: string; firstKeptEntryId: string; tokensBefore: number };
};

export async function runCompactionScenario(
  sessionManager: ExtensionContext["sessionManager"],
  event: CompactionEvent,
  {
    apiKey = "test-key",
    auth,
  }: {
    apiKey?: string | null;
    auth?: Awaited<ReturnType<ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]>>;
  } = {},
) {
  const on =
    vi.fn<(event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => void>();
  compactionSafeguardExtension({ on } as unknown as ExtensionAPI);
  const handler = on.mock.calls.findLast(([name]) => name === "session_before_compact")?.[1];
  if (!handler) {
    throw new Error("Expected compaction safeguard to register a handler.");
  }
  const getApiKeyAndHeadersMock = vi
    .fn()
    .mockResolvedValue(
      auth ?? (apiKey !== null ? { ok: true, apiKey } : { ok: false, error: "missing auth" }),
    );
  const result = (await handler(event, {
    model: undefined,
    sessionManager,
    modelRegistry: { getApiKeyAndHeaders: getApiKeyAndHeadersMock },
  })) as CompactionResult;
  return { result, getApiKeyAndHeadersMock };
}

export function expectCompactionResult(result: CompactionResult) {
  expect(result.cancel).not.toBe(true);
  if (!result.compaction) {
    throw new Error("Expected compaction result");
  }
  return result.compaction;
}
