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

const ACK_ONLY_PATTERNS = [
  /\b(i['’]?ll|i will|let me|going to)\b/i,
  /\b(acknowledged|understood|got it|on it|working on it|i can do that)\b/i,
] as const;

const RESULT_LIKE_PATTERNS = [
  /\b(done|completed|finished|here(?:'|’)s|result|output|found|fixed|updated)\b/i,
  /```/,
  /\n\s*[-*]\s+/,
] as const;

function hasToolRequiredPromptMarkers(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  let markerCount = 0;
  for (const marker of TOOL_REQUIRED_PROMPT_MARKERS) {
    if (normalized.includes(marker)) {
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
    params.didSendViaMessagingTool ||
    params.hasClientToolCall ||
    params.toolMetas.length > 0
  ) {
    return false;
  }

  if (!hasToolRequiredPromptMarkers(params.prompt)) {
    return false;
  }

  const stopReason = params.lastAssistant?.stopReason;
  if (stopReason === "error" || stopReason === "toolUse") {
    return false;
  }

  const primaryText =
    params.assistantTexts.find((text) => text.trim().length > 0) ??
    (typeof params.lastAssistant?.content?.[0] === "object" &&
    params.lastAssistant.content[0] &&
    "type" in params.lastAssistant.content[0] &&
    params.lastAssistant.content[0].type === "text" &&
    "text" in params.lastAssistant.content[0] &&
    typeof params.lastAssistant.content[0].text === "string"
      ? params.lastAssistant.content[0].text
      : "");

  if (!primaryText) {
    return false;
  }

  return isLikelyAckOnlyText(primaryText);
}
