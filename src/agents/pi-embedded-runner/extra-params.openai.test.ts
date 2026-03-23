import type { Model } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { captureEnv } from "../../test-utils/env.js";
import { runExtraParamsCase } from "./extra-params.test-support.js";

function makeModel<
  TApi extends "openai-completions" | "openai-responses" | "openai-codex-responses",
>(model: Pick<Model<TApi>, "api" | "provider" | "id"> & Partial<Model<TApi>>): Model<TApi> {
  return {
    name: model.id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1,
    maxTokens: 1,
    ...model,
  } as Model<TApi>;
}

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
      "User-Agent": "openclaw/2026.3.22",
    });
  });
});

describe("extra-params: OpenAI-compatible tool payloads", () => {
  it("strips function.strict for non-native openai-completions endpoints", () => {
    const payload = runExtraParamsCase({
      applyProvider: "lmstudio",
      applyModelId: "nemotron-nano-3",
      model: makeModel({
        api: "openai-completions",
        provider: "lmstudio",
        id: "nemotron-nano-3",
        baseUrl: "http://lmstudio.local:1234/v1",
        compat: { supportsStrictMode: false },
      }),
      payload: {
        tools: [
          {
            type: "function",
            function: {
              name: "web_search",
              description: "search the web",
              parameters: { type: "object", properties: {} },
              strict: true,
            },
          },
        ],
      },
    }).payload as {
      tools?: Array<{ function?: Record<string, unknown> }>;
    };

    expect(payload.tools?.[0]?.function).not.toHaveProperty("strict");
  });

  it("keeps function.strict when compat explicitly enables it on non-native endpoints", () => {
    const payload = runExtraParamsCase({
      applyProvider: "custom-openai",
      applyModelId: "tool-friendly-model",
      model: makeModel({
        api: "openai-responses",
        provider: "custom-openai",
        id: "tool-friendly-model",
        baseUrl: "https://proxy.example.com/v1",
        compat: { supportsStrictMode: true },
      }),
      payload: {
        tools: [
          {
            type: "function",
            function: {
              name: "web_search",
              description: "search the web",
              parameters: { type: "object", properties: {} },
              strict: true,
            },
          },
        ],
      },
    }).payload as {
      tools?: Array<{ function?: Record<string, unknown> }>;
    };

    expect(payload.tools?.[0]?.function?.strict).toBe(true);
  });

  it("keeps function.strict for native openai-responses with no explicit baseUrl", () => {
    const payload = runExtraParamsCase({
      applyProvider: "openai",
      applyModelId: "gpt-4o",
      model: makeModel({
        api: "openai-responses",
        provider: "openai",
        id: "gpt-4o",
      }),
      payload: {
        tools: [
          {
            type: "function",
            function: {
              name: "web_search",
              parameters: { type: "object", properties: {} },
              strict: true,
            },
          },
        ],
      },
    }).payload as {
      tools?: Array<{ function?: Record<string, unknown> }>;
    };

    expect(payload.tools?.[0]?.function?.strict).toBe(true);
  });

  it("strips function.strict for non-native openai-codex-responses endpoints", () => {
    const payload = runExtraParamsCase({
      applyProvider: "openai-codex",
      applyModelId: "gpt-5.4",
      model: makeModel({
        api: "openai-codex-responses",
        provider: "openai-codex",
        id: "gpt-5.4",
        baseUrl: "https://proxy.example.com/backend-api",
      }),
      payload: {
        tools: [
          {
            type: "function",
            function: {
              name: "web_search",
              parameters: { type: "object", properties: {} },
              strict: true,
            },
          },
        ],
      },
    }).payload as {
      tools?: Array<{ function?: Record<string, unknown> }>;
    };

    expect(payload.tools?.[0]?.function).not.toHaveProperty("strict");
  });

  it("keeps function.strict for OpenRouter Anthropic routes with structured outputs enabled", () => {
    const payload = runExtraParamsCase({
      applyProvider: "openrouter",
      applyModelId: "anthropic/claude-sonnet-4",
      model: makeModel({
        api: "openai-completions",
        provider: "openrouter",
        id: "anthropic/claude-sonnet-4",
        baseUrl: "https://openrouter.ai/api/v1",
        headers: { "x-anthropic-beta": "structured-outputs-2025-11-13" },
      }),
      payload: {
        tools: [
          {
            type: "function",
            function: {
              name: "web_search",
              parameters: { type: "object", properties: {} },
              strict: true,
            },
          },
        ],
      },
    }).payload as {
      tools?: Array<{ function?: Record<string, unknown> }>;
    };

    expect(payload.tools?.[0]?.function?.strict).toBe(true);
  });

  it("keeps function.strict when a later-cased OpenRouter Anthropic beta header opts in", () => {
    const payload = runExtraParamsCase({
      applyProvider: "openrouter",
      applyModelId: "anthropic/claude-sonnet-4",
      model: makeModel({
        api: "openai-completions",
        provider: "openrouter",
        id: "anthropic/claude-sonnet-4",
        baseUrl: "https://openrouter.ai/api/v1",
        headers: {
          "x-anthropic-beta": "other-beta",
          "X-Anthropic-Beta": "structured-outputs-2025-11-13",
        },
      }),
      payload: {
        tools: [
          {
            type: "function",
            function: {
              name: "web_search",
              parameters: { type: "object", properties: {} },
              strict: true,
            },
          },
        ],
      },
    }).payload as {
      tools?: Array<{ function?: Record<string, unknown> }>;
    };

    expect(payload.tools?.[0]?.function?.strict).toBe(true);
  });

  it("keeps function.strict for OpenRouter OpenAI-backed routes", () => {
    const payload = runExtraParamsCase({
      applyProvider: "openrouter",
      applyModelId: "openai/gpt-4o",
      model: makeModel({
        api: "openai-completions",
        provider: "openrouter",
        id: "openai/gpt-4o",
        baseUrl: "https://openrouter.ai/api/v1",
      }),
      payload: {
        tools: [
          {
            type: "function",
            function: {
              name: "web_search",
              parameters: { type: "object", properties: {} },
              strict: true,
            },
          },
        ],
      },
    }).payload as {
      tools?: Array<{ function?: Record<string, unknown> }>;
    };

    expect(payload.tools?.[0]?.function?.strict).toBe(true);
  });

  it("strips function.strict when provider is openrouter but the route is a non-OpenRouter proxy", () => {
    const payload = runExtraParamsCase({
      applyProvider: "openrouter",
      applyModelId: "openai/gpt-4o",
      model: makeModel({
        api: "openai-completions",
        provider: "openrouter",
        id: "openai/gpt-4o",
        baseUrl: "https://proxy.example.com/v1",
      }),
      payload: {
        tools: [
          {
            type: "function",
            function: {
              name: "web_search",
              parameters: { type: "object", properties: {} },
              strict: true,
            },
          },
        ],
      },
    }).payload as {
      tools?: Array<{ function?: Record<string, unknown> }>;
    };

    expect(payload.tools?.[0]?.function).not.toHaveProperty("strict");
  });

  it("keeps function.strict for custom providers routed to OpenRouter", () => {
    const payload = runExtraParamsCase({
      applyProvider: "custom-router",
      applyModelId: "openai/gpt-4o",
      model: makeModel({
        api: "openai-completions",
        provider: "custom-router",
        id: "openai/gpt-4o",
        baseUrl: "https://openrouter.ai/api/v1",
      }),
      payload: {
        tools: [
          {
            type: "function",
            function: {
              name: "web_search",
              parameters: { type: "object", properties: {} },
              strict: true,
            },
          },
        ],
      },
    }).payload as {
      tools?: Array<{ function?: Record<string, unknown> }>;
    };

    expect(payload.tools?.[0]?.function?.strict).toBe(true);
  });

  it("strips function.strict when provider.only does not guarantee an exclusive OpenAI route", () => {
    const payload = runExtraParamsCase({
      applyProvider: "openrouter",
      applyModelId: "auto",
      cfg: {
        agents: {
          defaults: {
            models: {
              "openrouter/auto": {
                params: {
                  provider: {
                    only: ["openai"],
                  },
                },
              },
            },
          },
        },
      },
      model: makeModel({
        api: "openai-completions",
        provider: "openrouter",
        id: "auto",
        baseUrl: "https://openrouter.ai/api/v1",
      }),
      payload: {
        tools: [
          {
            type: "function",
            function: {
              name: "web_search",
              parameters: { type: "object", properties: {} },
              strict: true,
            },
          },
        ],
      },
    }).payload as {
      tools?: Array<{ function?: Record<string, unknown> }>;
    };

    expect(payload.tools?.[0]?.function).not.toHaveProperty("strict");
  });

  it("strips function.strict when an OpenRouter route only prefers OpenAI but still allows fallbacks", () => {
    const payload = runExtraParamsCase({
      applyProvider: "openrouter",
      applyModelId: "auto",
      cfg: {
        agents: {
          defaults: {
            models: {
              "openrouter/auto": {
                params: {
                  provider: {
                    order: ["openai"],
                  },
                },
              },
            },
          },
        },
      },
      model: makeModel({
        api: "openai-completions",
        provider: "openrouter",
        id: "auto",
        baseUrl: "https://openrouter.ai/api/v1",
      }),
      payload: {
        tools: [
          {
            type: "function",
            function: {
              name: "web_search",
              parameters: { type: "object", properties: {} },
              strict: true,
            },
          },
        ],
      },
    }).payload as {
      tools?: Array<{ function?: Record<string, unknown> }>;
    };

    expect(payload.tools?.[0]?.function).not.toHaveProperty("strict");
  });

  it("keeps function.strict when an OpenRouter route disables fallbacks with allowFallbacks", () => {
    const payload = runExtraParamsCase({
      applyProvider: "openrouter",
      applyModelId: "auto",
      cfg: {
        agents: {
          defaults: {
            models: {
              "openrouter/auto": {
                params: {
                  provider: {
                    order: ["openai"],
                    allowFallbacks: false,
                  },
                },
              },
            },
          },
        },
      },
      model: makeModel({
        api: "openai-completions",
        provider: "openrouter",
        id: "auto",
        baseUrl: "https://openrouter.ai/api/v1",
      }),
      payload: {
        tools: [
          {
            type: "function",
            function: {
              name: "web_search",
              parameters: { type: "object", properties: {} },
              strict: true,
            },
          },
        ],
      },
    }).payload as {
      tools?: Array<{ function?: Record<string, unknown> }>;
    };

    expect(payload.tools?.[0]?.function?.strict).toBe(true);
  });

  it("strips function.strict when an OpenRouter OpenAI-backed route explicitly disables strict mode", () => {
    const payload = runExtraParamsCase({
      applyProvider: "openrouter",
      applyModelId: "openai/gpt-4o",
      model: makeModel({
        api: "openai-completions",
        provider: "openrouter",
        id: "openai/gpt-4o",
        baseUrl: "https://openrouter.ai/api/v1",
        compat: { supportsStrictMode: false },
      }),
      payload: {
        tools: [
          {
            type: "function",
            function: {
              name: "web_search",
              parameters: { type: "object", properties: {} },
              strict: true,
            },
          },
        ],
      },
    }).payload as {
      tools?: Array<{ function?: Record<string, unknown> }>;
    };

    expect(payload.tools?.[0]?.function).not.toHaveProperty("strict");
  });

  it("strips function.strict for non-Anthropic OpenRouter routes even with structured outputs headers", () => {
    const payload = runExtraParamsCase({
      applyProvider: "openrouter",
      applyModelId: "deepseek/deepseek-chat-v3-0324",
      model: makeModel({
        api: "openai-completions",
        provider: "openrouter",
        id: "deepseek/deepseek-chat-v3-0324",
        baseUrl: "https://openrouter.ai/api/v1",
        headers: { "x-anthropic-beta": "structured-outputs-2025-11-13" },
      }),
      payload: {
        tools: [
          {
            type: "function",
            function: {
              name: "web_search",
              parameters: { type: "object", properties: {} },
              strict: true,
            },
          },
        ],
      },
    }).payload as {
      tools?: Array<{ function?: Record<string, unknown> }>;
    };

    expect(payload.tools?.[0]?.function).not.toHaveProperty("strict");
  });

  it("strips function.strict for default-routed Anthropic OpenRouter routes", () => {
    const payload = runExtraParamsCase({
      applyProvider: "openrouter",
      applyModelId: "anthropic/claude-sonnet-4",
      model: makeModel({
        api: "openai-completions",
        provider: "openrouter",
        id: "anthropic/claude-sonnet-4",
        baseUrl: "https://openrouter.ai/api/v1",
        headers: { "x-anthropic-beta": "structured-outputs-2025-11-13" },
      }),
      payload: {
        tools: [
          {
            type: "function",
            function: {
              name: "web_search",
              parameters: { type: "object", properties: {} },
              strict: true,
            },
          },
        ],
      },
    }).payload as {
      tools?: Array<{ function?: Record<string, unknown> }>;
    };

    expect(payload.tools?.[0]?.function).not.toHaveProperty("strict");
  });

  it("preserves function.strict for Anthropic OpenRouter routes pinned to Anthropic", () => {
    const payload = runExtraParamsCase({
      applyProvider: "openrouter",
      applyModelId: "anthropic/claude-sonnet-4",
      cfg: {
        agents: {
          defaults: {
            models: {
              "openrouter/anthropic/claude-sonnet-4": {
                params: {
                  provider: {
                    providers: ["anthropic"],
                  },
                },
              },
            },
          },
        },
      },
      model: makeModel({
        api: "openai-completions",
        provider: "openrouter",
        id: "anthropic/claude-sonnet-4",
        baseUrl: "https://openrouter.ai/api/v1",
        headers: { "x-anthropic-beta": "structured-outputs-2025-11-13" },
      }),
      payload: {
        tools: [
          {
            type: "function",
            function: {
              name: "web_search",
              parameters: { type: "object", properties: {} },
              strict: true,
            },
          },
        ],
      },
    }).payload as {
      tools?: Array<{ function?: Record<string, unknown> }>;
    };

    expect(payload.tools?.[0]?.function?.strict).toBe(true);
  });

  it("strips function.strict for Anthropic model slugs when routing is pinned to a non-Anthropic provider", () => {
    const payload = runExtraParamsCase({
      applyProvider: "openrouter",
      applyModelId: "anthropic/claude-sonnet-4",
      cfg: {
        agents: {
          defaults: {
            models: {
              "openrouter/anthropic/claude-sonnet-4": {
                params: {
                  provider: {
                    providers: ["amazon-bedrock"],
                  },
                },
              },
            },
          },
        },
      },
      model: makeModel({
        api: "openai-completions",
        provider: "openrouter",
        id: "anthropic/claude-sonnet-4",
        baseUrl: "https://openrouter.ai/api/v1",
        headers: { "x-anthropic-beta": "structured-outputs-2025-11-13" },
      }),
      payload: {
        tools: [
          {
            type: "function",
            function: {
              name: "web_search",
              parameters: { type: "object", properties: {} },
              strict: true,
            },
          },
        ],
      },
    }).payload as {
      tools?: Array<{ function?: Record<string, unknown> }>;
    };

    expect(payload.tools?.[0]?.function).not.toHaveProperty("strict");
  });

  it("preserves function.strict for OpenRouter OpenAI routes pinned to Azure", () => {
    const payload = runExtraParamsCase({
      applyProvider: "openrouter",
      applyModelId: "openai/gpt-4o",
      cfg: {
        agents: {
          defaults: {
            models: {
              "openrouter/openai/gpt-4o": {
                params: {
                  provider: {
                    order: ["azure"],
                    allowFallbacks: false,
                  },
                },
              },
            },
          },
        },
      },
      model: makeModel({
        api: "openai-completions",
        provider: "openrouter",
        id: "openai/gpt-4o",
        baseUrl: "https://openrouter.ai/api/v1",
      }),
      payload: {
        tools: [
          {
            type: "function",
            function: {
              name: "web_search",
              parameters: { type: "object", properties: {} },
              strict: true,
            },
          },
        ],
      },
    }).payload as {
      tools?: Array<{ function?: Record<string, unknown> }>;
    };

    expect(payload.tools?.[0]?.function?.strict).toBe(true);
  });

  it("still strips function.strict for other OpenRouter proxy routes", () => {
    const payload = runExtraParamsCase({
      applyProvider: "openrouter",
      applyModelId: "anthropic/claude-sonnet-4",
      model: makeModel({
        api: "openai-completions",
        provider: "openrouter",
        id: "anthropic/claude-sonnet-4",
        baseUrl: "https://openrouter.ai/api/v1",
      }),
      payload: {
        tools: [
          {
            type: "function",
            function: {
              name: "web_search",
              parameters: { type: "object", properties: {} },
              strict: true,
            },
          },
        ],
      },
    }).payload as {
      tools?: Array<{ function?: Record<string, unknown> }>;
    };

    expect(payload.tools?.[0]?.function).not.toHaveProperty("strict");
  });
});
