import { describe, expect, it, vi } from "vitest";
import { resolveProviderPluginChoice } from "../../src/plugins/provider-auth-choice.runtime.js";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import { createCopilotSdkPlugin } from "./index.js";
import type { SdkClient } from "./sdk-client.js";

function buildFakeDeps(): {
  deps: Parameters<typeof createCopilotSdkPlugin>[0];
  getClient: ReturnType<typeof vi.fn>;
  fakeClient: SdkClient;
} {
  const fakeClient: SdkClient = {
    listModels: vi.fn(async () => [
      { id: "gpt-5", name: "GPT-5" },
      { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
    ]),
    runPrompt: vi.fn(async () => ({ content: "ok" })),
    close: vi.fn(async () => undefined),
  };
  const getClient = vi.fn(async () => fakeClient);
  return {
    deps: { getClient: getClient as never },
    getClient,
    fakeClient,
  };
}

describe("copilot-sdk provider plugin", () => {
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
    expect(catalog.provider.baseUrl).toBe("http://127.0.0.1:9527/v1");
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

  it("honors configured port in the catalog baseUrl", async () => {
    const { deps } = buildFakeDeps();
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
    expect(catalog.provider.baseUrl).toBe("http://127.0.0.1:11111/v1");
  });
});
