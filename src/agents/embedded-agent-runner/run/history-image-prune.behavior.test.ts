import { expectDefined } from "@openclaw/normalization-core";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import type { ImageContent } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import {
  attachRuntimePromptMediaFacts,
  readPersistedMediaFacts,
  readRuntimePromptMediaFacts,
} from "../../../media/media-facts.js";
import { castAgentMessage } from "../../test-helpers/agent-message-fixtures.js";
import {
  textAssistant,
  textToolResult,
} from "../../test-helpers/sparse-transcript.test-support.js";
import { pruneProcessedHistoryImages } from "./history-image-prune.js";

const image: ImageContent = { type: "image", data: "abc", mimeType: "image/png" };
const prunedImage = { type: "text", text: "[image data removed - already processed by model]" };
const prunedMedia = {
  type: "text",
  text: "[media reference removed - already processed by model]",
};

function history(roles: string): AgentMessage[] {
  return Array.from(roles).map((role, index) => {
    const text = `message ${index}`;
    if (role === "A") {
      return castAgentMessage(textAssistant(text));
    }
    return castAgentMessage({
      ...(role === "U" ? { role: "user" } : textToolResult(`call-${index}`, "read", text)),
      content: [{ type: "text", text }, image],
    });
  });
}

describe("history image pruning boundaries", () => {
  it.each([
    {
      name: "ignores an assistant before the initial tool result",
      roles: "ATUAUAUAU",
      prunedIndexes: [],
    },
    {
      name: "counts the initial tool result after its own assistant reply",
      roles: "ATAUAUAUAU",
      prunedIndexes: [1],
    },
    {
      name: "does not count an unanswered leading user",
      roles: "UUAUAUAU",
      prunedIndexes: [],
    },
    {
      name: "keeps the completed-turn cutoff after an unanswered historical user",
      roles: "UAUUAUAUAU",
      prunedIndexes: [0, 2],
    },
  ])("$name", ({ roles, prunedIndexes }) => {
    const messages = history(roles);
    const originalBytes = JSON.stringify(messages);

    const pruned = pruneProcessedHistoryImages(messages);

    if (prunedIndexes.length === 0) {
      expect(pruned).toBeNull();
    } else {
      const replay = expectDefined(pruned, "pruned history");
      expect(replay).toHaveLength(messages.length);
      expect(
        replay.flatMap((message, index) => (message !== messages[index] ? [index] : [])),
      ).toEqual(prunedIndexes);
      for (const index of prunedIndexes) {
        expect(replay[index]).toMatchObject({
          content: [{ type: "text", text: `message ${index}` }, prunedImage],
        });
      }
    }
    expect(JSON.stringify(messages)).toBe(originalBytes);
  });

  it("preserves sparse content slots and unchanged blocks while replacing multiple old blocks", () => {
    const caption = { type: "text", text: "caption stays" };
    const media = { type: "text", text: "[media attached: media://inbound/old.png]" };
    const opaque = { type: "custom", value: "unchanged" };
    const content: unknown[] = [];
    content.length = 9;
    content[0] = caption;
    content[2] = undefined;
    content[3] = image;
    content[5] = media;
    content[6] = image;
    content[7] = opaque;
    const original = content.slice();
    Object.freeze(content);
    const message = castAgentMessage({ role: "user", content });
    const messages = [message, ...history("AUAUAUAU")];

    const replay = expectDefined(pruneProcessedHistoryImages(messages), "pruned history");
    const projected = expectDefined(replay[0], "pruned user message");
    if (projected.role !== "user" || !Array.isArray(projected.content)) {
      throw new Error("Expected user content blocks");
    }
    const blocks = projected.content;

    expect(blocks).not.toBe(content);
    expect(blocks).toHaveLength(9);
    expect(Object.keys(blocks)).toEqual(["0", "2", "3", "5", "6", "7"]);
    expect(blocks[2]).toBeUndefined();
    expect(blocks[0]).toBe(caption);
    expect(blocks[7]).toBe(opaque);
    expect(blocks[3]).toEqual(prunedImage);
    expect(blocks[5]).toEqual(prunedMedia);
    expect(blocks[6]).toEqual(prunedImage);
    expect(content).toStrictEqual(original);
    for (let index = 1; index < messages.length; index += 1) {
      expect(replay[index]).toBe(messages[index]);
    }
    expect(pruneProcessedHistoryImages(replay)).toBeNull();
  });

  it.each([
    { source: "runtime", shape: "empty" },
    { source: "runtime", shape: "caption" },
    { source: "persisted", shape: "empty" },
    { source: "persisted", shape: "caption" },
  ])("isolates $shape array content when removing $source media facts", ({ source, shape }) => {
    const content = shape === "empty" ? [] : [{ type: "text" as const, text: "caption stays" }];
    const original = content.slice();
    const media = [{ path: "/tmp/old-history.png", contentType: "image/png" }];
    const message = castAgentMessage({
      role: "user",
      content,
      ...(source === "persisted" ? { __openclaw: { media } } : {}),
    });
    if (source === "runtime") {
      attachRuntimePromptMediaFacts(message, media);
    }
    Object.freeze(content);
    Object.freeze(message);
    const readFacts = source === "runtime" ? readRuntimePromptMediaFacts : readPersistedMediaFacts;
    const messages = [message, ...history("AUAUAUAU")];

    const replay = expectDefined(pruneProcessedHistoryImages(messages), "pruned history");
    const projected = expectDefined(replay[0], "pruned user message");
    if (projected.role !== "user" || !Array.isArray(projected.content)) {
      throw new Error("Expected user content blocks");
    }

    expect(projected).not.toBe(message);
    expect(projected.content).not.toBe(content);
    expect(projected.content).toStrictEqual(original);
    if (content.length > 0) {
      expect(projected.content[0]).toBe(content[0]);
    }
    expect(readRuntimePromptMediaFacts(projected)).toBeUndefined();
    expect(readPersistedMediaFacts(projected)).toBeUndefined();
    projected.content.push({ type: "text", text: "downstream context only" });
    expect(content).toStrictEqual(original);
    expect(readFacts(message)).toMatchObject(media);
  });
});
