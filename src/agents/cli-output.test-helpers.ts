export function createOpenAiCompatibleCliUsageCases() {
  return [
    {
      name: "standard OpenAI snake_case token fields",
      raw: {
        prompt_tokens: 17,
        completion_tokens: 5,
        total_tokens: 22,
        prompt_tokens_details: { cached_tokens: 6 },
      },
      normalized: { input: 11, output: 5, cacheRead: 6, cacheWrite: undefined, total: 22 },
    },
    {
      name: "camelCase OpenAI-compatible token fields",
      raw: {
        promptTokens: 17,
        completionTokens: 5,
        total_tokens: 22,
        prompt_tokens_details: { cached_tokens: 6 },
      },
      normalized: { input: 11, output: 5, cacheRead: 6, cacheWrite: undefined, total: 22 },
    },
    {
      name: "existing input/output field precedence",
      raw: {
        input_tokens: 19,
        prompt_tokens: 99,
        output_tokens: 7,
        completion_tokens: 77,
        total_tokens: 26,
        prompt_tokens_details: { cached_tokens: 4 },
      },
      normalized: { input: 15, output: 7, cacheRead: 4, cacheWrite: undefined, total: 26 },
    },
    {
      name: "flat Codex cached input is included in input_tokens",
      raw: {
        input_tokens: 15,
        output_tokens: 4,
        cached_input_tokens: 6,
      },
      normalized: { input: 9, output: 4, cacheRead: 6, cacheWrite: undefined, total: undefined },
    },
    {
      name: "flat Codex input includes both cached reads and cache writes",
      raw: {
        input_tokens: 100,
        output_tokens: 10,
        cached_input_tokens: 40,
        cache_write_input_tokens: 60,
      },
      normalized: { input: 0, output: 10, cacheRead: 40, cacheWrite: 60, total: undefined },
    },
    {
      name: "nested Codex input includes both cached reads and cache writes",
      raw: {
        input_tokens: 100,
        output_tokens: 10,
        input_tokens_details: { cached_tokens: 40, cache_write_tokens: 60 },
      },
      normalized: { input: 0, output: 10, cacheRead: 40, cacheWrite: 60, total: undefined },
    },
  ] as const;
}

export function joinJsonlFrames(...frames: unknown[]) {
  return frames
    .map((frame) => (typeof frame === "string" ? frame : JSON.stringify(frame)))
    .join("\n");
}

export function claudeStreamEvent(event: Record<string, unknown>) {
  return { type: "stream_event", event };
}

export function claudeTextDelta(text: string, index?: number | string) {
  return claudeStreamEvent({
    type: "content_block_delta",
    ...(index === undefined ? {} : { index }),
    delta: { type: "text_delta", text },
  });
}
