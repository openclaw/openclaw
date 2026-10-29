import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as runtimeEnv from "openclaw/plugin-sdk/runtime-env";
import { expect, it, vi } from "vitest";
import { CodexAppServerClient } from "./client.js";
import type { CodexAppServerStartOptions } from "./config.js";
import {
  getSharedCodexAppServerClient,
  getLeasedSharedCodexAppServerClient,
  createIsolatedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient,
} from "./shared-client.js";
import { createClientHarness } from "./test-support.js";

/** Share the owning suite's auth fixtures and physical-client cleanup. */
export function registerSharedClientWebSocketStartupTests({
  createStartOptions,
  createInitializingClientHarness,
  authHandoff,
}: {
  createStartOptions: (
    overrides: Partial<CodexAppServerStartOptions>,
  ) => CodexAppServerStartOptions;
  createInitializingClientHarness: () => ReturnType<typeof createClientHarness>;
  authHandoff: () => unknown;
}) {
  it("recovers a shared unopened WebSocket for foreground acquisition joining background startup", async () => {
    const failed = createClientHarness();
    const replacement = createInitializingClientHarness();
    const start = vi
      .spyOn(CodexAppServerClient, "start")
      .mockResolvedValueOnce(failed.client)
      .mockResolvedValueOnce(replacement.client);
    const backoff = vi.spyOn(runtimeEnv, "sleepWithAbort").mockResolvedValue();
    const options = {
      startOptions: createStartOptions({ transport: "websocket", url: "ws://example.invalid" }),
      authProfileId: null,
      timeoutMs: 10_000,
    };
    const background = getLeasedSharedCodexAppServerClient(options);
    await failed.waitForWrite(0);
    const joined = createDeferred<void>();
    const foreground = getLeasedSharedCodexAppServerClient({
      ...options,
      onStartedClient: () => joined.resolve(),
    });
    const result = Promise.all([background, foreground]);
    const recovered = expect(result).resolves.toEqual([replacement.client, replacement.client]);
    await joined.promise;
    expect(start).toHaveBeenCalledTimes(1);
    failed.process.emit(
      "error",
      Object.assign(new Error("Opening handshake has timed out"), {
        code: "CODEX_APP_SERVER_WEBSOCKET_OPEN_FAILED",
      }),
    );
    await recovered;
    expect(start).toHaveBeenCalledTimes(2);
    expect(backoff).toHaveBeenCalledTimes(1);
    expect(failed.writes.map((line) => JSON.parse(line).method)).toEqual(["initialize"]);
    expect(authHandoff).toHaveBeenCalledTimes(1);
    expect(releaseLeasedSharedCodexAppServerClient(replacement.client)).toBe(true);
    expect(releaseLeasedSharedCodexAppServerClient(replacement.client)).toBe(true);
    expect(releaseLeasedSharedCodexAppServerClient(replacement.client)).toBe(false);
  });

  it.each([
    ["unopened transient transport", "CODEX_APP_SERVER_WEBSOCKET_OPEN_FAILED", 3],
    ["post-open transport", "ECONNRESET", 1],
    ["authentication refusal", "HTTP_401", 1],
  ])("bounds acquisition retries for %s", async (_label, code, attempts) => {
    const transports: ReturnType<typeof createClientHarness>[] = [];
    vi.spyOn(runtimeEnv, "sleepWithAbort").mockResolvedValue();
    const start = vi.spyOn(CodexAppServerClient, "start").mockImplementation(async () => {
      const harness = createClientHarness({
        onWrite() {
          harness.process.emit("error", Object.assign(new Error("transport failed"), { code }));
        },
      });
      transports.push(harness);
      return harness.client;
    });
    await expect(
      getLeasedSharedCodexAppServerClient({
        startOptions: createStartOptions({ transport: "websocket", url: "ws://example.invalid" }),
        authProfileId: null,
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow("transport failed");
    expect(start).toHaveBeenCalledTimes(attempts);
    expect(authHandoff).not.toHaveBeenCalled();
    for (const transport of transports) {
      expect(transport.writes.map((line) => JSON.parse(line).method)).toEqual(["initialize"]);
    }
  });

  it.each(["abort", "deadline"] as const)(
    "stops unopened WebSocket recovery at its %s",
    async (reason) => {
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      const controller = new AbortController();
      const sleep = runtimeEnv.sleepWithAbort;
      vi.spyOn(runtimeEnv, "sleepWithAbort").mockImplementation((delay, signal) => {
        if (reason === "abort") {
          controller.abort();
          return sleep(delay, signal);
        }
        now = 5_000;
        return Promise.resolve();
      });
      const failed = createClientHarness({
        onWrite() {
          failed.process.emit(
            "error",
            Object.assign(new Error("connection refused"), {
              code: "CODEX_APP_SERVER_WEBSOCKET_OPEN_FAILED",
            }),
          );
        },
      });
      const start = vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(failed.client);
      await expect(
        createIsolatedCodexAppServerClient({
          startOptions: createStartOptions({ transport: "websocket", url: "ws://example.invalid" }),
          authProfileId: null,
          timeoutMs: 5_000,
          abandonSignal: controller.signal,
        }),
      ).rejects.toThrow(reason === "abort" ? "aborted" : "timed out");
      expect(start).toHaveBeenCalledTimes(1);
      expect(authHandoff).not.toHaveBeenCalled();
    },
  );

  it.each(["shared", "isolated"] as const)(
    "uses the configured remote endpoint for a %s client without explicit start options",
    async (kind) => {
      const harness = createInitializingClientHarness();
      const startSpy = vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
      const acquire =
        kind === "shared" ? getSharedCodexAppServerClient : createIsolatedCodexAppServerClient;

      const client = await acquire({
        pluginConfig: {
          appServer: { transport: "websocket", url: "ws://127.0.0.1:39175" },
        },
        timeoutMs: 1_000,
      });

      expect(client).toBe(harness.client);
      expect(startSpy).toHaveBeenCalledWith(
        expect.objectContaining({ transport: "websocket", url: "ws://127.0.0.1:39175" }),
        expect.anything(),
      );
      await client.closeAndWait();
    },
  );
}
