import {
  createNonExitingRuntimeEnv,
  createQueuedWizardPrompter,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-auth";
import type {
  ProviderAuthContext,
  ProviderAuthMethodNonInteractiveContext,
  ProviderCatalogContext,
} from "openclaw/plugin-sdk/provider-setup";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureLlamaInteractive,
  configureLlamaNonInteractive,
  detectLlama,
  discoverLlamaProvider,
  prepareLlama,
} from "./setup.js";

const baseUrl = "http://127.0.0.1:9931/v1";
const vision = "ggml-org/gemma-4-E4B-it-GGUF:Q8_0";
const textOnly = "ggml-org/gpt-oss-20b-GGUF:MXFP4";

// Rows as the Llama app's router reports them from /models.
const rows = [
  {
    id: vision,
    object: "model",
    status: { value: "unloaded" },
    architecture: { input_modalities: ["text", "image"] },
  },
  {
    id: textOnly,
    object: "model",
    status: { value: "loaded" },
    architecture: { input_modalities: ["text"] },
  },
];

function serve(data: unknown = rows, status = 200) {
  const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    Response.json({ data }, { status }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function refusing() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    }),
  );
}

function interactiveContext(url = ""): ProviderAuthContext {
  const { prompter } = createQueuedWizardPrompter({ textValues: [url], selectValues: [vision] });
  return {
    config: {},
    env: {},
    prompter,
    runtime: createNonExitingRuntimeEnv(),
    secretInputMode: "plaintext",
    allowSecretRefPrompt: false,
    isRemote: false,
    openUrl: async () => {},
    oauth: {
      createVpsAwareHandlers: () => {
        throw new Error("unused");
      },
    },
  };
}

function nonInteractiveContext(
  opts: ProviderAuthMethodNonInteractiveContext["opts"] = {},
  config: OpenClawConfig = {},
): ProviderAuthMethodNonInteractiveContext {
  return {
    authChoice: "llama",
    config,
    baseConfig: config,
    opts,
    runtime: createNonExitingRuntimeEnv(),
    resolveApiKey: vi.fn(async () => null),
    toApiKeyCredential: vi.fn(() => {
      throw new Error("keyless setup must not store credentials");
    }),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Llama setup", () => {
  it("detects the running app, prefers its loaded model, and saves only the connection", async () => {
    serve();
    await expect(detectLlama({ config: {}, env: {} })).resolves.toEqual({
      modelRef: `llama/${textOnly}`,
      detail: textOnly,
    });
    const prepared = await prepareLlama({ config: {}, env: {}, modelRef: `llama/${vision}` });
    expect(prepared).toEqual({
      profiles: [],
      defaultModel: `llama/${vision}`,
      configPatch: {
        models: { providers: { llama: { baseUrl, api: "openai-completions", models: [] } } },
      },
    });
  });

  it("finds nothing to offer when the app isn't running", async () => {
    refusing();
    await expect(detectLlama({ config: {}, env: {} })).resolves.toBeNull();
    const ctx = nonInteractiveContext();
    await expect(configureLlamaNonInteractive(ctx)).resolves.toBeNull();
    expect(ctx.runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Llama isn't reachable at http://127.0.0.1:9931/v1"),
    );
  });

  it("lists models live, with image input where the app reports it", async () => {
    serve();
    const config = { models: { providers: { llama: { baseUrl, models: [] } } } };
    const result = await discoverLlamaProvider({
      config,
      env: {},
      resolveProviderApiKey: () => ({ apiKey: undefined }),
      resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
    } as ProviderCatalogContext);
    const models = result && "provider" in result ? result.provider.models : [];
    expect(models.map(({ id, input }) => ({ id, input }))).toEqual([
      { id: vision, input: ["text", "image"] },
      { id: textOnly, input: ["text"] },
    ]);
  });

  it("skips catalog discovery until Llama is set up", async () => {
    const fetchMock = serve();
    await expect(
      discoverLlamaProvider({
        config: {},
        env: {},
        resolveProviderApiKey: () => ({ apiKey: undefined }),
        resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
      } as ProviderCatalogContext),
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the default URL when the prompt is left blank", async () => {
    const fetchMock = serve();
    await expect(configureLlamaInteractive(interactiveContext())).resolves.toMatchObject({
      defaultModel: `llama/${vision}`,
    });
    const [input] = fetchMock.mock.calls[0] ?? [];
    expect(input instanceof Request ? input.url : input?.toString()).toBe(`${baseUrl}/models`);
  });

  it("rejects an unknown model in non-interactive setup", async () => {
    serve();
    const ctx = nonInteractiveContext({ customModelId: "missing" });
    await expect(configureLlamaNonInteractive(ctx)).resolves.toBeNull();
    expect(ctx.runtime.error).toHaveBeenCalledWith(
      `Llama model missing was not found. Available models: ${vision}, ${textOnly}`,
    );
  });
});
