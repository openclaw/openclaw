// Slack plugin module owns assistant suggested prompt normalization.

export type SlackAssistantSuggestedPrompt = {
  title: string;
  message: string;
};

export type SlackAssistantPromptsConfig =
  | false
  | {
      title?: string;
      prompts: SlackAssistantSuggestedPrompt[];
    };

export const DEFAULT_ASSISTANT_PROMPTS_TITLE = "Try asking";

export const DEFAULT_ASSISTANT_PROMPTS: SlackAssistantSuggestedPrompt[] = [
  { title: "What can you do?", message: "What can you help me with?" },
  { title: "Summarize this channel", message: "Summarize the recent activity in this channel." },
  { title: "Draft a reply", message: "Help me draft a reply." },
];

function normalizePrompt(value: unknown): SlackAssistantSuggestedPrompt | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const title = typeof record.title === "string" ? record.title.trim() : "";
  const message = typeof record.message === "string" ? record.message.trim() : "";
  return title && message ? { title, message } : undefined;
}

export function normalizeSlackAssistantSuggestedPrompts(
  value: unknown,
): SlackAssistantSuggestedPrompt[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .flatMap((entry) => {
      const prompt = normalizePrompt(entry);
      return prompt ? [prompt] : [];
    })
    .slice(0, 4);
}

export function resolveSlackAssistantPromptsConfig(
  config: SlackAssistantPromptsConfig | undefined,
):
  | {
      title?: string;
      prompts: SlackAssistantSuggestedPrompt[];
    }
  | undefined {
  if (config === false) {
    return undefined;
  }
  const source = config ?? {
    title: DEFAULT_ASSISTANT_PROMPTS_TITLE,
    prompts: DEFAULT_ASSISTANT_PROMPTS,
  };
  const prompts = normalizeSlackAssistantSuggestedPrompts(source.prompts);
  if (prompts.length === 0) {
    return undefined;
  }
  const title = source.title?.trim();
  return {
    ...(title ? { title } : {}),
    prompts,
  };
}
