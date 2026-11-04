export function resolveBedrockSamplingConfig(
  modelId: string,
  adaptiveThinking: boolean,
  temperature: number | undefined,
): { temperature?: number } {
  // These confirmed Grok 4.6 Converse profiles reject sampling parameters.
  if (
    temperature === undefined ||
    adaptiveThinking ||
    modelId === "us.xai.grok-4.6" ||
    modelId === "global.xai.grok-4.6"
  ) {
    return {};
  }
  return { temperature };
}
