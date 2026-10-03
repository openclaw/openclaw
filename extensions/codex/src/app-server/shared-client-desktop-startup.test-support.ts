import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, vi, type Mock } from "vitest";
import { CodexAppServerClient } from "./client.js";
import type { CodexAppServerStartOptions } from "./config.js";
import {
  getLeasedSharedCodexAppServerClient,
  readCodexAppServerClientDesktopGeneration,
  releaseLeasedSharedCodexAppServerClient,
} from "./shared-client.js";
import { createClientHarness } from "./test-support.js";

/** Registers under the shared suite's auth and physical-client cleanup owner. */
export function registerSharedClientDesktopStartupTests({
  mocks,
  createInitializingClientHarness,
  createStartOptions,
  sendInitializeResult,
}: {
  mocks: {
    desktopGeneration?: { epoch: number; fingerprint: string };
    desktopGenerationCurrent: boolean;
    waitForCodexDesktopGeneration: Mock;
    readCodexDesktopGenerationCandidates: Mock;
    resolveManagedCodexAppServerStartOptions: Mock;
  };
  createInitializingClientHarness: () => ReturnType<typeof createClientHarness>;
  createStartOptions: (options: Partial<CodexAppServerStartOptions>) => CodexAppServerStartOptions;
  sendInitializeResult: (
    harness: ReturnType<typeof createClientHarness>,
    version: string,
  ) => Promise<void>;
}) {
  it.each(["resolved-managed", "config"] as const)(
    "preserves native MCP ownership by starting without overriding its config layers (%s)",
    async (commandSource) => {
      const harness = createInitializingClientHarness();
      const startSpy = vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
      const originalArgs = ["app-server"];
      const client = await getLeasedSharedCodexAppServerClient({
        timeoutMs: 1_000,
        agentDir: "/tmp/openclaw-agent",
        startOptions: {
          transport: "stdio",
          homeScope: "agent",
          commandSource,
          command: "/Applications/ChatGPT.app/Contents/Resources/codex",
          args: originalArgs,
          headers: {},
        },
      });
      try {
        expect(readCodexAppServerClientDesktopGeneration(client)).toBeUndefined();
        expect(startSpy).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ args: originalArgs }),
          expect.any(Function),
        );
      } finally {
        expect(releaseLeasedSharedCodexAppServerClient(client)).toBe(true);
      }
    },
  );

  it("rejects a lost generation snapshot through the existing bounded selection retry classifier", async () => {
    mocks.desktopGeneration = { epoch: 1, fingerprint: "superseded" };
    mocks.readCodexDesktopGenerationCandidates.mockReturnValue(undefined);
    await expect(
      getLeasedSharedCodexAppServerClient({
        agentDir: "/tmp/openclaw-agent",
        timeoutMs: 1_000,
        startOptions: {
          transport: "stdio",
          homeScope: "agent",
          command: "codex",
          commandSource: "managed",
          managedCommandOrder: "desktop-first",
          args: ["app-server"],
          headers: {},
        },
      }),
    ).rejects.toMatchObject({ code: "CODEX_APP_SERVER_START_SELECTION_CHANGED" });
    expect(mocks.resolveManagedCodexAppServerStartOptions).not.toHaveBeenCalled();
  });

  it("waits for a dirty desktop generation before reusing a warm managed client", async () => {
    const generation = { epoch: 1, fingerprint: "desktop-x" };
    mocks.desktopGeneration = generation;
    mocks.resolveManagedCodexAppServerStartOptions.mockImplementation(async (startOptions) => ({
      ...startOptions,
      command: "/Applications/ChatGPT.app/Contents/Resources/codex",
      commandSource: "resolved-managed" as const,
    }));
    const harness = createClientHarness();
    const startSpy = vi.spyOn(CodexAppServerClient, "start").mockResolvedValueOnce(harness.client);
    const config = {};
    const startOptions: CodexAppServerStartOptions = createStartOptions({
      homeScope: "agent",
      commandSource: "managed",
      managedCommandOrder: "desktop-first",
    });
    const options = { config, startOptions, agentDir: "/tmp/openclaw-agent" };

    const firstAcquire = getLeasedSharedCodexAppServerClient(options);
    await sendInitializeResult(harness, "openclaw/0.149.0 (macOS; test)");
    const first = await firstAcquire;
    expect(mocks.resolveManagedCodexAppServerStartOptions).toHaveBeenCalledWith(
      expect.any(Object),
      { desktopCandidates: mocks.readCodexDesktopGenerationCandidates.mock.results[0]?.value },
    );
    const dirty = createDeferred<typeof generation>();
    mocks.desktopGenerationCurrent = false;
    mocks.waitForCodexDesktopGeneration.mockReturnValue(dirty.promise);
    let settled = false;
    const secondAcquire = getLeasedSharedCodexAppServerClient(options).then((client) => {
      settled = true;
      return client;
    });

    try {
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(startSpy).toHaveBeenCalledOnce();
    } finally {
      mocks.desktopGenerationCurrent = true;
      dirty.resolve(generation);
      await secondAcquire;
    }
    await expect(secondAcquire).resolves.toBe(first);
    expect(startSpy).toHaveBeenCalledOnce();
    expect(releaseLeasedSharedCodexAppServerClient(first)).toBe(true);
    expect(releaseLeasedSharedCodexAppServerClient(first)).toBe(true);
  });
}
