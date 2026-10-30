import type { AgentMessage, StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { ExtensionContext } from "openclaw/plugin-sdk/agent-sessions";
import { createAssistantMessageEventStream, type AssistantMessage } from "openclaw/plugin-sdk/llm";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CompactionProvider } from "../../plugins/compaction-provider.js";
import {
  requireActivePluginRegistry,
  resetPluginRuntimeStateForTest,
} from "../../plugins/runtime.js";
import * as compactionModule from "../compaction.js";
import {
  castAgentMessage,
  makeAgentAssistantMessage,
} from "../test-helpers/agent-message-fixtures.js";
import { timestampedTextAssistant } from "../test-helpers/sparse-transcript.test-support.js";
import { createZeroUsageFixture } from "../test-helpers/usage-fixtures.js";
import { auditSummaryQuality as audit } from "./compaction-safeguard-quality.js";
import {
  consumeCompactionSafeguardCancellation as consumeCancellation,
  getCompactionSafeguardRuntime as getRuntime,
  setCompactionSafeguardCancellation as setCancellation,
  setCompactionSafeguardRuntime as setRuntime,
} from "./compaction-safeguard-runtime.js";
import {
  testing,
  structuredSummary,
  stubSessionManager,
  createAnthropicModelFixture as anthropicModel,
  configuredSession,
  modelSession,
  toolResultMessage,
  userMessage,
  toolCallMessage,
  createQualityGuardSessionManager as qualitySession,
  createCompactionEvent as compactionEvent,
  runCompactionScenario as runCompaction,
  expectCompactionResult,
} from "./compaction-safeguard.test-support.js";

const { log } = await vi.hoisted(async () => {
  const { createMockSubsystemLogger } =
    await import("../../../test/helpers/mock-subsystem-logger.js");
  return { log: vi.mocked(createMockSubsystemLogger("compaction-safeguard"), true) };
});

vi.mock("../../logging/subsystem.js", async () => {
  const actual = await vi.importActual<typeof import("../../logging/subsystem.js")>(
    "../../logging/subsystem.js",
  );
  return { ...actual, createSubsystemLogger: () => log };
});

const summarize = vi.fn(compactionModule.summarizeCompactionHistory);

const {
  splitPreservedRecentTurns,
  buildPreservedTurnsSection,
  resolveRecentTurnsPreserve,
  resolveQualityGuardMaxRetries,
  extractOpaqueIdentifiers,
  capCompactionSummary,
  budgetCompactionSummary,
  MAX_COMPACTION_SUMMARY_CHARS: SUMMARY_LIMIT,
  SUMMARY_TRUNCATED_MARKER,
  CONTEXT_TRUNCATED_MARKER,
} = testing;

function auditSummaryQuality(params: Omit<Parameters<typeof audit>[0], "structuralSummary">) {
  return audit({ ...params, structuralSummary: params.summary });
}

beforeEach(() => {
  summarize.mockReset();
  testing.setSummarizeCompactionHistoryForTest(summarize);
  log.warn.mockClear();
});

afterEach(() => {
  testing.setSummarizeCompactionHistoryForTest();
  resetPluginRuntimeStateForTest();
});

function installCompactionProviderForTest(
  id: string,
  providerSummarize: CompactionProvider["summarize"],
): void {
  requireActivePluginRegistry().compactionProviders.push({
    provider: { id, label: id, summarize: providerSummarize },
  });
}

const CANONICAL_SUMMARY_HEADINGS = [
  "## Decisions",
  "## Open TODOs",
  "## Constraints/Rules",
  "## Pending user asks",
  "## Exact identifiers",
] as const;

function expectCanonicalHeadings(summary: string): void {
  for (const heading of CANONICAL_SUMMARY_HEADINGS) {
    expect(summary.split("\n").filter((line) => line.trim() === heading)).toHaveLength(1);
  }
}

function mockCallArg<T>(
  mock: { mock: { calls: ReadonlyArray<readonly [T, ...unknown[]]> } },
  callIndex = 0,
): T {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected mock call ${callIndex + 1}`);
  }
  return call[0];
}

const requireRecord = createRequireRecord("object", "expected-record");
const runtimeContext = castAgentMessage({
  role: "custom",
  customType: "openclaw.runtime-context",
  content: "secret runtime context",
  display: false,
  timestamp: 1.5,
});

function historyEvent(
  messagesToSummarize: AgentMessage[],
  preparation: NonNullable<Parameters<typeof compactionEvent>[0]>["preparation"] = {},
) {
  return compactionEvent({ preparation: { messagesToSummarize, ...preparation } });
}

function textReply(text: string, timestamp: number): AgentMessage {
  return castAgentMessage(timestampedTextAssistant(text, timestamp));
}

function toolTurn(id: string, ask: string, output: string, timestamp: number, toolName = "read") {
  return [
    userMessage(ask, timestamp),
    toolCallMessage(id, toolName, timestamp + 1),
    toolResultMessage(id, output, { toolName, timestamp: timestamp + 2 }),
  ];
}

function recentConversation(latestAsk = "latest ask status"): AgentMessage[] {
  return [
    userMessage("older context", 1),
    runtimeContext,
    castAgentMessage({ role: "assistant", content: "older reply", timestamp: 2 }),
    userMessage(latestAsk, 3),
    textReply("latest assistant reply", 4),
  ];
}

async function runSummary(...args: Parameters<typeof runCompaction>) {
  const run = await runCompaction(...args);
  return { ...run, ...expectCompactionResult(run.result) };
}

function providerSession(id: string, body: string, recentTurnsPreserve = 0) {
  installCompactionProviderForTest(id, vi.fn().mockResolvedValue(body));
  return configuredSession({ provider: id, recentTurnsPreserve });
}

function expectPendingAsk(summary: string, ask: string) {
  expect(summary).toContain(
    `## Pending user asks\nLatest user request context: ${JSON.stringify(ask)}`,
  );
}

function summaryStream(
  model: ReturnType<typeof anthropicModel>,
  outcome: { error: string } | { text: string },
) {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = makeAgentAssistantMessage({
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: createZeroUsageFixture(),
    timestamp: 1,
    ...("text" in outcome
      ? { content: [{ type: "text" as const, text: outcome.text }], stopReason: "stop" as const }
      : { content: [], stopReason: "error" as const, errorMessage: outcome.error }),
  });
  stream.push(
    "text" in outcome
      ? { type: "done", reason: "stop", message }
      : { type: "error", reason: "error", error: message },
  );
  stream.end();
  return stream;
}

it("sends distinct history and split-turn summary formats", async () => {
  testing.setSummarizeCompactionHistoryForTest(compactionModule.summarizeCompactionHistory);
  const model = anthropicModel({
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
    return summaryStream(model, { text: "provider summary" });
  };
  const event = {
    ...historyEvent([], {
      turnPrefixMessages: [userMessage("summarize me: receipt_90210", Date.now())],
      tokensBefore: 1_000,
      isSplitTurn: true,
    }),
    customInstructions: "Keep the deployment decision.",
    thinkingLevel: "high" as const,
    streamFn,
  };
  const { summary } = await runSummary(sessionManager, event);
  expect(summary).toContain("provider summary");
  expect(summary).not.toContain("Earlier deployment decision");
  expect(providerPrompts).toHaveLength(2);
  expect(providerPrompts[0]).toContain("[User]: summarize me");
  expect(providerPrompts[0]).toContain("receipt_90210");
  expect(providerPrompts[0]).toContain("Keep the deployment decision.");
  expect(providerPrompts[0]).toContain("Preserve all opaque identifiers exactly");
  expect(providerPrompts[0]).not.toContain("## Goal");
  expect(providerPrompts[0]).not.toContain("## Constraints & Preferences");
  expect(providerPrompts[0]).toContain("## Pending user asks");
  expect(providerPrompts[0]).not.toContain("## Original Request");
  expect(providerPrompts[1]).toContain("## Original Request");
  expect(providerPrompts[1]).not.toContain("## Pending user asks");
  expect(providerBudgets).toEqual([3_200, 2_000]);
});

it("uses truncation markers when the budget exactly fits only the marker", () => {
  expect(capCompactionSummary("oversized".repeat(10), SUMMARY_TRUNCATED_MARKER.length)).toBe(
    SUMMARY_TRUNCATED_MARKER,
  );
  const suffix = { text: "oversized suffix".repeat(10), contextRanges: [] };
  const capped = requireRecord(
    budgetCompactionSummary("", suffix, CONTEXT_TRUNCATED_MARKER.length),
  );
  expect(capped.summary).toBe(CONTEXT_TRUNCATED_MARKER);
});

it("ignores non-object session managers", () => {
  setRuntime(null, { recentTurnsPreserve: 2 });
  expect(getRuntime(null)).toBeNull();
});
it("replaces cancellation provenance and consumes it once", () => {
  const sm = {};
  const error = Object.assign(new Error("provider unavailable"), { status: 503 });
  setCancellation(sm, "summarization failed", error);
  setCancellation(sm, "quality guard declined");
  expect(consumeCancellation(sm)).toEqual({ reason: "quality guard declined" });
  expect(consumeCancellation(sm)).toBeNull();
  expect(getRuntime(sm)).toEqual(null);
});
it("clamps oversized runtime values when config validation is bypassed", () => {
  expect(resolveQualityGuardMaxRetries(99)).toBe(3);
  expect(resolveRecentTurnsPreserve(99)).toBe(12);
});

it("preserves paired recent tool results", () => {
  const older = toolTurn("old", "older ask", "old result", 1);
  const recent = [
    ...toolTurn("recent", "recent ask", "recent result", 4),
    textReply("recent final answer", 7),
  ];
  expect(
    splitPreservedRecentTurns({ messages: [...older, ...recent], recentTurnsPreserve: 1 }),
  ).toEqual({ summarizableMessages: older, preservedMessages: recent });
});
it("preserves a bounded tail below the user-turn target", () => {
  const split = splitPreservedRecentTurns({
    messages: [
      userMessage("single user prompt", 1),
      ...Array.from({ length: 8 }, (_, i) => textReply(`assistant-${i + 1}`, i + 2)),
    ],
    recentTurnsPreserve: 3,
  });
  expect(split.preservedMessages).toContainEqual(
    expect.objectContaining({ role: "user", content: "single user prompt" }),
  );
  expect(split.preservedMessages).toHaveLength(6);
  const text = requireRecord(buildPreservedTurnsSection(split.preservedMessages)).text;
  expect(text).toContain("assistant-8");
  expect(text).not.toContain("assistant-2");
});
it("extracts case-normalized identifiers", () => {
  const identifiers = extractOpaqueIdentifiers(
    "a1b2c3d4e5f6 A1B2C3D4E5F6 https://example.com/a /tmp/x.log host.local:18789",
  );
  expect(identifiers).toStrictEqual([
    "A1B2C3D4E5F6", // pragma: allowlist secret
    "https://example.com/a",
    "/tmp/x.log",
    "host.local:18789",
  ]);
  const latestAsk = "Explain post-compaction behavior for memory indexing";
  expect(
    auditSummaryQuality({
      summary: structuredSummary({
        asks: `Latest user request context: ${JSON.stringify(latestAsk)}`,
        identifiers: identifiers.join(", ").toLowerCase(),
      }),
      identifiers,
      latestAsk,
    }).ok,
  ).toBe(true);
});
it("rejects summaries with an older pending fallback marker", () => {
  const latestAsk = "report deployment readiness";
  const quality = auditSummaryQuality({
    summary:
      `## Latest user request context\n"${latestAsk}"\n\n` +
      structuredSummary({ asks: "Latest user request context:\narchive old notes" }),
    identifiers: [],
    latestAsk,
    latestUnresolvedUserRequest: latestAsk,
  });
  expect(quality.ok).toBe(false);
  expect(quality.reasons).toContain("latest_user_ask_not_foregrounded");
});
it("does not enforce identifier retention when policy is off", async () => {
  summarize.mockResolvedValue(
    structuredSummary({
      asks: `Latest user request context: ${JSON.stringify("Provide status.")}`,
      identifiers: "Redacted.",
    }),
  );
  const session = qualitySession({ identifierPolicy: "off" });
  const event = historyEvent([
    userMessage("sensitive-token-123456", 1),
    userMessage("Provide status.", 2),
  ]);
  const { summary } = await runSummary(session, event);
  expect(summary).not.toContain("sensitive-token-123456");
  const instructions = requireRecord(mockCallArg(summarize).summaryPrompt).instructions;
  expect(instructions).toContain("do not enforce literal-preservation rules");
  expect(instructions).not.toContain("preserve literal values exactly as seen");
});
it.each(["cap-staged-limit", "copilot-headers", "keyless-sdk-auth"] as const)(
  "summarizes with provider-prepared model settings: %s",
  async (mode) => {
    summarize.mockResolvedValue("mock summary");
    const model = anthropicModel(
      mode === "cap-staged-limit"
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
    const session = configuredSession({ model, recentTurnsPreserve: 0 });
    const headers = { "Copilot-Integration-Id": "copilot-developer-cli", "X-Test": "1" };
    const capped = mode === "cap-staged-limit";
    const event = historyEvent([userMessage(capped ? "large history" : "summarize me", 1)], {
      tokensBefore: capped ? 250_000 : 1000,
      ...(capped ? { settings: { reserveTokens: 80_000 } } : {}),
    });
    const { result, getApiKeyAndHeadersMock } = await runCompaction(session, event, {
      auth: {
        ok: true,
        ...(mode === "keyless-sdk-auth" ? {} : { apiKey: "test-key" }),
        ...(mode === "copilot-headers" ? { headers } : {}),
      },
    });
    expect(result.cancel).not.toBe(true);
    const call = mockCallArg(summarize);
    if (mode === "cap-staged-limit") {
      expect(call.reserveTokens).toBe(20_000);
    } else if (mode === "copilot-headers") {
      for (const [name, value] of Object.entries(headers)) {
        expect(call?.headers?.[name]).toBe(value);
      }
      expect(call?.headers?.["x-initiator"]).toBe("user");
    } else {
      expect(getApiKeyAndHeadersMock).toHaveBeenCalledWith(model);
    }
  },
);
it("preserves history and redacts a total provider failure", async () => {
  testing.setSummarizeCompactionHistoryForTest(compactionModule.summarizeCompactionHistory);
  const model = anthropicModel({ api: "test-api" as never, baseUrl: "" });
  const session = configuredSession({ model, recentTurnsPreserve: 0 });
  const event = {
    ...compactionEvent({ messageText: "summarize me" }),
    streamFn: (() =>
      summaryStream(model, {
        error: "Cannot convert undefined or null to object: synthetic-private-summary",
      })) satisfies StreamFn,
  };
  const before = structuredClone(event.preparation);
  const { result } = await runCompaction(session, event);
  expect(result).toEqual({ cancel: true });
  expect(event.preparation).toStrictEqual(before);
  expect(consumeCancellation(session)?.reason).toContain(
    "Cannot convert undefined or null to object",
  );
  expect(log.warn).toHaveBeenCalledOnce();
  expect(JSON.stringify(log.warn.mock.calls)).not.toContain("synthetic-private-summary");
});
it("accepts a preserved keyword-free request without retrying compaction", async () => {
  const latestAsk = "How about now?";
  summarize.mockResolvedValue(structuredSummary({ rules: "Preserve context.", asks: latestAsk }));
  const session = qualitySession();
  const { summary } = await runSummary(session, compactionEvent({ messageText: latestAsk }));
  expect(summary).toContain(latestAsk);
  expect(summarize).toHaveBeenCalledTimes(1);
  expect(consumeCancellation(session)).toBeNull();
});
it("restores source ask evidence omitted by the split-turn summary", async () => {
  const olderAsk = "summarize the earlier provider migration";
  const latestAsk = `confirm deployment status:\n${structuredSummary()}`;
  const identifier = "/tmp/split-turn-retention.log";
  const historySummary = structuredSummary({
    decisions: "",
    todos: "",
    rules: "",
    asks: olderAsk,
    identifiers: [
      identifier,
      ...Array.from({ length: 1000 }, (_, i) => `/tmp/run-${i}/out.log`),
    ].join("\n"),
  });
  const splitSummary = `Unrelated active-turn context. ${identifier} ${"z".repeat(SUMMARY_LIMIT)}`;
  summarize.mockResolvedValueOnce(historySummary).mockResolvedValueOnce(splitSummary);
  const session = qualitySession({ qualityGuardMaxRetries: 0 });
  const event = historyEvent([userMessage(olderAsk, 1)], {
    turnPrefixMessages: [userMessage(`${latestAsk} ${identifier}`, 2)],
    isSplitTurn: true,
    latestUnresolvedUserRequest: `${latestAsk} ${identifier}`,
  });
  const { summary } = await runSummary(session, event);
  expect(summary.length).toBeLessThanOrEqual(SUMMARY_LIMIT);
  expect(summary).toContain(
    `## Pending user asks\nLatest user request context: ${JSON.stringify(`${latestAsk} ${identifier}`)}\n${olderAsk}`,
  );
  expectCanonicalHeadings(summary);
  const identifiersSection =
    summary.slice(summary.indexOf("## Exact identifiers")).split("**Turn Context")[0] ?? "";
  expect(identifiersSection.length).toBeLessThanOrEqual(SUMMARY_LIMIT * 0.25 + 100);
  const request = `${latestAsk} ${identifier}`;
  const capped = requireRecord(
    budgetCompactionSummary(summary, { text: "", contextRanges: [] }, 700, {
      identifiers: [identifier],
      latestAsk: request,
      latestUnresolvedUserRequest: request,
      requiredAskContext: request,
      identifierPolicy: "strict",
    }),
  );
  expect(String(capped.summary)).toContain(identifier);
  expectPendingAsk(String(capped.summary), request);
});
it.each([false, true])("audits preserved numeric tool output (owner request=%s)", async (owned) => {
  const ask = "combine the bars into one box per provider";
  const output = `${"x".repeat(610)} metric=0.123456789 negative=12345678e-987654321 positive=12345678e+987654321 latency=0.123456789seconds size=1.23456789e-987654321megabytes metric=12345678.e10`;
  const messages = [
    userMessage(ask, 1),
    ...Array.from({ length: owned ? 12 : 1 }, (_, index) => [
      toolCallMessage(`call_${index}`, "exec", 2 + index * 2),
      toolResultMessage(`call_${index}`, output, { toolName: "exec", timestamp: 3 + index * 2 }),
    ]).flat(),
    castAgentMessage({
      ...timestampedTextAssistant("The provider boxes are combined.", 100),
      stopReason: "stop",
    }),
  ];
  const { summary } = await runSummary(
    qualitySession({ recentTurnsPreserve: 12 }),
    historyEvent(messages, {
      tokensBefore: 90_000,
      ...(owned ? { latestUnresolvedUserRequest: ask } : {}),
    }),
  );
  expect(summary).toContain(ask);
  expect(summarize).not.toHaveBeenCalled();
  if (owned) {
    expectPendingAsk(summary, ask);
  }
  for (const value of ["123456789", "23456789e", "987654321", "12345678"]) {
    expect(summary).not.toContain(value);
  }
  expect(extractOpaqueIdentifiers(JSON.stringify(messages))).toEqual([]);
});
it.each([false, true])(
  "recovers earlier summary after corrective failure unless caller aborted (%s)",
  async (aborted) => {
    const controller = new AbortController();
    const abortError = Object.assign(new Error("corrective compaction aborted"), {
      name: "AbortError",
    });
    const correctiveFailureMarker = "USER_SESSION_TEXT_issue119932_corrective";
    summarize.mockResolvedValueOnce(
      aborted ? "invalid first attempt" : "history detail ".repeat(SUMMARY_LIMIT),
    );
    summarize.mockResolvedValueOnce("split-turn prefix context that must survive capping");
    summarize.mockImplementationOnce(async () => {
      if (aborted) {
        controller.abort(abortError);
        throw new Error("transport closed after abort");
      }
      throw new Error(correctiveFailureMarker);
    });
    const session = qualitySession({ recentTurnsPreserve: 1 });
    const event = compactionEvent({
      messageText: "report deployment status",
      signal: controller.signal,
      preparation: {
        messagesToSummarize: recentConversation(),
        turnPrefixMessages: [userMessage("prefix request that was split out", 0)],
        isSplitTurn: true,
      },
    });
    if (aborted) {
      const before = structuredClone(event.preparation.messagesToSummarize);
      await expect(runCompaction(session, event)).rejects.toBe(abortError);
      expect(event.preparation.messagesToSummarize).toStrictEqual(before);
      expect(consumeCancellation(session)).toBeNull();
    } else {
      const { result } = await runCompaction(session, event);
      expect(result).toMatchObject({ compaction: { details: { qualityDegraded: true } } });
      expect(expectCompactionResult(result).summary).toContain("history detail");
      expect(consumeCancellation(session)).toBeNull();
      const warnings = log.warn.mock.calls.map(([message]) => message).join("\n");
      expect(warnings).toContain("reasonCode=quality_guard_degraded_fallback");
      expect(warnings).toContain("attempt=2");
      expect(warnings).not.toContain(correctiveFailureMarker);
    }
    expect(summarize).toHaveBeenCalledTimes(3);
  },
);
it("retries when generated summary misses headings even if preserved turns contain them", async () => {
  const preservedUserText =
    "latest ask status\n" +
    structuredSummary({
      asks: "latest ask status",
      identifiers: "/tmp/preserved-turn-bypass.log",
    });
  summarize.mockResolvedValueOnce("invalid generated body").mockResolvedValueOnce(
    structuredSummary({
      asks: "latest ask status",
      identifiers: "/tmp/preserved-turn-bypass.log",
    }),
  );
  const session = qualitySession({ recentTurnsPreserve: 1 });
  const event = historyEvent([
    userMessage("older context", 1),
    runtimeContext,
    castAgentMessage({ role: "assistant", content: "older reply", timestamp: 2 }),
    userMessage(preservedUserText, 3),
  ]);
  const { summary } = await runSummary(session, event);
  expect(summarize).toHaveBeenCalledTimes(2);
  expect(summary).toContain("## Decisions");
});
it("normalizes legacy split-turn headings before re-distilling preserved history", async () => {
  summarize.mockResolvedValue(
    structuredSummary({
      decisions: "Keep the existing architecture.",
      identifiers: "/tmp/migration.log /tmp/latest.log",
    }),
  );
  const session = modelSession({ recentTurnsPreserve: 12 });
  const previousSummary = structuredSummary({
    decisions: "Keep the existing architecture.",
    identifiers:
      "/tmp/migration.log\n\n**Turn Context (split turn):**\n\n" +
      structuredSummary({
        decisions: "Inspect the latest result.",
        identifiers: "/tmp/latest.log",
      }) +
      "\n\n## Recent turns preserved verbatim\n[User] continue",
  });
  const event = historyEvent(
    [userMessage("latest user ask", 1), textReply("latest assistant reply", 2)],
    { previousSummary },
  );
  const { summary } = await runSummary(session, event);
  const summarizedHistory = mockCallArg(summarize).previousSummary;
  expect(summarizedHistory).toContain("### Decisions\nInspect the latest result.");
  expectCanonicalHeadings(summarizedHistory ?? "");
  expectCanonicalHeadings(summary);
  expect(summary).toContain("## Recent turns preserved verbatim");
  expect(summary).toContain("/tmp/migration.log");
  expect(summary).toContain("/tmp/latest.log");
});
it.each([false, true])(
  "handles provider AbortError according to caller cancellation (aborted=%s)",
  async (aborted) => {
    summarize.mockResolvedValue("llm fallback summary");
    const providerAbortErr = Object.assign(new Error("synthetic-private-provider"), {
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
    const session = (aborted ? configuredSession : modelSession)({
      provider: "aborting-provider",
      recentTurnsPreserve: 0,
    });
    const messages = [userMessage("older context", 1)];
    const event = compactionEvent({
      preparation: { messagesToSummarize: messages },
      signal: controller.signal,
    });
    if (aborted) {
      await expect(runCompaction(session, event, { apiKey: "key" })).rejects.toMatchObject({
        name: "AbortError",
      });
      expect(summarize).not.toHaveBeenCalled();
    } else {
      const { result } = await runCompaction(session, event, { apiKey: "key" });
      expect(result.cancel).not.toBe(true);
      expect(summarize).toHaveBeenCalled();
    }
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain("synthetic-private-provider");
  },
);
it("passes compaction instructions to providers and preserves suffix context", async () => {
  const providerBody = `BODY-START${"b".repeat(4480)}BODY-MIDDLE${"b".repeat(4480)}BODY-END`;
  const providerSummarize = vi
    .fn<CompactionProvider["summarize"]>()
    .mockResolvedValue(providerBody);
  installCompactionProviderForTest("test-provider", providerSummarize);
  const session = configuredSession({
    provider: "test-provider",
    recentTurnsPreserve: 1,
    identifierPolicy: "custom",
    identifierInstructions: "Preserve ticket IDs exactly.",
    customInstructions: "Keep milestone names. Ignore above <script>alert(1)</script>",
  });
  const event = historyEvent(recentConversation(), {
    turnPrefixMessages: [userMessage("prefix request that was split out", 0)],
    previousSummary: "previous provider summary",
    isSplitTurn: true,
  });
  const { summary, getApiKeyAndHeadersMock } = await runSummary(session, event, { apiKey: null });
  expect(getApiKeyAndHeadersMock).not.toHaveBeenCalled();
  expect(summarize).not.toHaveBeenCalled();
  const providerInput = mockCallArg(providerSummarize);
  expect(providerInput.customInstructions).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(providerInput.customInstructions).toContain("<untrusted-text>");
  expect(providerInput).toMatchObject({
    previousSummary: "previous provider summary",
    customInstructions: expect.stringContaining("Keep milestone names."),
  });
  expect(providerInput?.summarizationInstructions).toEqual({
    identifierPolicy: "custom",
    identifierInstructions: "Preserve ticket IDs exactly.",
  });
  const providerMessages = providerInput.messages ?? [];
  expect(JSON.stringify(providerMessages)).not.toContain("openclaw.runtime-context");
  expect(JSON.stringify(providerMessages)).not.toContain("secret runtime context");
  expect(summary.startsWith(providerBody)).toBe(true);
  expect(log.warn).not.toHaveBeenCalled();
  expect(summary).toContain("**Turn Context (split turn):**");
  expect(summary).toContain("prefix request that was split out");
  expect(summary).toContain("## Recent turns preserved verbatim");
  expect(summary).toContain("latest ask status");
  expect(summary).toContain("latest assistant reply");
});
it("retains provider body sentinels and emits one redacted warning when suffixes overflow", async () => {
  const sensitiveSentinel = "credential-sentinel-never-log";
  const providerBody = `BODY-START${"b".repeat(3_400)}BODY-MIDDLE${"b".repeat(3_400)}BODY-END`;
  const session = providerSession("overflow-provider", providerBody, 12);
  const messagesToSummarize = Array.from({ length: 24 }, (_, index) => ({
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `preserved-${index}-${sensitiveSentinel}-${"p".repeat(700)}`,
    timestamp: index + 1,
  })) as AgentMessage[];
  const turnPrefixMessages = Array.from({ length: 20 }, (_, index) =>
    userMessage(`raw-prefix-${index}-${sensitiveSentinel}-${"r".repeat(700)}`, index + 100),
  );
  const event = historyEvent(
    [...messagesToSummarize, toolResultMessage("failed-call", "failed", { isError: true })],
    { turnPrefixMessages, tokensBefore: 20_000, isSplitTurn: true },
  );
  Object.assign(event.preparation.fileOps, { read: ["foo.ts"] });
  const { summary } = await runSummary(session, event, { apiKey: null });
  expect(summary).toContain("## Tool Failures\n- read: failed");
  expect(summary).toContain("<read-files>\nfoo.ts\n</read-files>");
  expect(summary.length).toBeLessThanOrEqual(SUMMARY_LIMIT);
  expect(summary).toContain("BODY-START");
  expect(summary).toContain("BODY-MIDDLE");
  expect(summary).toContain("BODY-END");
  expect(summary).toContain(CONTEXT_TRUNCATED_MARKER.trim());
  expect(log.warn).toHaveBeenCalledOnce();
  const warning = log.warn.mock.calls[0]?.[0] ?? "";
  expect(warning).not.toContain(sensitiveSentinel);
});
it("finally trims a raw tool interaction only at its atomic boundary", async () => {
  const session = providerSession(
    "tool-boundary-provider",
    `BODY-START${"b".repeat(9_000)}BODY-END`,
    3,
  );
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
    castAgentMessage({ role: "assistant" as const, content: toolCalls, timestamp: 101 }),
    ...toolCalls.map((toolCall, index) =>
      toolResultMessage(toolCall.id, `finalizer-tool-output-${index}-${"r".repeat(600)}`, {
        timestamp: index + 102,
      }),
    ),
    textReply("raw terminal answer survives", 114),
  ];
  const event = historyEvent(messagesToSummarize, {
    turnPrefixMessages,
    tokensBefore: 20_000,
    isSplitTurn: true,
  });
  const { summary } = await runSummary(session, event, { apiKey: null });
  expect(summary.length).toBeLessThanOrEqual(SUMMARY_LIMIT);
  expect(summary).toContain("raw terminal answer survives");
  expect(summary).not.toContain("finalizer-tool-output-");
  expect(summary).not.toContain("- Tool result (read):");
  expect(summary).toContain("## Recent turns preserved verbatim");
});

it("cancels compaction when both ctx.model and runtime.model are undefined", async () => {
  const { result, getApiKeyAndHeadersMock } = await runCompaction(
    stubSessionManager(),
    compactionEvent({ messageText: "test", tokensBefore: 500 }),
    { apiKey: null },
  );
  expect(result).toEqual({ cancel: true });
  expect(getApiKeyAndHeadersMock).not.toHaveBeenCalled();
});

it("writes boundary again on repeated empty preparation (no cancel loop after new assistant message)", async () => {
  const session = modelSession();
  const mockEvent = historyEvent([], { firstKeptEntryId: "entry-3", tokensBefore: 1000 });
  const first = await runSummary(session, mockEvent);
  expect(first.summary).toContain("## Decisions");
  expect(first.summary).toContain("No prior history.");
  mockEvent.preparation.previousSummary = "## Decisions\nUsed approach A.";
  const second = await runSummary(session, mockEvent);
  expect(second.summary).toContain("## Decisions");
  expect(second.summary).toContain("Used approach A.");
  expect(second.firstKeptEntryId).toBe("entry-3");
});
it("does not write boundary when visible custom turn-prefix content is real conversation", async () => {
  const model = anthropicModel();
  const session = configuredSession({ model });
  const mockEvent = historyEvent([], {
    turnPrefixMessages: [
      castAgentMessage({
        role: "custom",
        customType: "cron-request",
        content: "prepare the daily report",
        display: true,
        timestamp: 1,
      }),
      toolCallMessage("call-1", "read", 2),
      toolResultMessage("call-1", "report source data", { timestamp: 3 }),
    ],
    firstKeptEntryId: "entry-5",
    tokensBefore: 38085,
    isSplitTurn: true,
  });
  const { result, getApiKeyAndHeadersMock } = await runCompaction(session, mockEvent, {
    apiKey: null,
  });
  expect(result).toEqual({ cancel: true });
  expect(getApiKeyAndHeadersMock).toHaveBeenCalledWith(model);
});
it.each([false, true])(
  "summarizes only the boundary-scoped window (recover omitted conversation=%s)",
  async (recover) => {
    summarize.mockResolvedValue(recover ? "range summary" : "tool window summary");
    const now = Date.now();
    const entry = (id: string, message: AgentMessage) => ({
      type: "message" as const,
      id,
      message,
    });
    const toolCall = toolCallMessage("call-1", "exec", now + 4);
    const toolResult = toolResultMessage("call-1", "deploy green", {
      toolName: "exec",
      timestamp: now + 5,
    });
    const oldUser = entry("old-user", userMessage("old request behind reset", now));
    const reset = {
      type: "reset",
      id: "reset-1",
      reason: "new",
      firstKeptEntryId: recover ? "reset-1" : "old-assistant",
    };
    const branch = (
      recover
        ? [
            oldUser,
            reset,
            entry("omitted-user", userMessage("verify the deploy status now", now + 2)),
            entry("assistant-1", toolCall),
            entry("tool-1", toolResult),
            entry("kept-user", userMessage("and then?", now + 5)),
          ]
        : [
            oldUser,
            entry("old-assistant", textReply("old reply behind reset", now + 1)),
            reset,
            {
              type: "compaction",
              id: "compaction-1",
              summary: "## Decisions\nUser asked for the deploy status.",
              firstKeptEntryId: "compaction-1",
              tokensBefore: 90_000,
              fromHook: true,
            },
          ]
    ).map((item, index, entries) =>
      Object.assign(item, {
        parentId: entries[index - 1]?.id ?? null,
        timestamp: new Date(now + index).toISOString(),
        ...("message" in item ? { message: { ...item.message, timestamp: now + index } } : {}),
      }),
    );
    const session = Object.assign(modelSession({ recentTurnsPreserve: 0 }), {
      getBranch: () => branch,
    }) as ExtensionContext["sessionManager"];
    const { summary } = await runSummary(
      session,
      historyEvent([toolCall, toolResult], {
        firstKeptEntryId: recover ? "kept-user" : "entry-6",
        tokensBefore: 38085,
      }),
    );
    expect(summary).toContain(recover ? "range summary" : "tool window summary");
    const messages = mockCallArg(summarize).messages;
    expect(messages.map((message) => message.role)).toEqual(
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
