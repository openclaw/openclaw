import type { Model } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
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

describe("extra-params: tool choice forwarding", () => {
  it("forwards tool_choice from agent model params into stream options", () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.4": {
              params: {
                tool_choice: "required",
              },
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    const capture = runExtraParamsCase({
      applyModelId: "gpt-5.4",
      applyProvider: "openai",
      cfg,
      model: {
        api: "openai-completions",
        provider: "openai",
        id: "gpt-5.4",
      } as Model<"openai-completions">,
      payload: {},
    });

    expect((capture.options as { toolChoice?: string } | undefined)?.toolChoice).toBe("required");
  });
});
