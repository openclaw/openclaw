import type { ProviderCatalogContext } from "openclaw/plugin-sdk/provider-catalog-shared";
import { describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ loaded: false, run: vi.fn() }));
vi.mock("./provider-catalog-runtime.js", () => {
  runtime.loaded = true;
  return { runAnthropicVertexCatalog: runtime.run };
});
vi.mock("openclaw/plugin-sdk/provider-http", () => {
  throw new Error("Discovery metadata must not load HTTP runtime");
});

describe("anthropic-vertex provider discovery entry", () => {
  it("loads catalog runtime only when discovery executes", async () => {
    const { default: provider } = await import("./provider-discovery.js");
    expect(provider.id).toBe("anthropic-vertex");
    expect(provider.catalog.order).toBe("simple");
    expect(runtime.loaded).toBe(false);
    expect(
      provider.resolveConfigApiKey({ env: { ANTHROPIC_VERTEX_USE_GCP_METADATA: "true" } }),
    ).toBe("gcp-vertex-credentials");

    const ctx: ProviderCatalogContext = {
      config: {},
      env: {},
      resolveProviderApiKey: () => ({ apiKey: undefined }),
      resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
    };
    const result = { provider: { models: [] } };
    runtime.run.mockResolvedValue(result);
    expect(await provider.catalog.run(ctx)).toBe(result);
    expect(runtime.loaded).toBe(true);
    expect(runtime.run).toHaveBeenCalledExactlyOnceWith(ctx);
  });
});
