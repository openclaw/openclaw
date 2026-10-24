import type { CliJsonlStreamingParserOptions } from "./cli-output-contracts.js";
import { createCliJsonlStreamingParser } from "./cli-output-stream.js";

export const localCliBackend: CliJsonlStreamingParserOptions["backend"] = {
  command: "local-cli",
  output: "jsonl",
  jsonlDialect: "claude-stream-json",
  sessionIdFields: ["session_id"],
};

export function createClaudeBackend(
  command = "local-cli",
): CliJsonlStreamingParserOptions["backend"] {
  return { ...localCliBackend, command, sessionIdFields: ["session_id"] };
}

export function createPluginParser(overrides: Partial<CliJsonlStreamingParserOptions> = {}) {
  return createCliJsonlStreamingParser({
    backend: { command: "acme", output: "jsonl" },
    providerId: "acme-cli",
    onAssistantDelta: () => {},
    ...overrides,
  });
}

export function finishCliFrames(
  parser: ReturnType<typeof createClaudeParser>,
  ...frames: unknown[]
) {
  parser.push(joinJsonlFrames(...frames));
  parser.finish();
}

export function claudeMessageStart(id?: string) {
  return claudeStreamEvent({ type: "message_start", ...(id ? { message: { id } } : {}) });
}
export const claudeMessageStop = () => claudeStreamEvent({ type: "message_stop" });

export function createClaudeParser(overrides: Partial<CliJsonlStreamingParserOptions> = {}) {
  return createCliJsonlStreamingParser({
    backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
    providerId: "claude-cli",
    onAssistantDelta: () => {},
    ...overrides,
  });
}

export function createOpenAiCompatibleCliUsageCases() {
  const openAiExpected = { input: 11, output: 5, cacheRead: 6, cacheWrite: undefined, total: 22 };
  const cached = { input: 0, output: 10, cacheRead: 40, cacheWrite: 60, total: undefined };
  const openAiMetadata = { total_tokens: 22, prompt_tokens_details: { cached_tokens: 6 } };
  const cachedInput = { input_tokens: 100, output_tokens: 10 };
  return [
    {
      name: "OpenAI snake_case",
      raw: { prompt_tokens: 17, completion_tokens: 5, ...openAiMetadata },
      normalized: openAiExpected,
    },
    {
      name: "OpenAI camelCase",
      raw: { promptTokens: 17, completionTokens: 5, ...openAiMetadata },
      normalized: openAiExpected,
    },
    {
      name: "input/output field precedence",
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
      name: "Codex cached input",
      raw: { input_tokens: 15, output_tokens: 4, cached_input_tokens: 6 },
      normalized: { input: 9, output: 4, cacheRead: 6, cacheWrite: undefined, total: undefined },
    },
    {
      name: "Codex flat cache reads/writes",
      raw: { ...cachedInput, cached_input_tokens: 40, cache_write_input_tokens: 60 },
      normalized: cached,
    },
    {
      name: "Codex nested cache reads/writes",
      raw: { ...cachedInput, input_tokens_details: { cached_tokens: 40, cache_write_tokens: 60 } },
      normalized: cached,
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

function indexedEvent(type: string, index: number | string | undefined, fields = {}) {
  return claudeStreamEvent({ type, ...(index === undefined ? {} : { index }), ...fields });
}

export function claudeBlockStart(contentBlock: Record<string, unknown>, index?: number) {
  return indexedEvent("content_block_start", index, { content_block: contentBlock });
}

export const claudeBlockStop = (index?: number) => indexedEvent("content_block_stop", index);

export function claudeInputJsonDelta(partialJson: string, index?: number) {
  return indexedEvent("content_block_delta", index, {
    delta: { type: "input_json_delta", partial_json: partialJson },
  });
}

export function claudeTextDelta(text: string, index?: number | string) {
  return indexedEvent("content_block_delta", index, { delta: { type: "text_delta", text } });
}
