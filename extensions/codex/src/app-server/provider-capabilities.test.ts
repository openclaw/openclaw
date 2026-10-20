import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerClient } from "./client.js";
import type { CodexAppServerRuntimeOptions } from "./config.js";
import { resolveCodexProviderWebSearchSupport } from "./provider-capabilities.js";
import type { CodexAppServerClientFactory } from "./shared-client.js";

const appServer = {
  start: {},
  requestTimeoutMs: 1_000,
} as CodexAppServerRuntimeOptions;

const request = vi.fn(async (_method: string) => ({ webSearch: false }));
const client = { request } as unknown as CodexAppServerClient;
const clientFactory = vi.fn<CodexAppServerClientFactory>();
beforeEach(() => {
  request.mockReset().mockResolvedValue({ webSearch: false });
  clientFactory.mockReset().mockResolvedValue(client);
});

function resolveSupport(
  overrides: Partial<Parameters<typeof resolveCodexProviderWebSearchSupport>[0]> = {},
) {
  return resolveCodexProviderWebSearchSupport({
    clientFactory,
    appServer,
    authProfileId: undefined,
    agentDir: "/tmp/agent",
    config: undefined,
    modelProviderOverride: undefined,
    signal: new AbortController().signal,
    ...overrides,
  });
}

describe("resolveCodexProviderWebSearchSupport", () => {
  it("reads the latest configured provider capability for each attempt", async () => {
    request.mockResolvedValueOnce({ webSearch: true });
    await expect(resolveSupport()).resolves.toBe("supported");
    await expect(resolveSupport()).resolves.toBe("unsupported");

    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledWith(
      "modelProvider/capabilities/read",
      {},
      expect.objectContaining({ timeoutMs: 1_000 }),
    );
  });

  it("does not use default OpenAI capabilities for a copilot thread", async () => {
    const read = vi.fn(async (method: string) =>
      method === "config/read" ? { config: { model_provider: undefined } } : { webSearch: true },
    );
    clientFactory.mockResolvedValue({ request: read } as unknown as CodexAppServerClient);
    const result = await resolveSupport({
      expectedNativeModelProvider: "copilot",
    });
    expect(result).toBe("unknown");
    expect(read).toHaveBeenCalledExactlyOnceWith(
      "config/read",
      { includeLayers: false },
      expect.anything(),
    );
  });

  it("forwards one prepared auth handoff to capability startup", async () => {
    request.mockResolvedValue({ webSearch: true });
    const preparedAuth = {
      kind: "api-key" as const,
      apiKey: "prepared-platform-key",
    };

    await expect(
      resolveSupport({
        authProfileId: "openai:decoy",
        preparedAuth,
      }),
    ).resolves.toBe("supported");

    expect(clientFactory.mock.calls[0]?.[0]?.preparedAuth).toBe(preparedAuth);
    expect(clientFactory).not.toHaveBeenCalledWith(
      expect.objectContaining({ authProfileId: expect.anything() }),
    );
  });

  it.each(["startup", "read"])("reports unknown support after %s failure", async (stage) => {
    (stage === "startup" ? clientFactory : request).mockRejectedValueOnce(new Error(stage));
    await expect(resolveSupport()).resolves.toBe("unknown");
    expect(request).toHaveBeenCalledTimes(stage === "startup" ? 0 : 1);
  });

  it.each([
    [" OpenAI ", "supported"],
    ["amazon-bedrock", "unsupported"],
  ])(
    "resolves the %s override without probing native capabilities",
    async (modelProviderOverride, expected) => {
      request.mockResolvedValue({ webSearch: expected === "unsupported" });
      await expect(resolveSupport({ modelProviderOverride })).resolves.toBe(expected);
      expect(clientFactory).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    },
  );
});
