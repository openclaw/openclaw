import { randomUUID } from "node:crypto";

type AssistantTextPhaseBlock = {
  type: "text";
  text: string;
  textSignature?: string;
};

export type PendingCommentaryTags = Map<AssistantTextPhaseBlock, string>;

const EMPTY_ASSISTANT_TEXT_BLOCK_SET: ReadonlySet<unknown> = new Set();

function isAssistantTextPhaseBlock(block: unknown): block is AssistantTextPhaseBlock {
  if (!block || typeof block !== "object") {
    return false;
  }
  const record = block as { type?: unknown; text?: unknown };
  return record.type === "text" && typeof record.text === "string";
}

function encodeAssistantTextSignatureV1(id: string, phase?: "commentary" | "final_answer"): string {
  return JSON.stringify({ v: 1, id, ...(phase ? { phase } : {}) });
}

function tagUnphasedText(
  content: ReadonlyArray<unknown>,
  phase: "commentary" | "final_answer",
  idPrefix: string,
): PendingCommentaryTags {
  const textBlocks = content.filter(isAssistantTextPhaseBlock);
  let phaseIndex = textBlocks.filter((block) => block.textSignature !== undefined).length;
  const tagged: PendingCommentaryTags = new Map();
  for (const block of textBlocks) {
    if (block.text.trim().length === 0 || block.textSignature !== undefined) {
      continue;
    }
    // Responses carry no run-scoped identity, so a response-local index aliases
    // segments across responses (every response's first commentary becomes
    // `<prefix>-0`) and collapses distinct stream-reconciliation rows. Entropy
    // keeps each generated identity unique per segment. History fallbacks must
    // copy this signature so phase filters can keep commentary out of the
    // visible final answer.
    const signature = encodeAssistantTextSignatureV1(
      `${idPrefix}-${phaseIndex}-${randomUUID().replaceAll("-", "").slice(0, 24)}`,
      phase,
    );
    block.textSignature = signature;
    tagged.set(block, signature);
    phaseIndex += 1;
  }
  return tagged;
}

/** Prefix for MiniMax pre-tool narration that Control UI should keep off the live thread. */
const MINIMAX_COMMENTARY_ID_PREFIX = "minimax-commentary";

/** Ordinary OpenClaw-generated commentary identities (visible per #135081). */
const COMMENTARY_ID_PREFIX = "commentary";

function resolveCommentaryIdPrefix(provider: string | undefined): string {
  const normalized = typeof provider === "string" ? provider.trim().toLowerCase() : "";
  return normalized === "minimax" ||
    normalized === "minimax-portal" ||
    normalized === "minimax-cn" ||
    normalized === "minimax-portal-cn"
    ? MINIMAX_COMMENTARY_ID_PREFIX
    : COMMENTARY_ID_PREFIX;
}

/** Tags unphased narration before a tool-call event becomes consumer-visible. */
export function tagPendingCommentaryText(
  content: ReadonlyArray<unknown>,
  options?: { idPrefix?: string; provider?: string },
): PendingCommentaryTags {
  const idPrefix =
    options?.idPrefix ??
    (options?.provider !== undefined
      ? resolveCommentaryIdPrefix(options.provider)
      : COMMENTARY_ID_PREFIX);
  return tagUnphasedText(content, "commentary", idPrefix);
}

/** Records the confirmed final-answer boundary after reasoning resumes. */
export function tagInterruptedTextPhases(
  content: ReadonlyArray<unknown>,
  interruptedText: unknown,
  preservedVisibleText: ReadonlySet<unknown> = EMPTY_ASSISTANT_TEXT_BLOCK_SET,
): void {
  const interruptedTextIndex = content.indexOf(interruptedText);
  if (interruptedTextIndex === -1) {
    return;
  }
  const finalAnswerIndex = content.findIndex(
    (block, index) =>
      index > interruptedTextIndex &&
      isAssistantTextPhaseBlock(block) &&
      block.text.trim().length > 0,
  );
  if (finalAnswerIndex === -1) {
    return;
  }
  tagUnphasedText(
    content.slice(0, finalAnswerIndex).filter((block) => !preservedVisibleText.has(block)),
    "commentary",
    "commentary",
  );
  tagUnphasedText(
    content.filter((block, index) => index >= finalAnswerIndex || preservedVisibleText.has(block)),
    "final_answer",
    "final-answer",
  );
}

/** Prevents unresolved completion text from becoming a fallback answer after stream failure. */
export function tagUnresolvedTextAsCommentary(message: {
  content: ReadonlyArray<unknown>;
  openclawDelivery?: { textPhaseRequiresTerminal?: true };
}): void {
  if (message.openclawDelivery?.textPhaseRequiresTerminal) {
    tagUnphasedText(message.content, "commentary", "commentary");
  }
}

/** Rolls back only the exact provisional signatures created by this transport turn. */
export function clearPendingCommentaryText(tags: PendingCommentaryTags): void {
  for (const [block, signature] of tags) {
    if (block.textSignature === signature) {
      delete block.textSignature;
    }
  }
  tags.clear();
}

export function rememberPendingCommentaryTags(
  target: PendingCommentaryTags,
  tagged: PendingCommentaryTags,
): void {
  for (const [block, signature] of tagged) {
    target.set(block, signature);
  }
}
