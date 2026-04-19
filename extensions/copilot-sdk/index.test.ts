import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveProviderPluginChoice } from "../../src/plugins/provider-auth-choice.runtime.js";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import { createCopilotSdkPlugin, __resetShimForTests } from "./index.js";
import type { SdkClient } from "./sdk-client.js";
import type { ShimServerHandle } from "./shim-server.js";

function buildFakeDeps(): {
  deps: Parameters<typeof createCopilotSdkPlugin>[0];
  startShim: ReturnType<typeof vi.fn>;
  getClient: ReturnType<typeof vi.fn>;
  fakeClient: SdkClient;
  closeShim: ReturnType<typeof vi.fn>;
} {
  const closeShim = vi.fn(async () => undefined);
  const fakeClient: SdkClient = {
    listModels: vi.fn(async () => [
      { id: "gpt-5", name: "GPT-5" },
      { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
    ]),
    runPrompt: vi.fn(async () => ({ content: "ok" })),
    close: vi.fn(async () => undefined),
  };
  const handle: ShimServerHandle = {
    url: "http://127.0.0.1:9527/v1",
    port: 9527,
    close: closeShim,
  };
  const startShim = vi.fn(async () => handle);
  const getClient = vi.fn(async () => fakeClient);
  return {
    deps: { startShim: startShim as never, getClient: getClient as never },
    startShim,
    getClient,
    fakeClient,
    closeShim,
  };
}

describe("copilot-sdk provider plugin", () => {
  afterEach(async () => {
    await __resetShimForTests();
  });

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
    const { deps, startShim } = buildFakeDeps();
    const provider = await registerSingleProviderPlugin(createCopilotSdkPlugin(deps));
    expect(provider.catalog).toBeDefined();

    const result = await provider.catalog!.run({
      config: {},
      env: {},
      resolveProviderApiKey: () => ({ apiKey: undefined }),
      resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
    } as never);

    expect(result).toBeNull();
    expect(startShim).not.toHaveBeenCalled();
  });

  it("catalog starts the shim and returns a provider pointed at its loopback URL", async () => {
    const { deps, startShim, getClient } = buildFakeDeps();
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
    expect(catalog.provider.baseUrl).toBe("http://127.0.0.1:9527/v1");
    expect(catalog.provider.models?.map((m) => m.id)).toEqual(["gpt-5", "claude-sonnet-4.5"]);
    expect(startShim).toHaveBeenCalledOnce();
    expect(getClient).toHaveBeenCalled();
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

  it("catalog returns null when shim fails to start", async () => {
    const { deps, startShim } = buildFakeDeps();
    startShim.mockRejectedValueOnce(new Error("port in use"));
    const provider = await registerSingleProviderPlugin(createCopilotSdkPlugin(deps));

    const result = await provider.catalog!.run({
      config: {},
      env: {},
      resolveProviderApiKey: () => ({ apiKey: "copilot-sdk" }),
      resolveProviderAuth: () => ({ apiKey: "copilot-sdk", mode: "token", source: "profile" }),
    } as never);

    expect(result).toBeNull();
  });

  it("reuses the shim across repeated catalog calls with unchanged config", async () => {
    const { deps, startShim } = buildFakeDeps();
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

    expect(startShim).toHaveBeenCalledOnce();
  });

  it("honors configured port from plugins.entries.copilot-sdk.config.port", async () => {
    const { deps, startShim } = buildFakeDeps();
    const provider = await registerSingleProviderPlugin(createCopilotSdkPlugin(deps));

    await provider.catalog!.run({
      config: {
        plugins: { entries: { "copilot-sdk": { config: { port: 11111 } } } },
      },
      env: {},
      resolveProviderApiKey: () => ({ apiKey: "copilot-sdk" }),
      resolveProviderAuth: () => ({ apiKey: "copilot-sdk", mode: "token", source: "profile" }),
    } as never);

    expect(startShim).toHaveBeenCalledWith(
      expect.objectContaining({ port: 11111, rejectToolRequests: true }),
    );
  });
});
