export function resolveLiveCompletionSessionId(model: { provider: string; id: string }): string {
  return `models-profiles-live:${model.provider}:${model.id}`;
}

export function resolveLiveSystemPrompt(model: { provider: string }): string | undefined {
  if (model.provider === "openai") {
    return "You are a concise assistant. Follow the user's instruction exactly.";
  }
  return undefined;
}
