import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { AgentHarnessPreflightError } from "openclaw/plugin-sdk/agent-harness-runtime";
import * as runtimeEnv from "openclaw/plugin-sdk/runtime-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { codexAppInventoryResponse } from "./app-inventory.test-helpers.js";
import { createAttemptThreadStarter, readHarnessMessages } from "./attempt-startup.test-support.js";
import { CodexAppServerClient, CodexAppServerRpcError } from "./client.js";
import { threadStartResult } from "./codex-app-server.test-fixtures.js";
import { setManagedCodexPluginRoot } from "./managed-binary.js";
import {
  appInfo,
  appSummary,
  pluginDetail,
  pluginInstalled,
  pluginSummary,
} from "./plugin-inventory.test-helpers.js";
import { defaultCodexPluginMetadataCache } from "./plugin-metadata-cache.js";
import { resetCodexTestBindingStore } from "./session-binding.test-helpers.js";
import { clearSharedCodexAppServerClientAndWait } from "./shared-client.js";
import { createCodexLifecycleHarness } from "./thread-lifecycle.test-fixtures.js";

const tempRoots = new Set<string>();
const start = createAttemptThreadStarter(tempRoots, {
  appServer: { command: "codex" },
  codexPlugins: {
    enabled: true,
    plugins: { calendar: { marketplaceName: "openai-curated", pluginName: "calendar" } },
  },
});

describe("Codex startup transport recovery", () => {
  beforeEach(async () => {
    vi.stubEnv("CODEX_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    await clearSharedCodexAppServerClientAndWait();
    setManagedCodexPluginRoot(fileURLToPath(new URL("../../", import.meta.url)));
    defaultCodexPluginMetadataCache.clear();
    resetCodexTestBindingStore();
    vi.useFakeTimers();
    vi.spyOn(runtimeEnv, "sleepWithAbort").mockImplementation(async (_delay, signal) => {
      signal?.throwIfAborted();
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await clearSharedCodexAppServerClientAndWait();
    setManagedCodexPluginRoot(undefined);
    defaultCodexPluginMetadataCache.clear();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await Promise.all([...tempRoots].map((root) => fs.rm(root, { recursive: true, force: true })));
    tempRoots.clear();
  });

  it.each(["deleted", "already deleted", "refused"] as const)(
    "reconciles a disconnected provisional thread before another start: %s",
    async (cleanup) => {
      const calls: Array<{ connection: number; method: string; params: unknown }> = [];
      const clients = [0, 1, 2].map((connection) => {
        const harness = createCodexLifecycleHarness({
          respond: (method, params) => {
            calls.push({ connection, method, params });
            if (method === "config/read") {
              return { config: {}, origins: {}, layers: [] };
            }
            if (method === "account/read") {
              return { account: { type: "apiKey" }, requiresOpenaiAuth: false };
            }
            if (method === "configRequirements/read") {
              return { requirements: null };
            }
            if (method === "plugin/installed") {
              return pluginInstalled([
                pluginSummary("calendar", { installed: true, enabled: true }),
              ]);
            }
            if (method === "plugin/read") {
              return pluginDetail("calendar", [appSummary("calendar-app")]);
            }
            if (method === "app/installed" || method === "app/read") {
              const threadId = (params as { threadId?: string }).threadId;
              if (connection === 0 && threadId) {
                // The same transport exit used by the WebSocket adapter. The
                // real pending request gets wrapped by admission and cleanup.
                harness.process.emit("exit", 1006, "");
                return {};
              }
              return codexAppInventoryResponse(method, [appInfo("calendar-app", true)]);
            }
            if (method === "thread/start") {
              return threadStartResult(`thread-${connection}`);
            }
            if (method === "thread/delete") {
              expect(params).toEqual({ threadId: "thread-0" });
              if (cleanup !== "deleted") {
                throw new CodexAppServerRpcError(
                  {
                    code: -32600,
                    message:
                      cleanup === "already deleted"
                        ? "thread not found: thread-0"
                        : "cleanup refused",
                  },
                  method,
                );
              }
              return {};
            }
            throw new Error(`Unexpected request: ${method}`);
          },
        });
        return harness;
      });
      const factory = vi.spyOn(CodexAppServerClient, "start");
      for (const harness of clients) {
        factory.mockResolvedValueOnce(harness.client);
      }
      const run = start(20_000, undefined, { harness: clients[0], skipStartSpy: true }).run;
      const outcome = run.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      // Advance request/cleanup deadlines while filesystem-backed startup settles.
      let settled: Awaited<typeof outcome> | undefined;
      void outcome.then((value) => {
        settled = value;
      });
      await vi.waitFor(() => expect(settled).toBeDefined(), { interval: 10, timeout: 5_000 });
      const result = await outcome;
      const starts = calls.filter((call) => call.method === "thread/start");
      if ("error" in result) {
        expect(cleanup).toBe("refused");
        expect(result.error).toBeInstanceOf(AgentHarnessPreflightError);
        expect(result.error).toMatchObject({
          scope: undefined,
          message: expect.stringContaining("Codex uncommitted thread cleanup failed"),
          cause: { name: "CodexUncommittedThreadCleanupError", threadId: "thread-0" },
        });
        expect(starts).toHaveLength(1);
        expect(factory).toHaveBeenCalledTimes(3);
      } else {
        expect(starts).toHaveLength(2);
        expect(starts.map((call) => (call.params as { model: string }).model)).toEqual([
          "gpt-5.4-codex",
          "gpt-5.4-codex",
        ]);
        expect(calls.findIndex((call) => call.method === "thread/delete")).toBeLessThan(
          calls.indexOf(starts[1]),
        );
        expect(result.value.thread.threadId).toBe("thread-1");
        result.value.turnRoute.release();
        result.value.releaseSharedClientLease();
      }
      expect(
        clients
          .flatMap((harness) => readHarnessMessages(harness.writes))
          .filter((call) => call.method === "turn/start"),
      ).toEqual([]);
    },
  );

  it("keeps an exhausted WebSocket handshake failure outside model fallback", async () => {
    const cause = Object.assign(new Error("WebSocket connection failed"), {
      code: "CODEX_APP_SERVER_WEBSOCKET_OPEN_FAILED",
    });
    const factory = vi.fn(async () => {
      throw cause;
    });
    const run = start(5_000, undefined, { attemptClientFactory: () => factory }).run;
    await expect(run).rejects.toMatchObject({
      name: "AgentHarnessPreflightError",
      scope: undefined,
      cause,
    });
    expect(factory).toHaveBeenCalledOnce();
  });
});
