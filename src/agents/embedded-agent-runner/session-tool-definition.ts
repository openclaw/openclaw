import { getPublishedRuntimeToolInputSchema } from "@openclaw/ai/internal/tool-schema";
import { stableStringify } from "@openclaw/normalization-core";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { normalizeTranscriptJsonValue } from "../../config/sessions/transcript-json-normalize.js";
import { retainOwnedTranscriptPayload } from "../../config/sessions/transcript-json.js";
import type { AnyAgentTool } from "../agent-tools.types.js";

// One current descriptor per live schema publication; retired schemas release their slot.
const publishedToolDefinitions = new WeakMap<
  object,
  Pick<AnyAgentTool, "name" | "description" | "parameters">
>();

export function describeSessionToolDefinition(
  tool: AnyAgentTool,
): Pick<AnyAgentTool, "name" | "description" | "parameters"> {
  const { name, description, parameters } = tool;
  const published = getPublishedRuntimeToolInputSchema(parameters);
  const previous = published && publishedToolDefinitions.get(published);
  if (previous && previous.name === name && previous.description === description) {
    return previous;
  }
  const definition = { name, description, parameters };
  if (published) {
    retainOwnedTranscriptPayload(parameters);
    // Detach name/description backing once and seal the descriptor at the transcript boundary.
    normalizeTranscriptJsonValue({ definition }, "");
    publishedToolDefinitions.set(published, definition);
  }
  return definition;
}

export function sameToolParameters(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  const a = getPublishedRuntimeToolInputSchema(left);
  const b = getPublishedRuntimeToolInputSchema(right);
  // Restored transcript pins have no publication fact; derive only their side.
  return a || b
    ? (a?.canonicalFingerprint ?? sha256Hex(stableStringify(left))) ===
        (b?.canonicalFingerprint ?? sha256Hex(stableStringify(right)))
    : stableStringify(left) === stableStringify(right);
}
