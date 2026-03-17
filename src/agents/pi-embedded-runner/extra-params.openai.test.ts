import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { captureEnv } from "../../test-utils/env.js";
import { applyExtraParamsToAgent } from "./extra-params.js";

type CapturedCall = {
  headers?: Record<string, string>;
};

function applyAndCapture(params: {
  provider: string;
  modelId: string;
  baseUrl?: string;
  callerHeaders?: Record<string, string>;
}): CapturedCall {
  const captured: CapturedCall = {};
  const baseStreamFn: StreamFn = (model, _context, options) => {
    captured.headers = options?.headers;
    options?.onPayload?.({}, model);
    return createAssistantMessageEventStream();
  };
  const agent = { streamFn: baseStreamFn };

  applyExtraParamsToAgent(agent, undefined, params.provider, params.modelId);

  const model = {
    api: "openai-responses",
    provider: params.provider,
    id: params.modelId,
    baseUrl: params.baseUrl,
  } as Model<"openai-responses">;
  const context: Context = { messages: [] };

  void agent.streamFn?.(model, context, { headers: params.callerHeaders });

  return captured;
}

describe("extra-params: OpenAI attribution", () => {
  const envSnapshot = captureEnv(["OPENCLAW_VERSION"]);

  afterEach(() => {
    envSnapshot.restore();
  });

  it("injects originator and release-based user agent for native OpenAI", () => {
    process.env.OPENCLAW_VERSION = "2026.3.14";

    const { headers } = applyAndCapture({
      provider: "openai",
      modelId: "gpt-5.4",
      baseUrl: "https://api.openai.com/v1",
    });

    expect(headers).toEqual({
      originator: "openclaw",
      "User-Agent": "openclaw/2026.3.14",
    });
  });

  it("overrides caller-supplied OpenAI attribution headers", () => {
    process.env.OPENCLAW_VERSION = "2026.3.14";

    const { headers } = applyAndCapture({
      provider: "openai",
      modelId: "gpt-5.4",
      baseUrl: "https://api.openai.com/v1",
      callerHeaders: {
        originator: "spoofed",
        "User-Agent": "spoofed/0.0.0",
        "X-Custom": "1",
      },
    });

    expect(headers).toEqual({
      originator: "openclaw",
      "User-Agent": "openclaw/2026.3.14",
      "X-Custom": "1",
    });
  });

  it("does not inject attribution on non-native OpenAI-compatible base URLs", () => {
    process.env.OPENCLAW_VERSION = "2026.3.14";

    const { headers } = applyAndCapture({
      provider: "openai",
      modelId: "gpt-5.4",
      baseUrl: "https://proxy.example.com/v1",
    });

    expect(headers).toBeUndefined();
  });

  it("injects attribution for ChatGPT-backed OpenAI Codex traffic", () => {
    process.env.OPENCLAW_VERSION = "2026.3.14";

    const { headers } = applyAndCapture({
      provider: "openai-codex",
      modelId: "gpt-5.4",
      baseUrl: "https://chatgpt.com/backend-api",
    });

    expect(headers).toEqual({
      originator: "openclaw",
      "User-Agent": "openclaw/2026.3.14",
    });
  });
});
