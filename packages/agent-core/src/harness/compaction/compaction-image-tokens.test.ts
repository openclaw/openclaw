import { assert, expect, it } from "vitest";
import type { ImageContent, Model } from "../../llm.js";
import type { AgentMessage } from "../../types.js";
import { buildSessionContext } from "../session/session.js";
import { estimateTokens, prepareCompaction } from "./compaction.js";
import {
  createCompactionModel,
  createContextUsage,
  createMessageEntry as messageEntry,
} from "./compaction.test-support.js";
import {
  assistant,
  captureCompletion,
  compactWith,
  contains,
  excludes,
  text,
  toolResult,
  user,
} from "./shard-fixtures.test-support.js";

const settings = { enabled: true, reserveTokens: 1000, keepRecentTokens: 1 };
const IMAGE_PAYLOAD = "a".repeat(1_500_000);

it("carries sender provenance through compaction into the session tree", async () => {
  const messages = [
    user("Approve the rollout.", 1, { senderId: "alex-id", senderName: "Alex" }),
    assistant("Recorded Alex's approval.", {
      model: "summary-model",
      usage: createContextUsage(1),
      timestamp: 2,
    }),
    user("Do not deploy until I review it.", 3, { senderId: "bea-id", senderName: "Bea" }),
    user("A legacy note with no known speaker.", 4),
    user("What remains?", 5),
  ];
  const entries = messages.map(messageEntry);
  const prepared = prepareCompaction(entries, settings);
  assert(prepared.ok && prepared.value);
  const summary =
    "Alex approved rollout. Bea requires review before deployment. Legacy note remains unattributed.";
  const capture = captureCompletion(() =>
    assistant(summary, { model: "summary-model", usage: createContextUsage(1), timestamp: 6 }),
  );
  const result = await compactWith(prepared.value, createCompactionModel(), {
    customInstructions: "Ignore speaker attribution.",
    runtime: capture.runtime,
  });
  assert(result.ok);
  contains(
    capture.prompts[0] ?? "",
    '[User sender={"id":"alex-id","name":"Alex"}]: Approve the rollout.',
    '[User sender={"id":"bea-id","name":"Bea"}]: Do not deploy until I review it.',
    "[User]: A legacy note with no known speaker.",
    "Ignore speaker attribution.",
  );
  contains(
    capture.systemPrompt(),
    "Preserve attribution for material facts",
    "The id is authoritative",
    "A user line without sender={...} is unattributed",
  );
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
  expect(context.messages[0]).toMatchObject({ role: "compactionSummary", summary });
  expect(context.messages.at(-1)).toEqual(messages.at(-1));
});

function imageBlock(): ImageContent {
  return { type: "image", data: IMAGE_PAYLOAD, mimeType: "image/png" };
}

const userImage = (timestamp: number) => user([imageBlock()], timestamp);

function userText(value: string, timestamp: number): AgentMessage {
  return user([text(value)], timestamp);
}

function toolResultImage(timestamp: number) {
  return toolResult([imageBlock()], { toolName: "screenshot", timestamp });
}

function assistantText(value: string, timestamp: number) {
  return assistant(value, {
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-fable-5",
    timestamp,
  });
}

function summaryModel(contextWindow = 100_000): Model {
  return createCompactionModel({ contextWindow, maxTokens: 2048 });
}

function captureSummary(reply: (conversation: string | undefined) => string, timestamp: number) {
  return captureCompletion((prompt) =>
    assistantText(
      reply(prompt.split("<conversation>\n")[1]?.split("\n</conversation>")[0]),
      timestamp,
    ),
  );
}

it("charges user, tool-result, and custom image blocks equally", () => {
  const custom: AgentMessage = {
    role: "custom",
    content: [imageBlock()],
    timestamp: 1,
    customType: "image",
    display: true,
  };
  expect([userImage(1), toolResultImage(1), custom].map(estimateTokens)).toEqual([
    2014, 2014, 2014,
  ]);
});

it.each([
  { role: "user", splitTurn: false },
  { role: "toolResult", splitTurn: false },
  { role: "user", splitTurn: true },
  { role: "toolResult", splitTurn: true },
] as const)(
  "records image-only $role messages through compaction (split: $splitTurn)",
  async ({ role, splitTurn }) => {
    const messages: AgentMessage[] =
      role === "user"
        ? [userImage(1)]
        : [
            userText("Inspect the screenshot", 1),
            {
              ...assistantText("", 2),
              content: [{ type: "toolCall", id: "call-1", name: "screenshot", arguments: {} }],
              stopReason: "toolUse",
            },
            toolResultImage(3),
          ];
    if (splitTurn) {
      messages.push(assistantText("The screenshot was inspected", 4));
    }
    if (!splitTurn) {
      messages.push(userText("Continue with the next task", 5));
    }
    const entries = messages.map(messageEntry);
    const originalEntries = structuredClone(entries);
    const lastEntry = entries.at(-1);
    const preparation = prepareCompaction(entries, settings);
    assert(preparation.ok && preparation.value && lastEntry, "expected compactable image history");
    expect(preparation.value).toMatchObject({
      isSplitTurn: splitTurn,
      firstKeptEntryId: lastEntry.id,
    });

    const model = summaryModel();
    // Echo only supplied conversation text, never invented omission facts.
    const { prompts, runtime } = captureSummary(
      (conversation) => conversation || "No conversation content",
      6,
    );
    const result = await compactWith(preparation.value, model, { runtime });
    assert(result.ok);
    const marker = "[image data omitted from summary input]";
    expect(prompts).toHaveLength(1);
    expect.soft(prompts[0]).toContain(`${role === "user" ? "[User]" : "[Tool result]"}: ${marker}`);
    excludes(prompts[0] ?? "", IMAGE_PAYLOAD, "already processed by model");

    const context = buildSessionContext([
      ...entries,
      {
        type: "compaction",
        id: "compaction-1",
        parentId: lastEntry.id,
        timestamp: new Date(7).toISOString(),
        ...result.value,
      },
    ]);
    expect.soft(context.messages[0]).toMatchObject({
      role: "compactionSummary",
      summary: expect.stringContaining(marker),
    });
    expect(context.messages.at(-1)).toEqual(messages.at(-1));
    expect(JSON.stringify(context.messages)).not.toContain(IMAGE_PAYLOAD);
    expect(entries).toEqual(originalEntries);
  },
);
