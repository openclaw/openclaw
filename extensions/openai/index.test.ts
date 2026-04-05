import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import * as providerAuth from "openclaw/plugin-sdk/provider-auth-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../test/helpers/plugins/plugin-api.js";
import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "../../test/helpers/plugins/provider-registration.js";
import { buildOpenAIImageGenerationProvider } from "./image-generation-provider.js";
import plugin from "./index.js";
import { OPENAI_FRIENDLY_PROMPT_OVERLAY } from "./prompt-overlay.js";

const runtimeMocks = vi.hoisted(() => ({
  ensureGlobalUndiciEnvProxyDispatcher: vi.fn(),
  refreshOpenAICodexToken: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  ensureGlobalUndiciEnvProxyDispatcher: runtimeMocks.ensureGlobalUndiciEnvProxyDispatcher,
}));

vi.mock("@mariozechner/pi-ai/oauth", async () => {
  const actual = await vi.importActual<typeof import("@mariozechner/pi-ai/oauth")>(
    "@mariozechner/pi-ai/oauth",
  );
  return {
    ...actual,
    refreshOpenAICodexToken: runtimeMocks.refreshOpenAICodexToken,
  };
});

import { refreshOpenAICodexToken } from "./openai-codex-provider.runtime.js";

const registerOpenAIPlugin = async () =>
  registerProviderPlugin({
    plugin,
    id: "openai",
    name: "OpenAI Provider",
  });

async function registerOpenAIPluginWithHook(params?: { pluginConfig?: Record<string, unknown> }) {
  const on = vi.fn();
  await plugin.register(
    createTestPluginApi({
      id: "openai",
      name: "OpenAI Provider",
      source: "test",
      config: {},
      runtime: {} as never,
      pluginConfig: params?.pluginConfig,
      on,
    }),
  );
  return { on };
}

describe("openai plugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("generates PNG buffers from the OpenAI Images API", async () => {
    const resolveApiKeySpy = vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "sk-test",
      source: "env",
      mode: "api-key",
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            b64_json: Buffer.from("png-data").toString("base64"),
            revised_prompt: "revised",
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = buildOpenAIImageGenerationProvider();
    const authStore = { version: 1, profiles: {} };
    const result = await provider.generateImage({
      provider: "openai",
      model: "gpt-image-1",
      prompt: "draw a cat",
      cfg: {},
      authStore,
    });

    expect(resolveApiKeySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        store: authStore,
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/images/generations",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          model: "gpt-image-1",
          prompt: "draw a cat",
          n: 1,
          size: "1024x1024",
        }),
      }),
    );
    expect(result).toEqual({
      images: [
        {
          buffer: Buffer.from("png-data"),
          mimeType: "image/png",
          fileName: "image-1.png",
          revisedPrompt: "revised",
        },
      ],
      model: "gpt-image-1",
    });
  });

  it("submits reference-image edits to the OpenAI Images edits endpoint", async () => {
    const resolveApiKeySpy = vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "sk-test",
      source: "env",
      mode: "api-key",
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            b64_json: Buffer.from("edited-image").toString("base64"),
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = buildOpenAIImageGenerationProvider();
    const authStore = { version: 1, profiles: {} };

    const result = await provider.generateImage({
      provider: "openai",
      model: "gpt-image-1",
      prompt: "Edit this image",
      cfg: {},
      authStore,
      inputImages: [
        { buffer: Buffer.from("x"), mimeType: "image/png" },
        { buffer: Buffer.from("y"), mimeType: "image/jpeg", fileName: "ref.jpg" },
      ],
    });

    expect(resolveApiKeySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        store: authStore,
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/images/edits",
      expect.objectContaining({
        method: "POST",
        body: expect.any(FormData),
      }),
    );
    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const requestBody = requestInit?.body;
    if (!(requestBody instanceof FormData)) {
      throw new Error("expected multipart form body");
    }
    expect(requestBody.get("model")).toBe("gpt-image-1");
    expect(requestBody.get("prompt")).toBe("Edit this image");
    expect(requestBody.get("n")).toBe("1");
    expect(requestBody.get("size")).toBe("1024x1024");
    const images = requestBody.getAll("image");
    expect(images).toHaveLength(2);
    expect(result).toEqual({
      images: [
        {
          buffer: Buffer.from("edited-image"),
          mimeType: "image/png",
          fileName: "image-1.png",
        },
      ],
      model: "gpt-image-1",
    });
  });

  it("does not allow private-network routing just because a custom base URL is configured", async () => {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "sk-test",
      source: "env",
      mode: "api-key",
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const provider = buildOpenAIImageGenerationProvider();
    await expect(
      provider.generateImage({
        provider: "openai",
        model: "gpt-image-1",
        prompt: "draw a cat",
        cfg: {
          models: {
            providers: {
              openai: {
                baseUrl: "http://127.0.0.1:8080/v1",
                models: [],
              },
            },
          },
        } satisfies OpenClawConfig,
      }),
    ).rejects.toThrow("Blocked hostname or private/internal/special-use IP address");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bootstraps the env proxy dispatcher before refreshing codex oauth credentials", async () => {
    const refreshed = {
      access: "next-access",
      refresh: "next-refresh",
      expires: Date.now() + 60_000,
    };
    runtimeMocks.refreshOpenAICodexToken.mockResolvedValue(refreshed);

    await expect(refreshOpenAICodexToken("refresh-token")).resolves.toBe(refreshed);

    expect(runtimeMocks.ensureGlobalUndiciEnvProxyDispatcher).toHaveBeenCalledOnce();
    expect(runtimeMocks.refreshOpenAICodexToken).toHaveBeenCalledOnce();
    expect(
      runtimeMocks.ensureGlobalUndiciEnvProxyDispatcher.mock.invocationCallOrder[0],
    ).toBeLessThan(runtimeMocks.refreshOpenAICodexToken.mock.invocationCallOrder[0]);
  });

  it("registers the friendly prompt overlay by default and scopes it to OpenAI providers", async () => {
    const { on } = await registerOpenAIPluginWithHook();

    expect(on).toHaveBeenCalledWith("before_prompt_build", expect.any(Function));
    const beforePromptBuild = on.mock.calls.find((call) => call[0] === "before_prompt_build")?.[1];
    const openaiResult = await beforePromptBuild?.(
      { prompt: "hello", messages: [] },
      { modelProviderId: "openai", modelId: "gpt-5.4" },
    );
    expect(openaiResult).toEqual({
      appendSystemContext: OPENAI_FRIENDLY_PROMPT_OVERLAY,
    });
    expect(OPENAI_FRIENDLY_PROMPT_OVERLAY).toContain("This is a live chat, not a memo.");
    expect(OPENAI_FRIENDLY_PROMPT_OVERLAY).toContain(
      "Avoid walls of text, long preambles, and repetitive restatement.",
    );

    const codexResult = await beforePromptBuild?.(
      { prompt: "hello", messages: [] },
      { modelProviderId: "openai-codex", modelId: "gpt-5.4" },
    );
    expect(codexResult).toEqual({
      appendSystemContext: OPENAI_FRIENDLY_PROMPT_OVERLAY,
    });

    const nonOpenAIResult = await beforePromptBuild?.(
      { prompt: "hello", messages: [] },
      { modelProviderId: "anthropic", modelId: "sonnet-4.6" },
    );
    expect(nonOpenAIResult).toBeUndefined();
  });

  it("includes stronger execution guidance in the OpenAI prompt overlay", () => {
    expect(OPENAI_FRIENDLY_PROMPT_OVERLAY).toContain(
      "If the user asks you to do the work, start in the same turn instead of restating the plan.",
    );
    expect(OPENAI_FRIENDLY_PROMPT_OVERLAY).toContain(
      "Commentary-only turns are incomplete when the next action is clear.",
    );
  });

  it("supports opting out of the prompt overlay via plugin config", async () => {
    const { on } = await registerOpenAIPluginWithHook({
      pluginConfig: { personalityOverlay: "off" },
    });

    expect(on).not.toHaveBeenCalledWith("before_prompt_build", expect.any(Function));
  });
});
