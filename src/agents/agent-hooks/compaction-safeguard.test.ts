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
  return (
    budgetCompactionSummary(body, { text: suffix, contextRanges: [] }, maxChars) as {
      summary: string;
    }
  ).summary;
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
  const acceptedDetails = jsonResult({
    status: "accepted",
    childSessionKey: "agent:watcher:subagent:abc",
    runId: "run-123",
    mode: "run",
  }).details;
  const failure = (id: string, text: string, details?: unknown, toolName = "exec") =>
    toolResultMessage(id, text, { toolName, isError: true, details });
  it.each([
    {
      name: "accepted spawn exclusion and look-alike failures",
      messages: [
        failure("call-spawn-accepted", "accepted", acceptedDetails, "sessions_spawn"),
        failure("call-exec-failed", "boom", { status: "failed", exitCode: 1 }),
        failure("call-spawn-error", "spawn rejected", { status: "error" }, "sessions_spawn"),
        failure("call-other-lookalike", "real failure", acceptedDetails, "some_other_tool"),
      ],
      ids: ["call-exec-failed", "call-spawn-error", "call-other-lookalike"],
      expected: ["exec (status=failed exitCode=1): boom"],
      firstSummary: undefined,
    },
    {
      name: "deduplication and empty output",
      messages: [
        {
          role: "toolResult" as const,
          toolCallId: "call-1",
          toolName: "exec",
          isError: true,
          details: { exitCode: 2 },
          content: [],
          timestamp: 1,
        },
        failure("call-1", "ignored"),
      ],
      ids: ["call-1"],
      expected: ["exec (exitCode=2): failed"],
      firstSummary: undefined,
    },
    {
      name: "bounded failure counts and UTF-16 summaries",
      messages: Array.from({ length: 9 }, (_, idx) =>
        failure(`call-${idx}`, `${"x".repeat(236)}🚀tail-${idx}`),
      ),
      ids: Array.from({ length: 9 }, (_, idx) => `call-${idx}`),
      expected: ["## Tool Failures", "...and 1 more"],
      firstSummary: `${"x".repeat(236)}...`,
    },
  ])("formats tool failures with $name", ({ messages, ids, expected, firstSummary }) => {
    const failures = collectToolFailures(messages);
    expect(failures.map((entry: { toolCallId: string }) => entry.toolCallId)).toEqual(ids);
    const section = formatToolFailuresSection(failures);
    for (const text of expected) {
      expect(section).toContain(text);
    }
    if (firstSummary !== undefined) {
      expect(failures[0]?.summary).toBe(firstSummary);
    }
  });
});

describe("compaction-safeguard summary budgets", () => {
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
      budgetCompactionSummary(body, { text: "", contextRanges: [] }, 1_000, {
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
      budgetCompactionSummary(String(first.summary), { text: "", contextRanges: [] }, 700, {
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

  it.each([false, true])("consumes cancellation provenance once (replaced=%s)", (replaced) => {
    const sm = {};
    const error = Object.assign(new Error("provider unavailable"), { status: 503 });
    if (!replaced) {
      setCompactionSafeguardRuntime(sm, { maxHistoryShare: 0.6 });
    }
    setCompactionSafeguardCancellation(sm, "summarization failed", error);
    if (replaced) {
      setCompactionSafeguardCancellation(sm, "quality guard declined");
    }
    expect(consumeCompactionSafeguardCancellation(sm)).toEqual(
      replaced
        ? { reason: "quality guard declined" }
        : {
            reason: "summarization failed",
            error: expect.objectContaining({ message: "provider unavailable", status: 503 }),
          },
    );
    expect(consumeCompactionSafeguardCancellation(sm)).toBeNull();
    expect(getCompactionSafeguardRuntime(sm)).toEqual(replaced ? null : { maxHistoryShare: 0.6 });
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
  it.each([
    {
      name: "paired recent tool results",
      messages: [
        userMessage("older ask", 1),
        toolCallMessage("call_old", "read", 2),
        toolResultMessage("call_old", "old result", { timestamp: 3 }),
        userMessage("recent ask", 4),
        toolCallMessage("call_recent", "read", 5),
        toolResultMessage("call_recent", "recent result", { timestamp: 6 }),
        castAgentMessage(timestampedTextAssistant("recent final answer", 7)),
      ],
      recentTurnsPreserve: 1,
      user: "recent ask",
      roles: ["user", "assistant", "toolResult", "assistant"],
    },
    {
      name: "bounded tail below the user-turn target",
      messages: [
        userMessage("single user prompt", 1),
        ...Array.from({ length: 8 }, (_, i) =>
          castAgentMessage(timestampedTextAssistant(`assistant-${i + 1}`, i + 2)),
        ),
      ],
      recentTurnsPreserve: 3,
      user: "single user prompt",
      roles: undefined,
    },
  ])("preserves $name", ({ messages, recentTurnsPreserve, user, roles }) => {
    const split = splitPreservedRecentTurns({ messages, recentTurnsPreserve });
    expect(split.preservedMessages).toContainEqual(
      expect.objectContaining({ role: "user", content: user }),
    );
    if (roles) {
      expect(split.preservedMessages.map((msg: AgentMessage) => msg.role)).toEqual(roles);
      const resultIds = split.summarizableMessages
        .filter((msg: AgentMessage) => msg.role === "toolResult")
        .map((msg: Extract<AgentMessage, { role: "toolResult" }>) => msg.toolCallId);
      expect(resultIds).toContain("call_old");
      expect(resultIds).not.toContain("call_recent");
    } else {
      expect(split.preservedMessages).toHaveLength(6);
      expect(preservedTurnsText(split.preservedMessages)).toContain("assistant-8");
      expect(preservedTurnsText(split.preservedMessages)).not.toContain("assistant-2");
    }
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

  it.each([
    {
      name: "mixed-content placeholders",
      message: castAgentMessage({
        role: "user",
        content: [
          { type: "text", text: "caption text" },
          { type: "image", data: "abc", mimeType: "image/png" },
        ],
        timestamp: 1,
      }),
      expected: ["- User: caption text", "[non-text content: image]"],
    },
    {
      name: "UTF-16-safe truncation",
      message: userMessage(`${"x".repeat(599)}🚀tail`, 1),
      expected: [`- User: ${"x".repeat(599)}...`],
    },
  ])("renders preserved messages with $name", ({ message, expected }) => {
    const section = preservedTurnsText([message]);
    for (const text of expected) {
      expect(section).toContain(text);
    }
  });

  const uniqueIdentifierTail = Array.from(
    { length: 12 },
    (_, idx) => `b${idx.toString(16).padStart(7, "0")}`,
  );
  it.each([
    {
      name: "case-normalized identifiers",
      input:
        "Track id a1b2c3d4e5f6 plus A1B2C3D4E5F6 and URL https://example.com/a and /tmp/x.log plus port host.local:18789",
      expected: [
        "A1B2C3D4E5F6", // pragma: allowlist secret
        "https://example.com/a",
        "/tmp/x.log",
        "host.local:18789",
      ],
    },
    {
      name: "host/ports after a long token",
      input: `${"x".repeat(120_000)} host.local:18789 api.example.com/v1:443 127.0.0.1:8080 sub-domain.example.test:65535`,
      expected: [
        "host.local:18789",
        "api.example.com/v1:443",
        "127.0.0.1:8080",
        "sub-domain.example.test:65535",
      ],
    },
    {
      name: "deduplication before capping",
      input: `${Array.from({ length: 10 }, () => "a0b0c0d0").join(" ")} ${uniqueIdentifierTail.join(" ")}`,
      expected: undefined,
    },
    {
      name: "decimal and scientific values",
      input:
        "metric=0.123456789 scientific=1.23456789e10 exponent=1e-987654321 order_id=246813579 hash=deadbeef1234 ambiguous=12345678e10",
      expected: ["246813579", "DEADBEEF1234", "12345678E10"], // pragma: allowlist secret
    },
  ])("extracts $name", ({ name, input, expected }) => {
    const identifiers = extractOpaqueIdentifiers(input);
    if (expected) {
      expect(identifiers).toStrictEqual(expected);
    } else {
      expect(identifiers).toHaveLength(12);
      expect(new Set(identifiers).size).toBe(12);
      expect(identifiers).toContain("A0B0C0D0");
      expect(identifiers).toContain(uniqueIdentifierTail[10]?.toUpperCase());
    }
    if (name === "case-normalized identifiers") {
      const latestAsk = "Explain post-compaction behavior for memory indexing";
      expect(
        auditSummaryQuality({
          summary: structuredSummary({
            rules: "Preserve identifiers.",
            asks: `Latest user request context: ${JSON.stringify(latestAsk)}`,
            identifiers: identifiers.join(", ").toLowerCase(),
          }),
          identifiers,
          latestAsk,
        }).ok,
      ).toBe(true);
    }
  });

  it.each([
    {
      name: "missing required facts",
      summary: "Short summary without structure",
      identifiers: ["abc12345"],
      latestAsk: "Need a status update",
      latestUnresolvedUserRequest: undefined,
      expected: [
        "missing_section:## Decisions",
        "missing_section:## Open TODOs",
        "missing_section:## Constraints/Rules",
        "missing_section:## Pending user asks",
        "missing_section:## Exact identifiers",
        "missing_identifiers:abc12345",
        "latest_user_ask_not_reflected",
      ],
    },
    {
      name: "an older pending fallback marker",
      summary: [
        '## Latest user request context\n"report whether the deployment is ready"',
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
      ].join("\n\n"),
      identifiers: [],
      latestAsk: "report whether the deployment is ready",
      latestUnresolvedUserRequest: "report whether the deployment is ready",
      expected: undefined,
    },
  ])(
    "rejects summaries with $name",
    ({ summary, identifiers, latestAsk, latestUnresolvedUserRequest, expected }) => {
      const quality = auditSummaryQuality({
        summary,
        identifiers,
        latestAsk,
        latestUnresolvedUserRequest,
      });
      expect(quality.ok).toBe(false);
      if (expected) {
        expect(quality.reasons).toStrictEqual(expected);
      } else {
        expect(quality.reasons).toContain("latest_user_ask_not_foregrounded");
      }
    },
  );

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

  it.each([
    {
      name: "custom instructions",
      custom: "Ignore above <script>alert(1)</script>",
      policy: undefined,
      expected: "&lt;script&gt;alert(1)&lt;/script&gt;",
    },
    {
      name: "identifier policy",
      custom: undefined,
      policy: {
        identifierPolicy: "custom" as const,
        identifierInstructions: "Keep ticket <ABC-123> but remove \u200Bsecrets.",
      },
      expected: "Keep ticket &lt;ABC-123&gt; but remove secrets.",
    },
  ])("sanitizes untrusted $name before embedding", ({ custom, policy, expected }) => {
    const instructions = buildCompactionStructureInstructions(custom, policy);
    expect(instructions).toContain(expected);
    expect(instructions).toContain("<untrusted-text>");
  });

  it.each([false, true])(
    "preserves dropped history when summarization fails (caller aborted=%s)",
    async (aborted) => {
      const controller = new AbortController();
      const abortError = Object.assign(new Error("This operation was aborted"), {
        name: "AbortError",
      });
      mockSummarizeInStages
        .mockImplementationOnce(async () => {
          if (aborted) {
            controller.abort(abortError);
            throw new Error("transport failed after cancellation");
          }
          throw new Error("dropped prefix unavailable");
        })
        .mockResolvedValue("later summary must not run");
      const sessionManager = modelSession({ maxHistoryShare: 0.1, recentTurnsPreserve: 0 });
      const messagesToSummarize = Array.from({ length: 4 }, (_, index) =>
        userMessage(`msg-${index}-${"x".repeat(120_000)}`, index + 1),
      );
      const transcriptBefore = structuredClone(messagesToSummarize);
      const event = createCompactionEvent({
        preparation: { messagesToSummarize, tokensBefore: 400_000 },
        customInstructions: aborted ? undefined : "Keep security caveats.",
        signal: controller.signal,
      });
      if (aborted) {
        await expect(runCompactionScenario(sessionManager, event)).rejects.toBe(abortError);
        expect(consumeCompactionSafeguardCancellation(sessionManager)).toBeNull();
      } else {
        const { result } = await runCompactionScenario(sessionManager, event);
        expect(result).toEqual({ cancel: true });
        expect(result).not.toHaveProperty("compaction");
        expect(consumeCompactionSafeguardCancellation(sessionManager)?.reason).toBe(
          "Compaction safeguard could not summarize the session: " +
            "Failed to summarize dropped messages. | dropped prefix unavailable",
        );
      }
      expect(mockSummarizeInStages).toHaveBeenCalledTimes(1);
      expect(messagesToSummarize).toStrictEqual(transcriptBefore);
    },
  );

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

  it.each(["model-output-limit", "copilot-headers", "keyless-sdk-auth"] as const)(
    "summarizes with provider-prepared model settings: %s",
    async (mode) => {
      mockSummarizeInStages.mockResolvedValue("mock summary");
      const model = createAnthropicModelFixture(
        mode === "model-output-limit"
          ? { contextWindow: 1_000_000, maxTokens: 128_000 }
          : mode === "copilot-headers"
            ? {
                id: "gpt-5.4",
                name: "gpt-5.4",
                provider: "github-copilot",
                api: "openai-responses",
                baseUrl: "https://api.githubcopilot.com",
              }
            : { provider: "amazon-bedrock" },
      );
      const sessionManager = configuredSession({ model, recentTurnsPreserve: 0 });
      const headers = {
        "Copilot-Integration-Id": "copilot-developer-cli",
        "Editor-Plugin-Version": "copilot-chat/0.35.0",
        "Openai-Organization": "github-copilot",
        "User-Agent": "GitHubCopilotChat/0.35.0",
        "X-Test": "1",
      };
      const getApiKeyAndHeadersMock = vi.fn().mockResolvedValue(
        mode === "keyless-sdk-auth"
          ? { ok: true }
          : {
              ok: true,
              apiKey: mode === "copilot-headers" ? "github-token" : "test-key",
              ...(mode === "copilot-headers" ? { headers: { ...headers } } : {}),
            },
      );
      const event = createCompactionEvent(
        mode === "model-output-limit"
          ? {
              preparation: {
                messagesToSummarize: [userMessage("large history", 1)],
                tokensBefore: 250_000,
                settings: { reserveTokens: 240_000 },
              },
            }
          : { messageText: "summarize me", tokensBefore: 1000 },
      );
      const result = await createCompactionHandler()(
        event,
        createCompactionContext({ sessionManager, getApiKeyAndHeadersMock }),
      );
      expect(requireRecord(result).cancel).not.toBe(true);
      const call = mockSummarizeInStages.mock.lastCall?.[0];
      if (mode === "model-output-limit") {
        expect(call?.reserveTokens).toBe(128_000);
      } else if (mode === "copilot-headers") {
        for (const [name, value] of Object.entries(headers)) {
          expect(call?.headers?.[name]).toBe(value);
        }
        expect(call?.headers?.["x-initiator"]).toBe("user");
      } else {
        expect(getApiKeyAndHeadersMock).toHaveBeenCalledWith(model);
        expect(mockSummarizeInStages).toHaveBeenCalled();
      }
    },
  );

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

  it.each([200, 400])(
    "caps a re-distilled identifier list with %s entries without starving real sections",
    async (count) => {
      const latestAsk = "preserve the pending deployment status";
      const identifier = "/tmp/source-only-compaction-id.log";
      const hoardedIdentifiers = Array.from(
        { length: count },
        (_, index) => `- /home/vac/clawd/tmp/session-artifacts/run-${index}/output.log`,
      ).join("\n");
      const generatedSummary = structuredSummary({
        decisions:
          "Latest user request status: pending.\nDeployment stays paused until the backup is verified.",
        todos: "Verify the backup.",
        asks: latestAsk,
        identifiers: count === 200 ? `${identifier}\n${hoardedIdentifiers}` : hoardedIdentifiers,
      });
      if (count === 400) {
        expect(generatedSummary.length).toBeGreaterThan(MAX_COMPACTION_SUMMARY_CHARS);
      } else {
        expect(generatedSummary.length).toBeLessThan(MAX_COMPACTION_SUMMARY_CHARS);
      }
      mockSummarizeInStages.mockResolvedValue(generatedSummary);
      const sessionManager = createQualityGuardSessionManager();
      const { result } = await runCompactionScenario(
        sessionManager,
        createCompactionEvent({ messageText: `${latestAsk} ${identifier}` }),
        { latestUnresolvedUserRequest: count === 400 },
      );
      const summary = expectCompactionResult(result).summary;
      expect(summary.length).toBeLessThanOrEqual(MAX_COMPACTION_SUMMARY_CHARS);
      expect(summary).toContain("Deployment stays paused until the backup is verified.");
      expect(summary).toContain(identifier);
      expect(summary).not.toContain(`run-${count - 1}/output.log`);
      if (count === 400) {
        expect(summary).toContain("## Open TODOs\nVerify the backup.");
        expect(summary).toContain(
          `## Pending user asks\nLatest user request context: ${JSON.stringify(`${latestAsk} ${identifier}`)}`,
        );
        expect(summary).toContain("run-0/output.log");
      }
      expect(summary.slice(summary.indexOf("## Exact identifiers")).length).toBeLessThanOrEqual(
        MAX_COMPACTION_SUMMARY_CHARS * 0.25 + 200,
      );
      expect(consumeCompactionSafeguardCancellation(sessionManager)).toBeNull();
    },
  );

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

    const finalized = budgetCompactionSummary(body, { text: "", contextRanges: [] }, maxChars, {
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

  it.each([
    {
      name: "overlapping stale task",
      latestAsk: "delete production only after verified backup",
      decisions:
        "Latest user request status: pending.\ndelete production only after verified backup was reviewed.",
      rules: "Use normal safeguards.",
      asks: "Delete production backup immediately.",
      tokensBefore: undefined,
    },
    {
      name: "model-classified completed work",
      latestAsk: "combine the provider boxes into one completed artifact",
      decisions:
        "Latest user request status: completed.\nThe provider boxes were combined into the final artifact.",
      rules: undefined,
      asks: "Finish the older migration.",
      tokensBefore: 90_000,
    },
  ])(
    "foregrounds the owner-provided request before $name",
    async ({ latestAsk, decisions, rules, asks, tokensBefore }) => {
      mockSummarizeInStages.mockResolvedValue(structuredSummary({ decisions, rules, asks }));
      const sessionManager = createQualityGuardSessionManager({ qualityGuardMaxRetries: 0 });
      const { result } = await runCompactionScenario(
        sessionManager,
        createCompactionEvent({ messageText: latestAsk, tokensBefore }),
        { latestUnresolvedUserRequest: true },
      );
      const summary = expectCompactionResult(result).summary;
      expect(summary).toContain(
        `## Pending user asks\nLatest user request context: ${JSON.stringify(latestAsk)}\n${asks}`,
      );
      expect(summary).toContain(`## Decisions\n${decisions.split("\n")[0]}`);
      expect(summary).toContain(asks);
      expect(mockSummarizeInStages).toHaveBeenCalledTimes(1);
      expect(consumeCompactionSafeguardCancellation(sessionManager)).toBeNull();
    },
  );

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

  const completedAsk = "combine the bars into one box per provider";
  const truncatedAsk = `${"x".repeat(610)} report deployment status /tmp/all-preserved-truncated.log`;
  it.each([
    {
      name: "owner request after a completed tool turn",
      messages: [
        userMessage(completedAsk, 1),
        ...Array.from({ length: 12 }, (_, index) => [
          toolCallMessage(`call_${index}`, "exec", 2 + index * 2),
          toolResultMessage(`call_${index}`, "output ".repeat(200), {
            toolName: "exec",
            timestamp: 3 + index * 2,
          }),
        ]).flat(),
        castAgentMessage({
          role: "assistant",
          content: [{ type: "text", text: "The provider boxes are combined." }],
          stopReason: "stop",
          timestamp: 100,
        }),
      ],
      tokensBefore: 90_000,
      ownerRequest: true,
      expected: [
        completedAsk,
        `## Pending user asks\nLatest user request context: ${JSON.stringify(completedAsk)}`,
      ],
      absent: [],
      audit: undefined,
    },
    {
      name: "numeric tool noise",
      messages: [
        userMessage("report metric status", 1),
        toolCallMessage("call_metric", "read", 2),
        toolResultMessage(
          "call_metric",
          `${"x".repeat(610)} metric=0.123456789 negative=12345678e-987654321 positive=12345678e+987654321 latency=0.123456789seconds size=1.23456789e-987654321megabytes metric=12345678.e10`,
          { timestamp: 3 },
        ),
        castAgentMessage(timestampedTextAssistant("metric checked", 4)),
      ],
      tokensBefore: undefined,
      ownerRequest: false,
      expected: ["report metric status"],
      absent: ["123456789", "23456789e", "987654321", "12345678"],
      audit: { identifiers: [], latestAsk: undefined },
    },
    {
      name: "owner facts beyond truncated text",
      messages: [userMessage(truncatedAsk, 1)],
      tokensBefore: undefined,
      ownerRequest: true,
      expected: [
        "report deployment status",
        "/tmp/all-preserved-truncated.log",
        "## Recent turns preserved verbatim",
      ],
      absent: [],
      audit: { identifiers: ["/tmp/all-preserved-truncated.log"], latestAsk: truncatedAsk },
    },
  ])(
    "audits all-preserved turns containing $name without summarization",
    async ({ messages, tokensBefore, ownerRequest, expected, absent, audit }) => {
      const sessionManager = createQualityGuardSessionManager({ recentTurnsPreserve: 12 });
      const { result } = await runCompactionScenario(
        sessionManager,
        createCompactionEvent({ preparation: { messagesToSummarize: messages }, tokensBefore }),
        { latestUnresolvedUserRequest: ownerRequest },
      );
      const summary = expectCompactionResult(result).summary;
      for (const text of expected) {
        expect(summary).toContain(text);
      }
      for (const text of absent) {
        expect(summary).not.toContain(text);
      }
      expect(mockSummarizeInStages).not.toHaveBeenCalled();
      if (audit) {
        expect(mockAuditSummaryQuality).toHaveBeenCalledTimes(1);
        const input = requireRecord(mockCallArg(mockAuditSummaryQuality));
        expect(input.identifiers).toEqual(audit.identifiers);
        if (audit.latestAsk) {
          expect(input.latestAsk).toBe(audit.latestAsk);
          for (const text of expected) {
            expect(input.summary).toContain(text);
          }
          expect(mockAuditSummaryQuality.mock.results[0]?.value).toEqual({ ok: true, reasons: [] });
          expect(consumeCompactionSafeguardCancellation(sessionManager)).toBeNull();
        }
      }
    },
  );

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

  it.each([false, true])(
    "preserves history when corrective generation fails (caller aborted=%s)",
    async (aborted) => {
      const controller = new AbortController();
      const abortError = Object.assign(new Error("corrective compaction aborted"), {
        name: "AbortError",
      });
      const correctiveFailureMarker = "USER_SESSION_TEXT_issue119932_corrective";
      mockSummarizeInStages.mockResolvedValueOnce(
        aborted ? "invalid first attempt" : "history detail ".repeat(MAX_COMPACTION_SUMMARY_CHARS),
      );
      if (!aborted) {
        mockSummarizeInStages.mockResolvedValueOnce(
          "split-turn prefix context that must survive capping",
        );
      }
      mockSummarizeInStages.mockImplementationOnce(async () => {
        if (aborted) {
          controller.abort(abortError);
          throw new Error("transport closed after abort");
        }
        throw new Error(correctiveFailureMarker);
      });
      const sessionManager = createQualityGuardSessionManager(
        aborted ? {} : { recentTurnsPreserve: 1 },
      );
      const event = createCompactionEvent({
        messageText: "report deployment status",
        signal: controller.signal,
        ...(aborted
          ? {}
          : {
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
            }),
      });
      if (aborted) {
        await expect(runCompactionScenario(sessionManager, event)).rejects.toBe(abortError);
        expect(consumeCompactionSafeguardCancellation(sessionManager)).toBeNull();
      } else {
        const { result } = await runCompactionScenario(sessionManager, event);
        expect(result).toEqual({ cancel: true });
        expect(requireRecord(mockCallArg(mockSummarizeInStages, 2)).customInstructions).toContain(
          "Quality check feedback",
        );
        expect(consumeCompactionSafeguardCancellation(sessionManager)?.reason).toBe(
          "Compaction safeguard finalized summary failed quality checks and corrective generation failed.",
        );
        const warnings = compactionLogger.warn.mock.calls.flat().join("\n");
        expect(warnings).toContain("reasonCode=corrective_generation_failed");
        expect(warnings).toContain("attempt=2");
        expect(warnings).not.toContain(correctiveFailureMarker);
      }
      expect(mockSummarizeInStages).toHaveBeenCalledTimes(aborted ? 2 : 3);
    },
  );

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

  it.each([false, true])(
    "handles provider AbortError according to caller cancellation (aborted=%s)",
    async (aborted) => {
      mockSummarizeInStages.mockResolvedValue("llm fallback summary");
      const providerAbortErr = Object.assign(new Error("This operation was aborted"), {
        name: "AbortError",
      });
      installCompactionProviderForTest(
        "aborting-provider",
        vi.fn().mockRejectedValue(providerAbortErr),
      );
      const controller = new AbortController();
      if (aborted) {
        controller.abort();
      }
      const sessionManager = aborted
        ? configuredSession({ provider: "aborting-provider" })
        : modelSession({ provider: "aborting-provider", recentTurnsPreserve: 0 });
      const event = createCompactionEvent({
        preparation: {
          messagesToSummarize: [
            userMessage("older context", 1),
            ...(aborted
              ? []
              : [castAgentMessage({ role: "assistant", content: "older reply", timestamp: 2 })]),
          ],
        },
        signal: controller.signal,
      });
      if (aborted) {
        await expect(
          runCompactionScenario(sessionManager, event, { apiKey: "key" }),
        ).rejects.toMatchObject({ name: "AbortError" });
        expect(mockSummarizeInStages).not.toHaveBeenCalled();
      } else {
        const { result } = await runCompactionScenario(sessionManager, event, { apiKey: "key" });
        expect(result.cancel).not.toBe(true);
        expect(mockSummarizeInStages).toHaveBeenCalled();
      }
    },
  );

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

  it.each([false, true])(
    "summarizes only the boundary-scoped window (recover omitted conversation=%s)",
    async (recover) => {
      mockSummarizeInStages.mockResolvedValue(recover ? "range summary" : "tool window summary");
      const now = Date.now();
      const entry = (
        id: string,
        parentId: string | null,
        offset: number,
        message: AgentMessage,
      ) => ({
        type: "message",
        id,
        parentId,
        timestamp: new Date(now + offset).toISOString(),
        message: { ...message, timestamp: now + offset },
      });
      const toolCall = toolCallMessage("call-1", "exec", now + 4);
      const toolResult = toolResultMessage("call-1", "deploy green", {
        toolName: "exec",
        timestamp: now + 5,
      });
      const oldUser = entry("old-user", null, 0, userMessage("old request behind reset", now));
      const reset = {
        type: "reset",
        id: "reset-1",
        parentId: recover ? "old-user" : "old-assistant",
        timestamp: new Date(now + (recover ? 1 : 2)).toISOString(),
        reason: "new",
        firstKeptEntryId: recover ? "reset-1" : "old-assistant",
      };
      const sessionManager = {
        ...stubSessionManager(),
        getBranch: () =>
          recover
            ? [
                oldUser,
                reset,
                entry(
                  "omitted-user",
                  "reset-1",
                  2,
                  userMessage("verify the deploy status now", now + 2),
                ),
                entry("assistant-1", "omitted-user", 3, toolCall),
                entry("tool-1", "assistant-1", 4, toolResult),
                entry("kept-user", "tool-1", 5, userMessage("and then?", now + 5)),
              ]
            : [
                oldUser,
                entry(
                  "old-assistant",
                  "old-user",
                  1,
                  castAgentMessage(timestampedTextAssistant("old reply behind reset", now + 1)),
                ),
                reset,
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
      setCompactionSafeguardRuntime(sessionManager, {
        model: createAnthropicModelFixture(),
        recentTurnsPreserve: 0,
      });
      const { result } = await runCompactionScenario(
        sessionManager,
        createCompactionEvent({
          preparation: {
            messagesToSummarize: [toolCall, toolResult],
            firstKeptEntryId: recover ? "kept-user" : "entry-6",
            tokensBefore: 38085,
          },
        }),
      );
      expect(expectCompactionResult(result).summary).toContain(
        recover ? "range summary" : "tool window summary",
      );
      expect(mockSummarizeInStages).toHaveBeenCalledTimes(1);
      const messages = requireArray(requireRecord(mockCallArg(mockSummarizeInStages)).messages);
      expect(messages.map((message) => requireRecord(message).role)).toEqual(
        recover ? ["user", "assistant", "toolResult"] : ["assistant", "toolResult"],
      );
      const serialized = JSON.stringify(messages);
      expect(serialized).not.toContain("behind reset");
      if (recover) {
        expect(serialized).toContain("verify the deploy status now");
        expect(serialized).not.toContain("and then?");
      }
    },
  );

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

  const limitPrefix =
    "## Session Startup\n\n" + "x".repeat(1_999 - "## Session Startup\n\n".length);
  const boundedContent = `${limitPrefix}🚀tail\n`;
  it.each([
    {
      name: "disabled sections",
      content: "## Session Startup\n\nRead AGENTS.md\n",
      sections: [],
      expected: [],
    },
    {
      name: "oversized file",
      content: `## Session Startup\n\n${"x".repeat(MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES)}`,
      sections: ["Session Startup"],
      expected: [],
    },
    {
      name: "file at the byte limit",
      content:
        boundedContent +
        "x".repeat(MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES - Buffer.byteLength(boundedContent)),
      sections: ["Session Startup"],
      expected: ["<workspace-critical-rules>", `${limitPrefix}\n...[truncated]...`],
    },
    {
      name: "legacy defaults",
      content: "## Every Session\n\nDo startup things.\n\n## Safety\n\nBe safe.\n",
      sections: ["Red Lines", "Session Startup"],
      expected: ["Do startup things", "Be safe"],
    },
  ])("reads workspace context with $name", async ({ content, sections, expected }) => {
    const result = await withWorkspaceSummary(content, sections);
    if (expected.length === 0) {
      expect(result).toBe("");
    } else {
      for (const text of expected) {
        expect(result).toContain(text);
      }
    }
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

  it.runIf(process.platform !== "win32").each(["symlink", "hardlink"] as const)(
    "returns empty when AGENTS.md is a %s alias",
    async (kind) => {
      await expectWorkspaceSummaryEmptyForAgentsAlias((outside, agentsPath) => {
        if (kind === "symlink") {
          fs.symlinkSync(outside, agentsPath);
        } else {
          fs.linkSync(outside, agentsPath);
        }
      });
    },
  );
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
