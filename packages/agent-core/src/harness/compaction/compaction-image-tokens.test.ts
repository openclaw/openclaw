import { assert, expect, it } from "vitest";
import type { ImageContent, Model } from "../../llm.js";
import type { AgentCoreCompletionRuntimeDeps } from "../../runtime-deps.js";
import type { AgentMessage } from "../../types.js";
import { buildSessionContext } from "../session/session.js";
import type { SessionTreeEntry } from "../types.js";
import { generateBranchSummary } from "./branch-summarization.js";
import { estimateTokens, findCutPoint, prepareCompaction } from "./compaction.js";
import {
  createCompactionModel,
  createMessageEntry as messageEntry,
} from "./compaction.test-support.js";
import { assistant, compactWith, text, toolResult, user } from "./shard-fixtures.test-support.js";

const settings = { enabled: true, reserveTokens: 1000, keepRecentTokens: 1 };
const IMAGE_PAYLOAD = "a".repeat(1_500_000);

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
  const prompts: string[] = [];
  const runtime: AgentCoreCompletionRuntimeDeps = {
    completeSimple: async (_model, context) => {
      const content = context.messages[0]?.content;
      if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== "text") {
        throw new Error("expected one text-only summarization input");
      }
      prompts.push(content[0].text);
      const conversation = content[0].text
        .split("<conversation>\n")[1]
        ?.split("\n</conversation>")[0];
      return assistantText(reply(conversation), timestamp);
    },
  };
  return { prompts, runtime };
}

function buildTranscript(recentUserTurns: AgentMessage[]): SessionTreeEntry[] {
  const messages: AgentMessage[] = [userText("start of the conversation", 1)];
  let timestamp = 2;
  for (const turn of recentUserTurns) {
    messages.push(assistantText("ok", timestamp++));
    messages.push(turn);
  }
  return messages.map((message, index) => messageEntry(message, index));
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

it("matches image-heavy cut points to equivalent text-cost controls", () => {
  const imageEntries = buildTranscript([10, 20, 30].map(userImage));
  const textEntries = buildTranscript(
    [10, 20, 30].map((timestamp) => userText("x".repeat(8_056), timestamp)),
  );
  const cut = (entries: SessionTreeEntry[]) =>
    findCutPoint(entries, 0, entries.length, 1500).firstKeptEntryIndex;
  expect(cut(textEntries)).toBeGreaterThan(0);
  expect(cut(imageEntries)).toBe(cut(textEntries));
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
    expect(prompts[0]).not.toContain(IMAGE_PAYLOAD);
    expect(prompts[0]).not.toContain("already processed by model");

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

it.each([
  { mode: "ordinary", type: "image" },
  { mode: "split", type: "audio" },
  { mode: "branch", type: "image" },
] as const)(
  "bounds many $type messages at the $mode completion boundary",
  async ({ mode, type }) => {
    const model = summaryModel(type === "image" ? 1_000_000 : 8192);
    const messages: AgentMessage[] = [
      userText("Inspect attachments", 0),
      ...Array.from(
        { length: 200 },
        (_, i) =>
          ({
            ...toolResult([], { toolCallId: `call-${i}`, toolName: "inspect", timestamp: i + 1 }),
            content: [{ type, data: "PAYLOAD_SENTINEL", mimeType: "image/png" }],
          }) as AgentMessage,
      ),
    ];
    const entries = messages.map(messageEntry);
    const conversations: string[] = [];
    const { runtime } = captureSummary((conversation) => {
      assert(conversation, "expected conversation");
      conversations.push(conversation);
      return "Summary";
    }, 202);
    let result;
    if (mode === "branch") {
      result = await generateBranchSummary(entries, {
        model,
        apiKey: "test-key",
        signal: new AbortController().signal,
        runtime,
      });
    } else {
      entries.push(
        messageEntry(
          mode === "split" ? assistantText("Retained answer", 201) : userText("Next task", 201),
          entries.length,
        ),
      );
      const preparation = prepareCompaction(entries, settings);
      assert(preparation.ok && preparation.value, "expected compactable history");
      expect(preparation.value.isSplitTurn).toBe(mode === "split");
      result = await compactWith(preparation.value, model, { runtime });
    }
    expect(result.ok).toBe(true);
    expect(conversations).toHaveLength(1);
    const conversation = conversations[0];
    assert(conversation, "expected captured conversation");
    expect(
      Buffer.byteLength(conversation) - Buffer.byteLength("[User]: Inspect attachments"),
    ).toBeLessThanOrEqual(847);
    expect(conversation.match(/\[Tool result\]:/g)).toHaveLength(8);
    expect(
      conversation.split("[More image/non-text data omitted from summary input]"),
    ).toHaveLength(2);
    expect(conversation).not.toMatch(/PAYLOAD_SENTINEL|already processed by model/);
  },
);
