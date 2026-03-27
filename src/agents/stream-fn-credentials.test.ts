import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { wrapStreamFnWithModelRegistryCredentials } from "./stream-fn-credentials.js";

const testModel = {
  api: "openai-codex-responses",
  id: "gpt-5.4",
  provider: "openai-codex",
} as unknown as Model<Api>;

const testContext = { messages: [] } as Parameters<StreamFn>[1];

function createModelRegistryMock(
  ...results: Array<Awaited<ReturnType<ModelRegistry["getApiKeyAndHeaders"]>>>
) {
  const getApiKeyAndHeaders = vi.fn();
  for (const result of results) {
    getApiKeyAndHeaders.mockResolvedValueOnce(result);
  }
  if (results.length === 1) {
    getApiKeyAndHeaders.mockResolvedValue(results[0]);
  }

  return {
    getApiKeyAndHeaders,
  } as unknown as ModelRegistry & {
    getApiKeyAndHeaders: ReturnType<typeof vi.fn>;
  };
}

describe("wrapStreamFnWithModelRegistryCredentials", () => {
  it("injects model-registry credentials and merges headers", async () => {
    const sentinel = { ok: true } as Awaited<ReturnType<StreamFn>>;
    const baseStreamFn = vi.fn(async () => sentinel) as unknown as StreamFn;
    const modelRegistry = createModelRegistryMock({
      ok: true,
      apiKey: "resolved-token",
      headers: {
        Authorization: "Bearer resolved-token",
        "X-Registry": "registry",
        "X-Shared": "registry",
      },
    });
    const wrapped = wrapStreamFnWithModelRegistryCredentials(baseStreamFn, modelRegistry);

    const result = await wrapped(testModel, testContext, {
      headers: {
        "X-Client": "client",
        "X-Shared": "client",
      },
    });

    expect(result).toBe(sentinel);
    expect(modelRegistry.getApiKeyAndHeaders).toHaveBeenCalledWith(testModel);
    expect(baseStreamFn).toHaveBeenCalledWith(
      testModel,
      testContext,
      expect.objectContaining({
        apiKey: "resolved-token",
        headers: {
          Authorization: "Bearer resolved-token",
          "X-Client": "client",
          "X-Registry": "registry",
          "X-Shared": "client",
        },
      }),
    );
  });

  it("re-resolves credentials on every call", async () => {
    const baseStreamFn = vi.fn(async (_model, _context, options) => options) as unknown as StreamFn;
    const modelRegistry = createModelRegistryMock(
      { ok: true, apiKey: "first-token", headers: { "X-Seq": "1" } },
      { ok: true, apiKey: "second-token", headers: { "X-Seq": "2" } },
    );
    const wrapped = wrapStreamFnWithModelRegistryCredentials(baseStreamFn, modelRegistry);

    const first = await wrapped(testModel, testContext, {});
    const second = await wrapped(testModel, testContext, {});

    expect(modelRegistry.getApiKeyAndHeaders).toHaveBeenCalledTimes(2);
    expect(first).toMatchObject({
      apiKey: "first-token",
      headers: { "X-Seq": "1" },
    });
    expect(second).toMatchObject({
      apiKey: "second-token",
      headers: { "X-Seq": "2" },
    });
  });

  it("throws the model-registry error when credentials cannot be resolved", async () => {
    const baseStreamFn = vi.fn(async () => ({ ok: true })) as unknown as StreamFn;
    const modelRegistry = createModelRegistryMock({
      ok: false,
      error: 'No API key found for "openai-codex"',
    });
    const wrapped = wrapStreamFnWithModelRegistryCredentials(baseStreamFn, modelRegistry);

    await expect(wrapped(testModel, testContext, {})).rejects.toThrow(
      'No API key found for "openai-codex"',
    );
    expect(baseStreamFn).not.toHaveBeenCalled();
  });
});
