type PromptSubmissionSkipReason = "blank_user_prompt" | "empty_prompt_history_images";

/** Classifies prompt submissions that have no visible current-turn content. */
export function resolvePromptSubmissionSkipReason(params: {
  prompt: string;
  messages: readonly unknown[];
  imageCount: number;
  videoCount?: number;
  runtimeOnly?: boolean;
}): PromptSubmissionSkipReason | null {
  if (params.prompt.trim().length > 0 || params.imageCount > 0 || (params.videoCount ?? 0) > 0) {
    return null;
  }
  return params.messages.some(hasVisiblePromptHistory)
    ? "blank_user_prompt"
    : "empty_prompt_history_images";
}

function hasVisiblePromptHistory(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const record = message as { role?: unknown; content?: unknown };
  if (record.role !== "user" && record.role !== "assistant") {
    return false;
  }
  return hasNonEmptyContent(record.content);
}

function hasNonEmptyContent(content: unknown): boolean {
  if (typeof content === "string") {
    return content.trim().length > 0;
  }
  if (Array.isArray(content)) {
    return content.some(hasNonEmptyContent);
  }
  if (!content || typeof content !== "object") {
    return false;
  }
  const record = content as { type?: unknown; text?: unknown; content?: unknown; data?: unknown };
  if ((record.type === "image" || record.type === "video") && typeof record.data === "string") {
    return record.data.length > 0;
  }
  return hasNonEmptyContent(record.text) || hasNonEmptyContent(record.content);
}
