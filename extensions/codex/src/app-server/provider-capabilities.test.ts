import { once } from "node:events";
import { awaitGateBeforeSettlement } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerClient } from "./client.js";
import type { CodexAppServerRuntimeOptions } from "./config.js";
import { resolveCodexProviderWebSearchSupport } from "./provider-capabilities.js";
import {
  createIsolatedCodexAppServerClient,
  type CodexAppServerClientFactory,
} from "./shared-client.js";
import { createClientHarness, useAutoCleanupTempDirTracker } from "./test-support.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

const appServer = {
  start: {},
  requestTimeoutMs: 1_000,
} as CodexAppServerRuntimeOptions;

function createClientFactory(webSearch: boolean | boolean[]) {
  const values = Array.isArray(webSearch) ? [...webSearch] : [webSearch];
  const request = vi.fn(async () => ({ webSearch: values.shift() ?? false }));
  const client = { request } as unknown as CodexAppServerClient;
  const clientFactory = vi.fn<CodexAppServerClientFactory>(async () => client);
  return { clientFactory, request };
}

function resolveSupport(
  clientFactory: CodexAppServerClientFactory,
  modelProviderOverride?: string,
) {
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
  afterEach(() => vi.restoreAllMocks());

  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it.each([false, true])(
    "awaits isolated capability probe exit (RPC failure: %s)",
    async (fails) => {
      const agentDir = tempDirs.make("codex-capability-probe-");
      let capabilityRead = false;
      const harness = createClientHarness({
        autoEmitExit: false,
        onWrite: (line, send) => {
          const { id, method } = JSON.parse(line);
          if (id === undefined) {
            return;
          }
          capabilityRead ||= method === "modelProvider/capabilities/read";
          send(
            method === "initialize"
              ? { id, result: { userAgent: `codex-cli/${CODEX_APP_SERVER_VERSION}` } }
              : fails
                ? { id, error: { code: -32603, message: "capability probe failed" } }
                : { id, result: { webSearch: true } },
          );
        },
      });
      vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
      const stdinClosed = once(harness.process.stdin, "close");
      const pending = resolveCodexProviderWebSearchSupport({
        clientFactory: createIsolatedCodexAppServerClient,
        appServer: {
          ...appServer,
          start: { transport: "stdio", command: process.execPath, args: [], headers: {} },
        },
        authProfileId: null,
        agentDir,
        config: undefined,
        modelProviderOverride: undefined,
        signal: new AbortController().signal,
      });
      let settled = false;
      const outcome = pending.finally(() => {
        settled = true;
      });
      try {
        await awaitGateBeforeSettlement(stdinClosed, outcome, "probe returned without closing");
        expect(capabilityRead).toBe(true);
        expect(settled).toBe(false);
        expect(harness.process.exitCode).toBeNull();
        harness.emitExit();
        await expect(outcome).resolves.toBe(fails ? "unknown" : "supported");
      } finally {
        harness.emitExit();
        await harness.client.closeAndWait();
      }
    },
  );

  it("reads the latest configured provider capability for each attempt", async () => {
    const { clientFactory, request } = createClientFactory([true, false]);

    await expect(resolveSupport(clientFactory)).resolves.toBe("supported");
    await expect(resolveSupport(clientFactory)).resolves.toBe("unsupported");

    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledWith(
      "modelProvider/capabilities/read",
      {},
      expect.objectContaining({ timeoutMs: 1_000 }),
    );
  });

  it.each([
    { configuredProvider: "copilot", expectedProvider: "copilot", matches: true },
    { configuredProvider: "different-provider", expectedProvider: "copilot", matches: false },
    { configuredProvider: undefined, expectedProvider: "copilot", matches: false },
    { configuredProvider: undefined, expectedProvider: "openai", matches: true },
    { configuredProvider: null, expectedProvider: "openai", matches: true },
  ])(
    "uses native capabilities only for matching configured identity ($configuredProvider / $expectedProvider)",
    async ({ configuredProvider, expectedProvider, matches }) => {
      const request = vi.fn(async (method: string) =>
        method === "config/read"
          ? { config: { model_provider: configuredProvider } }
          : { webSearch: true },
      );
      const client = { request } as unknown as CodexAppServerClient;
      const clientFactory = vi.fn<CodexAppServerClientFactory>(async () => client);
      const result = await resolveCodexProviderWebSearchSupport({
        clientFactory,
        appServer,
        authProfileId: undefined,
        agentDir: "/tmp/agent",
        config: undefined,
        modelProviderOverride: undefined,
        expectedNativeModelProvider: expectedProvider,
        signal: new AbortController().signal,
      });
      expect(result).toBe(matches ? "supported" : "unknown");
      expect(request.mock.calls.map(([method]) => method)).toEqual(
        matches ? ["config/read", "modelProvider/capabilities/read"] : ["config/read"],
      );
    },
  );

  it("forwards one prepared auth handoff to capability startup", async () => {
    const { clientFactory } = createClientFactory(true);
    const preparedAuth = {
      kind: "api-key" as const,
      apiKey: "prepared-platform-key",
    };

    await expect(
      resolveCodexProviderWebSearchSupport({
        clientFactory,
        appServer,
        authProfileId: "openai:decoy",
        preparedAuth,
        agentDir: "/tmp/agent",
        config: undefined,
        modelProviderOverride: undefined,
        signal: new AbortController().signal,
      }),
    ).resolves.toBe("supported");

    expect(clientFactory).toHaveBeenCalledWith(expect.objectContaining({ preparedAuth }));
    expect(clientFactory.mock.calls[0]?.[0]?.preparedAuth).toBe(preparedAuth);
    expect(clientFactory).not.toHaveBeenCalledWith(
      expect.objectContaining({ authProfileId: expect.anything() }),
    );
  });

  it("reports unknown support when app-server startup fails", async () => {
    const clientFactory = vi.fn(async () => {
      throw new Error("old app-server");
    }) as unknown as CodexAppServerClientFactory;

    await expect(resolveSupport(clientFactory)).resolves.toBe("unknown");
  });

  it("uses hosted search for the built-in OpenAI provider override", async () => {
    const { clientFactory, request } = createClientFactory(false);

    await expect(resolveSupport(clientFactory, " OpenAI ")).resolves.toBe("supported");
    expect(clientFactory).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps managed search for provider overrides the capability RPC cannot target", async () => {
    const { clientFactory, request } = createClientFactory(true);

    await expect(resolveSupport(clientFactory, "amazon-bedrock")).resolves.toBe("unsupported");
    await expect(resolveSupport(clientFactory, "custom-provider")).resolves.toBe("unsupported");
    await expect(resolveSupport(clientFactory, "lmstudio")).resolves.toBe("unsupported");
    expect(clientFactory).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
});
