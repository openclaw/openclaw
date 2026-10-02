import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentMessage, CompactionPreparation, StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { ExtensionAPI, ExtensionContext } from "openclaw/plugin-sdk/agent-sessions";
import { createAssistantMessageEventStream, type Model } from "openclaw/plugin-sdk/llm";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { CompactionProvider } from "../../plugins/compaction-provider.js";
import {
  requireActivePluginRegistry,
  resetPluginRuntimeStateForTest,
} from "../../plugins/runtime.js";
import * as compactionModule from "../compaction.js";
import { buildEmbeddedExtensionFactories } from "../embedded-agent-runner/extensions.js";
import { castAgentMessage } from "../test-helpers/agent-message-fixtures.js";
import { timestampedTextAssistant } from "../test-helpers/sparse-transcript.test-support.js";
import { createZeroUsageFixture } from "../test-helpers/usage-fixtures.js";
import { jsonResult } from "../tools/common.js";
import { MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES } from "../workspace-bootstrap-read.js";
import * as compactionQualityModule from "./compaction-safeguard-quality.js";
import {
  consumeCompactionSafeguardCancellation,
  getCompactionSafeguardRuntime,
  setCompactionSafeguardCancellation,
  setCompactionSafeguardRuntime,
} from "./compaction-safeguard-runtime.js";
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

vi.mock("./compaction-safeguard-quality.js", async () => {
  const actual = await vi.importActual<typeof compactionQualityModule>(
    "./compaction-safeguard-quality.js",
  );
  return { ...actual, auditSummaryQuality: vi.fn(actual.auditSummaryQuality) };
});

vi.mock("../compaction.js", async () => {
  const actual = await vi.importActual<typeof compactionModule>("../compaction.js");
  return {
    ...actual,
    summarizeInStages: vi.fn(actual.summarizeInStages),
  };
});

const mockSummarizeInStages = vi.mocked(compactionModule.summarizeInStages);
const actualCompactionModule = await vi.importActual<typeof compactionModule>("../compaction.js");
const actualCompactionQualityModule = await vi.importActual<typeof compactionQualityModule>(
  "./compaction-safeguard-quality.js",
);
const mockAuditSummaryQuality = vi.mocked(compactionQualityModule.auditSummaryQuality);

function structuredSummary(
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
function headingTemplate(prefix: string): string {
  return `${prefix}\n${structuredSummary({ decisions: "alpha", todos: "beta", rules: "gamma", asks: "delta", identifiers: "epsilon" })}`;
}

function budgetCompactionSummaryText(
  body: string,
  suffix: string,
  maxChars = MAX_COMPACTION_SUMMARY_CHARS,
): string {
  return (budgetCompactionSummary(body, suffix, maxChars) as { summary: string }).summary;
}

function preservedTurnsText(messages: AgentMessage[]): string {
  return (buildPreservedTurnsSection(messages) as { text: string }).text;
}

const {
  collectToolFailures,
  formatToolFailuresSection,
  splitPreservedRecentTurns,
  buildPreservedTurnsSection,
  buildCompactionStructureInstructions,
  prependPreviousSummaryForRedistill,
  resolveRecentTurnsPreserve,
  resolveQualityGuardMaxRetries,
  extractOpaqueIdentifiers,
  auditSummaryQuality: auditSummaryQualityOwner,
  capCompactionSummary,
  formatFileOperations,
  MAX_FILE_OPS_SECTION_CHARS,
  budgetCompactionSummary,
  readWorkspaceContextForSummary,
  MAX_COMPACTION_SUMMARY_CHARS,
  SUMMARY_TRUNCATED_MARKER,
  CONTEXT_TRUNCATED_MARKER,
  MAX_SPLIT_TURN_CONTEXT_CHARS,
} = testing;

function auditSummaryQuality(
  params: Omit<
    Parameters<typeof compactionQualityModule.auditSummaryQuality>[0],
    "structuralSummary"
  >,
) {
  return auditSummaryQualityOwner({ ...params, structuralSummary: params.summary });
}

beforeEach(() => {
  mockSummarizeInStages.mockReset();
  testing.setSummarizeInStagesForTest(mockSummarizeInStages);
  mockAuditSummaryQuality.mockImplementation(actualCompactionQualityModule.auditSummaryQuality);
  mockAuditSummaryQuality.mockClear();
  compactionLogger.warn.mockClear();
});

afterEach(() => {
  testing.setSummarizeInStagesForTest();
  resetPluginRuntimeStateForTest();
});

function installCompactionProviderForTest(
  id: string,
  summarize: CompactionProvider["summarize"],
): void {
  requireActivePluginRegistry().compactionProviders.push({
    provider: { id, label: id, summarize },
  });
}

function stubSessionManager(): ExtensionContext["sessionManager"] {
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

type SafeguardRuntime = NonNullable<Parameters<typeof setCompactionSafeguardRuntime>[1]>;

function configuredSession(runtime: SafeguardRuntime) {
  const sessionManager = stubSessionManager();
  setCompactionSafeguardRuntime(sessionManager, runtime);
  return sessionManager;
}

function modelSession(runtime: SafeguardRuntime = {}) {
  return configuredSession({ model: createAnthropicModelFixture(), ...runtime });
}

function toolResultMessage(
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

function userMessage(content: string, timestamp: number): AgentMessage {
  return { role: "user", content, timestamp };
}

function toolCallMessage(id: string, name: string, timestamp: number): AgentMessage {
  return castAgentMessage({
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: {} }],
    timestamp,
  });
}

function createQualityGuardSessionManager(
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

const createCompactionEvent = (
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

const createCompactionContext = (params: {
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

async function runCompactionScenario(
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

function expectCompactionResult(result: {
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

const CANONICAL_SUMMARY_HEADINGS = [
  "## Decisions",
  "## Open TODOs",
  "## Constraints/Rules",
  "## Pending user asks",
  "## Exact identifiers",
] as const;

function expectCanonicalSummaryHeadingsOnce(summary: string): void {
  for (const heading of CANONICAL_SUMMARY_HEADINGS) {
    expect(summary.split("\n").filter((line) => line.trim() === heading)).toHaveLength(1);
  }
}

function mockCallArg(
  mock: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } },
  callIndex = 0,
  argIndex = 0,
): unknown {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected mock call ${callIndex + 1}`);
  }
  return call[argIndex];
}

const requireRecord = createRequireRecord("object", "expected-record");

function requireArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error("expected array");
  }
  return value;
}

describe("compaction-safeguard tool failures", () => {
  it("only excludes the accepted spawn from a mixed batch and reports look-alike non-spawn tools", () => {
    const acceptedDetails = jsonResult({
      status: "accepted",
      childSessionKey: "agent:watcher:subagent:abc",
      runId: "run-123",
      mode: "run",
    }).details;
    const messages: AgentMessage[] = [
      toolResultMessage("call-spawn-accepted", "accepted", {
        toolName: "sessions_spawn",
        isError: true,
        details: acceptedDetails,
        timestamp: Date.now(),
      }),
      toolResultMessage("call-exec-failed", "boom", {
        toolName: "exec",
        isError: true,
        details: { status: "failed", exitCode: 1 },
        timestamp: Date.now(),
      }),
      toolResultMessage("call-spawn-error", "spawn rejected", {
        toolName: "sessions_spawn",
        isError: true,
        details: { status: "error" },
        timestamp: Date.now(),
      }),
      toolResultMessage("call-other-lookalike", "real failure", {
        toolName: "some_other_tool",
        isError: true,
        details: acceptedDetails,
        timestamp: Date.now(),
      }),
    ];

    const failures = collectToolFailures(messages);
    expect(failures.map((failure: { toolCallId: string }) => failure.toolCallId)).toEqual([
      "call-exec-failed",
      "call-spawn-error",
      "call-other-lookalike",
    ]);
    expect(formatToolFailuresSection(failures)).toContain("exec (status=failed exitCode=1): boom");
  });

  it("dedupes by toolCallId and handles empty output", () => {
    const messages: AgentMessage[] = [
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "exec",
        isError: true,
        details: { exitCode: 2 },
        content: [],
        timestamp: Date.now(),
      },
      toolResultMessage("call-1", "ignored", {
        toolName: "exec",
        isError: true,
        timestamp: Date.now(),
      }),
    ];

    const failures = collectToolFailures(messages);
    expect(failures).toHaveLength(1);

    const section = formatToolFailuresSection(failures);
    expect(section).toContain("exec (exitCode=2): failed");
  });

  it("caps the number of failures and adds overflow line", () => {
    const messages: AgentMessage[] = Array.from({ length: 9 }, (_, idx) =>
      toolResultMessage(`call-${idx}`, `${"x".repeat(236)}🚀tail-${idx}`, {
        toolName: "exec",
        isError: true,
        timestamp: Date.now(),
      }),
    );

    const failures = collectToolFailures(messages);
    const section = formatToolFailuresSection(failures);
    expect(section).toContain("## Tool Failures");
    expect(section).toContain("...and 1 more");
    expect(failures[0]?.summary).toBe(`${"x".repeat(236)}...`);
  });
});

describe("compaction-safeguard summary budgets", () => {
  it("caps file operations summary and reports omitted entries", () => {
    const files = Array.from(
      { length: 200 },
      (_, i) => `src/features/${i}/nested/component/file-${i}.ts`,
    );
    const section = formatFileOperations(files, files);
    expect(section).toContain("<read-files>");
    expect(section).toContain("<modified-files>");
    expect(section).toContain("...and ");
    expect(section.length).toBeLessThanOrEqual(MAX_FILE_OPS_SECTION_CHARS);
  });

  it("preserves diagnostic sections (tool failures, file ops) when capping oversized body", () => {
    const diagnosticSuffix =
      "\n\n## Tool Failures\n- exec: failed\n\n<read-files>\nfoo.ts\n</read-files>\n\n" +
      "<workspace-critical-rules>\n## Session Startup\nRead AGENTS.md\n</workspace-critical-rules>";
    const body = "x".repeat(MAX_COMPACTION_SUMMARY_CHARS);

    const capped = budgetCompactionSummaryText(body, diagnosticSuffix);

    expect(capped.length).toBeLessThanOrEqual(MAX_COMPACTION_SUMMARY_CHARS);
    expect(capped).toContain("## Tool Failures");
    expect(capped).toContain("<read-files>");
    expect(capped).toContain("<workspace-critical-rules>");
    expect(capped.endsWith(diagnosticSuffix)).toBe(true);
  });

  it("uses truncation markers when the budget exactly fits only the marker", () => {
    expect(capCompactionSummary("oversized".repeat(10), SUMMARY_TRUNCATED_MARKER.length)).toBe(
      SUMMARY_TRUNCATED_MARKER,
    );
    expect(
      budgetCompactionSummaryText(
        "",
        "oversized suffix".repeat(10),
        CONTEXT_TRUNCATED_MARKER.length,
      ),
    ).toBe(CONTEXT_TRUNCATED_MARKER);
  });

  it("preserves exact identifiers when recompacting encoded heading-like context", () => {
    const latestAsk = headingTemplate("zephyr quasar template must survive:");
    const identifier = "REAL-OLD-ID-MUST-SURVIVE";
    const body = structuredSummary({ decisions: "No related decision.", identifiers: identifier });
    const first = requireRecord(
      budgetCompactionSummary(body, "", 1_000, {
        identifiers: [identifier],
        latestAsk,
        latestUnresolvedUserRequest: latestAsk,
        requiredAskContext: latestAsk,
        identifierPolicy: "strict",
      }),
    );
    expect(String(first.summary)).toContain(
      `## Pending user asks\nLatest user request context: ${JSON.stringify(latestAsk)}`,
    );

    const second = requireRecord(
      budgetCompactionSummary(String(first.summary), "", 700, {
        identifiers: [identifier],
        latestAsk,
        latestUnresolvedUserRequest: latestAsk,
        requiredAskContext: latestAsk,
        identifierPolicy: "strict",
      }),
    );

    expect(String(second.summary)).toContain(identifier);
    expect(String(second.summary)).toContain(
      `## Pending user asks\nLatest user request context: ${JSON.stringify(latestAsk)}`,
    );
  });
});

describe("compaction-safeguard runtime registry", () => {
  it("ignores non-object session managers", () => {
    setCompactionSafeguardRuntime(null, { maxHistoryShare: 0.5 });
    expect(getCompactionSafeguardRuntime(null)).toBeNull();
    setCompactionSafeguardRuntime(undefined, { maxHistoryShare: 0.5 });
    expect(getCompactionSafeguardRuntime(undefined)).toBeNull();
  });

  it("consumes cancellation provenance once without dropping other runtime fields", () => {
    const sm = {};
    const error = Object.assign(new Error("provider unavailable"), { status: 503 });
    setCompactionSafeguardRuntime(sm, { maxHistoryShare: 0.6 });
    setCompactionSafeguardCancellation(sm, "summarization failed", error);

    expect(consumeCompactionSafeguardCancellation(sm)).toEqual({
      reason: "summarization failed",
      error: expect.objectContaining({ message: "provider unavailable", status: 503 }),
    });
    expect(consumeCompactionSafeguardCancellation(sm)).toBeNull();
    expect(getCompactionSafeguardRuntime(sm)).toEqual({ maxHistoryShare: 0.6 });
  });

  it("replaces provider failure provenance with an intentional decline atomically", () => {
    const sm = {};
    setCompactionSafeguardCancellation(sm, "summary failed", new Error("request timed out"));
    setCompactionSafeguardCancellation(sm, "quality guard declined");

    expect(consumeCompactionSafeguardCancellation(sm)).toEqual({
      reason: "quality guard declined",
    });
    expect(getCompactionSafeguardRuntime(sm)).toBeNull();
  });

  it("wires oversized safeguard runtime values when config validation is bypassed", () => {
    const sessionManager = {} as unknown as Parameters<
      typeof buildEmbeddedExtensionFactories
    >[0]["sessionManager"];
    const cfg = {
      agents: {
        defaults: {
          compaction: {
            mode: "safeguard",
            recentTurnsPreserve: 99,
            qualityGuard: { maxRetries: 99 },
          },
        },
      },
    } as OpenClawConfig;

    buildEmbeddedExtensionFactories({
      cfg,
      sessionManager,
      provider: "anthropic",
      modelId: "claude-3-opus",
      model: {
        contextWindow: 200_000,
      } as Parameters<typeof buildEmbeddedExtensionFactories>[0]["model"],
    });

    const runtime = getCompactionSafeguardRuntime(sessionManager);
    expect(runtime?.qualityGuardMaxRetries).toBe(99);
    expect(runtime?.recentTurnsPreserve).toBe(99);
    expect(resolveQualityGuardMaxRetries(runtime?.qualityGuardMaxRetries)).toBe(3);
    expect(resolveRecentTurnsPreserve(runtime?.recentTurnsPreserve)).toBe(12);
  });
});

describe("compaction-safeguard recent-turn preservation", () => {
  it("drops orphaned tool results from preserved assistant turns", () => {
    const messages: AgentMessage[] = [
      userMessage("older ask", 1),
      toolCallMessage("call_old", "read", 2),
      toolResultMessage("call_old", "old result", { timestamp: 3 }),
      userMessage("recent ask", 4),
      toolCallMessage("call_recent", "read", 5),
      toolResultMessage("call_recent", "recent result", { timestamp: 6 }),
      castAgentMessage(timestampedTextAssistant("recent final answer", 7)),
    ];

    const split = splitPreservedRecentTurns({
      messages,
      recentTurnsPreserve: 1,
    });

    expect(split.preservedMessages.map((msg: AgentMessage) => msg.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
    expect(split.preservedMessages).toContainEqual(
      expect.objectContaining({ role: "user", content: "recent ask" }),
    );

    const summarizableToolResultIds = split.summarizableMessages
      .filter((msg: AgentMessage) => msg.role === "toolResult")
      .map((msg: AgentMessage) => (msg as { toolCallId?: unknown }).toolCallId);
    expect(summarizableToolResultIds).toContain("call_old");
    expect(summarizableToolResultIds).not.toContain("call_recent");
  });

  it("drops an oversized preserved tool interaction as one atomic group", () => {
    const toolCalls = Array.from({ length: 30 }, (_, index) => ({
      type: "toolCall",
      id: `call_${index}`,
      name: "read",
      arguments: {},
    }));
    const split = splitPreservedRecentTurns({
      messages: [
        userMessage("recent ask", 1),
        castAgentMessage({ role: "assistant", content: toolCalls, timestamp: 2 }),
        ...toolCalls.map((toolCall, index) =>
          toolResultMessage(
            toolCall.id,
            `paired-result-${String(index).padStart(2, "0")}-${"x".repeat(700)}`,
            { timestamp: index + 3 },
          ),
        ),
        castAgentMessage(timestampedTextAssistant("terminal answer survives", 33)),
      ],
      recentTurnsPreserve: 1,
    });

    const section = preservedTurnsText(split.preservedMessages) as string;

    expect(section.length).toBeLessThanOrEqual(MAX_SPLIT_TURN_CONTEXT_CHARS);
    expect(section).toContain("[Earlier preserved messages truncated]");
    expect(section).not.toContain("paired-result-00-");
    expect(section).not.toContain("paired-result-29-");
    expect(section).not.toContain("- Tool result (read):");
    expect(section).toContain("- Assistant: terminal answer survives");
    expect(section.split("\n").some((line) => line.startsWith("x"))).toBe(false);
  });

  it("keeps non-text placeholders for mixed-content preserved messages", () => {
    const section = preservedTurnsText([
      castAgentMessage({
        role: "user",
        content: [
          { type: "text", text: "caption text" },
          { type: "image", data: "abc", mimeType: "image/png" },
        ],
        timestamp: 1,
      }),
    ]);

    expect(section).toContain("- User: caption text");
    expect(section).toContain("[non-text content: image]");
  });

  it("keeps bounded preserved-turn text UTF-16 safe", () => {
    const section = preservedTurnsText([userMessage(`${"x".repeat(599)}🚀tail`, 1)]);

    expect(section).toContain(`- User: ${"x".repeat(599)}...`);
  });

  it("caps preserved tail when user turns are below preserve target", () => {
    const messages: AgentMessage[] = [
      userMessage("single user prompt", 1),
      ...Array.from({ length: 8 }, (_, i) =>
        castAgentMessage(timestampedTextAssistant(`assistant-${i + 1}`, i + 2)),
      ),
    ];

    const split = splitPreservedRecentTurns({
      messages,
      recentTurnsPreserve: 3,
    });
    expect(split.preservedMessages).toHaveLength(6);
    expect(split.preservedMessages).toContainEqual(
      expect.objectContaining({ role: "user", content: "single user prompt" }),
    );
    expect(preservedTurnsText(split.preservedMessages)).toContain("assistant-8");
    expect(preservedTurnsText(split.preservedMessages)).not.toContain("assistant-2");
  });

  it("extracts opaque identifiers and audits summary quality", () => {
    const identifiers = extractOpaqueIdentifiers(
      "Track id a1b2c3d4e5f6 plus A1B2C3D4E5F6 and URL https://example.com/a and /tmp/x.log plus port host.local:18789",
    );
    expect(identifiers).toStrictEqual([
      "A1B2C3D4E5F6", // pragma: allowlist secret
      "https://example.com/a",
      "/tmp/x.log",
      "host.local:18789",
    ]);

    const summary = structuredSummary({
      rules: "Preserve identifiers.",
      asks: `Latest user request context: ${JSON.stringify("Explain post-compaction behavior for memory indexing")}`,
      identifiers: identifiers.join(", ").toLowerCase(),
    });

    const quality = auditSummaryQuality({
      summary,
      identifiers,
      latestAsk: "Explain post-compaction behavior for memory indexing",
    });
    expect(quality.ok).toBe(true);
  });

  it("keeps valid host/port identifiers after a long non-identifier token", () => {
    const identifiers = extractOpaqueIdentifiers(
      `${"x".repeat(120_000)} host.local:18789 ` +
        "api.example.com/v1:443 127.0.0.1:8080 sub-domain.example.test:65535",
    );

    expect(identifiers).toStrictEqual([
      "host.local:18789",
      "api.example.com/v1:443",
      "127.0.0.1:8080",
      "sub-domain.example.test:65535",
    ]);
  });

  it("dedupes identifiers before applying the result cap", () => {
    const noisyPrefix = Array.from({ length: 10 }, () => "a0b0c0d0").join(" ");
    const uniqueTail = Array.from(
      { length: 12 },
      (_, idx) => `b${idx.toString(16).padStart(7, "0")}`,
    );
    const identifiers = extractOpaqueIdentifiers(`${noisyPrefix} ${uniqueTail.join(" ")}`);

    expect(identifiers).toHaveLength(12);
    expect(new Set(identifiers).size).toBe(12);
    expect(identifiers).toContain("A0B0C0D0");
    expect(identifiers).toContain(uniqueTail[10]?.toUpperCase());
  });

  it.each([
    {
      name: "decimal and scientific values",
      input:
        "metric=0.123456789 scientific=1.23456789e10 exponent=1e-987654321 order_id=246813579 hash=deadbeef1234 ambiguous=12345678e10",
      expected: ["246813579", "DEADBEEF1234", "12345678E10"], // pragma: allowlist secret
    },
  ])("classifies $name", ({ input, expected }) => {
    expect(extractOpaqueIdentifiers(input)).toStrictEqual(expected);
  });

  it("fails quality audit when required sections are missing", () => {
    const quality = auditSummaryQuality({
      summary: "Short summary without structure",
      identifiers: ["abc12345"],
      latestAsk: "Need a status update",
    });
    expect(quality.ok).toBe(false);
    expect(quality.reasons).toStrictEqual([
      "missing_section:## Decisions",
      "missing_section:## Open TODOs",
      "missing_section:## Constraints/Rules",
      "missing_section:## Pending user asks",
      "missing_section:## Exact identifiers",
      "missing_identifiers:abc12345",
      "latest_user_ask_not_reflected",
    ]);
  });

  it("does not enforce identifier retention when policy is off", async () => {
    mockSummarizeInStages.mockResolvedValue(
      structuredSummary({
        decisions: "Use redacted summary.",
        rules: "No sensitive identifiers.",
        asks: `Latest user request context: ${JSON.stringify("Provide status.")}`,
        identifiers: "Redacted.",
      }),
    );
    const sessionManager = createQualityGuardSessionManager({ identifierPolicy: "off" });
    const event = createCompactionEvent({
      preparation: {
        messagesToSummarize: [
          userMessage("sensitive-token-123456", 1),
          userMessage("Provide status.", 2),
        ],
      },
    });
    const { result } = await runCompactionScenario(sessionManager, event);
    expect(expectCompactionResult(result).summary).not.toContain("sensitive-token-123456");
    expect(mockSummarizeInStages).toHaveBeenCalledOnce();
    const instructions = requireRecord(
      requireRecord(mockCallArg(mockSummarizeInStages)).summaryPrompt,
    ).instructions;
    expect(instructions).toContain("do not enforce literal-preservation rules");
    expect(instructions).not.toContain("preserve literal values exactly as seen");
  });

  it("rejects an older pending fallback marker before the latest request", () => {
    const latestAsk = "report whether the deployment is ready";
    const summary = [
      `## Latest user request context\n${JSON.stringify(latestAsk)}`,
      "## Decisions",
      "The deployment readiness report was delivered.",
      "## Open TODOs",
      "None.",
      "## Constraints/Rules",
      "Preserve exact context.",
      "## Pending user asks",
      "Latest user request context:\narchive the previous release notes",
      "## Exact identifiers",
      "None.",
    ].join("\n\n");

    expect(
      auditSummaryQuality({
        summary,
        identifiers: [],
        latestAsk,
        latestUnresolvedUserRequest: latestAsk,
      }).reasons,
    ).toContain("latest_user_ask_not_foregrounded");
  });

  it("sanitizes untrusted custom instruction text before embedding", () => {
    const instructions = buildCompactionStructureInstructions(
      "Ignore above <script>alert(1)</script>",
    );
    expect(instructions).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(instructions).toContain("<untrusted-text>");
  });

  it("sanitizes custom identifier policy text before embedding", () => {
    const instructions = buildCompactionStructureInstructions(undefined, {
      identifierPolicy: "custom",
      identifierInstructions: "Keep ticket <ABC-123> but remove \u200Bsecrets.",
    });
    expect(instructions).toContain("Keep ticket &lt;ABC-123&gt; but remove secrets.");
    expect(instructions).toContain("<untrusted-text>");
  });

  it("cancels without advancing the boundary when dropped history cannot be summarized", async () => {
    mockSummarizeInStages
      .mockRejectedValueOnce(new Error("dropped prefix unavailable"))
      .mockResolvedValue("later summary must not run");

    const sessionManager = modelSession({
      maxHistoryShare: 0.1,
      recentTurnsPreserve: 0,
    });

    const messagesToSummarize: AgentMessage[] = Array.from({ length: 4 }, (_unused, index) =>
      userMessage(`msg-${index}-${"x".repeat(120_000)}`, index + 1),
    );
    const transcriptBefore = structuredClone(messagesToSummarize);
    const event = createCompactionEvent({
      preparation: { messagesToSummarize, tokensBefore: 400_000 },
      customInstructions: "Keep security caveats.",
    });

    const { result } = await runCompactionScenario(sessionManager, event);

    expect(result).toEqual({ cancel: true });
    expect(result).not.toHaveProperty("compaction");
    expect(mockSummarizeInStages).toHaveBeenCalledTimes(1);
    expect(messagesToSummarize).toStrictEqual(transcriptBefore);
    expect(consumeCompactionSafeguardCancellation(sessionManager)?.reason).toBe(
      "Compaction safeguard could not summarize the session: " +
        "Failed to summarize dropped messages. | dropped prefix unavailable",
    );
  });

  it("sends pairing-discarded retained results to the dropped-history summary", async () => {
    mockSummarizeInStages
      .mockResolvedValueOnce("dropped history summary")
      .mockResolvedValueOnce("main history summary");

    const sessionManager = configuredSession({
      model: createAnthropicModelFixture({ contextWindow: 2_000 }),
      maxHistoryShare: 0.5,
      recentTurnsPreserve: 0,
    });

    const messagesToSummarize: AgentMessage[] = [
      userMessage("x".repeat(4_000), 1),
      toolResultMessage("missing-call", "orphan-result ".repeat(500), {
        toolName: "test_tool",
        timestamp: 2,
      }),
      userMessage("x".repeat(4_000), 3),
    ];
    const event = createCompactionEvent({
      preparation: { messagesToSummarize, tokensBefore: 10_000 },
    });

    const { result } = await runCompactionScenario(sessionManager, event);

    expectCompactionResult(result);
    expect(mockSummarizeInStages).toHaveBeenCalledTimes(2);
    const droppedCall = requireRecord(mockCallArg(mockSummarizeInStages));
    const droppedMessages = requireArray(droppedCall.messages) as AgentMessage[];
    expect(droppedMessages.map((message) => message.timestamp)).toEqual([1, 2]);
    const mainCall = requireRecord(mockCallArg(mockSummarizeInStages, 1));
    expect(JSON.stringify(mainCall.messages)).toContain("dropped history summary");
  });

  it("propagates caller abort while summarizing dropped history", async () => {
    const controller = new AbortController();
    const abortError = Object.assign(new Error("This operation was aborted"), {
      name: "AbortError",
    });
    const lateSummarizationError = new Error("transport failed after cancellation");
    mockSummarizeInStages
      .mockImplementationOnce(async () => {
        controller.abort(abortError);
        throw lateSummarizationError;
      })
      .mockResolvedValue("later summary must not run");

    const sessionManager = modelSession({
      maxHistoryShare: 0.1,
      recentTurnsPreserve: 0,
    });

    const messagesToSummarize: AgentMessage[] = Array.from({ length: 4 }, (_unused, index) =>
      userMessage(`msg-${index}-${"x".repeat(120_000)}`, index + 1),
    );
    const transcriptBefore = structuredClone(messagesToSummarize);
    const event = createCompactionEvent({
      preparation: { messagesToSummarize, tokensBefore: 400_000 },
      signal: controller.signal,
    });

    await expect(runCompactionScenario(sessionManager, event)).rejects.toBe(abortError);
    expect(mockSummarizeInStages).toHaveBeenCalledTimes(1);
    expect(consumeCompactionSafeguardCancellation(sessionManager)).toBeNull();
    expect(messagesToSummarize).toStrictEqual(transcriptBefore);
  });

  it("caps summarization reserve tokens to the model output limit", async () => {
    mockSummarizeInStages.mockResolvedValue("mock summary");

    const sessionManager = configuredSession({
      model: createAnthropicModelFixture({
        contextWindow: 1_000_000,
        maxTokens: 128_000,
      }),
      recentTurnsPreserve: 0,
    });

    const event = createCompactionEvent({
      preparation: {
        messagesToSummarize: [userMessage("large history", 1) as AgentMessage],
        tokensBefore: 250_000,
        settings: { reserveTokens: 240_000 },
      },
    });

    await runCompactionScenario(sessionManager, event);

    const call = requireRecord(mockCallArg(mockSummarizeInStages));
    expect(call?.reserveTokens).toBe(128_000);
  });

  it("preserves provider-prepared Copilot headers in built-in compaction summarization", async () => {
    mockSummarizeInStages.mockResolvedValue("mock summary");

    const sessionManager = configuredSession({
      model: createAnthropicModelFixture({
        id: "gpt-5.4",
        name: "gpt-5.4",
        provider: "github-copilot",
        api: "openai-responses" as const,
        baseUrl: "https://api.githubcopilot.com",
      }),
      recentTurnsPreserve: 0,
    });

    const getApiKeyAndHeadersMock = vi.fn().mockResolvedValue({
      ok: true,
      apiKey: "github-token",
      headers: {
        "Copilot-Integration-Id": "copilot-developer-cli",
        "Editor-Plugin-Version": "copilot-chat/0.35.0",
        "Openai-Organization": "github-copilot",
        "User-Agent": "GitHubCopilotChat/0.35.0",
        "X-Test": "1",
      },
    });
    const mockContext = createCompactionContext({
      sessionManager,
      getApiKeyAndHeadersMock,
    });
    const compactionHandler = createCompactionHandler();
    const event = createCompactionEvent({
      messageText: "summarize me",
      tokensBefore: 1000,
    });

    const result = (await compactionHandler(event, mockContext)) as { cancel?: boolean };

    expect(result.cancel).not.toBe(true);
    const summaryCall = mockSummarizeInStages.mock.lastCall?.[0];
    expect(summaryCall?.headers?.["Copilot-Integration-Id"]).toBe("copilot-developer-cli");
    expect(summaryCall?.headers?.["Editor-Plugin-Version"]).toBe("copilot-chat/0.35.0");
    expect(summaryCall?.headers?.["Openai-Organization"]).toBe("github-copilot");
    expect(summaryCall?.headers?.["User-Agent"]).toBe("GitHubCopilotChat/0.35.0");
    expect(summaryCall?.headers?.["X-Test"]).toBe("1");
    expect(summaryCall?.headers?.["x-initiator"]).toBe("user");
  });

  it.each([false, true])(
    "sends one authoritative safeguard summary format (prefix=%s)",
    async (prefix) => {
      testing.setSummarizeInStagesForTest(actualCompactionModule.summarizeInStages);
      const model = createAnthropicModelFixture({
        api: "test-api" as never,
        baseUrl: "",
        reasoning: true,
      });
      const sessionManager = configuredSession({ model, recentTurnsPreserve: 0 });

      const providerPrompts: string[] = [];
      const providerBudgets: Array<number | undefined> = [];
      const streamFn: StreamFn = (_activeModel, context, options) => {
        expect(options?.reasoning).toBe("high");
        providerPrompts.push(JSON.stringify(context));
        providerBudgets.push(options?.maxTokens);
        const stream = createAssistantMessageEventStream();
        stream.push({
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "provider summary" }],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: createZeroUsageFixture(),
            stopReason: "stop",
            timestamp: 1,
          },
        });
        stream.end();
        return stream;
      };
      const event = {
        ...createCompactionEvent({
          messageText: "summarize me: receipt_90210",
          tokensBefore: 1_000,
        }),
        customInstructions: "Keep the deployment decision.",
        thinkingLevel: "high" as const,
        streamFn,
      };
      const preparation = {
        ...event.preparation,
        isSplitTurn: prefix,
        messagesToSummarize: prefix ? [] : event.preparation.messagesToSummarize,
        turnPrefixMessages: prefix ? event.preparation.messagesToSummarize : [],
        previousSummary: prefix ? undefined : "Earlier deployment decision: use canary staging.",
      };

      const { result } = await runCompactionScenario(sessionManager, { ...event, preparation });

      expect(result.cancel).not.toBe(true);
      expect(result.compaction?.summary).toContain("provider summary");
      expect(result.compaction?.summary).not.toContain("Earlier deployment decision");
      expect(providerPrompts).toHaveLength(1);
      expect(providerPrompts[0]).toContain("[User]: summarize me");
      expect(providerPrompts[0]).toContain("receipt_90210");
      expect(providerPrompts[0]).toContain("Keep the deployment decision.");
      expect(providerPrompts[0]).toContain("Preserve all opaque identifiers exactly");
      expect(providerPrompts[0]).not.toContain("## Goal");
      expect(providerPrompts[0]).not.toContain("## Constraints & Preferences");
      expect(providerPrompts[0]).toContain(prefix ? "## Original Request" : "## Pending user asks");
      expect(providerPrompts[0]).not.toContain(
        prefix ? "## Pending user asks" : "## Original Request",
      );
      expect(providerBudgets).toEqual([prefix ? 2_000 : 3_200]);
      if (!prefix) {
        expect(providerPrompts[0]).toContain("Earlier deployment decision: use canary staging.");
      }
    },
  );

  it("surfaces a total provider failure and leaves the safeguard transcript unchanged", async () => {
    testing.setSummarizeInStagesForTest(actualCompactionModule.summarizeInStages);
    const model = createAnthropicModelFixture({
      api: "test-api" as never,
      baseUrl: "",
    });
    const sessionManager = configuredSession({ model, recentTurnsPreserve: 0 });

    const streamFn: StreamFn = () => {
      const stream = createAssistantMessageEventStream();
      stream.push({
        type: "error",
        reason: "error",
        error: {
          role: "assistant",
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: createZeroUsageFixture(),
          stopReason: "error",
          errorMessage: "Cannot convert undefined or null to object",
          timestamp: 1,
        },
      });
      stream.end();
      return stream;
    };
    const event = {
      ...createCompactionEvent({ messageText: "summarize me", tokensBefore: 1_000 }),
      streamFn,
    };
    const transcriptBefore = structuredClone(event.preparation.messagesToSummarize);

    const { result } = await runCompactionScenario(sessionManager, event);

    expect(result).toEqual({ cancel: true });
    expect(result).not.toHaveProperty("compaction");
    expect(event.preparation.messagesToSummarize).toStrictEqual(transcriptBefore);
    expect(consumeCompactionSafeguardCancellation(sessionManager)?.reason).toContain(
      "Cannot convert undefined or null to object",
    );
  });

  it.each(["How about now?", "１０ and ２０"])(
    "accepts a preserved keyword-free request without retrying compaction: %s",
    async (latestAsk) => {
      const generatedSummary = structuredSummary({ rules: "Preserve context.", asks: latestAsk });
      mockSummarizeInStages.mockResolvedValue(generatedSummary);
      const sessionManager = createQualityGuardSessionManager();
      const event = createCompactionEvent({ messageText: latestAsk });
      const { result } = await runCompactionScenario(sessionManager, event);

      expect(expectCompactionResult(result).summary).toContain(latestAsk);
      expect(mockSummarizeInStages).toHaveBeenCalledTimes(1);
      expect(consumeCompactionSafeguardCancellation(sessionManager)).toBeNull();
    },
  );

  it("marks a trimmed built-in body and emits one redacted tail-loss warning", async () => {
    const sensitiveSentinel = "body-secret-never-log";
    const body = `${sensitiveSentinel}-${"b".repeat(MAX_COMPACTION_SUMMARY_CHARS)}`;
    mockSummarizeInStages.mockResolvedValue(body);
    const sessionManager = modelSession({ recentTurnsPreserve: 0 });
    const event = createCompactionEvent({ messageText: "summarize me" });

    const { result } = await runCompactionScenario(sessionManager, event);

    expect(expectCompactionResult(result).summary).toContain(SUMMARY_TRUNCATED_MARKER.trim());
    expect(compactionLogger.warn).toHaveBeenCalledOnce();
    const warning = compactionLogger.warn.mock.calls[0]?.join(" ") ?? "";
    expect(warning).toBe("Compaction safeguard: finalized artifact truncated; loss=summary-tail");
    expect(warning).not.toContain(sensitiveSentinel);
    expect(mockSummarizeInStages).toHaveBeenCalledOnce();
  });

  it("preserves audit-required tail sections when an earlier section exhausts the budget", async () => {
    const latestAsk = "preserve the pending deployment status";
    const identifier = "/tmp/compaction-final-audit.log";
    const auditValidBeforeFinalization = structuredSummary({
      decisions: [
        "Latest user request status: pending.",
        "x".repeat(MAX_COMPACTION_SUMMARY_CHARS),
      ].join("\n"),
      asks: `Latest user request context: ${JSON.stringify(latestAsk)}`,
      identifiers: identifier,
    });
    expect(
      auditSummaryQuality({
        summary: auditValidBeforeFinalization,
        identifiers: [identifier],
        latestAsk,
      }).ok,
    ).toBe(true);
    mockSummarizeInStages.mockResolvedValue(auditValidBeforeFinalization);

    const sessionManager = createQualityGuardSessionManager();
    const event = createCompactionEvent({ messageText: `${latestAsk} ${identifier}` });

    const { result } = await runCompactionScenario(sessionManager, event, {
      latestUnresolvedUserRequest: true,
    });

    const summary = expectCompactionResult(result).summary;
    expect(summary.length).toBeLessThanOrEqual(MAX_COMPACTION_SUMMARY_CHARS);
    expect(summary).toContain(SUMMARY_TRUNCATED_MARKER.trim());
    expect(summary).toContain("## Open TODOs");
    expect(summary).toContain("## Constraints/Rules");
    expect(summary).toContain(
      `## Pending user asks\nLatest user request context: ${JSON.stringify(`${latestAsk} ${identifier}`)}`,
    );
    expect(summary).toContain(`## Exact identifiers\n${identifier}`);
    expect(mockSummarizeInStages).toHaveBeenCalledTimes(1);
    expect(consumeCompactionSafeguardCancellation(sessionManager)).toBeNull();
  });

  it("keeps real sections when a re-distilled identifier list outgrows the budget", async () => {
    const latestAsk = "preserve the pending deployment status";
    const identifier = "/tmp/source-only-compaction-id.log";
    const hoardedIdentifiers = Array.from(
      { length: 400 },
      (_, index) => `- /home/vac/clawd/tmp/session-artifacts/run-${index}/output.log`,
    ).join("\n");
    const generatedSummary = structuredSummary({
      decisions: [
        "Latest user request status: pending.",
        "Deployment stays paused until the backup is verified.",
      ].join("\n"),
      todos: "Verify the backup.",
      asks: latestAsk,
      identifiers: hoardedIdentifiers,
    });
    expect(generatedSummary.length).toBeGreaterThan(MAX_COMPACTION_SUMMARY_CHARS);
    mockSummarizeInStages.mockResolvedValue(generatedSummary);

    const sessionManager = createQualityGuardSessionManager();
    const event = createCompactionEvent({
      messageText: `${latestAsk} ${identifier}`,
    });

    const { result } = await runCompactionScenario(sessionManager, event, {
      latestUnresolvedUserRequest: true,
    });

    const summary = expectCompactionResult(result).summary;
    expect(summary.length).toBeLessThanOrEqual(MAX_COMPACTION_SUMMARY_CHARS);
    expect(summary).toContain("Deployment stays paused until the backup is verified.");
    expect(summary).toContain("## Open TODOs\nVerify the backup.");
    expect(summary).toContain(
      `## Pending user asks\nLatest user request context: ${JSON.stringify(`${latestAsk} ${identifier}`)}`,
    );
    expect(summary).toContain(identifier);
    expect(summary).toContain("run-0/output.log");
    expect(summary).not.toContain("run-399/output.log");
    const identifiersSection = summary.slice(summary.indexOf("## Exact identifiers"));
    expect(identifiersSection.length).toBeLessThanOrEqual(
      MAX_COMPACTION_SUMMARY_CHARS * 0.25 + 200,
    );
    expect(consumeCompactionSafeguardCancellation(sessionManager)).toBeNull();
  });

  it("keeps surplus budget out of the protected sections when trimming", () => {
    const identifier = "/tmp/surplus-compaction-id.log";
    const latestAsk = "preserve the pending deployment status";
    const body = structuredSummary({
      decisions: "",
      todos: "",
      rules: "",
      asks: latestAsk,
      identifiers: [
        identifier,
        ...Array.from({ length: 300 }, (_, i) => `- /tmp/run-${i}/out.log`),
      ].join("\n"),
    });
    const maxChars = 4_000;
    expect(body.length).toBeGreaterThan(maxChars);

    const finalized = budgetCompactionSummary(body, "", maxChars, {
      identifiers: [identifier],
      latestAsk,
      identifierPolicy: "strict",
    });

    const structural = (finalized as { structuralSummary: string }).structuralSummary;
    expect(structural.length).toBeLessThanOrEqual(maxChars);
    expect(structural).toContain("## Decisions");
    expect(structural).toContain(identifier);
    const identifiersSection = structural.slice(structural.indexOf("## Exact identifiers"));
    expect(identifiersSection.length).toBeLessThanOrEqual(maxChars * 0.25 + 100);
  });

  it("caps an identifier list that outgrew its share while the summary still fits", async () => {
    const latestAsk = "preserve the pending deployment status";
    const identifier = "/tmp/source-only-compaction-id.log";
    const hoardedIdentifiers = Array.from(
      { length: 200 },
      (_, index) => `- /home/vac/clawd/tmp/session-artifacts/run-${index}/output.log`,
    ).join("\n");
    const generatedSummary = structuredSummary({
      decisions: [
        "Latest user request status: pending.",
        "Deployment stays paused until the backup is verified.",
      ].join("\n"),
      todos: "Verify the backup.",
      asks: latestAsk,
      identifiers: `${identifier}\n${hoardedIdentifiers}`,
    });
    expect(generatedSummary.length).toBeLessThan(MAX_COMPACTION_SUMMARY_CHARS);
    mockSummarizeInStages.mockResolvedValue(generatedSummary);

    const sessionManager = createQualityGuardSessionManager();
    const event = createCompactionEvent({
      messageText: `${latestAsk} ${identifier}`,
    });

    const { result } = await runCompactionScenario(sessionManager, event);

    const summary = expectCompactionResult(result).summary;
    expect(summary).toContain("Deployment stays paused until the backup is verified.");
    expect(summary).toContain(identifier);
    expect(summary).not.toContain("run-199/output.log");
    const identifiersSection = summary.slice(summary.indexOf("## Exact identifiers"));
    expect(identifiersSection.length).toBeLessThanOrEqual(
      MAX_COMPACTION_SUMMARY_CHARS * 0.25 + 200,
    );
    expect(consumeCompactionSafeguardCancellation(sessionManager)).toBeNull();
  });

  it("restores source identifiers omitted by a generated summary that fits the budget", async () => {
    const latestAsk = "preserve the pending deployment status";
    const identifier = "/tmp/source-only-compaction-id.log";
    const generatedSummary = structuredSummary({
      decisions: ["Latest user request status: pending.", "Deployment stays paused."].join("\n"),
      asks: latestAsk,
    });
    mockSummarizeInStages.mockResolvedValue(generatedSummary);

    const sessionManager = createQualityGuardSessionManager();
    const event = createCompactionEvent({
      messageText: `${latestAsk} ${identifier}`,
    });

    const { result } = await runCompactionScenario(sessionManager, event);

    const summary = expectCompactionResult(result).summary;
    expect(summary).toContain(`## Exact identifiers\nNone.\n${identifier}`);
    expect(summary).not.toContain(SUMMARY_TRUNCATED_MARKER.trim());
    expect(mockSummarizeInStages).toHaveBeenCalledTimes(1);
    expect(consumeCompactionSafeguardCancellation(sessionManager)).toBeNull();
  });

  it("foregrounds exact source qualifiers before an overlapping stale task", async () => {
    const latestAsk = "delete production only after verified backup";
    const generatedSummary = structuredSummary({
      decisions: ["Latest user request status: pending.", `${latestAsk} was reviewed.`].join("\n"),
      rules: "Use normal safeguards.",
      asks: "Delete production backup immediately.",
    });
    mockSummarizeInStages.mockResolvedValue(generatedSummary);

    const sessionManager = createQualityGuardSessionManager({ qualityGuardMaxRetries: 0 });
    const event = createCompactionEvent({ messageText: latestAsk });

    const { result } = await runCompactionScenario(sessionManager, event, {
      latestUnresolvedUserRequest: true,
    });

    const summary = expectCompactionResult(result).summary;
    expect(summary).toContain(
      `## Pending user asks\nLatest user request context: ${JSON.stringify(latestAsk)}\nDelete production backup immediately.`,
    );
    expect(mockSummarizeInStages).toHaveBeenCalledTimes(1);
    expect(consumeCompactionSafeguardCancellation(sessionManager)).toBeNull();
  });

  it("fails closed when audit-required tail sections cannot fit the artifact cap", async () => {
    const latestAsk = "preserve the pending deployment status";
    const identifier = `https://example.com/${"a".repeat(MAX_COMPACTION_SUMMARY_CHARS)}`;
    const oversizedRequiredTail = structuredSummary({ asks: latestAsk, identifiers: identifier });
    mockSummarizeInStages.mockResolvedValue(oversizedRequiredTail);

    const sessionManager = createQualityGuardSessionManager({ qualityGuardMaxRetries: 0 });
    const event = createCompactionEvent({
      messageText: `${latestAsk} ${identifier}`,
    });

    const { result } = await runCompactionScenario(sessionManager, event);

    expect(result).toEqual({ cancel: true });
    expect(mockSummarizeInStages).toHaveBeenCalledTimes(1);
    expect(consumeCompactionSafeguardCancellation(sessionManager)?.reason).toBe(
      "Compaction safeguard required facts exceed the finalized summary budget.",
    );
  });

  it("restores source ask evidence omitted by the split-turn summary", async () => {
    const olderAsk = "summarize the earlier provider migration";
    const latestAsk = "confirm whether the aurora migration completed successfully";
    const identifier = "/tmp/split-turn-retention.log";
    const historySummary = structuredSummary({
      decisions: [
        "Latest user request status: pending.",
        "x".repeat(MAX_COMPACTION_SUMMARY_CHARS),
      ].join("\n"),
      asks: olderAsk,
    });
    const splitSummary = `Unrelated active-turn context. ${identifier} ${"z".repeat(MAX_COMPACTION_SUMMARY_CHARS)}`;
    mockSummarizeInStages.mockResolvedValueOnce(historySummary).mockResolvedValueOnce(splitSummary);

    const sessionManager = createQualityGuardSessionManager({ qualityGuardMaxRetries: 0 });
    const event = createCompactionEvent({
      preparation: {
        messagesToSummarize: [userMessage(olderAsk, 1)] as AgentMessage[],
        turnPrefixMessages: [userMessage(`${latestAsk} ${identifier}`, 2)] as AgentMessage[],
        isSplitTurn: true,
      },
    });

    const { result } = await runCompactionScenario(sessionManager, event, {
      latestUnresolvedUserRequest: true,
    });

    const summary = expectCompactionResult(result).summary;
    expect(summary.length).toBeLessThanOrEqual(MAX_COMPACTION_SUMMARY_CHARS);
    expect(summary).toContain(
      `## Pending user asks\nLatest user request context: ${JSON.stringify(`${latestAsk} ${identifier}`)}\n${olderAsk}`,
    );
    expect(summary).toContain(latestAsk);
    expect(summary).toContain(identifier);
    expectCanonicalSummaryHeadingsOnce(summary);
    expect(
      auditSummaryQuality({
        summary,
        identifiers: [identifier],
        latestAsk: `${latestAsk} ${identifier}`,
      }).ok,
    ).toBe(true);
    expect(mockSummarizeInStages).toHaveBeenCalledTimes(2);

    const redistillMessages = prependPreviousSummaryForRedistill({
      messages: [userMessage("continue", 3)],
      previousSummary: summary,
    });
    const redistillContent = requireArray(requireRecord(redistillMessages[0]).content);
    const redistillPrompt = requireRecord(redistillContent[0]).text;
    expect(typeof redistillPrompt).toBe("string");
    expectCanonicalSummaryHeadingsOnce(redistillPrompt as string);
  });

  it("keeps an owner-provided request pending when its completed turn is preserved", async () => {
    const latestAsk = "combine the bars into one box per provider";
    const completion = "The provider boxes are combined.";
    const sessionManager = createQualityGuardSessionManager({ recentTurnsPreserve: 12 });
    const toolChain = Array.from({ length: 12 }, (_, index) => {
      const id = `call_${index}`;
      return [
        toolCallMessage(id, "exec", 2 + index * 2),
        toolResultMessage(id, "output ".repeat(200), {
          toolName: "exec",
          timestamp: 3 + index * 2,
        }),
      ];
    }).flat();
    const event = createCompactionEvent({ messageText: latestAsk, tokensBefore: 90_000 });
    event.preparation.messagesToSummarize = [
      userMessage(latestAsk, 1),
      ...toolChain,
      castAgentMessage({
        role: "assistant",
        content: [{ type: "text", text: completion }],
        stopReason: "stop",
        timestamp: 100,
      }),
    ];

    const { result } = await runCompactionScenario(sessionManager, event, {
      latestUnresolvedUserRequest: true,
    });

    const finalSummary = expectCompactionResult(result).summary;
    expect(finalSummary).toContain(latestAsk);
    expect(finalSummary).toContain(
      `## Pending user asks\nLatest user request context: ${JSON.stringify(latestAsk)}`,
    );
    expect(mockSummarizeInStages).not.toHaveBeenCalled();
  });

  it("keeps an owner-provided request ahead of model-classified older work", async () => {
    const latestAsk = "combine the provider boxes into one completed artifact";
    const summary = structuredSummary({
      decisions: [
        "Latest user request status: completed.",
        "The provider boxes were combined into the final artifact.",
      ].join("\n"),
      asks: "Finish the older migration.",
    });
    mockSummarizeInStages.mockResolvedValue(summary);

    const sessionManager = createQualityGuardSessionManager({ qualityGuardMaxRetries: 0 });
    const event = createCompactionEvent({ messageText: latestAsk, tokensBefore: 90_000 });

    const { result } = await runCompactionScenario(sessionManager, event, {
      latestUnresolvedUserRequest: true,
    });

    const finalSummary = expectCompactionResult(result).summary;
    expect(finalSummary).toContain(
      `## Pending user asks\nLatest user request context: ${JSON.stringify(latestAsk)}`,
    );
    expect(finalSummary).toContain(`## Decisions\n${summary.split("\n")[1]}`);
    expect(finalSummary).toContain("Finish the older migration.");
    expect(mockSummarizeInStages).toHaveBeenCalledTimes(1);
  });

  it("retries model output that copies a heading-template ask into structured sections", async () => {
    const latestAsk = headingTemplate("zephyr quasar template:");
    const templateSummary = (decision: string, pending: string) =>
      structuredSummary({
        decisions: ["Latest user request status: pending.", decision].join("\n"),
        asks: pending,
      });
    mockSummarizeInStages
      .mockResolvedValueOnce(templateSummary(latestAsk, "None."))
      .mockResolvedValueOnce(
        templateSummary("No decision yet.", "Track the zephyr quasar template request."),
      );

    const sessionManager = createQualityGuardSessionManager();
    const event = createCompactionEvent({ messageText: latestAsk, tokensBefore: 90_000 });

    const { result } = await runCompactionScenario(sessionManager, event, {
      latestUnresolvedUserRequest: true,
    });

    const finalSummary = expectCompactionResult(result).summary;
    expect(mockSummarizeInStages).toHaveBeenCalledTimes(2);
    expect(finalSummary).toContain(
      `## Pending user asks\nLatest user request context: ${JSON.stringify(latestAsk)}`,
    );
    const retry = requireRecord(mockCallArg(mockSummarizeInStages, 1));
    expect(retry.customInstructions).toContain("duplicate_section");
    expect(retry.customInstructions).toContain("complete summary body within 16000 UTF-16");
  });

  it("propagates caller abort during corrective generation", async () => {
    const controller = new AbortController();
    const abortError = Object.assign(new Error("corrective compaction aborted"), {
      name: "AbortError",
    });
    mockSummarizeInStages
      .mockResolvedValueOnce("invalid first attempt")
      .mockImplementationOnce(async () => {
        controller.abort(abortError);
        throw new Error("transport closed after abort");
      });

    const sessionManager = createQualityGuardSessionManager();
    const event = createCompactionEvent({
      messageText: "report deployment status",
    });
    event.signal = controller.signal;

    await expect(runCompactionScenario(sessionManager, event)).rejects.toBe(abortError);
    expect(mockSummarizeInStages).toHaveBeenCalledTimes(2);
    expect(consumeCompactionSafeguardCancellation(sessionManager)).toBeNull();
  });

  it("keeps an owner-provided split-turn request pending across retained context", async () => {
    const latestAsk = "combine the provider boxes into one completed artifact";
    const identifier = "/tmp/pr130620/live/marker";
    const prefixSummary = (pendingAsk?: string) =>
      [
        "## Original Request",
        latestAsk,
        "## Early Progress",
        "The RCA is complete.",
        "## Context for Suffix",
        `Implementation remains. Preserve ${identifier}.`,
        ...(pendingAsk ? ["## Pending user asks", pendingAsk] : []),
      ].join("\n");
    mockSummarizeInStages
      .mockResolvedValueOnce(prefixSummary(latestAsk))
      .mockResolvedValueOnce(prefixSummary());

    const sessionManager = createQualityGuardSessionManager();
    const event = createCompactionEvent({
      preparation: {
        messagesToSummarize: [] as AgentMessage[],
        turnPrefixMessages: [
          userMessage(latestAsk, 1),
          castAgentMessage({
            role: "assistant",
            content: [
              {
                type: "text",
                text: `The RCA is complete; implementation remains. Preserve ${identifier}.`,
              },
            ],
            timestamp: 2,
          }),
        ] as AgentMessage[],
        tokensBefore: 90_000,
        isSplitTurn: true,
      },
    });

    const { result } = await runCompactionScenario(sessionManager, event, {
      latestUnresolvedUserRequest: true,
    });

    const finalSummary = expectCompactionResult(result).summary;
    expect(mockSummarizeInStages).toHaveBeenCalledTimes(2);
    const retry = requireRecord(mockCallArg(mockSummarizeInStages, 1));
    expect(retry.customInstructions).toContain("retained_turn_ask_marked_pending");
    expect(finalSummary).toContain(
      `## Pending user asks\nLatest user request context: ${JSON.stringify(latestAsk)}`,
    );
    expect(finalSummary).toContain("### Context for Suffix\nImplementation remains.");
    expect(finalSummary).not.toContain(`## Pending user asks\n${latestAsk}`);
    expectCanonicalSummaryHeadingsOnce(finalSummary);
  });

  it("keeps an older pending ask when the split prefix has no user request", async () => {
    const latestAsk = "finish the pending provider migration";
    const historySummary = structuredSummary({
      decisions: "Keep the migration active.",
      todos: "Finish the provider migration.",
      rules: "Preserve the pending request.",
      asks: latestAsk,
    });
    mockSummarizeInStages
      .mockResolvedValueOnce(historySummary)
      .mockResolvedValueOnce("Maintenance activity continues in the retained suffix.");

    const sessionManager = createQualityGuardSessionManager({ qualityGuardMaxRetries: 0 });
    const { result } = await runCompactionScenario(
      sessionManager,
      createCompactionEvent({
        preparation: {
          messagesToSummarize: [userMessage(latestAsk, 1)] as AgentMessage[],
          turnPrefixMessages: [
            {
              role: "custom",
              customType: "maintenance",
              content: "maintenance event",
              display: true,
              timestamp: 2,
            },
          ] as AgentMessage[],
          firstKeptEntryId: "entry-2",
          tokensBefore: 90_000,
          isSplitTurn: true,
        },
      }),
      { latestUnresolvedUserRequest: true },
    );

    const finalSummary = expectCompactionResult(result).summary;
    const historyCall = requireRecord(mockCallArg(mockSummarizeInStages));
    expect(historyCall.customInstructions).not.toContain("belongs to a split turn");
    expect(finalSummary).toContain(
      `## Pending user asks\nLatest user request context: ${JSON.stringify(latestAsk)}\n${latestAsk}`,
    );
    expectCanonicalSummaryHeadingsOnce(finalSummary);
    expect(mockSummarizeInStages).toHaveBeenCalledTimes(2);
  });

  it("ignores truncated numeric tool-result noise in strict all-preserved audits", async () => {
    const latestAsk = "report metric status";
    const sessionManager = createQualityGuardSessionManager({ recentTurnsPreserve: 12 });
    const messagesToSummarize: AgentMessage[] = [
      userMessage(latestAsk, 1),
      toolCallMessage("call_metric", "read", 2),
      toolResultMessage(
        "call_metric",
        `${"x".repeat(610)} metric=0.123456789 ` +
          "negative=12345678e-987654321 positive=12345678e+987654321 " +
          "latency=0.123456789seconds size=1.23456789e-987654321megabytes metric=12345678.e10",
        { timestamp: 3 },
      ),
      castAgentMessage(timestampedTextAssistant("metric checked", 4)),
    ];
    const event = createCompactionEvent({ preparation: { messagesToSummarize } });

    const { result } = await runCompactionScenario(sessionManager, event);

    const summary = expectCompactionResult(result).summary;
    expect(summary).toContain(latestAsk);
    expect(summary).not.toContain("123456789");
    expect(summary).not.toContain("23456789e");
    expect(summary).not.toContain("987654321");
    expect(summary).not.toContain("12345678");
    expect(mockSummarizeInStages).not.toHaveBeenCalled();
    expect(mockAuditSummaryQuality).toHaveBeenCalledTimes(1);
    const auditInput = requireRecord(mockCallArg(mockAuditSummaryQuality));
    expect(auditInput.identifiers).toEqual([]);
  });

  it("retains owner facts without summarizing an all-preserved turn", async () => {
    const latestAsk = "report deployment status";
    const identifier = "/tmp/all-preserved-truncated.log";
    const sessionManager = createQualityGuardSessionManager({ recentTurnsPreserve: 12 });
    const sourceText = `${"x".repeat(610)} ${latestAsk} ${identifier}`;
    const event = createCompactionEvent({ messageText: sourceText });

    const { result } = await runCompactionScenario(sessionManager, event, {
      latestUnresolvedUserRequest: true,
    });

    const summary = expectCompactionResult(result).summary;
    expect(summary).toContain(latestAsk);
    expect(summary).toContain(identifier);
    expect(mockSummarizeInStages).not.toHaveBeenCalled();
    expect(mockAuditSummaryQuality).toHaveBeenCalledTimes(1);
    const auditInput = requireRecord(mockCallArg(mockAuditSummaryQuality));
    expect(auditInput.latestAsk).toBe(sourceText);
    expect(auditInput.identifiers).toEqual([identifier]);
    expect(auditInput.summary).toContain("## Recent turns preserved verbatim");
    expect(auditInput.summary).toContain(identifier);
    expect(auditInput.summary).toContain(latestAsk);
    expect(mockAuditSummaryQuality.mock.results[0]?.value).toEqual({ ok: true, reasons: [] });
    expect(consumeCompactionSafeguardCancellation(sessionManager)).toBeNull();
  });

  it("retries when generated summary misses headings even if preserved turns contain them", async () => {
    const preservedUserText = [
      "latest ask status",
      "## Decisions",
      "from preserved turns",
      "## Open TODOs",
      "from preserved turns",
      "## Constraints/Rules",
      "from preserved turns",
      "## Pending user asks",
      "latest ask status",
      "## Exact identifiers",
      "/tmp/preserved-turn-bypass.log",
    ].join("\n");
    mockSummarizeInStages.mockResolvedValueOnce("invalid generated body").mockResolvedValueOnce(
      structuredSummary({
        rules: "Follow rules.",
        asks: "latest ask status",
        identifiers: "/tmp/preserved-turn-bypass.log",
      }),
    );

    const sessionManager = createQualityGuardSessionManager({ recentTurnsPreserve: 1 });

    const event = createCompactionEvent({
      preparation: {
        messagesToSummarize: [
          userMessage("older context", 1),
          castAgentMessage({
            role: "custom",
            customType: "openclaw.runtime-context",
            content: "secret runtime context",
            display: false,
            timestamp: 1.5,
          }),
          castAgentMessage({ role: "assistant", content: "older reply", timestamp: 2 }),
          userMessage(preservedUserText, 3),
        ],
      },
    });

    const { result } = await runCompactionScenario(sessionManager, event);

    expect(result.cancel).not.toBe(true);
    expect(mockSummarizeInStages).toHaveBeenCalledTimes(2);
    const firstAudit = requireRecord(mockCallArg(mockAuditSummaryQuality));
    expect(firstAudit.structuralSummary).toBe("invalid generated body");
    expect(firstAudit.summary).toContain(preservedUserText);
    const secondCall = mockCallArg(mockSummarizeInStages, 1) as {
      customInstructions?: string;
    };
    expect(secondCall.customInstructions).toContain("Quality check feedback");
    expect(secondCall.customInstructions).toContain("missing_section:## Decisions");
    expect(result.compaction?.summary).toContain("## Decisions");
  });

  it("cancels when corrective generation fails after finalized quality rejection", async () => {
    const oversizedHistorySummary = "history detail ".repeat(MAX_COMPACTION_SUMMARY_CHARS);
    const splitTurnPrefixSummary = "split-turn prefix context that must survive capping";
    const correctiveFailureMarker = "USER_SESSION_TEXT_issue119932_corrective";
    mockSummarizeInStages
      .mockResolvedValueOnce(oversizedHistorySummary)
      .mockResolvedValueOnce(splitTurnPrefixSummary)
      .mockRejectedValueOnce(new Error(correctiveFailureMarker));

    const sessionManager = createQualityGuardSessionManager({ recentTurnsPreserve: 1 });

    const event = createCompactionEvent({
      preparation: {
        messagesToSummarize: [
          userMessage("older context", 1),
          castAgentMessage({ role: "assistant", content: "older reply", timestamp: 2 }),
          userMessage("latest ask status", 3),
          castAgentMessage(timestampedTextAssistant("latest assistant reply", 4)),
        ],
        turnPrefixMessages: [userMessage("prefix request that was split out", 0)],
        isSplitTurn: true,
      },
    });

    const { result } = await runCompactionScenario(sessionManager, event);

    expect(result).toEqual({ cancel: true });
    expect(mockSummarizeInStages).toHaveBeenCalledTimes(3);
    expect(requireRecord(mockCallArg(mockSummarizeInStages, 2)).customInstructions).toContain(
      "Quality check feedback",
    );
    expect(consumeCompactionSafeguardCancellation(sessionManager)?.reason).toBe(
      "Compaction safeguard finalized summary failed quality checks and corrective generation failed.",
    );
    const terminalWarnings = compactionLogger.warn.mock.calls.flat().join("\n");
    expect(terminalWarnings).toContain("reasonCode=corrective_generation_failed");
    expect(terminalWarnings).toContain("attempt=2");
    expect(terminalWarnings).not.toContain(correctiveFailureMarker);
  });

  it("normalizes legacy split-turn headings when history is carried forward", async () => {
    const sessionManager = modelSession({
      recentTurnsPreserve: 12,
    });

    const event = createCompactionEvent({
      preparation: {
        messagesToSummarize: [
          userMessage("latest user ask", 1),
          castAgentMessage(timestampedTextAssistant("latest assistant reply", 2)),
        ],
        previousSummary: structuredSummary({
          decisions: "Keep the existing architecture.",
          todos: "Finish the migration.",
          rules: "Preserve operator context.",
          asks: "Continue the migration.",
          identifiers: [
            "/tmp/migration.log\n\n**Turn Context (split turn):**\n",
            structuredSummary({
              decisions: "Inspect the latest result.",
              todos: "Verify the output.",
              rules: "Keep the exact path.",
              asks: "Report completion.",
              identifiers: "/tmp/latest.log",
            }),
            "\n## Recent turns preserved verbatim\n[User] continue",
          ].join("\n"),
        }),
      },
    });

    const { result } = await runCompactionScenario(sessionManager, event);

    expect(result.cancel).not.toBe(true);
    expect(mockSummarizeInStages).not.toHaveBeenCalled();
    const summary = result.compaction?.summary ?? "";
    expectCanonicalSummaryHeadingsOnce(summary);
    expect(summary).toContain("### Decisions\nInspect the latest result.");
    expect(summary).toContain("## Recent turns preserved verbatim");
    expect(summary).toContain("/tmp/migration.log");
    expect(summary).toContain("/tmp/latest.log");
  });

  it("falls back to LLM when provider throws a provider-side AbortError with signal not aborted", async () => {
    mockSummarizeInStages.mockResolvedValue("llm fallback summary");

    const providerAbortErr = Object.assign(new Error("This operation was aborted"), {
      name: "AbortError",
    });
    const failingProviderSummarize = vi.fn().mockRejectedValue(providerAbortErr);
    installCompactionProviderForTest("disconnecting-provider", failingProviderSummarize);

    const sessionManager = modelSession({
      provider: "disconnecting-provider",
      recentTurnsPreserve: 0,
    });

    const event = createCompactionEvent({
      preparation: {
        messagesToSummarize: [
          userMessage("older context", 1),
          castAgentMessage({ role: "assistant", content: "older reply", timestamp: 2 }),
        ],
      },
    });
    const { result } = await runCompactionScenario(sessionManager, event, { apiKey: "key" });
    expect(result.cancel).not.toBe(true);
    expect(mockSummarizeInStages).toHaveBeenCalled();
  });

  it("propagates provider AbortError and cancels when caller signal is already aborted", async () => {
    const providerAbortErr = Object.assign(new Error("This operation was aborted"), {
      name: "AbortError",
    });
    const failingProviderSummarize = vi.fn().mockRejectedValue(providerAbortErr);
    installCompactionProviderForTest("aborted-provider", failingProviderSummarize);

    const controller = new AbortController();
    controller.abort();

    const sessionManager = configuredSession({
      provider: "aborted-provider",
    });

    const event = createCompactionEvent({
      preparation: {
        messagesToSummarize: [userMessage("older context", 1)] as AgentMessage[],
      },
      signal: controller.signal,
    });

    await expect(
      runCompactionScenario(sessionManager, event, { apiKey: "key" }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(mockSummarizeInStages).not.toHaveBeenCalled();
  });

  it("passes compaction instructions to providers and preserves suffix context", async () => {
    const providerSummarize = vi.fn().mockResolvedValue("provider summary body");
    installCompactionProviderForTest("test-provider", providerSummarize);

    const sessionManager = configuredSession({
      provider: "test-provider",
      recentTurnsPreserve: 1,
      identifierPolicy: "custom",
      identifierInstructions: "Preserve ticket IDs exactly.",
      customInstructions: "Keep milestone names.",
    });

    const event = createCompactionEvent({
      preparation: {
        messagesToSummarize: [
          userMessage("older context", 1),
          castAgentMessage({ role: "assistant", content: "older reply", timestamp: 2 }),
          userMessage("latest ask status", 3),
          timestampedTextAssistant("latest assistant reply", 4) as AgentMessage,
        ],
        turnPrefixMessages: [userMessage("prefix request that was split out", 0)],
        previousSummary: "previous provider summary",
        isSplitTurn: true,
      },
    });

    const { result, getApiKeyAndHeadersMock } = await runCompactionScenario(sessionManager, event, {
      apiKey: null,
    });

    const compaction = expectCompactionResult(result);
    expect(getApiKeyAndHeadersMock).not.toHaveBeenCalled();
    expect(mockSummarizeInStages).not.toHaveBeenCalled();
    const providerInput = requireRecord(mockCallArg(providerSummarize));
    expect(providerInput?.previousSummary).toBe("previous provider summary");
    expect(providerInput?.customInstructions).toContain("Keep milestone names.");
    expect(providerInput?.summarizationInstructions).toEqual({
      identifierPolicy: "custom",
      identifierInstructions: "Preserve ticket IDs exactly.",
    });
    const providerMessages = providerInput.messages ?? [];
    expect(JSON.stringify(providerMessages)).not.toContain("openclaw.runtime-context");
    expect(JSON.stringify(providerMessages)).not.toContain("secret runtime context");
    expect(compaction.summary).toContain("provider summary body");
    expect(compaction.summary).toContain("**Turn Context (split turn):**");
    expect(compaction.summary).toContain("prefix request that was split out");
    expect(compaction.summary).toContain("## Recent turns preserved verbatim");
    expect(compaction.summary).toContain("latest ask status");
    expect(compaction.summary).toContain("latest assistant reply");
  });

  it("preserves an above-half provider body byte-for-byte when the joined artifact fits", async () => {
    const providerBody = `BODY-START${"b".repeat(4_480)}BODY-MIDDLE${"b".repeat(4_480)}BODY-END`;
    const providerSummarize = vi.fn().mockResolvedValue(providerBody);
    installCompactionProviderForTest("within-budget-provider", providerSummarize);
    const sessionManager = configuredSession({
      provider: "within-budget-provider",
      recentTurnsPreserve: 0,
    });
    const event = createCompactionEvent({
      preparation: {
        messagesToSummarize: [userMessage("summarize the active work", 1)] as AgentMessage[],
        turnPrefixMessages: [userMessage("small split-turn suffix", 2)] as AgentMessage[],
        isSplitTurn: true,
      },
    });

    const { result } = await runCompactionScenario(sessionManager, event, { apiKey: null });

    const summary = expectCompactionResult(result).summary;
    expect(summary.startsWith(providerBody)).toBe(true);
    expect(summary).toContain("small split-turn suffix");
    expect(compactionLogger.warn).not.toHaveBeenCalled();
  });

  it("retains provider body sentinels and emits one redacted warning when suffixes overflow", async () => {
    const sensitiveSentinel = "credential-sentinel-never-log";
    const providerBody = `BODY-START${"b".repeat(3_400)}BODY-MIDDLE${"b".repeat(3_400)}BODY-END`;
    const providerSummarize = vi.fn().mockResolvedValue(providerBody);
    installCompactionProviderForTest("overflow-provider", providerSummarize);
    const sessionManager = configuredSession({
      provider: "overflow-provider",
      recentTurnsPreserve: 12,
    });
    const messagesToSummarize = Array.from({ length: 24 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `preserved-${index}-${sensitiveSentinel}-${"p".repeat(700)}`,
      timestamp: index + 1,
    })) as AgentMessage[];
    const turnPrefixMessages = Array.from({ length: 20 }, (_, index) =>
      userMessage(`raw-prefix-${index}-${sensitiveSentinel}-${"r".repeat(700)}`, index + 100),
    );
    const event = createCompactionEvent({
      preparation: {
        messagesToSummarize,
        turnPrefixMessages,
        tokensBefore: 20_000,
        isSplitTurn: true,
      },
    });

    const { result } = await runCompactionScenario(sessionManager, event, { apiKey: null });

    const summary = expectCompactionResult(result).summary;
    expect(summary.length).toBeLessThanOrEqual(MAX_COMPACTION_SUMMARY_CHARS);
    expect(summary).toContain("BODY-START");
    expect(summary).toContain("BODY-MIDDLE");
    expect(summary).toContain("BODY-END");
    expect(summary).toContain(CONTEXT_TRUNCATED_MARKER.trim());
    expect(compactionLogger.warn).toHaveBeenCalledOnce();
    const warning = compactionLogger.warn.mock.calls[0]?.join(" ") ?? "";
    expect(warning).toBe(
      "Compaction safeguard: finalized artifact truncated; " +
        "loss=split-turn-head,preserved-turn-head,suffix-head",
    );
    expect(warning).not.toContain(sensitiveSentinel);
  });

  it("finally trims a raw tool interaction only at its atomic boundary", async () => {
    const providerSummarize = vi.fn().mockResolvedValue(`BODY-START${"b".repeat(9_000)}BODY-END`);
    installCompactionProviderForTest("tool-boundary-provider", providerSummarize);
    const sessionManager = configuredSession({
      provider: "tool-boundary-provider",
      recentTurnsPreserve: 3,
    });
    const messagesToSummarize = Array.from({ length: 6 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `preserved-${index}-${"p".repeat(600)}`,
      timestamp: index + 1,
    })) as AgentMessage[];
    const toolCalls = Array.from({ length: 12 }, (_, index) => ({
      type: "toolCall",
      id: `finalizer_call_${index}`,
      name: "read",
      arguments: {},
    }));
    const turnPrefixMessages = [
      userMessage("raw tool request", 100),
      castAgentMessage({
        role: "assistant" as const,
        content: toolCalls,
        timestamp: 101,
      }),
      ...toolCalls.map((toolCall, index) =>
        toolResultMessage(toolCall.id, `finalizer-tool-output-${index}-${"r".repeat(600)}`, {
          timestamp: index + 102,
        }),
      ),
      castAgentMessage({
        role: "assistant" as const,
        content: [{ type: "text", text: "raw terminal answer survives" }],
        timestamp: 114,
      }),
    ];
    const event = createCompactionEvent({
      preparation: {
        messagesToSummarize,
        turnPrefixMessages,
        tokensBefore: 20_000,
        isSplitTurn: true,
      },
    });

    const { result } = await runCompactionScenario(sessionManager, event, { apiKey: null });

    const summary = expectCompactionResult(result).summary;
    expect(summary.length).toBeLessThanOrEqual(MAX_COMPACTION_SUMMARY_CHARS);
    expect(summary).toContain("raw terminal answer survives");
    expect(summary).not.toContain("finalizer-tool-output-");
    expect(summary).not.toContain("- Tool result (read):");
    expect(summary).toContain("## Recent turns preserved verbatim");
  });
});

describe("compaction-safeguard extension model fallback", () => {
  it("proceeds with keyless SDK-managed auth (ok:true, no apiKey/headers)", async () => {
    mockSummarizeInStages.mockResolvedValue("mock summary");

    const model = createAnthropicModelFixture({ provider: "amazon-bedrock" });
    const sessionManager = configuredSession({ model, recentTurnsPreserve: 0 });

    const getApiKeyAndHeadersMock = vi.fn().mockResolvedValue({ ok: true });
    const mockContext = createCompactionContext({ sessionManager, getApiKeyAndHeadersMock });
    const compactionHandler = createCompactionHandler();
    const event = createCompactionEvent({ messageText: "summarize me", tokensBefore: 1000 });

    const result = (await compactionHandler(event, mockContext)) as { cancel?: boolean };

    expect(result.cancel).not.toBe(true);
    expect(getApiKeyAndHeadersMock).toHaveBeenCalledWith(model);
    expect(mockSummarizeInStages).toHaveBeenCalled();
  });

  it("cancels compaction when both ctx.model and runtime.model are undefined", async () => {
    const sessionManager = stubSessionManager();

    const mockEvent = createCompactionEvent({
      messageText: "test",
      tokensBefore: 500,
    });
    const { result, getApiKeyAndHeadersMock } = await runCompactionScenario(
      sessionManager,
      mockEvent,
      { apiKey: null },
    );

    expect(result).toEqual({ cancel: true });
    expect(getApiKeyAndHeadersMock).not.toHaveBeenCalled();
  });
});

describe("compaction-safeguard double-compaction guard", () => {
  it("writes boundary again on repeated empty preparation (no cancel loop after new assistant message)", async () => {
    const sessionManager = modelSession();

    const mockEvent = createCompactionEvent({
      preparation: {
        messagesToSummarize: [] as AgentMessage[],
        firstKeptEntryId: "entry-3",
        tokensBefore: 1000,
      },
    });
    const { result: result1 } = await runCompactionScenario(sessionManager, mockEvent, {
      apiKey: "sk-test",
    });
    const compaction1 = expectCompactionResult(result1);
    expect(compaction1.summary).toContain("## Decisions");
    expect(compaction1.summary).toContain("No prior history.");

    mockEvent.preparation.previousSummary = "## Decisions\nUsed approach A.";
    const { result: result2 } = await runCompactionScenario(sessionManager, mockEvent, {
      apiKey: "sk-test",
    });
    const compaction2 = expectCompactionResult(result2);
    expect(compaction2.summary).toContain("## Decisions");
    expect(compaction2.summary).toContain("Used approach A.");
    expect(compaction2.firstKeptEntryId).toBe("entry-3");
  });

  it("does not write boundary when visible custom turn-prefix content is real conversation", async () => {
    const model = createAnthropicModelFixture();
    const sessionManager = configuredSession({ model });

    const mockEvent = createCompactionEvent({
      preparation: {
        messagesToSummarize: [] as AgentMessage[],
        turnPrefixMessages: [
          {
            role: "custom" as const,
            customType: "cron-request",
            content: "prepare the daily report",
            display: true,
            timestamp: 1,
          },
          {
            role: "assistant" as const,
            content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
            timestamp: 2,
          },
          toolResultMessage("call-1", "report source data", { timestamp: 3 }),
        ] as AgentMessage[],
        firstKeptEntryId: "entry-5",
        tokensBefore: 38085,
        isSplitTurn: true,
      },
    });
    const { result, getApiKeyAndHeadersMock } = await runCompactionScenario(
      sessionManager,
      mockEvent,
      { apiKey: null },
    );

    expect(result).toEqual({ cancel: true });
    expect(getApiKeyAndHeadersMock).toHaveBeenCalledWith(model);
  });

  it("summarizes only the prepared tool-only window when the context anchors it", async () => {
    mockSummarizeInStages.mockResolvedValue("tool window summary");

    const now = Date.now();
    const sessionManager = {
      ...stubSessionManager(),
      getBranch: () => [
        {
          type: "message",
          id: "old-user",
          parentId: null,
          timestamp: new Date(now).toISOString(),
          message: userMessage("old request behind reset", now),
        },
        {
          type: "message",
          id: "old-assistant",
          parentId: "old-user",
          timestamp: new Date(now + 1).toISOString(),
          message: {
            role: "assistant",
            content: [{ type: "text", text: "old reply behind reset" }],
            timestamp: now + 1,
          },
        },
        {
          type: "reset",
          id: "reset-1",
          parentId: "old-assistant",
          timestamp: new Date(now + 2).toISOString(),
          reason: "new",
          firstKeptEntryId: "old-assistant",
        },
        {
          type: "compaction",
          id: "compaction-1",
          parentId: "reset-1",
          timestamp: new Date(now + 3).toISOString(),
          summary: "## Decisions\nUser asked for the deploy status.",
          firstKeptEntryId: "compaction-1",
          tokensBefore: 90_000,
          fromHook: true,
        },
      ],
    } as ExtensionContext["sessionManager"];
    const model = createAnthropicModelFixture();
    setCompactionSafeguardRuntime(sessionManager, { model, recentTurnsPreserve: 0 });

    const toolOnlyWindow = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "exec", arguments: {} }],
        timestamp: now + 4,
      },
      toolResultMessage("call-1", "deploy green", { toolName: "exec", timestamp: now + 5 }),
    ] as AgentMessage[];
    const mockEvent = createCompactionEvent({
      preparation: {
        messagesToSummarize: toolOnlyWindow,
        firstKeptEntryId: "entry-6",
        tokensBefore: 38085,
      },
    });
    const { result } = await runCompactionScenario(sessionManager, mockEvent);

    const compaction = expectCompactionResult(result);
    expect(compaction.summary).toContain("tool window summary");
    expect(mockSummarizeInStages).toHaveBeenCalledTimes(1);
    const summarizeCall = requireRecord(mockCallArg(mockSummarizeInStages));
    const messages = requireArray(summarizeCall.messages);
    expect(messages.map((message) => requireRecord(message).role)).toEqual([
      "assistant",
      "toolResult",
    ]);
    expect(JSON.stringify(messages)).not.toContain("behind reset");
  });

  it("recovers real conversation the preparation omitted from its boundary-scoped range", async () => {
    mockSummarizeInStages.mockResolvedValue("range summary");

    const now = Date.now();
    const entry = (id: string, parentId: string | null, offset: number, message: AgentMessage) => ({
      type: "message",
      id,
      parentId,
      timestamp: new Date(now + offset).toISOString(),
      message: { ...message, timestamp: now + offset },
    });
    const omittedUser = { role: "user", content: "verify the deploy status now" } as AgentMessage;
    const toolCallAssistant = {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "exec", arguments: {} }],
    } as AgentMessage;
    const toolResult = {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "exec",
      content: [{ type: "text", text: "deploy green" }],
    } as AgentMessage;
    const sessionManager = {
      ...stubSessionManager(),
      getBranch: () => [
        entry("old-user", null, 0, {
          role: "user",
          content: "old request behind reset",
        } as AgentMessage),
        {
          type: "reset",
          id: "reset-1",
          parentId: "old-user",
          timestamp: new Date(now + 1).toISOString(),
          reason: "new",
          firstKeptEntryId: "reset-1",
        },
        entry("omitted-user", "reset-1", 2, omittedUser),
        entry("assistant-1", "omitted-user", 3, toolCallAssistant),
        entry("tool-1", "assistant-1", 4, toolResult),
        entry("kept-user", "tool-1", 5, { role: "user", content: "and then?" } as AgentMessage),
      ],
    } as ExtensionContext["sessionManager"];
    const model = createAnthropicModelFixture();
    setCompactionSafeguardRuntime(sessionManager, { model, recentTurnsPreserve: 0 });
    const mockEvent = createCompactionEvent({
      preparation: {
        messagesToSummarize: [toolCallAssistant, toolResult],
        firstKeptEntryId: "kept-user",
        tokensBefore: 38085,
      },
    });
    const { result } = await runCompactionScenario(sessionManager, mockEvent);

    expect(expectCompactionResult(result).summary).toContain("range summary");
    expect(mockSummarizeInStages).toHaveBeenCalledTimes(1);
    const summarizeCall = requireRecord(mockCallArg(mockSummarizeInStages));
    const messages = requireArray(summarizeCall.messages);
    expect(messages.map((message) => requireRecord(message).role)).toEqual([
      "user",
      "assistant",
      "toolResult",
    ]);
    const serialized = JSON.stringify(messages);
    expect(serialized).toContain("verify the deploy status now");
    expect(serialized).not.toContain("behind reset");
    expect(serialized).not.toContain("and then?");
  });

  it("writes the anti-loop boundary for a tool-only window when nothing anchors it", async () => {
    const sessionManager = modelSession();

    const mockEvent = createCompactionEvent({
      preparation: {
        messagesToSummarize: [
          toolResultMessage("call-1", "heartbeat probe ok", {
            toolName: "exec",
            timestamp: Date.now(),
          }),
        ] as AgentMessage[],
      },
    });
    const { result, getApiKeyAndHeadersMock } = await runCompactionScenario(
      sessionManager,
      mockEvent,
    );

    const compaction = expectCompactionResult(result);
    expect(compaction.summary).toContain("No prior history.");
    expect(mockSummarizeInStages).not.toHaveBeenCalled();
    expect(getApiKeyAndHeadersMock).not.toHaveBeenCalled();
  });
});

async function expectWorkspaceSummaryEmptyForAgentsAlias(
  createAlias: (outsidePath: string, agentsPath: string) => void,
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-compaction-summary-"));
  const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(root);
  try {
    const outside = path.join(root, "outside-secret.txt");
    fs.writeFileSync(outside, "secret");
    createAlias(outside, path.join(root, "AGENTS.md"));
    await expect(readWorkspaceContextForSummary(["Session Startup", "Red Lines"])).resolves.toBe(
      "",
    );
  } finally {
    cwdSpy.mockRestore();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("readWorkspaceContextForSummary", () => {
  async function withWorkspaceSummary(
    content: string,
    sectionNames: string[] | undefined,
  ): Promise<string> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-compaction-summary-"));
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(root);
    try {
      fs.writeFileSync(path.join(root, "AGENTS.md"), content);
      return await readWorkspaceContextForSummary(sectionNames);
    } finally {
      cwdSpy.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  it("returns empty when post-compaction sections are explicitly disabled", async () => {
    const result = await withWorkspaceSummary("## Session Startup\n\nRead AGENTS.md\n", []);

    expect(result).toBe("");
  });

  it("returns empty when AGENTS.md exceeds the workspace bootstrap limit", async () => {
    const result = await withWorkspaceSummary(
      `## Session Startup\n\n${"x".repeat(MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES)}`,
      ["Session Startup"],
    );

    expect(result).toBe("");
  });

  it("reads AGENTS.md at the workspace bootstrap limit", async () => {
    const heading = "## Session Startup\n\n";
    const prefix = heading + "x".repeat(1_999 - heading.length);
    const bounded = `${prefix}🚀tail\n`;
    const result = await withWorkspaceSummary(
      bounded + "x".repeat(MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES - Buffer.byteLength(bounded)),
      ["Session Startup"],
    );

    expect(result).toContain("<workspace-critical-rules>");
    expect(result).toContain(`${prefix}\n...[truncated]...`);
  });

  it("reads workspace context from the configured workspace instead of process cwd", async () => {
    const processRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-compaction-cwd-"));
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-compaction-workspace-"));
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(processRoot);
    try {
      fs.writeFileSync(
        path.join(processRoot, "AGENTS.md"),
        "## Session Startup\n\nWrong cwd rules.\n",
      );
      fs.writeFileSync(
        path.join(workspaceRoot, "AGENTS.md"),
        "## Session Startup\n\nUse the run workspace rules.\n\n## Other\nIgnore me.\n",
      );

      const result = await readWorkspaceContextForSummary(["Session Startup"], workspaceRoot);

      expect(result).toContain("Use the run workspace rules.");
      expect(result).not.toContain("Wrong cwd rules.");
      expect(result).not.toContain("Ignore me.");
      expect(result).toContain("<workspace-critical-rules>");
    } finally {
      cwdSpy.mockRestore();
      fs.rmSync(processRoot, { recursive: true, force: true });
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("preserves legacy fallback only for the explicit default section pair", async () => {
    const result = await withWorkspaceSummary(
      "## Every Session\n\nDo startup things.\n\n## Safety\n\nBe safe.\n",
      ["Red Lines", "Session Startup"],
    );

    expect(result).toContain("Do startup things");
    expect(result).toContain("Be safe");
  });

  it.runIf(process.platform !== "win32")(
    "returns empty when AGENTS.md is a symlink escape",
    async () => {
      await expectWorkspaceSummaryEmptyForAgentsAlias((outside, agentsPath) => {
        fs.symlinkSync(outside, agentsPath);
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "returns empty when AGENTS.md is a hardlink alias",
    async () => {
      await expectWorkspaceSummaryEmptyForAgentsAlias((outside, agentsPath) => {
        fs.linkSync(outside, agentsPath);
      });
    },
  );
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
