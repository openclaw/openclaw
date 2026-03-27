import type { Model } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { captureEnv } from "../../test-utils/env.js";
import { runExtraParamsCase } from "./extra-params.test-support.js";

function applyAndCapture(params: {
  provider: string;
  modelId: string;
  baseUrl?: string;
  callerHeaders?: Record<string, string>;
}) {
  return runExtraParamsCase({
    applyModelId: params.modelId,
    applyProvider: params.provider,
    callerHeaders: params.callerHeaders,
    model: {
      api: "openai-responses",
      provider: params.provider,
      id: params.modelId,
      baseUrl: params.baseUrl,
    } as Model<"openai-responses">,
    payload: {},
  });
}

describe("extra-params: OpenAI attribution", () => {
  const envSnapshot = captureEnv(["OPENCLAW_VERSION"]);

  afterEach(() => {
    envSnapshot.restore();
  });

  it("injects originator and release-based user agent for native OpenAI", () => {
    process.env.OPENCLAW_VERSION = "2026.3.22";

    const { headers } = applyAndCapture({
      provider: "openai",
      modelId: "gpt-5.4",
      baseUrl: "https://api.openai.com/v1",
    });

    expect(headers).toEqual({
      originator: "openclaw",
      version: "2026.3.22",
      "User-Agent": "openclaw/2026.3.22",
    });
  });

  it("overrides caller-supplied OpenAI attribution headers", () => {
    process.env.OPENCLAW_VERSION = "2026.3.22";

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
      version: "2026.3.22",
      "User-Agent": "openclaw/2026.3.22",
      "X-Custom": "1",
    });
  });

  it("does not inject attribution on non-native OpenAI-compatible base URLs", () => {
    process.env.OPENCLAW_VERSION = "2026.3.22";

    const { headers } = applyAndCapture({
      provider: "openai",
      modelId: "gpt-5.4",
      baseUrl: "https://proxy.example.com/v1",
    });

    expect(headers).toBeUndefined();
  });

  it("injects attribution for ChatGPT-backed OpenAI Codex traffic", () => {
    process.env.OPENCLAW_VERSION = "2026.3.22";

    const { headers } = applyAndCapture({
      provider: "openai-codex",
      modelId: "gpt-5.4",
      baseUrl: "https://chatgpt.com/backend-api",
    });

    expect(headers).toEqual({
      originator: "openclaw",
      version: "2026.3.22",
      "User-Agent": "openclaw/2026.3.22",
    });
  });
});
