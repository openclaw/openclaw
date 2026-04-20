import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveProviderPluginChoice } from "../../src/plugins/provider-auth-choice.runtime.js";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import { __resetShimForTests, createCopilotSdkPlugin } from "./index.js";
import type { SdkClient } from "./sdk-client.js";
import type { ShimServerHandle } from "./shim-server.js";

let shimPortCounter = 40_000;

function buildFakeDeps(): {
  deps: Parameters<typeof createCopilotSdkPlugin>[0];
  getClient: ReturnType<typeof vi.fn>;
  fakeClient: SdkClient;
  createDedicatedClient: ReturnType<typeof vi.fn>;
  dedicatedClient: SdkClient;
  startShimServer: ReturnType<typeof vi.fn>;
} {
  const fakeClient: SdkClient = {
    listModels: vi.fn(async () => [
      { id: "gpt-5", name: "GPT-5" },
      { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
    ]),
    runPrompt: vi.fn(async () => ({ content: "ok" })),
    close: vi.fn(async () => undefined),
  };
  const dedicatedClient: SdkClient = {
    listModels: vi.fn(async () => []),
    runPrompt: vi.fn(async () => ({ content: "shim-ok" })),
    close: vi.fn(async () => undefined),
  };
  const getClient = vi.fn(async () => fakeClient);
  const createDedicatedClient = vi.fn(async () => dedicatedClient);
  const startShimServer = vi.fn(async (): Promise<ShimServerHandle> => {
    const port = shimPortCounter++;
    return {
      url: `http://127.0.0.1:${port}/v1`,
      port,
      close: vi.fn(async () => undefined),
    };
  });
  return {
    deps: {
      getClient: getClient as never,
      createDedicatedClient: createDedicatedClient as never,
      startShimServer: startShimServer as never,
    },
    getClient,
    fakeClient,
    createDedicatedClient,
    dedicatedClient,
    startShimServer,
  };
}

describe("copilot-sdk provider plugin", () => {
  afterEach(() => __resetShimForTests());

  it("registers the provider with an SDK auth method and wizard entry", async () => {
    const { deps } = buildFakeDeps();
    const provider = await registerSingleProviderPlugin(createCopilotSdkPlugin(deps));

    expect(provider.id).toBe("copilot-sdk");
    expect(provider.label).toBe("Copilot SDK (experimental)");
    expect(provider.auth).toHaveLength(1);
    expect(provider.auth[0].id).toBe("sdk");

    const resolved = resolveProviderPluginChoice({
      providers: [provider],
      choice: "copilot-sdk",
    });
    expect(resolved?.provider.id).toBe("copilot-sdk");
    expect(resolved?.method.id).toBe("sdk");
  });

  it("custom auth emits a token credential and plugin enablement patch", async () => {
    const { deps } = buildFakeDeps();
    const provider = await registerSingleProviderPlugin(createCopilotSdkPlugin(deps));
    const method = provider.auth[0];
    if (method.kind !== "custom") {
      throw new Error("expected custom auth method");
    }

    const result = await method.run({
      prompter: {} as never,
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
      env: {},
    } as never);

    expect(result.profiles?.[0]?.credential.type).toBe("token");
    const plugins = (
      result.configPatch as { plugins?: { entries?: Record<string, { enabled?: boolean }> } }
    )?.plugins;
    expect(plugins?.entries?.["copilot-sdk"]?.enabled).toBe(true);
    expect(result.notes?.some((note) => note.includes("device login"))).toBe(true);
  });

  it("catalog returns null when no token is resolved", async () => {
    const { deps, getClient } = buildFakeDeps();
    const provider = await registerSingleProviderPlugin(createCopilotSdkPlugin(deps));
    expect(provider.catalog).toBeDefined();

    const result = await provider.catalog!.run({
      config: {},
      env: {},
      resolveProviderApiKey: () => ({ apiKey: undefined }),
      resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
    } as never);

    expect(result).toBeNull();
    expect(getClient).not.toHaveBeenCalled();
  });

  it("catalog uses SDK client to discover models and stops it afterward", async () => {
    const { deps, getClient, fakeClient } = buildFakeDeps();
    const provider = await registerSingleProviderPlugin(createCopilotSdkPlugin(deps));

    const catalog = await provider.catalog!.run({
      config: {},
      env: {},
      resolveProviderApiKey: () => ({ apiKey: "copilot-sdk" }),
      resolveProviderAuth: () => ({ apiKey: "copilot-sdk", mode: "token", source: "profile" }),
    } as never);

    expect(catalog && "provider" in catalog).toBe(true);
    if (!catalog || !("provider" in catalog)) {
      throw new Error("expected provider catalog");
    }
    expect(catalog.provider.api).toBe("openai-completions");
    expect(catalog.provider.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    expect(catalog.provider.models?.map((m) => m.id)).toEqual(["gpt-5", "claude-sonnet-4.5"]);
    expect(getClient).toHaveBeenCalled();
    // SDK client must be stopped after catalog so the subprocess exits
    expect(fakeClient.close).toHaveBeenCalled();
  });

  it("falls back to static model catalog when SDK listModels throws", async () => {
    const { deps, fakeClient } = buildFakeDeps();
    (fakeClient.listModels as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("sdk offline"),
    );
    const provider = await registerSingleProviderPlugin(createCopilotSdkPlugin(deps));

    const catalog = await provider.catalog!.run({
      config: {},
      env: {},
      resolveProviderApiKey: () => ({ apiKey: "copilot-sdk" }),
      resolveProviderAuth: () => ({ apiKey: "copilot-sdk", mode: "token", source: "profile" }),
    } as never);

    if (!catalog || !("provider" in catalog)) {
      throw new Error("expected provider catalog");
    }
    const ids = catalog.provider.models?.map((m) => m.id) ?? [];
    expect(ids.length).toBeGreaterThan(0);
    // fallback catalog includes at least the gpt-5 id.
    expect(ids).toContain("gpt-5");
  });

  it("catalog falls back to static models when getClient fails", async () => {
    const { deps, getClient } = buildFakeDeps();
    getClient.mockRejectedValueOnce(new Error("sdk crash"));
    const provider = await registerSingleProviderPlugin(createCopilotSdkPlugin(deps));

    const catalog = await provider.catalog!.run({
      config: {},
      env: {},
      resolveProviderApiKey: () => ({ apiKey: "copilot-sdk" }),
      resolveProviderAuth: () => ({ apiKey: "copilot-sdk", mode: "token", source: "profile" }),
    } as never);

    if (!catalog || !("provider" in catalog)) {
      throw new Error("expected provider catalog");
    }
    const ids = catalog.provider.models?.map((m) => m.id) ?? [];
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).toContain("gpt-5");
  });

  it("each catalog call creates and stops a fresh SDK client", async () => {
    const { deps, getClient, fakeClient } = buildFakeDeps();
    const provider = await registerSingleProviderPlugin(createCopilotSdkPlugin(deps));

    const ctx = {
      config: {},
      env: {},
      resolveProviderApiKey: () => ({ apiKey: "copilot-sdk" }),
      resolveProviderAuth: () => ({
        apiKey: "copilot-sdk",
        mode: "token" as const,
        source: "profile" as const,
      }),
    };
    await provider.catalog!.run(ctx as never);
    await provider.catalog!.run(ctx as never);

    expect(getClient).toHaveBeenCalledTimes(2);
    expect(fakeClient.close).toHaveBeenCalledTimes(2);
  });

  it("honors configured port passed to startShimServer", async () => {
    const { deps, startShimServer } = buildFakeDeps();
    const provider = await registerSingleProviderPlugin(createCopilotSdkPlugin(deps));

    const catalog = await provider.catalog!.run({
      config: {
        plugins: { entries: { "copilot-sdk": { config: { port: 11111 } } } },
      },
      env: {},
      resolveProviderApiKey: () => ({ apiKey: "copilot-sdk" }),
      resolveProviderAuth: () => ({ apiKey: "copilot-sdk", mode: "token", source: "profile" }),
    } as never);

    if (!catalog || !("provider" in catalog)) {
      throw new Error("expected provider catalog");
    }
    expect(startShimServer).toHaveBeenCalledWith(expect.objectContaining({ port: 11111 }));
    // baseUrl comes from the shim handle, not the raw config port
    expect(catalog.provider.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
  });

  it("ensureShim() starts shim and catalog returns its URL", async () => {
    const { deps, startShimServer, createDedicatedClient } = buildFakeDeps();
    const provider = await registerSingleProviderPlugin(createCopilotSdkPlugin(deps));

    const catalog = await provider.catalog!.run({
      config: {},
      env: {},
      resolveProviderApiKey: () => ({ apiKey: "copilot-sdk" }),
      resolveProviderAuth: () => ({ apiKey: "copilot-sdk", mode: "token", source: "profile" }),
    } as never);

    expect(createDedicatedClient).toHaveBeenCalledTimes(1);
    expect(startShimServer).toHaveBeenCalledTimes(1);
    if (!catalog || !("provider" in catalog)) {
      throw new Error("expected provider catalog");
    }
    // The baseUrl must come from the shim handle, not a hardcoded port
    expect(catalog.provider.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
  });

  it("ensureShim() reuses existing shim on repeated catalog calls", async () => {
    const { deps, createDedicatedClient, startShimServer } = buildFakeDeps();
    const provider = await registerSingleProviderPlugin(createCopilotSdkPlugin(deps));

    const ctx = {
      config: {},
      env: {},
      resolveProviderApiKey: () => ({ apiKey: "copilot-sdk" }),
      resolveProviderAuth: () => ({
        apiKey: "copilot-sdk",
        mode: "token" as const,
        source: "profile" as const,
      }),
    };
    const cat1 = await provider.catalog!.run(ctx as never);
    const cat2 = await provider.catalog!.run(ctx as never);

    // Shim created only once — reused on second call
    expect(createDedicatedClient).toHaveBeenCalledTimes(1);
    expect(startShimServer).toHaveBeenCalledTimes(1);
    // Both catalogs return the same shim URL
    if (!cat1 || !("provider" in cat1) || !cat2 || !("provider" in cat2)) {
      throw new Error("expected provider catalogs");
    }
    expect(cat1.provider.baseUrl).toBe(cat2.provider.baseUrl);
  });

  it("ensureShim() rebuilds shim when config changes", async () => {
    const { deps, createDedicatedClient, startShimServer } = buildFakeDeps();
    const provider = await registerSingleProviderPlugin(createCopilotSdkPlugin(deps));

    const ctx1 = {
      config: {
        plugins: { entries: { "copilot-sdk": { config: { port: 9001 } } } },
      },
      env: {},
      resolveProviderApiKey: () => ({ apiKey: "copilot-sdk" }),
      resolveProviderAuth: () => ({
        apiKey: "copilot-sdk",
        mode: "token" as const,
        source: "profile" as const,
      }),
    };
    const ctx2 = {
      config: {
        plugins: { entries: { "copilot-sdk": { config: { port: 9002 } } } },
      },
      env: {},
      resolveProviderApiKey: () => ({ apiKey: "copilot-sdk" }),
      resolveProviderAuth: () => ({
        apiKey: "copilot-sdk",
        mode: "token" as const,
        source: "profile" as const,
      }),
    };

    const cat1 = await provider.catalog!.run(ctx1 as never);
    const cat2 = await provider.catalog!.run(ctx2 as never);

    // Config change triggers a new shim
    expect(createDedicatedClient).toHaveBeenCalledTimes(2);
    expect(startShimServer).toHaveBeenCalledTimes(2);
    expect(startShimServer).toHaveBeenNthCalledWith(1, expect.objectContaining({ port: 9001 }));
    expect(startShimServer).toHaveBeenNthCalledWith(2, expect.objectContaining({ port: 9002 }));
    // Different URLs from the two shim handles
    if (!cat1 || !("provider" in cat1) || !cat2 || !("provider" in cat2)) {
      throw new Error("expected provider catalogs");
    }
    expect(cat1.provider.baseUrl).not.toBe(cat2.provider.baseUrl);
  });

  it("catalog returns null when shim startup fails", async () => {
    const { deps, startShimServer } = buildFakeDeps();
    startShimServer.mockRejectedValueOnce(new Error("port unavailable"));
    const provider = await registerSingleProviderPlugin(createCopilotSdkPlugin(deps));

    const catalog = await provider.catalog!.run({
      config: {},
      env: {},
      resolveProviderApiKey: () => ({ apiKey: "copilot-sdk" }),
      resolveProviderAuth: () => ({ apiKey: "copilot-sdk", mode: "token", source: "profile" }),
    } as never);

    expect(catalog).toBeNull();
  });

  it("passes allowBuiltinTools config to startShimServer", async () => {
    const { deps, startShimServer } = buildFakeDeps();
    const provider = await registerSingleProviderPlugin(createCopilotSdkPlugin(deps));

    await provider.catalog!.run({
      config: {
        plugins: { entries: { "copilot-sdk": { config: { allowBuiltinTools: true } } } },
      },
      env: {},
      resolveProviderApiKey: () => ({ apiKey: "copilot-sdk" }),
      resolveProviderAuth: () => ({ apiKey: "copilot-sdk", mode: "token", source: "profile" }),
    } as never);

    expect(startShimServer).toHaveBeenCalledWith(
      expect.objectContaining({ allowBuiltinTools: true }),
    );
  });
});
