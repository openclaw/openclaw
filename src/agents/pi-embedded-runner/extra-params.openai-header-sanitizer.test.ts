import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { applyExtraParamsToAgent } from "./extra-params.js";

function runSanitizer(params: {
  provider: string;
  modelApi: "openai-completions" | "openai-responses" | "anthropic-messages";
  inputHeaders: Record<string, string>;
}) {
  const seen: Array<Record<string, string> | undefined> = [];
  const baseStreamFn: StreamFn = (_model, _context, options) => {
    seen.push(options?.headers);
    return createAssistantMessageEventStream();
  };
  const agent = { streamFn: baseStreamFn };

  applyExtraParamsToAgent(agent, undefined, params.provider, "test-model");

  const model = {
    api: params.modelApi,
    provider: params.provider,
    id: "test-model",
  } as Model<typeof params.modelApi>;
  const context: Context = { messages: [] };

  void agent.streamFn?.(model, context, { headers: params.inputHeaders });
  return seen[0];
}

describe("extra-params: OpenAI compat header sanitizer", () => {
  it("strips x-stainless-* headers for openai-completions", () => {
    const headers = runSanitizer({
      provider: "custom",
      modelApi: "openai-completions",
      inputHeaders: {
        Authorization: "Bearer test",
        "User-Agent": "OpenClaw/1.0",
        "x-stainless-os": "MacOS",
        "x-stainless-runtime": "node",
      },
    });

    expect(headers).toEqual({
      Authorization: "Bearer test",
      "User-Agent": "OpenClaw/1.0",
    });
  });

  it("preserves non-stainless headers", () => {
    const headers = runSanitizer({
      provider: "custom",
      modelApi: "openai-responses",
      inputHeaders: {
        Authorization: "Bearer test",
        "x-foo": "bar",
      },
    });

    expect(headers).toEqual({
      Authorization: "Bearer test",
      "x-foo": "bar",
    });
  });

  it("does not sanitize non-openai-compatible apis", () => {
    const inputHeaders = {
      Authorization: "Bearer test",
      "x-stainless-os": "MacOS",
    };
    const headers = runSanitizer({
      provider: "anthropic",
      modelApi: "anthropic-messages",
      inputHeaders,
    });

    expect(headers).toEqual(inputHeaders);
  });
});
