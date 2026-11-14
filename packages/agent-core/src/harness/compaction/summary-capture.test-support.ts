import type { AssistantMessage, Model } from "../../llm.js";
import type { SessionTreeEntry } from "../types.js";
import { createMessageEntry } from "./compaction.test-support.js";
import { assistant, user } from "./shard-fixtures.test-support.js";

export const userEntry = (content: string, index: number) =>
  createMessageEntry(user(content, index + 1), index);
export const modelReply = (model: Model, content: string | AssistantMessage["content"]) =>
  assistant(content, { api: model.api, provider: model.provider, model: model.id });

export function compactionEntry(
  index: number,
  summary: string,
  firstKeptEntryId: string,
  overrides: Partial<Extract<SessionTreeEntry, { type: "compaction" }>> = {},
): SessionTreeEntry {
  return {
    type: "compaction",
    id: `entry-${index}`,
    parentId: `entry-${index - 1}`,
    timestamp: new Date(index + 1).toISOString(),
    summary,
    firstKeptEntryId,
    tokensBefore: 200_000,
    ...overrides,
  };
}
