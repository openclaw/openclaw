import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ToolResultMessage } from "../../llm/types.js";
import { freezeJsonSnapshot, isDeeplyFrozenPlainData } from "../../shared/immutable-data.js";
import type { AgentMessage } from "../runtime/index.js";
import type { ToolResultPromptProjection } from "./cache-ttl-checkpoint.js";
import {
  getToolResultTextBlocks,
  hashToolResultText,
  TOOL_RESULT_PROJECTION_KEY,
} from "./tool-result-projection-key.js";

function mergeProjectedToolResultMessage(
  message: AgentMessage,
  projectedContent: ToolResultMessage["content"],
  sourceHash: string | undefined,
  cacheTtl?: "soft" | "hard",
): AgentMessage {
  if (message.role !== "toolResult") {
    return message;
  }
  const currentContent = message.content;
  if (!Array.isArray(currentContent) || !Array.isArray(projectedContent)) {
    return { ...message, content: projectedContent };
  }
  const projectedText = projectedContent.flatMap((block) =>
    isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : [],
  );
  if (sourceHash && hashToolResultText(message) !== sourceHash) {
    return message;
  }
  if (cacheTtl) {
    return { ...message, content: projectedContent };
  }
  if (getToolResultTextBlocks(message).length !== projectedText.length) {
    return message;
  }
  let textIndex = 0;
  const mergedContent = currentContent.map((block) => {
    if (!isRecord(block) || block.type !== "text") {
      return block;
    }
    return Object.assign({}, block, { text: projectedText[textIndex++] });
  });
  return { ...message, content: mergedContent };
}

// Source and replacement content are both weak identities. A policy change selects
// different content; key/hash/mode still guard the envelope's exact replay identity.
const projectedToolResults = new WeakMap<
  AgentMessage,
  WeakMap<
    object,
    {
      key: string | undefined;
      sourceHash: string | undefined;
      cacheTtl: "soft" | "hard" | undefined;
      message: AgentMessage;
    }
  >
>();

/** Merge admitted result bytes with canonical metadata without retaining mutable inputs. */
export function projectToolResultMessage(
  source: AgentMessage,
  projected: ToolResultPromptProjection,
  key: string | undefined,
  sourceHash: string | undefined,
): AgentMessage {
  const immutable =
    Array.isArray(projected.content) &&
    isDeeplyFrozenPlainData(source) &&
    isDeeplyFrozenPlainData(projected.content);
  let cache = immutable ? projectedToolResults.get(source) : undefined;
  const cached = cache?.get(projected.content);
  if (
    cached &&
    cached.key === key &&
    cached.sourceHash === sourceHash &&
    cached.cacheTtl === projected.cacheTtl
  ) {
    return cached.message;
  }
  let message = mergeProjectedToolResultMessage(
    source,
    projected.content,
    sourceHash,
    projected.cacheTtl,
  );
  if (key && projected.cacheTtl && message !== source) {
    // Carry canonical identity through content edits, including duplicate or absent tool ids.
    message = Object.assign({}, message, { [TOOL_RESULT_PROJECTION_KEY]: key });
  }
  if (immutable) {
    if (!cache) {
      cache = new WeakMap();
      projectedToolResults.set(source, cache);
    }
    cache.set(projected.content, {
      key,
      sourceHash,
      cacheTtl: projected.cacheTtl,
      message: freezeJsonSnapshot(message),
    });
  }
  return message;
}
