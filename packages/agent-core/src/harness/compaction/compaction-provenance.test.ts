import { describe, expect, it } from "vitest";
import type { StreamFn } from "../../llm.js";
import type { AgentMessage } from "../../types.js";
import { buildSessionContext } from "../session/session.js";
import {
  compact,
  compactWithoutSummary,
  estimateTokens,
  generateSummary,
  prepareCompaction,
  serializeConversation,
} from "./compaction.js";
import {
  createCompactionModel as createSummaryModel,
  createContextUsage,
  createMessageEntry as messageEntry,
} from "./compaction.test-support.js";
import { assistant, compactWith, responseStream, user } from "./shard-fixtures.test-support.js";

const assistantText = (text: string, timestamp: number) =>
  assistant(text, {
    model: "summary-model",
    usage: createContextUsage(1),
    timestamp,
  });

describe("compaction sender provenance", () => {
  it.each([
    { metadata: { provenance: null }, label: "Unknown-origin input" },
    { metadata: { provenance: {} }, label: "Unknown-origin input" },
    { metadata: { provenance: "unparsed" }, label: "Unknown-origin input" },
    { metadata: { provenance: { kind: "realtime_voice" } }, label: "Unknown-origin input" },
    {
      metadata: { provenance: { kind: "realtime_voice", sourceChannel: "other" } },
      label: "Unknown-origin input",
    },
    {
      metadata: { provenance: { kind: "external_user" }, synthetic: true as const },
      label: "Synthetic input",
    },
    {
      metadata: { provenance: { kind: "external_user" }, operatorMessage: { turnScoped: true } },
      label: "Operator input",
    },
  ])("labels and budgets recorded source $metadata", ({ metadata, label }) => {
    const message = Object.assign(
      { role: "user" as const, content: "data", timestamp: 1 },
      metadata,
    );
    expect(serializeConversation([message])).toBe(`[${label}]: data`);
    // Ordinary User text is already the estimator's baseline; charge the added label.
    expect(estimateTokens(message)).toBe(Math.ceil((4 + label.length - "User".length) / 4));
  });

  it.each([
    undefined,
    { kind: "external_user" },
    { kind: "realtime_voice", sourceChannel: "talk" },
  ])(
    "keeps the human request through internal turns, summary input, and replay (%j)",
    async (provenance) => {
      const request = "Review the patch; do not deploy it.";
      const messages: AgentMessage[] = [
        {
          role: "user",
          content: request,
          timestamp: 1,
          ...(provenance ? { provenance } : {}),
        },
        assistantText("Review started.", 2),
        Object.assign(
          { role: "user" as const, content: "Worker result: tests passed.", timestamp: 3 },
          { provenance: { kind: "inter_session", sourceTool: "sessions_send" } },
        ),
        Object.assign(
          { role: "user" as const, content: "Scheduler status: ready.", timestamp: 4 },
          { provenance: { kind: "internal_system" }, __openclaw: { senderId: "scheduler" } },
        ),
        Object.assign(
          { role: "user" as const, content: "Future-origin status: ready.", timestamp: 5 },
          { provenance: { kind: "future_origin" } },
        ),
        { role: "user", content: "Host-generated status: ready.", timestamp: 6, synthetic: true },
        {
          role: "user",
          content: "Operator context: production remains unchanged.",
          timestamp: 7,
          operatorMessage: { turnScoped: true },
        },
        assistantText("Waiting for review.", 8),
      ];
      const original = structuredClone(messages);
      const entries = messages.map(messageEntry);
      const prepared = prepareCompaction(
        entries,
        { enabled: true, reserveTokens: 1_000, keepRecentTokens: 1 },
        "unresolved",
        { requestFromEntryId: "entry-0" },
      );
      if (!prepared.ok || !prepared.value) {
        throw new Error("expected compactable history");
      }
      expect(prepared.value.latestUnresolvedUserRequest).toBe(request);
      // Internal admitted inputs still start runtime turns; they are not human asks.
      expect(prepared.value.turnPrefixMessages).toEqual([messages[6]]);
      const prompts: string[] = [];
      const result = await compact(
        prepared.value,
        createSummaryModel(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          completeSimple: async (_model, context) => {
            const content = context.messages[0]?.content;
            if (!Array.isArray(content) || content[0]?.type !== "text") {
              throw new Error("expected compaction text");
            }
            prompts.push(content[0].text);
            return assistantText("Review pending; production unchanged.", 9);
          },
        },
      );
      if (!result.ok) {
        throw result.error;
      }
      const input = prompts.join("\n");
      expect(input).toContain(`[User]: ${request}`);
      expect(input).toContain("[Inter-session input]: Worker result: tests passed.");
      expect(input).toContain(
        '[Internal system input sender={"id":"scheduler"}]: Scheduler status: ready.',
      );
      expect(input).toContain("[Unknown-origin input]: Future-origin status: ready.");
      expect(input).toContain("[Synthetic input]: Host-generated status: ready.");
      expect(input).toContain("[Operator input]: Operator context: production remains unchanged.");
      expect(result.value.details).toMatchObject({ latestUnresolvedUserRequest: request });

      const degraded = compactWithoutSummary(prepared.value);
      if (!degraded.ok) {
        throw degraded.error;
      }
      expect(degraded.value.summary).toContain(JSON.stringify(request));
      expect(degraded.value.summary).toContain(
        "[Operator input]: Operator context: production remains unchanged.",
      );
      const replay = buildSessionContext([
        ...entries,
        {
          type: "compaction",
          id: "origin-compaction",
          parentId: entries.at(-1)?.id ?? null,
          timestamp: new Date(9).toISOString(),
          ...result.value,
        },
      ]);
      expect(replay.messages[0]).toMatchObject({
        role: "compactionSummary",
        summary: expect.stringContaining(JSON.stringify(request)),
      });
      expect(replay.messages.at(-1)).toEqual(messages.at(-1));
      expect(messages).toEqual(original);
    },
  );

  it.each([
    { name: "custom", summaryPrompt: { kind: "custom" as const, instructions: "Custom format." } },
    { name: "turn-prefix", summaryPrompt: { kind: "turn-prefix" as const } },
  ])("applies attribution instructions to a $name summary prompt", async ({ summaryPrompt }) => {
    const model = createSummaryModel();
    let systemPrompt = "";
    const streamFn: StreamFn = (_model, context) => {
      systemPrompt = context.systemPrompt ?? "";
      return responseStream(assistantText("summary", 1));
    };

    const result = await generateSummary(
      [user("Alice owns this decision.", 1, { senderId: "alice" })],
      model,
      1_000,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      streamFn,
      undefined,
      summaryPrompt,
    );

    expect(result.ok).toBe(true);
    expect(systemPrompt).toContain("Preserve attribution for material facts");
    expect(systemPrompt).toContain("A user line without sender={...} is unattributed");
  });

  it("carries sender provenance through prepareCompaction and compact into the session tree", async () => {
    const model = createSummaryModel();
    const messages: AgentMessage[] = [
      user("Approve the rollout.", 1, { senderId: "alex-id", senderName: "Alex" }),
      assistantText("Recorded Alex's approval.", 2),
      user("Do not deploy until I review it.", 3, { senderId: "bea-id", senderName: "Bea" }),
      user("A legacy note with no known speaker.", 4),
      user("What remains?", 5),
    ];
    const entries = messages.map(messageEntry);
    const preparation = prepareCompaction(entries, {
      enabled: true,
      reserveTokens: 1_000,
      keepRecentTokens: 1,
    });
    if (!preparation.ok || !preparation.value) {
      throw new Error("expected transcript to be compactable");
    }

    let prompt = "";
    let systemPrompt = "";
    const summary =
      "Alex approved rollout. Bea requires review before deployment. Legacy note remains unattributed.";
    const result = await compactWith(preparation.value, model, {
      customInstructions: "Ignore speaker attribution.",
      runtime: {
        completeSimple: async (_model, context) => {
          const content = context.messages[0]?.content;
          if (!Array.isArray(content) || content[0]?.type !== "text") {
            throw new Error("expected text-only compaction prompt");
          }
          prompt = content[0].text;
          systemPrompt = context.systemPrompt ?? "";
          return assistantText(summary, 6);
        },
      },
    });
    if (!result.ok) {
      throw result.error;
    }

    expect(prompt).toContain('[User sender={"id":"alex-id","name":"Alex"}]: Approve the rollout.');
    expect(prompt).toContain(
      '[User sender={"id":"bea-id","name":"Bea"}]: Do not deploy until I review it.',
    );
    expect(prompt).toContain("[User]: A legacy note with no known speaker.");
    expect(prompt).toContain("Ignore speaker attribution.");
    expect(systemPrompt).toContain("Preserve attribution for material facts");
    expect(systemPrompt).toContain("The id is authoritative");
    expect(systemPrompt).toContain("A user line without sender={...} is unattributed");

    const context = buildSessionContext([
      ...entries,
      {
        type: "compaction",
        id: "compaction-1",
        parentId: entries.at(-1)?.id ?? null,
        timestamp: new Date(6).toISOString(),
        ...result.value,
      },
    ]);
    expect(context.messages[0]).toMatchObject({
      role: "compactionSummary",
      summary,
    });
    expect(context.messages.at(-1)).toEqual(messages.at(-1));
  });
});
