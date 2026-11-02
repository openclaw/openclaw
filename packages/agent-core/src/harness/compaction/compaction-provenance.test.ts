import { describe, expect, it } from "vitest";
import type { StreamFn } from "../../llm.js";
import type { AgentMessage } from "../../types.js";
import { buildSessionContext } from "../session/session.js";
import { generateSummary, prepareCompaction } from "./compaction.js";
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
