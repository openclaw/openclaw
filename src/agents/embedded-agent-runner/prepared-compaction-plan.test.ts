import { expect, it, vi } from "vitest";
import { prepareCompactionFloor } from "../../../packages/agent-core/src/harness/compaction/compaction-floor.js";
import { compactWithoutSummary } from "../../../packages/agent-core/src/harness/compaction/compaction.js";
import {
  collectConversationMessageFact,
  collectConversationRangeDescriptors,
  MAX_SUMMARY_INPUT_CHARS,
  renderConversationEntriesWithinBudget,
  serializeConversationEntry,
  serializeConversationWithinBudget,
} from "../../../packages/agent-core/src/harness/compaction/utils.js";
import { convertToLlm } from "../../../packages/agent-core/src/harness/messages.js";
import type { AgentMessage } from "../../../packages/agent-core/src/types.js";
import {
  prepareCompactionSafeguardHistory,
  prepareCompactionSafeguardMessages,
  prepareCompactionSafeguardSections,
  prepareCompactionSafeguardSummary,
} from "../agent-hooks/compaction-safeguard-preparation.js";
import { sanitizeCompactionMessages } from "../compaction-planning.js";
import { prepareAgentCompactionWork } from "../sessions/compaction/preparation.js";
import * as requestBudget from "../sessions/compaction/request-budget.js";
import type { SessionEntry } from "../sessions/session-manager-types.js";
import {
  collectPreparedCompactionEntryFact,
  readPreparedCompactionMessage,
  prepareCompactionPlan as prepareFacts,
} from "./prepared-compaction-plan.js";
import type { PreparedCompactionPlanOptions } from "./prepared-compaction-plan.types.js";

function prepareCompactionPlan(
  entries: SessionEntry[],
  sequences: ReadonlyMap<string, number>,
  options: PreparedCompactionPlanOptions,
) {
  const rows = new Map(entries.map((entry) => [sequences.get(entry.id)!, entry]));
  return prepareFacts(
    entries.map((entry) => collectPreparedCompactionEntryFact(entry, sequences.get(entry.id)!)),
    options,
    { readEntry: (seq) => rows.get(seq)! },
  );
}

const options = {
  work: {
    itemId: "compaction",
    mode: "manual" as const,
    summaryOutputPolicy: "none" as const,
    settings: { enabled: true, reserveTokens: 1000, keepRecentTokens: 1 },
  },
  qualityGuardEnabled: true,
};

it("keeps long row-number selections separate from bounded textual facts", () => {
  const entries: SessionEntry[] = Array.from({ length: 20_000 }, (_, index) => ({
    type: "message",
    id: "entry-" + index,
    parentId: index ? "entry-" + (index - 1) : null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content: "Request " + index, timestamp: index },
  }));
  const sequences = new Map(entries.map((entry, index) => [entry.id, 1_000_000_000 + index]));
  const result = prepareCompactionPlan(entries, sequences, options);
  if (result.status !== "prepared") {
    throw new Error(
      "Long native rows lost their private preparation eligibility: " + result.reason,
    );
  }
  expect(result.plan.selections.history.map((entry) => entry.source)).toEqual(
    Array.from({ length: 19_999 }, (_, index) => 1_000_000_000 + index),
  );
  expect(result.plan.retainedSequences).toEqual([1_000_019_999]);
  expect(JSON.stringify(result.plan).length).toBeGreaterThan(MAX_SUMMARY_INPUT_CHARS);
  expect(result.plan.floor.userLines.join("").length).toBeLessThan(8000);
});

it("records equal projected wrappers from their distinct source rows", () => {
  const entries: SessionEntry[] = [
    {
      type: "custom_message",
      id: "custom",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      customType: "fixture",
      content: "Visible custom input",
      display: true,
    },
    {
      type: "custom_message",
      id: "custom-twin",
      parentId: "custom",
      timestamp: "2026-01-01T00:00:00.000Z",
      customType: "fixture",
      content: "Visible custom input",
      display: true,
    },
    {
      type: "message",
      id: "request",
      parentId: "custom-twin",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: "Current request", timestamp: 1 },
    },
  ];
  const result = prepareCompactionPlan(
    entries,
    new Map(entries.map((entry, index) => [entry.id, 40 + index])),
    options,
  );
  expect(result.status).toBe("prepared");
  if (result.status !== "prepared") {
    throw new Error("Custom message lost its recorded projection source");
  }
  expect(result.plan.selections.history.map((entry) => entry.source)).toEqual([40, 41]);
});

it.each([false, true])(
  "only calculates the consumed replay fallback (foreground budget=%s)",
  (budgeted) => {
    const entries: SessionEntry[] = [
      {
        type: "message",
        id: "past",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: "Earlier request", timestamp: 1 },
      },
      {
        type: "message",
        id: "retained",
        parentId: "past",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: "Current request", timestamp: 2 },
      },
    ];
    const replay = vi.spyOn(requestBudget, "replayTokenBudget");
    try {
      const result = prepareCompactionPlan(
        entries,
        new Map(entries.map((entry, index) => [entry.id, index])),
        {
          ...options,
          work: {
            ...options.work,
            ...(budgeted
              ? {
                  contextWindow: 32_000,
                  requestBudget: requestBudget.createCompactionRequestBudget({
                    contextWindow: 32_000,
                    reserveTokens: 1000,
                    systemPrompt: "",
                    tools: [],
                  }),
                }
              : {}),
          },
        },
      );
      if (result.status !== "prepared") {
        throw new Error(
          "Replay budget fixture lost its real compaction preparation: " + result.reason,
        );
      }
      expect(result.plan.preparation.summaryTokenBudget !== undefined).toBe(budgeted);
      expect(replay).toHaveBeenCalledTimes(budgeted ? 0 : 1);
      if (budgeted) {
        expect(result.plan.summaryReplayTokenBudget).toBeUndefined();
      }
    } finally {
      replay.mockRestore();
    }
  },
);

it("reduces exact raw summary policy without rereading removed payloads or clipping the ask", () => {
  const ask = `Please retain the whole ask ${"context ".repeat(25_000)}exact ending`;
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const assistant = (
    content: Extract<AgentMessage, { role: "assistant" }>["content"],
  ): AgentMessage => ({
    role: "assistant",
    content,
    api: "test",
    provider: "test",
    model: "test",
    stopReason: "stop",
    usage,
    timestamp: 0,
  });
  const messages: AgentMessage[] = [
    { role: "user", content: "Inspect /tmp/first.txt #195361", timestamp: 0 },
    assistant([
      {
        type: "toolCall",
        id: "repeat",
        name: "write",
        arguments: { path: "/tmp/first.txt", body: "opaque-arguments-".repeat(1000) },
      },
    ]),
    {
      role: "toolResult",
      toolCallId: "repeat",
      toolName: "write",
      content: [{ type: "text", text: "no change" }],
      details: { changed: false },
      isError: true,
      timestamp: 0,
    },
    assistant([
      { type: "toolCall", id: "repeat", name: "read", arguments: { path: "/tmp/second.txt" } },
    ]),
    {
      role: "toolResult",
      toolCallId: "repeat",
      toolName: "read",
      content: [
        { type: "text", text: "opaque-result-".repeat(1000) },
        { type: "image", data: "image-payload", mimeType: "image/png" },
      ],
      details: { secret: "opaque-details" },
      isError: false,
      timestamp: 0,
    },
    { role: "user", content: ask, timestamp: 0 },
    { role: "user", content: "Retained request", timestamp: 0 },
  ];
  const entries: SessionEntry[] = messages.map((message, index) => ({
    type: "message",
    id: `e${index}`,
    parentId: index ? `e${index - 1}` : null,
    timestamp: new Date(0).toISOString(),
    message,
  }));
  const facts = entries.map((entry, index) => collectPreparedCompactionEntryFact(entry, index));
  expect(JSON.stringify(facts)).not.toContain("opaque-arguments-".repeat(100));
  expect(JSON.stringify(facts)).not.toContain("opaque-result-".repeat(100));
  expect(JSON.stringify(facts)).not.toContain("opaque-details");
  const readEntry = vi.fn((seq: number) => {
    expect(seq).toBe(5);
    return entries[seq]!;
  });
  const result = prepareFacts(facts, options, { readEntry });
  expect(result.status).toBe("prepared");
  if (result.status !== "prepared") {
    throw new Error("No native plan");
  }
  const work = prepareAgentCompactionWork(entries, options.work);
  if (work.status !== "prepared") {
    throw new Error("No array plan");
  }
  const history = prepareCompactionSafeguardHistory({
    messages: prepareCompactionSafeguardMessages(work.preparation),
    firstKeptEntryId: work.preparation.firstKeptEntryId,
    readBranch: () => entries,
  });
  const summary = prepareCompactionSafeguardSummary({
    history,
    preparation: work.preparation,
    splitTurnContextChars: 8000,
    qualityGuardEnabled: true,
  });
  expect(result.plan.facts.summary.latestUserAsk).toBe(ask);
  expect(result.plan.facts.summary).toEqual({
    latestUserAsk: summary.latestUserAsk,
    latestAskInRetainedTurn: summary.latestAskInRetainedTurn,
    identifiers: summary.identifiers,
    requiredAskContext: summary.requiredAskContext,
    preservedTurnsSection: summary.preservedTurnsSection,
  });
  expect(result.plan.facts.sections).toEqual(
    prepareCompactionSafeguardSections({ fileOps: work.preparation.fileOps, history }),
  );
  expect(result.plan.floor).toEqual(
    prepareCompactionFloor([
      ...work.preparation.messagesToSummarize,
      ...work.preparation.turnPrefixMessages,
    ]),
  );
  const deterministic = compactWithoutSummary(work.preparation);
  expect(deterministic.ok && deterministic.value).toEqual(result.plan.deterministic);
  expect(result.plan.selections.history).toEqual(
    collectConversationRangeDescriptors(
      summary.reconciliationMessages.flatMap((message) =>
        convertToLlm(sanitizeCompactionMessages([message])).map((projected) =>
          collectConversationMessageFact(projected, messages.indexOf(message)),
        ),
      ),
    ),
  );
  expect(result.plan.retainedSequences).toEqual([6]);
  expect(readEntry).toHaveBeenCalledTimes(2);
});

const identity = (id: string) => ({ id, parentId: null, timestamp: new Date(0).toISOString() });
const userEntry = (id: string, content: string): Extract<SessionEntry, { type: "message" }> => ({
  ...identity(id),
  type: "message",
  message: { role: "user", content, timestamp: 0 },
});

it.each(
  ["placed", "after-prior", "before-prior", "unplaced", "reset"].flatMap((variant) =>
    [0, 3].map((recentTurnsPreserve) => ({ variant, recentTurnsPreserve })),
  ),
)(
  "renders the same canonical context fallback as the array owner ($variant, preserve=$recentTurnsPreserve)",
  ({ variant, recentTurnsPreserve }) => {
    const backgroundMessage: Extract<AgentMessage, { role: "assistant" }> & {
      excludeFromContext: true;
      openclawModelPlacement: "pending";
    } = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Background result complete: keep this finding.",
        },
      ],
      api: "test",
      provider: "openclaw",
      model: "automation-result",
      stopReason: "stop",
      timestamp: 0,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      excludeFromContext: true,
      openclawModelPlacement: "pending",
    };
    const pending: SessionEntry = {
      ...identity("pending"),
      type: "message",
      message: backgroundMessage,
    };
    const placement: SessionEntry = {
      ...identity("placed"),
      type: "custom",
      customType: "openclaw.background-result-placement",
      data: { afterEntryId: "pending", resultEntryIds: ["pending"] },
    };
    const tool: SessionEntry = {
      ...identity("tool"),
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "x",
        toolName: "read",
        content: [{ type: "text", text: "data" }],
        timestamp: 0,
        isError: false,
      },
    };
    const prior: SessionEntry = {
      ...identity("prior"),
      type: "compaction",
      firstKeptEntryId: variant === "before-prior" ? "pending" : "earlier-tool",
      summary: "Prior accepted work",
      tokensBefore: 1000,
      fromHook: true,
    };
    const hiddenMessage: Extract<AgentMessage, { role: "user" }> & { excludeFromContext: true } = {
      role: "user",
      content: "Previously retained ask",
      timestamp: 0,
      excludeFromContext: true,
    };
    const prefix: SessionEntry[] =
      variant === "reset"
        ? [
            {
              ...userEntry("hidden", "Previously retained ask"),
              message: hiddenMessage,
            },
            { ...identity("reset"), type: "reset", reason: "new", firstKeptEntryId: "hidden" },
          ]
        : variant === "after-prior"
          ? [{ ...tool, id: "earlier-tool" }, prior, pending, placement]
          : variant === "before-prior"
            ? [pending, prior, placement]
            : variant === "unplaced"
              ? [pending]
              : [pending, placement];
    const entries = [...prefix, tool, userEntry("latest", "Latest request")];
    for (const [index, entry] of entries.entries()) {
      entry.parentId = entries[index - 1]?.id ?? null;
    }
    const localOptions = {
      ...options,
      recentTurnsPreserve,
      work: { ...options.work, settings: { ...options.work.settings, keepRecentTokens: 0 } },
    };
    const array = prepareAgentCompactionWork(entries, localOptions.work);
    const native = prepareFacts(
      entries.map((entry, index) => collectPreparedCompactionEntryFact(entry, index)),
      localOptions,
      {
        readEntry: (seq) => entries[seq]!,
      },
    );
    if (array.status !== "prepared" || native.status !== "prepared") {
      throw new Error("Expected prepared projections");
    }
    const history = prepareCompactionSafeguardHistory({
      messages: prepareCompactionSafeguardMessages(array.preparation),
      firstKeptEntryId: array.preparation.firstKeptEntryId,
      readBranch: () => entries,
    });
    const summary = prepareCompactionSafeguardSummary({
      history,
      preparation: array.preparation,
      recentTurnsPreserve,
      qualityGuardEnabled: true,
      splitTurnContextChars: 8000,
    });
    expect(native.plan.facts.history).toEqual({
      hasRealConversation: history.hasRealConversation,
      usedPreparationRange: history.usedPreparationRange,
    });
    expect(native.plan.facts.reconciliationCount).toBe(summary.reconciliationMessages.length);
    expect(native.plan.facts.summary.preservedTurnsSection).toEqual(summary.preservedTurnsSection);
    const expected = convertToLlm(sanitizeCompactionMessages(summary.reconciliationMessages));
    for (const maxChars of [40, 4000]) {
      const rendered = renderConversationEntriesWithinBudget(
        native.plan.selections.history,
        maxChars,
        (descriptor, textVariant) => {
          const message = readPreparedCompactionMessage(descriptor.source, (seq) => entries[seq]!);
          const projected = message && convertToLlm(sanitizeCompactionMessages([message]))[0];
          if (!projected) {
            throw new Error("Missing projected message");
          }
          return serializeConversationEntry(projected, descriptor, textVariant);
        },
      );
      expect(rendered).toEqual(serializeConversationWithinBudget(expected, maxChars));
      if (
        maxChars === 4000 &&
        (variant === "placed"
          ? recentTurnsPreserve === 0
          : ["after-prior", "before-prior"].includes(variant))
      ) {
        expect(rendered.text).toContain("Background result complete");
      }
    }
  },
);

it.each(["active", "empty-tools", "no-tools", "model-change"])(
  "budgets the latest sent tool checkpoint, including retirement (%s)",
  (variant) => {
    const tools = [
      {
        name: "prior_tool",
        description: "retained tool wording ".repeat(1200),
        parameters: { type: "object", properties: {} },
      },
    ];
    const pin: SessionEntry = {
      ...identity("pin"),
      type: "custom",
      customType: "openclaw.system-prompt",
      data: { tools },
    };
    const retirement: SessionEntry[] =
      variant === "active"
        ? []
        : variant === "model-change"
          ? [
              {
                ...identity("retire"),
                type: "model_change",
                provider: "test",
                modelId: "new-model",
              },
            ]
          : [
              {
                ...identity("retire"),
                type: "custom",
                customType: "openclaw.system-prompt",
                data: variant === "empty-tools" ? { tools: [] } : { restart: true },
              },
            ];
    const obsoleteMalformedPin: SessionEntry = {
      ...identity("obsolete-pin"),
      type: "custom",
      customType: "openclaw.system-prompt",
      data: { tools: [null] },
    };
    const entries = [
      userEntry("old", "Older work"),
      obsoleteMalformedPin,
      pin,
      ...retirement,
      userEntry("new", "Latest ask"),
    ];
    for (const maxSummaryChars of [16000, 20000]) {
      const work = {
        ...options.work,
        contextWindow: 16000,
        systemPrompt: "system",
        tools: [],
        settings: { ...options.work.settings, maxSummaryChars },
      };
      const expectedBudget = requestBudget.createStandaloneCompactionRequestBudget({
        maxSummaryChars,
        contextWindow: work.contextWindow,
        reserveTokens: work.settings.reserveTokens,
        systemPrompt: work.systemPrompt,
        tools: variant === "active" ? tools : [],
      });
      const native = prepareFacts(
        entries.map((entry, index) => collectPreparedCompactionEntryFact(entry, index)),
        { ...options, work },
        { readEntry: (seq) => entries[seq]! },
      );
      const array = prepareAgentCompactionWork(entries, {
        ...work,
        tools: variant === "active" ? tools : [],
      });
      if (native.status !== "prepared" || array.status !== "prepared") {
        throw new Error("Expected budgeted plan");
      }
      expect(native.plan.requestBudget).toEqual(expectedBudget);
      expect(native.plan.preparation.summaryTokenBudget).toEqual(
        array.preparation.summaryTokenBudget,
      );
      if (maxSummaryChars === 20000) {
        expect(native.plan.requestBudget?.fixedTokens).toBe(variant === "active" ? 10640 : 32);
      } else {
        expect(native.plan.summaryReplayTokenBudget).toBe(variant === "active" ? 3577 : 12417);
      }
    }
  },
);
