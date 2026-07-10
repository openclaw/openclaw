// Slack plugin module implements blocks input behavior.
import type { Block, KnownBlock } from "@slack/web-api";

export const SLACK_MAX_BLOCKS = 50;

type ValidateSlackBlocksArrayOptions = {
  maxBlocks?: number;
};

function parseBlocksJson(raw: string) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("blocks must be valid JSON");
  }
}

function assertBlocksArray(raw: unknown, options?: ValidateSlackBlocksArrayOptions) {
  const maxBlocks = options?.maxBlocks ?? SLACK_MAX_BLOCKS;
  if (!Array.isArray(raw)) {
    throw new Error("blocks must be an array");
  }
  if (raw.length === 0) {
    throw new Error("blocks must contain at least one block");
  }
  if (raw.length > maxBlocks) {
    throw new Error(`blocks cannot exceed ${maxBlocks} items`);
  }
  for (const block of raw) {
    if (!block || typeof block !== "object" || Array.isArray(block)) {
      throw new Error("each block must be an object");
    }
    const type = (block as { type?: unknown }).type;
    if (typeof type !== "string" || type.trim().length === 0) {
      throw new Error("each block must include a non-empty string type");
    }
  }
}

export function validateSlackBlocksArray(
  raw: unknown,
  options?: ValidateSlackBlocksArrayOptions,
): (Block | KnownBlock)[] {
  assertBlocksArray(raw, options);
  return raw as (Block | KnownBlock)[];
}

export function parseSlackBlocksInput(raw: unknown): (Block | KnownBlock)[] | undefined {
  if (raw == null) {
    return undefined;
  }
  const parsed = typeof raw === "string" ? parseBlocksJson(raw) : raw;
  return validateSlackBlocksArray(parsed);
}
