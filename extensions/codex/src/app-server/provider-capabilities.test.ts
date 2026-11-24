import { once } from "node:events";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { awaitGateBeforeSettlement } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerClient } from "./client.js";
import type { CodexAppServerRuntimeOptions } from "./config.js";
import { resolveCodexProviderWebSearchSupport } from "./provider-capabilities.js";
import {
  createIsolatedCodexAppServerClient,
  type CodexAppServerClientFactory,
} from "./shared-client.js";
import { createClientHarness, useAutoCleanupTempDirTracker } from "./test-support.js";
import { buildCodexRuntimeThreadConfigForRun } from "./thread-requests.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";
import { resolveCodexWebSearchPlan } from "./web-search.js";

const appServer = { start: {}, requestTimeoutMs: 1_000 } as CodexAppServerRuntimeOptions;

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
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it.each(["success", "RPC failure", "timeout", "borrowed success"] as const)(
    "preserves capability client ownership after %s",
    async (result) => {
      vi.useFakeTimers();
      const agentDir = tempDirs.make("codex-capability-probe-");
      const capabilityRead = createDeferred<void>();
      const harness = createClientHarness({
        autoEmitExit: false,
        onWrite: (line, send) => {
          const { id, method } = JSON.parse(line);
          if (id === undefined) {
            return;
          }
          if (method === "modelProvider/capabilities/read") {
            capabilityRead.resolve();
            if (result === "timeout") {
              return;
            }
          }
          send(
            method === "initialize"
              ? { id, result: { userAgent: `codex-cli/${CODEX_APP_SERVER_VERSION}` } }
              : result === "RPC failure"
                ? { id, error: { code: -32603, message: "capability probe failed" } }
                : { id, result: { webSearch: true } },
          );
        },
      });
      vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
      const stdinClosed = once(harness.process.stdin, "close");
      const borrowed = result === "borrowed success";
      const pending = resolveSupport({
        clientFactory: borrowed
          ? (options) => createIsolatedCodexAppServerClient(options)
          : createIsolatedCodexAppServerClient,
        appServer: {
          ...appServer,
          start: { transport: "stdio", command: process.execPath, args: [], headers: {} },
        },
        authProfileId: null,
        agentDir,
      });
      let settled = false;
      const outcome = pending.finally(() => {
        settled = true;
      });
      try {
        await awaitGateBeforeSettlement(capabilityRead.promise, outcome, "probe skipped its read");
        if (result === "timeout") {
          await vi.advanceTimersByTimeAsync(appServer.requestTimeoutMs);
        }
        if (borrowed) {
          await expect(outcome).resolves.toBe("supported");
          await expect(
            harness.client.request("modelProvider/capabilities/read", {}),
          ).resolves.toEqual({
            webSearch: true,
          });
          return;
        }
        await awaitGateBeforeSettlement(stdinClosed, outcome, "probe returned without closing");
        expect(settled).toBe(false);
        expect(harness.process.exitCode).toBeNull();
        harness.emitExit();
        await expect(outcome).resolves.toBe(result === "success" ? "supported" : "unknown");
      } finally {
        harness.emitExit();
        await harness.client.closeAndWait();
      }
    },
  );

  it("reads the latest configured provider capability for each attempt", async () => {
    request.mockResolvedValueOnce({ webSearch: true });
    await expect(resolveSupport()).resolves.toBe("supported");
    await expect(resolveSupport()).resolves.toBe("unsupported");
  });

  it.each([true, false])(
    "keeps custom-provider native search behind its standalone declaration (%s)",
    async (declared) => {
      const read = vi.fn(async (method: string) =>
        method === "config/read"
          ? {
              config: {
                model_provider: "custom-responses",
                model_providers: {
                  "custom-responses": { supports_standalone_web_search: declared },
                },
              },
            }
          : { webSearch: true },
      );
      clientFactory.mockResolvedValue({ request: read } as unknown as CodexAppServerClient);
      const support = await resolveSupport({ modelProviderOverride: "custom-responses" });
      const plan = resolveCodexWebSearchPlan({ nativeProviderWebSearchSupport: support });
      const thread = buildCodexRuntimeThreadConfigForRun({ modelId: "fixture-model" }, undefined, {
        nativeCodeModeEnabled: true,
        nativeProviderWebSearchSupport: support,
      });

      expect(plan).toMatchObject({
        kind: declared ? "native-hosted" : "managed",
        suppressManagedWebSearch: declared,
        threadConfig: {
          "features.standalone_web_search": declared,
          web_search: declared ? "cached" : "disabled",
        },
      });
      expect(thread["features.standalone_web_search"]).toBe(declared);
      expect(thread.web_search).toBe(declared ? "cached" : "disabled");
    },
  );

  it.each(["expectedNativeModelProvider", "modelProviderOverride"] as const)(
    "does not borrow default OpenAI capabilities for a copilot %s",
    async (field) => {
      const read = vi.fn(async (method: string) =>
        method === "config/read" ? { config: { model_provider: undefined } } : { webSearch: true },
      );
      clientFactory.mockResolvedValue({ request: read } as unknown as CodexAppServerClient);
      await expect(resolveSupport({ [field]: "copilot" })).resolves.toBe("unknown");
      expect(read.mock.calls.map(([method]) => method)).toEqual(["config/read"]);
    },
  );

  it("forwards one prepared auth handoff to capability startup", async () => {
    request.mockResolvedValue({ webSearch: true });
    const preparedAuth = { kind: "api-key" as const, apiKey: "prepared-platform-key" };
    await expect(resolveSupport({ authProfileId: "openai:decoy", preparedAuth })).resolves.toBe(
      "supported",
    );

    expect(clientFactory.mock.calls[0]?.[0]?.preparedAuth).toBe(preparedAuth);
    expect(clientFactory).not.toHaveBeenCalledWith(
      expect.objectContaining({ authProfileId: expect.anything() }),
    );
  });

  it("reports unknown support after startup failure", async () => {
    clientFactory.mockRejectedValueOnce(new Error("startup"));
    await expect(resolveSupport()).resolves.toBe("unknown");
  });

  it("resolves an OpenAI override without probing native capabilities", async () => {
    await expect(resolveSupport({ modelProviderOverride: " OpenAI " })).resolves.toBe("supported");
    expect(clientFactory).not.toHaveBeenCalled();
  });
});
