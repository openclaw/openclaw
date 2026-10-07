import { describe, expect, it } from "vitest";
import { createAssistantMessageEventStream } from "../../llm.js";
import type { AssistantMessage, StreamFn } from "../../llm.js";
import type { AgentMessage } from "../../types.js";
import { buildSessionContext } from "../session/session.js";
import { compact, generateSummary, prepareCompaction } from "./compaction.js";
import {
  createCompactionModel as createSummaryModel,
  createContextUsage,
  createMessageEntry as messageEntry,
} from "./compaction.test-support.js";

function assistantText(text: string, timestamp: number): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "test-api",
    provider: "test-provider",
    model: "summary-model",
    usage: createContextUsage(1),
    stopReason: "stop",
    timestamp,
  };
}

function createCapturingSummaryStream() {
  let systemPrompt = "";
  const streamFn: StreamFn = (_model, context) => {
    systemPrompt = context.systemPrompt ?? "";
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "done", reason: "stop", message: assistantText("summary", 1) });
    stream.end();
    return stream;
  };
  return { streamFn, capture: () => ({ systemPrompt }) };
}

describe("compaction sender provenance", () => {
  it.each([
    { name: "custom", summaryPrompt: { kind: "custom" as const, instructions: "Custom format." } },
    { name: "turn-prefix", summaryPrompt: { kind: "turn-prefix" as const } },
  ])("applies attribution instructions to a $name summary prompt", async ({ summaryPrompt }) => {
    const model = createSummaryModel();
    const summaryStream = createCapturingSummaryStream();

    const result = await generateSummary(
      [
        {
          role: "user",
          content: "Alice owns this decision.",
          timestamp: 1,
          __openclaw: { senderId: "alice" },
        } as unknown as AgentMessage,
      ],
      model,
      1_000,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      summaryStream.streamFn,
      undefined,
      summaryPrompt,
    );

    expect(result.ok).toBe(true);
    const { systemPrompt } = summaryStream.capture();
    expect(systemPrompt).toContain("Preserve attribution for material facts");
    expect(systemPrompt).toContain("A user line without sender={...} is unattributed");
  });

  it("carries sender provenance through prepareCompaction and compact into the session tree", async () => {
    const model = createSummaryModel();
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: "Approve the rollout.",
        timestamp: 1,
        __openclaw: { senderId: "alex-id", senderName: "Alex" },
      } as unknown as AgentMessage,
      assistantText("Recorded Alex's approval.", 2),
      {
        role: "user",
        content: "Do not deploy until I review it.",
        timestamp: 3,
        __openclaw: { senderId: "bea-id", senderName: "Bea" },
      } as unknown as AgentMessage,
      { role: "user", content: "A legacy note with no known speaker.", timestamp: 4 },
      { role: "user", content: "What remains?", timestamp: 5 },
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
    const result = await compact(
      preparation.value,
      model,
      undefined,
      undefined,
      "Ignore speaker attribution.",
      undefined,
      undefined,
      undefined,
      {
        completeSimple: async (_model, context) => {
          const content = context.messages[0]?.content;
          if (!Array.isArray(content) || content[0]?.type !== "text") {
            throw new Error("expected text-only compaction prompt");
          }
          prompt = content[0].text;
          systemPrompt = context.systemPrompt ?? "";
          return assistantText(
            "Alex approved rollout. Bea requires review before deployment. Legacy note remains unattributed.",
            6,
          );
        },
      },
    );
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
      summary:
        "Alex approved rollout. Bea requires review before deployment. Legacy note remains unattributed.",
    });
    expect(context.messages.at(-1)).toEqual(messages.at(-1));
  });
});
