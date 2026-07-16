import "./tts.js";

function requireTestApi(symbolName: string): unknown {
  const api = Reflect.get(globalThis, Symbol.for(symbolName));
  if (!api) {
    throw new Error(`OpenAI test API is unavailable: ${symbolName}`);
  }
  return api;
}

export const { resolveOpenAITtsInstructions } = requireTestApi("openclaw.openaiTtsTestApi") as {
  resolveOpenAITtsInstructions: (
    model: string,
    instructions?: string,
    baseUrl?: string,
  ) => string | undefined;
};
