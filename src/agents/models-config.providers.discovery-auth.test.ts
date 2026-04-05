import { afterEach, describe, expect, it, vi } from "vitest";
import { buildHuggingfaceProvider } from "../../extensions/huggingface/provider-catalog.js";
import { buildVllmProvider } from "../../extensions/vllm/models.js";
import { NON_ENV_SECRETREF_MARKER } from "./model-auth-markers.js";
import { resolveApiKeyFromCredential } from "./models-config.providers.secrets.js";

describe("provider discovery auth marker guardrails", () => {
  let originalVitest: string | undefined;
  let originalNodeEnv: string | undefined;
  let originalFetch: typeof globalThis.fetch | undefined;

  afterEach(() => {
    if (originalVitest !== undefined) {
      process.env.VITEST = originalVitest;
    } else {
      delete process.env.VITEST;
    }
    if (originalNodeEnv !== undefined) {
      process.env.NODE_ENV = originalNodeEnv;
    } else {
      delete process.env.NODE_ENV;
    }
    if (originalFetch) {
      globalThis.fetch = originalFetch;
    }
  });

  function enableDiscovery() {
    originalVitest = process.env.VITEST ?? "true";
    originalNodeEnv = process.env.NODE_ENV ?? "test";
    originalFetch = globalThis.fetch;
    delete process.env.VITEST;
    delete process.env.NODE_ENV;
  }

  function installFetchMock(response?: unknown) {
    const fetchMock =
      response === undefined
        ? vi.fn()
        : vi.fn().mockResolvedValue({ ok: true, json: async () => response });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  it("does not send marker value as vLLM bearer token during discovery", async () => {
    enableDiscovery();
    const fetchMock = installFetchMock({ data: [] });
    const resolved = resolveApiKeyFromCredential({
      type: "api_key",
      provider: "vllm",
      keyRef: { source: "file", provider: "vault", id: "/vllm/apiKey" },
    });

    expect(resolved?.apiKey).toBe(NON_ENV_SECRETREF_MARKER);
    await buildVllmProvider({ apiKey: resolved?.discoveryApiKey });
    const request = fetchMock.mock.calls[0]?.[1] as
      | { headers?: Record<string, string> }
      | undefined;
    expect(request?.headers?.Authorization).toBeUndefined();
  });

  it("does not call Hugging Face discovery with marker-backed credentials", async () => {
    enableDiscovery();
    const fetchMock = installFetchMock();
    const resolved = resolveApiKeyFromCredential({
      type: "api_key",
      provider: "huggingface",
      keyRef: { source: "exec", provider: "vault", id: "providers/hf/token" },
    });

    expect(resolved?.apiKey).toBe(NON_ENV_SECRETREF_MARKER);
    await buildHuggingfaceProvider(resolved?.discoveryApiKey);
    const huggingfaceCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("router.huggingface.co"),
    );
    expect(huggingfaceCalls).toHaveLength(0);
  });

  it("keeps all-caps plaintext API keys for authenticated discovery", async () => {
    enableDiscovery();
    const fetchMock = installFetchMock({ data: [{ id: "vllm/test-model" }] });
    const resolved = resolveApiKeyFromCredential({
      type: "api_key",
      provider: "vllm",
      key: "ALLCAPS_SAMPLE",
    });

    expect(resolved?.apiKey).toBe("ALLCAPS_SAMPLE");
    await buildVllmProvider({ apiKey: resolved?.discoveryApiKey });
    const vllmCall = fetchMock.mock.calls.find(([url]) => String(url).includes(":8000"));
    const request = vllmCall?.[1] as { headers?: Record<string, string> } | undefined;
    expect(request?.headers?.Authorization).toBe("Bearer ALLCAPS_SAMPLE");
  });
});
