import { SemVer } from "semver";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { CodexAppServerClient } from "./client.js";
import type { CodexAppServerStartOptions } from "./config.js";
import {
  INSTALLED_CODEX_START_TIMEOUT_MS,
  rejectInstalledCodexAppServer,
} from "./managed-binary.js";
import {
  clearSharedCodexAppServerClientAndWait,
  createIsolatedCodexAppServerClient,
  getLeasedSharedCodexAppServerClient,
  getSharedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient,
} from "./shared-client.js";
import { createClientHarness } from "./test-support.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

type ClientHarness = ReturnType<typeof createClientHarness>;

/** Registers version-driven fallback between managed start candidates. */
export function registerSharedClientManagedFallbackTests(params: {
  configureManagedDesktopFallback: () => CodexAppServerStartOptions;
  resolveManagedStart: Mock;
  sendInitializeResult: (harness: ClientHarness, userAgent: string) => Promise<void>;
  warn: Mock;
}): void {
  it("keeps a supported desktop prerelease instead of falling back by version", async () => {
    const desktop = createClientHarness();
    const desktopVersion = `${new SemVer(CODEX_APP_SERVER_VERSION).inc("minor").version}-alpha.4`;
    const startSpy = vi.spyOn(CodexAppServerClient, "start").mockResolvedValueOnce(desktop.client);
    const startOptions = params.configureManagedDesktopFallback();

    const acquire = getSharedCodexAppServerClient({ startOptions, timeoutMs: 1_000 });
    await params.sendInitializeResult(desktop, `openclaw/${desktopVersion} (macOS; test)`);
    const client = await acquire;

    expect(client).toBe(desktop.client);
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(startSpy.mock.calls[0]?.[0]).toMatchObject({
      command: "/Applications/Codex.app/Contents/Resources/codex",
      commandSource: "resolved-managed",
      managedFallbackCommandPaths: ["/cache/openclaw/codex"],
    });
    expect(desktop.process.stdin.destroyed).toBe(false);
    expect(params.warn).toHaveBeenCalledExactlyOnceWith(
      "codex app-server is newer than OpenClaw's managed runtime; continuing with normal startup validation",
      {
        detectedVersion: desktopVersion,
        validatedVersion: CODEX_APP_SERVER_VERSION,
      },
    );

    await clearSharedCodexAppServerClientAndWait({ exitTimeoutMs: 25, forceKillDelayMs: 5 });
    expect(desktop.process.stdin.destroyed).toBe(true);
  });

  describe("selected installed Codex", () => {
    const installedCommand = "/usr/local/lib/node_modules/@openai/codex/bin/codex.js";
    const installedVersion = new SemVer(CODEX_APP_SERVER_VERSION).inc("minor").version;
    // Same slot test/setup.shared.ts seeds; managed-binary.ts captured this object.
    const installedState = (globalThis as Record<PropertyKey, unknown>)[
      Symbol.for("openclaw.codexInstalledAppServer")
    ] as {
      selection?: Promise<unknown>;
      selected?: { command: string; nativeCommand: string; version: string };
    };

    function selectInstalledCodex(): CodexAppServerStartOptions {
      const selected = {
        command: installedCommand,
        nativeCommand: "/usr/local/bin/codex-native",
        version: installedVersion,
      };
      installedState.selected = selected;
      installedState.selection = Promise.resolve(selected);
      params.resolveManagedStart.mockImplementation(
        async (startOptions: CodexAppServerStartOptions) => ({
          ...startOptions,
          command: installedCommand,
          commandSource: "resolved-managed",
          managedFallbackCommandPaths: ["/cache/openclaw/codex"],
        }),
      );
      return {
        transport: "stdio",
        command: "codex",
        commandSource: "managed",
        args: ["app-server", "--listen", "stdio://"],
        headers: {},
      };
    }

    afterEach(() => {
      vi.useRealTimers();
      installedState.selection = Promise.resolve(undefined);
      delete installedState.selected;
    });

    it.each([
      { failure: "spawn EACCES", installed: "spawn" },
      { failure: "initialize refused", installed: "initialize" },
      { failure: `app-server reported ${CODEX_APP_SERVER_VERSION}`, installed: "version" },
      // The generic version fallback must not skip dropping the installed selection.
      { failure: "Codex app-server 0.149.0 or newer is required", installed: "unsupported" },
      // Never answers initialize: a deadline-bound start keeps half for the bundled binary,
      { failure: "codex app-server initialize timed out", installed: "deadline hang" },
      // and a shared startup, which has no deadline of its own, stops waiting after a cap.
      { failure: "codex app-server initialize timed out", installed: "hang" },
      { failure: "another start failed", installed: "rejected hang" },
    ] as const)("falls back to the bundled package on $installed failure", async (scenario) => {
      const isolated = scenario.installed === "deadline hang";
      const installed = createClientHarness();
      const bundled = createClientHarness();
      const startSpy = vi.spyOn(CodexAppServerClient, "start");
      if (scenario.installed === "spawn") {
        startSpy.mockRejectedValueOnce(new Error(scenario.failure));
      } else {
        startSpy.mockResolvedValueOnce(installed.client);
      }
      startSpy.mockResolvedValueOnce(bundled.client);
      const sharedHang = scenario.installed === "hang" || scenario.installed === "rejected hang";
      if (sharedHang) {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      }

      const requested = selectInstalledCodex();
      if (scenario.installed === "rejected hang") {
        rejectInstalledCodexAppServer(installedCommand, new Error(scenario.failure));
      }
      const acquireOptions = { startOptions: requested, timeoutMs: sharedHang ? 10_000 : 1_000 };
      const acquire = isolated
        ? createIsolatedCodexAppServerClient(acquireOptions)
        : getSharedCodexAppServerClient(acquireOptions);
      if (scenario.installed === "initialize") {
        const initialize = JSON.parse(await installed.waitForWrite(0)) as { id: number };
        installed.send({ id: initialize.id, error: { code: -32603, message: scenario.failure } });
      } else if (scenario.installed === "version") {
        await params.sendInitializeResult(installed, `codex-cli/${CODEX_APP_SERVER_VERSION}`);
      } else if (scenario.installed === "unsupported") {
        await params.sendInitializeResult(installed, "codex-cli/0.148.0");
      } else if (sharedHang) {
        await installed.waitForWrite(0);
        await vi.advanceTimersByTimeAsync(INSTALLED_CODEX_START_TIMEOUT_MS);
        vi.useRealTimers();
      }
      await params.sendInitializeResult(bundled, `codex-cli/${CODEX_APP_SERVER_VERSION}`);
      const failure = scenario.failure;

      expect(await acquire).toBe(bundled.client);
      expect(startSpy.mock.calls.map(([options]) => options?.command)).toEqual([
        installedCommand,
        "/cache/openclaw/codex",
      ]);
      expect(params.warn).toHaveBeenCalledWith(
        expect.stringContaining(
          `Codex app-server: installed ${installedCommand} ${installedVersion} failed to start (${failure}`,
        ),
      );
      // Later managed starts and model discovery in this process use the bundled package.
      await expect(installedState.selection).resolves.toBeUndefined();
      expect(installedState.selected).toBeUndefined();
      if (!isolated) {
        // Fresh acquisitions now resolve to the bundled package and share this client.
        params.resolveManagedStart.mockImplementation(
          async (startOptions: CodexAppServerStartOptions) => ({
            ...startOptions,
            command: "/cache/openclaw/codex",
            commandSource: "resolved-managed",
          }),
        );
        await expect(
          getSharedCodexAppServerClient({ startOptions: requested, timeoutMs: 1_000 }),
        ).resolves.toBe(bundled.client);
        expect(startSpy).toHaveBeenCalledTimes(2);
      }
      await bundled.client.closeAndWait({ exitTimeoutMs: 25, forceKillDelayMs: 5 });
      await clearSharedCodexAppServerClientAndWait({ exitTimeoutMs: 25, forceKillDelayMs: 5 });
    });

    it("keeps the installed binary when its handshake matches the selection", async () => {
      const installed = createClientHarness();
      const startSpy = vi
        .spyOn(CodexAppServerClient, "start")
        .mockResolvedValueOnce(installed.client);

      const acquire = getSharedCodexAppServerClient({
        startOptions: selectInstalledCodex(),
        timeoutMs: 1_000,
      });
      await params.sendInitializeResult(installed, `codex-cli/${installedVersion}`);

      expect(await acquire).toBe(installed.client);
      expect(startSpy).toHaveBeenCalledOnce();
      expect(installedState.selected?.command).toBe(installedCommand);
      await clearSharedCodexAppServerClientAndWait({ exitTimeoutMs: 25, forceKillDelayMs: 5 });
    });

    it.each(["this startup", "another startup"] as const)(
      "shares pending bundled fallback after %s rejects the installed binary",
      async (rejector) => {
        const installed = createClientHarness();
        const bundled = createClientHarness();
        const startSpy = vi
          .spyOn(CodexAppServerClient, "start")
          .mockResolvedValueOnce(installed.client)
          .mockResolvedValueOnce(bundled.client)
          .mockRejectedValue(new Error("unexpected duplicate bundled startup"));
        const requested = selectInstalledCodex();
        const options = { startOptions: requested, timeoutMs: 1_000 };
        const first = getLeasedSharedCodexAppServerClient(options);
        await installed.waitForWrite(0);
        params.resolveManagedStart.mockImplementation(
          async (start: CodexAppServerStartOptions) => ({
            ...start,
            command: "/cache/openclaw/codex",
            commandSource: "resolved-managed",
          }),
        );
        if (rejector === "this startup") {
          await params.sendInitializeResult(installed, `codex-cli/${CODEX_APP_SERVER_VERSION}`);
          await bundled.waitForWrite(0);
        } else {
          rejectInstalledCodexAppServer(installedCommand, new Error("peer rejected"));
        }
        const second = getLeasedSharedCodexAppServerClient(options);
        const both = Promise.all([first, second]);
        if (rejector === "another startup") {
          await bundled.waitForWrite(0);
          await params.sendInitializeResult(installed, `codex-cli/${installedVersion}`);
        }
        await params.sendInitializeResult(bundled, `codex-cli/${CODEX_APP_SERVER_VERSION}`);
        expect(await both).toEqual([bundled.client, bundled.client]);
        expect(startSpy).toHaveBeenCalledTimes(2);
        expect(installed.process.stdin.destroyed).toBe(true);
        expect(releaseLeasedSharedCodexAppServerClient(bundled.client)).toBe(true);
        expect(releaseLeasedSharedCodexAppServerClient(bundled.client)).toBe(true);
        expect(releaseLeasedSharedCodexAppServerClient(bundled.client)).toBe(false);
        await clearSharedCodexAppServerClientAndWait({ exitTimeoutMs: 25, forceKillDelayMs: 5 });
      },
    );

    it.each(["config", "env"] as const)(
      "does not reject a working %s override when managed startup rejected the same path",
      async (commandSource) => {
        selectInstalledCodex();
        rejectInstalledCodexAppServer(installedCommand, new Error("managed startup failed"));
        params.resolveManagedStart.mockImplementation(async (start) => start);
        const custom = createClientHarness();
        const startSpy = vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(custom.client);
        const acquire = getSharedCodexAppServerClient({
          startOptions: {
            transport: "stdio",
            command: installedCommand,
            commandSource,
            args: ["app-server", "--listen", "stdio://"],
            headers: {},
          },
          timeoutMs: 1_000,
        });
        await params.sendInitializeResult(custom, `codex-cli/${installedVersion}`);
        expect(await acquire).toBe(custom.client);
        expect(startSpy).toHaveBeenCalledOnce();
        await clearSharedCodexAppServerClientAndWait({ exitTimeoutMs: 25, forceKillDelayMs: 5 });
      },
    );
  });
}
