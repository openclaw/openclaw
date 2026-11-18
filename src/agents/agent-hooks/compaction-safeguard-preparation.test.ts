import { describe, expect, it, vi } from "vitest";
import type { CompactionPreparation } from "../../../packages/agent-core/src/harness/compaction/compaction.js";
import type { AgentMessage, SessionTreeEntry } from "../runtime/index.js";
import { castAgentMessage } from "../test-helpers/agent-message-fixtures.js";
import {
  buildPreservedTurnsSectionFromFacts,
  buildSplitTurnContextSectionFromFacts,
  collectCompactionContextMessageFact,
  selectPreservedRecentTurnIndexes,
} from "./compaction-safeguard-context.js";
import {
  collectCompactionSafeguardAskFact,
  selectCompactionSafeguardAskIndex,
  prepareCompactionSafeguardContext,
  prepareCompactionSafeguardHistory,
  prepareCompactionSafeguardMessages,
  prepareCompactionSafeguardSections,
  prepareCompactionSafeguardSummary,
} from "./compaction-safeguard-preparation.js";
import {
  extractOpaqueIdentifiers,
  extractOpaqueIdentifiersFromFacts,
} from "./compaction-safeguard-quality.js";

const user = (content: string): AgentMessage => ({ role: "user", content, timestamp: 1 });
const runtimeContext = castAgentMessage({
  role: "custom",
  customType: "openclaw.runtime-context",
  content: "private runtime input",
  display: false,
  timestamp: 1,
});
const failure: AgentMessage = {
  role: "toolResult",
  toolCallId: "check-1",
  toolName: "exec",
  content: [{ type: "text", text: "check failed" }],
  details: { status: "failed", exitCode: 2 },
  isError: true,
  timestamp: 2,
};
const preparation = (
  messagesToSummarize: AgentMessage[],
  overrides: Partial<CompactionPreparation> = {},
): CompactionPreparation => ({
  firstKeptEntryId: "kept",
  messagesToSummarize,
  turnPrefixMessages: [],
  isSplitTurn: false,
  tokensBefore: 100,
  fileOps: { read: new Set(), edited: new Set(), written: new Set() },
  settings: { enabled: true, reserveTokens: 4000, keepRecentTokens: 2000 },
  ...overrides,
});
const entry = (id: string, message: AgentMessage): SessionTreeEntry => ({
  id,
  type: "message",
  parentId: null,
  timestamp: "2026-01-01T00:00:00.000Z",
  message,
});
const history = (input: CompactionPreparation) =>
  prepareCompactionSafeguardHistory({
    messages: prepareCompactionSafeguardMessages(input),
    firstKeptEntryId: input.firstKeptEntryId,
    readBranch: () => {
      throw new Error("real prepared conversation must not read the branch");
    },
  });
const summarize = (
  input: CompactionPreparation,
  options: { recentTurnsPreserve?: number; qualityGuardEnabled?: boolean } = {},
) =>
  prepareCompactionSafeguardSummary({
    history: history(input),
    preparation: input,
    splitTurnContextChars: 8000,
    recentTurnsPreserve: options.recentTurnsPreserve ?? 3,
    qualityGuardEnabled: options.qualityGuardEnabled ?? false,
  });

describe("canonical safeguard preparation", () => {
  it("reduces selected fact ranges without retaining payloads or searching past independent asks", () => {
    const assistant = castAgentMessage({
      role: "assistant",
      content: [
        { type: "text", text: "Checking" },
        {
          type: "toolCall",
          id: "check-1",
          name: "exec",
          arguments: { command: "private-argument" },
        },
      ],
      timestamp: 1,
    });
    const messages = [
      user("old"),
      assistant,
      failure,
      user("new"),
      assistant,
      { ...failure, content: [{ type: "text" as const, text: "latest result" }] },
    ];
    const facts = messages.map(collectCompactionContextMessageFact);
    expect(JSON.stringify(facts)).not.toContain("private-argument");
    const selected = facts.slice(3);
    expect([...selectPreservedRecentTurnIndexes(selected, 1)]).toEqual([0, 1, 2]);
    const section = buildPreservedTurnsSectionFromFacts(selected, 8000);
    expect(section.text).toBe(
      "\n\n## Recent turns preserved verbatim\n- User: new\n- Assistant: Checking\n[non-text content: toolCall]\n- Tool result (exec): latest result",
    );
    expect(buildSplitTurnContextSectionFromFacts(selected.slice(2)).text).toBe("");
    expect(buildPreservedTurnsSectionFromFacts(selected, 100).truncatedLoss).toBe(
      "preserved-turn-head",
    );
    const largeAsk = user("x".repeat(50_000));
    const barrier = Object.assign(user("independent input"), {
      provenance: { kind: "inter_session" as const, sourceTool: "sessions_send" },
    });
    const askFacts = [largeAsk, barrier, failure].map(collectCompactionSafeguardAskFact);
    expect(askFacts).toEqual([true, false, undefined]);
    expect(selectCompactionSafeguardAskIndex(askFacts)).toBeNull();
    expect(selectCompactionSafeguardAskIndex(askFacts.slice(0, 1))).toBe(0);
    expect(summarize(preparation([largeAsk])).latestUserAsk).toBe(largeAsk.content);
    const texts = Array.from(
      { length: 15 },
      (_, index) => `https://example.test/${index} deadbeef 1.2e6`,
    );
    const identifiers = texts.map(extractOpaqueIdentifiers);
    expect(extractOpaqueIdentifiersFromFacts(identifiers.slice(-10))).toEqual(
      extractOpaqueIdentifiers(texts.slice(-10).join("\n")),
    );
  });

  it("keeps source identity and metadata, strips only runtime carriers, and normalizes legacy summaries", () => {
    const message = Object.assign(user("Check https://example.test/work/123456"), {
      provenance: { kind: "inter_session", sourceTool: "sessions_send" },
      __openclaw: { senderId: "alice" },
    });
    const messages = [message];
    const prefix = [user("latest request")];
    const clean = history(preparation(messages, { turnPrefixMessages: prefix }));
    expect(clean.messagesToSummarize).toBe(messages);
    expect(clean.turnPrefixMessages).toBe(prefix);
    expect(clean.usedPreparationRange).toBe(false);
    const stripped = history(
      preparation([runtimeContext, message], {
        turnPrefixMessages: [runtimeContext, ...prefix],
        previousSummary:
          "  ## Decisions\nOld\n**Turn Context (split turn):**\n## Pending user asks\nOld ask  ",
      }),
    );
    expect(stripped.messagesToSummarize).toEqual([message]);
    expect(stripped.messagesToSummarize[0]).toBe(message);
    expect(stripped.turnPrefixMessages[0]).toBe(prefix[0]);
    expect(stripped.previousSummary).toBe(
      "## Decisions\nOld\n**Turn Context (split turn):**\n### Pending user asks\nOld ask",
    );
    expect(message.provenance).toEqual({ kind: "inter_session", sourceTool: "sessions_send" });
  });

  it("recovers omitted conversation only inside the current reset boundary", () => {
    const omitted = user("current omitted request");
    const kept = user("kept request");
    const branch: SessionTreeEntry[] = [
      entry("old", user("obsolete request behind reset")),
      {
        id: "reset",
        type: "reset",
        reason: "new",
        firstKeptEntryId: "reset",
        parentId: "old",
        timestamp: "2026-01-01T00:00:00.000Z",
      },
      entry("omitted", omitted),
      entry("tool", failure),
      entry("kept", kept),
    ];
    const readBranch = vi.fn(() => branch);
    const prepared = prepareCompactionSafeguardHistory({
      messages: prepareCompactionSafeguardMessages(preparation([failure])),
      firstKeptEntryId: "kept",
      readBranch,
    });
    expect(readBranch).toHaveBeenCalledTimes(1);
    expect(prepared.usedPreparationRange).toBe(true);
    expect(prepared.hasRealConversation).toBe(true);
    expect(prepared.messagesToSummarize).toEqual([omitted, failure]);
    expect(prepared.turnPrefixMessages).toEqual([]);
  });

  it.each([true, false])(
    "reads the branch once for tool-only context (anchored=%s)",
    (anchored) => {
      const branch: SessionTreeEntry[] = anchored
        ? [
            {
              id: "compacted",
              type: "compaction",
              summary: "Prior conversation",
              firstKeptEntryId: "compacted",
              tokensBefore: 100,
              parentId: null,
              timestamp: "2026-01-01T00:00:00.000Z",
            },
          ]
        : [];
      const readBranch = vi.fn(() => branch);
      const messages = [failure];
      const prepared = prepareCompactionSafeguardHistory({
        messages: prepareCompactionSafeguardMessages(preparation(messages)),
        firstKeptEntryId: "missing",
        readBranch,
      });
      expect(readBranch).toHaveBeenCalledTimes(1);
      expect(prepared.hasRealConversation).toBe(anchored);
      expect(prepared.usedPreparationRange).toBe(false);
      expect(prepared.messagesToSummarize).toBe(messages);
    },
  );

  it("shares canonical file and failure sections across the whole prepared window", () => {
    const input = preparation([user("check files"), failure], {
      turnPrefixMessages: [failure],
      fileOps: {
        read: new Set(["z.ts", "a.ts", "edited.ts"]),
        edited: new Set(["edited.ts"]),
        written: new Set(["new.ts"]),
      },
    });
    expect(
      prepareCompactionSafeguardSections({ fileOps: input.fileOps, history: history(input) }),
    ).toEqual({
      readFiles: ["a.ts", "z.ts"],
      modifiedFiles: ["edited.ts", "new.ts"],
      fileOpsSummary:
        "\n\n<read-files>\na.ts\nz.ts\n</read-files>\n\n<modified-files>\nedited.ts\nnew.ts\n</modified-files>",
      toolFailureSection: "\n\n## Tool Failures\n- exec (status=failed exitCode=2): check failed",
    });
  });

  it("keeps preservation separate from reconciliation and retains complete original messages", () => {
    const messages = [user("Correct the owner to Maya at https://example.test/task/123456")];
    const input = preparation(messages);
    const withoutPrevious = summarize(input);
    expect(withoutPrevious.summarizableMessages).toEqual([]);
    expect(withoutPrevious.preservedMessages[0]).toBe(messages[0]);
    expect(withoutPrevious.reconciliationMessages).toEqual([]);
    expect(withoutPrevious.oracleMessages).toBe(messages);
    const withPrevious = summarize({ ...input, previousSummary: "Owner was Lee" });
    expect(withPrevious.reconciliationMessages).toBe(messages);
    expect(withPrevious.identifiers).toEqual(["https://example.test/task/123456"]);
    const context = prepareCompactionSafeguardContext({
      messagesToSummarize: messages,
      recentTurnsPreserve: 0,
      splitTurnContextChars: 8000,
    });
    expect(context.summarizableMessages).toBe(messages);
    expect(context.preservedMessages).toEqual([]);
  });

  it.each(["legacy", "unresolved", "none"] as const)(
    "honors %s request selection across split-turn sources",
    (state) => {
      const request = "Check the release status";
      const prefix = [user(request)];
      const input = preparation([user("old ask")], {
        isSplitTurn: true,
        turnPrefixMessages: prefix,
        ...(state === "legacy"
          ? {}
          : {
              requestSelection: state === "none" ? { state } : { state, request },
            }),
      });
      const result = summarize(input);
      expect(result.turnPrefixMessages).toBe(prefix);
      expect(result.reconciliationMessages).toEqual([...input.messagesToSummarize, ...prefix]);
      expect(result.reconciliationMessages[1]).toBe(prefix[0]);
      expect(result.latestUserAsk).toBe(state === "none" ? null : request);
      expect(result.latestAskInRetainedTurn).toBe(state !== "none");
      expect(result.requiredAskContext).toBe(state === "none" ? "" : request);
    },
  );

  it("reconciles a preserved ask that exceeds its verbatim excerpt, unless the run owner supplies it", () => {
    const request = "Review the current release details. ".repeat(30);
    const input = preparation([user(request)]);
    const result = summarize(input, { qualityGuardEnabled: true });
    expect(result.preservedTurnsSection.text).not.toContain(result.requiredAskContext);
    expect(result.reconciliationMessages).toBe(input.messagesToSummarize);
    const selected = summarize(
      { ...input, latestUnresolvedUserRequest: request },
      {
        qualityGuardEnabled: true,
      },
    );
    expect(selected.reconciliationMessages).toEqual([]);
  });
});
