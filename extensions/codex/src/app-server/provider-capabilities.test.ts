import { describe, expect, it, vi } from "vitest";
import type { CodexAppServerClientFactory } from "./client-factory.js";
import type { CodexAppServerClient } from "./client.js";
import type { CodexAppServerRuntimeOptions } from "./config.js";
import { resolveCodexProviderWebSearchSupport } from "./provider-capabilities.js";

const appServer = {
  start: {},
  requestTimeoutMs: 1_000,
} as CodexAppServerRuntimeOptions;

function createClientFactory(webSearch: boolean | boolean[]) {
  const values = Array.isArray(webSearch) ? [...webSearch] : [webSearch];
  const request = vi.fn(async () => ({ webSearch: values.shift() ?? false }));
  const client = { request } as unknown as CodexAppServerClient;
  const clientFactory = vi.fn(async () => client) as unknown as CodexAppServerClientFactory;
  return { clientFactory, request };
}

function resolveSupport(
  clientFactory: CodexAppServerClientFactory,
  modelProviderOverride?: string,
): Promise<boolean> {
  return resolveCodexProviderWebSearchSupport({
    clientFactory,
    appServer,
    authProfileId: undefined,
    agentDir: "/tmp/agent",
    config: undefined,
    modelProviderOverride,
    signal: new AbortController().signal,
  });
}

describe("resolveCodexProviderWebSearchSupport", () => {
  it("reads the latest configured provider capability for each attempt", async () => {
    const { clientFactory, request } = createClientFactory([true, false]);

    await expect(resolveSupport(clientFactory)).resolves.toBe(true);
    await expect(resolveSupport(clientFactory)).resolves.toBe(false);

    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledWith(
      "modelProvider/capabilities/read",
      {},
      expect.objectContaining({ timeoutMs: 1_000 }),
    );
  });

  it("keeps managed search when configured provider support cannot be read", async () => {
    const clientFactory = vi.fn(async () => {
      throw new Error("old app-server");
    }) as unknown as CodexAppServerClientFactory;

    await expect(resolveSupport(clientFactory)).resolves.toBe(false);
  });

  it("keeps managed search when the configured provider reports no hosted support", async () => {
    const { clientFactory, request } = createClientFactory(false);

    await expect(resolveSupport(clientFactory)).resolves.toBe(false);
    expect(request).toHaveBeenCalledOnce();
  });

  it("uses hosted search for the built-in OpenAI provider override", async () => {
    const { clientFactory, request } = createClientFactory(false);

    await expect(resolveSupport(clientFactory, " OpenAI ")).resolves.toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps managed search for provider overrides the capability RPC cannot target", async () => {
    const { clientFactory, request } = createClientFactory(true);

    await expect(resolveSupport(clientFactory, "amazon-bedrock")).resolves.toBe(false);
    await expect(resolveSupport(clientFactory, "custom-provider")).resolves.toBe(false);
    expect(request).not.toHaveBeenCalled();
  });
});
