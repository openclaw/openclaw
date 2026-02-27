import type { AssistantMessage } from "@mariozechner/pi-ai";

export const TOOLLESS_ACK_MAX_RETRIES = 2;

const TOOL_REQUIRED_PROMPT_MARKERS = [
  "run",
  "test",
  "fix",
  "edit",
  "update",
  "read",
  "open",
  "inspect",
  "debug",
  "refactor",
  "implement",
  "commit",
  "file",
  "repo",
  "workspace",
  "command",
  "terminal",
  "logs",
] as const;

const TOOL_HELP_QUESTION_PATTERNS = [
  /\bwhat command\b/i,
  /\bwhich command\b/i,
  /\bhow (?:do|can) i\b/i,
  /\bhow (?:do|can) we\b/i,
  /\bcan you (?:explain|show|tell)(?: me)? (?:how|what|which|why|where)\b/i,
  /\bcan you (?:explain|show|tell)(?: me)? (?:the )?(?:command|steps?|way)\b/i,
  /\bcould you (?:explain|show|tell)(?: me)? (?:how|what|which|why|where)\b/i,
  /\bcould you (?:explain|show|tell)(?: me)? (?:the )?(?:command|steps?|way)\b/i,
  /^\s*how to\b/i,
  /\bshould i (?:run|use)\b/i,
  /\b(?:explain|show|tell)(?: me)? (?:the )?command\b/i,
  /^(?:explain|show|tell)(?: me)? (?:how|what|which|why|where)\b/i,
  /^(?:explain|show|tell)(?: me)? (?:the )?(?:command|steps?|way)\b/i,
] as const;

const ACK_ONLY_PATTERNS = [
  /\b(i['’]?ll|i will|let me|going to)\b/i,
  /\b(acknowledged|understood|got it|on it|working on it|i can do that)\b/i,
] as const;

const RESULT_LIKE_PATTERNS = [
  /\b(done|completed|finished|here(?:'|’)s|result|found)\b/i,
  /```/,
  /\n\s*[-*]\s+/,
] as const;

function hasToolRequiredPromptMarkers(prompt: string): boolean {
  const tokens = new Set(
    prompt
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .filter((token) => token.length > 0),
  );
  let markerCount = 0;
  for (const marker of TOOL_REQUIRED_PROMPT_MARKERS) {
    if (tokens.has(marker)) {
      markerCount += 1;
      if (markerCount >= 2) {
        return true;
      }
    }
  }
  return false;
}

function isLikelyAckOnlyText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 8 || trimmed.length > 320) {
    return false;
  }
  if (RESULT_LIKE_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return false;
  }
  return ACK_ONLY_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function isLikelyToolHelpQuestion(prompt: string): boolean {
  const trimmed = prompt.trim();
  return TOOL_HELP_QUESTION_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function extractLatestAssistantText(params: {
  assistantTexts: string[];
  lastAssistant?: AssistantMessage;
}): string {
  const lastChunk = [...params.assistantTexts]
    .toReversed()
    .find((text) => typeof text === "string" && text.trim().length > 0);
  if (lastChunk) {
    return lastChunk;
  }

  const content = params.lastAssistant?.content;
  if (!Array.isArray(content)) {
    return "";
  }

  const textBlocks: string[] = [];
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      "type" in block &&
      block.type === "text" &&
      "text" in block &&
      typeof block.text === "string" &&
      block.text.trim().length > 0
    ) {
      textBlocks.push(block.text);
    }
  }

  return textBlocks.at(-1) ?? "";
}

export function buildToolRequiredRetryPrompt(prompt: string): string {
  return (
    `${prompt}\n\n` +
    "Important: if this task requires actions in the workspace, do not send an acknowledgement-only response. " +
    "Call the required tools first, then report concrete results."
  );
}

export function shouldRetryToolRequiredToolless(params: {
  provider: string;
  prompt: string;
  assistantTexts: string[];
  lastAssistant?: AssistantMessage;
  toolMetas: Array<{ toolName: string; meta?: string }>;
  didSendViaMessagingTool: boolean;
  hasClientToolCall: boolean;
  disableTools: boolean;
  promptError: unknown;
  aborted: boolean;
  timedOut: boolean;
  timedOutDuringCompaction: boolean;
}): boolean {
  if (params.provider !== "openai-codex") {
    return false;
  }
  if (
    params.promptError ||
    params.aborted ||
    params.timedOut ||
    params.timedOutDuringCompaction ||
    params.disableTools ||
    params.didSendViaMessagingTool ||
    params.hasClientToolCall ||
    params.toolMetas.length > 0
  ) {
    return false;
  }

  if (!hasToolRequiredPromptMarkers(params.prompt)) {
    return false;
  }
  if (isLikelyToolHelpQuestion(params.prompt)) {
    return false;
  }

  const stopReason = params.lastAssistant?.stopReason;
  if (stopReason === "error" || stopReason === "toolUse") {
    return false;
  }

  const primaryText = extractLatestAssistantText({
    assistantTexts: params.assistantTexts,
    lastAssistant: params.lastAssistant,
  });

  if (!primaryText) {
    return false;
  }

  return isLikelyAckOnlyText(primaryText);
}
