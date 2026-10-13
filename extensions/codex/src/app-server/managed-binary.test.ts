// Codex tests cover managed binary plugin behavior.
import { access, chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { SemVer } from "semver";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerStartOptions } from "./config-contracts.js";
import { resolveCodexAppServerRuntimeOptions } from "./config-runtime.js";
import * as desktopAppPaths from "./desktop-app-paths.js";
import {
  assertInstalledCodexAppServerVersion,
  INSTALLED_CODEX_PROBE_TIMEOUT_MS,
  rejectInstalledCodexAppServer,
  resolveManagedCodexAppServerStartOptions,
  resolveManagedCodexClientVersion,
  resolveManagedCodexNativeCommand,
  setManagedCodexPluginRoot,
} from "./managed-binary.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

function startOptions(
  commandSource: CodexAppServerStartOptions["commandSource"],
  managedCommandOrder?: CodexAppServerStartOptions["managedCommandOrder"],
): CodexAppServerStartOptions {
  return {
    transport: "stdio",
    command: "codex",
    commandSource,
    ...(managedCommandOrder ? { managedCommandOrder } : {}),
    args: ["app-server", "--listen", "stdio://"],
    headers: {},
  };
}

function managedCommandPath(root: string, platform: NodeJS.Platform): string {
  return path.join(root, "node_modules", ".bin", platform === "win32" ? "codex.cmd" : "codex");
}

async function writeExecutable(file: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "#!/usr/bin/env node\n");
  await chmod(file, 0o755);
}

async function writePackageLauncher(owner: string): Promise<string> {
  const packageRoot = path.join(owner, "node_modules", "@openai", "codex");
  const launcher = path.join(packageRoot, "bin", "codex.js");
  await writeExecutable(launcher);
  await writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@openai/codex",
      type: "module",
      bin: { codex: "bin/codex.js" },
    }),
  );
  return launcher;
}

const MACOS_DESKTOP_CODEX_APP_SERVER_COMMAND = "/Applications/Codex.app/Contents/Resources/codex";
const MACOS_DESKTOP_CHATGPT_APP_SERVER_COMMAND =
  "/Applications/ChatGPT.app/Contents/Resources/codex";
const MACOS_DESKTOP_CHATGPT_SIGNED_APP_SERVER_COMMAND =
  "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";

describe("managed Codex app-server binary", () => {
  let root: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openclaw-codex-owner-")));
  });
  afterEach(async () => {
    setManagedCodexPluginRoot(undefined);
    await rm(root, { recursive: true, force: true });
  });

  it("resolves native dependencies from the real package behind an isolated install shim", async () => {
    const installRoot = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "openclaw-codex-isolated-")),
    );
    try {
      const platform = process.platform === "win32" ? "win32" : "linux";
      const modulesDir = path.join(installRoot, "node_modules");
      const realScopeDir = path.join(modulesDir, ".pnpm", "codex-slot", "node_modules", "@openai");
      const packageRoot = path.join(realScopeDir, "codex");
      const platformPackage = `@openai/codex-${platform}-x64`;
      const platformRoot = path.join(realScopeDir, `codex-${platform}-x64`);
      const native = path.join(
        platformRoot,
        "vendor",
        platform === "win32" ? "x86_64-pc-windows-msvc" : "x86_64-unknown-linux-musl",
        "bin",
        platform === "win32" ? "codex.exe" : "codex",
      );
      const command = managedCommandPath(installRoot, platform);
      await mkdir(packageRoot, { recursive: true });
      await mkdir(path.dirname(native), { recursive: true });
      await mkdir(path.dirname(command), { recursive: true });
      await mkdir(path.join(modulesDir, "@openai"), { recursive: true });
      await writeFile(
        path.join(packageRoot, "package.json"),
        JSON.stringify({ name: "@openai/codex" }),
      );
      await writeFile(
        path.join(platformRoot, "package.json"),
        JSON.stringify({ name: platformPackage }),
      );
      await writeFile(native, "native artifact fixture");
      await writeFile(command, "launcher fixture");
      await symlink(
        packageRoot,
        path.join(modulesDir, "@openai", "codex"),
        platform === "win32" ? "junction" : "dir",
      );

      expect(resolveManagedCodexNativeCommand(command, { platform, arch: "x64" })).toBe(native);
    } finally {
      await rm(installRoot, { recursive: true, force: true });
    }
  });

  it("reports the signed desktop bundle binary as its native artifact", () => {
    const command = MACOS_DESKTOP_CHATGPT_SIGNED_APP_SERVER_COMMAND;
    expect(
      resolveManagedCodexNativeCommand(command, {
        platform: "darwin",
        arch: "arm64",
      }),
    ).toBe(command);
  });

  it.each([true, false])(
    "uses embedded vendor binaries only when the platform package is absent (present=%s)",
    (platformPackagePresent) => {
      const packageRoot = "/repo/node_modules/@openai/codex";
      const embedded = `${packageRoot}/vendor/aarch64-apple-darwin/bin/codex`;
      expect(
        resolveManagedCodexNativeCommand(`${packageRoot}/bin/codex.js`, {
          platform: "darwin",
          arch: "arm64",
          resolvePackageJson: (name) =>
            name === "@openai/codex"
              ? `${packageRoot}/package.json`
              : platformPackagePresent
                ? "/repo/node_modules/@openai/codex-darwin-arm64/package.json"
                : undefined,
          pathExists: (candidate) => candidate === embedded,
        }),
      ).toBe(platformPackagePresent ? undefined : embedded);
    },
  );

  it("resolves the isolated npm generation package without a local shim on Windows", async () => {
    const platform = "win32";
    const generation = path.join(
      root,
      "npm",
      "projects",
      "openclaw-codex-fixture--g-0123456789abcdef",
    );
    const pluginRoot = path.join(generation, "node_modules", "@openclaw", "codex");
    await mkdir(pluginRoot, { recursive: true });
    const launcher = await writePackageLauncher(generation);
    // The flat project and an ancestor shim do not own this plugin's dependency.
    await writePackageLauncher(path.join(root, "npm", "projects", "openclaw-codex-fixture"));
    await writeExecutable(managedCommandPath(root, platform));

    await expect(
      resolveManagedCodexAppServerStartOptions(startOptions("managed"), {
        platform,
        pluginRoot,
      }),
    ).resolves.toEqual({
      ...startOptions("managed"),
      command: launcher,
      commandSource: "resolved-managed",
    });
  });

  it("shares the registered owner with separately loaded runtime modules", async () => {
    const launcher = await writePackageLauncher(root);
    setManagedCodexPluginRoot(root);
    vi.resetModules();
    const runtimeCopy = await import("./managed-binary.js");
    await expect(
      runtimeCopy.resolveManagedCodexAppServerStartOptions(startOptions("managed"), {
        platform: "linux",
      }),
    ).resolves.toMatchObject({ command: launcher });
  });

  it("preserves an explicit command override without managed discovery", async () => {
    const explicit = resolveCodexAppServerRuntimeOptions({
      pluginConfig: { appServer: { command: "/operator/config-codex" } },
      env: { OPENCLAW_CODEX_APP_SERVER_BIN: "/operator/env-codex" },
      codexConfigToml: null,
      requirementsToml: null,
    }).start;
    const pathExists = vi.fn(async () => false);
    expect(explicit.commandSource).toBe("config");
    expect(explicit.command).toBe("/operator/config-codex");
    await expect(resolveManagedCodexAppServerStartOptions(explicit, { pathExists })).resolves.toBe(
      explicit,
    );
    expect(pathExists).not.toHaveBeenCalled();
  });

  it.each([
    {
      order: "package-only",
      desktopCommands: [
        MACOS_DESKTOP_CHATGPT_APP_SERVER_COMMAND,
        MACOS_DESKTOP_CODEX_APP_SERVER_COMMAND,
      ],
    },
    { order: "desktop-first", desktopCommands: [MACOS_DESKTOP_CHATGPT_SIGNED_APP_SERVER_COMMAND] },
  ] as const)(
    "honors macOS $order ordering with desktop bundles present",
    async ({ order, desktopCommands }) => {
      const launcher = await writePackageLauncher(root);
      const commands = order === "package-only" ? [launcher] : [...desktopCommands, launcher];
      await expect(
        resolveManagedCodexAppServerStartOptions(startOptions("managed", order), {
          platform: "darwin",
          pluginRoot: root,
          pathExists: async (candidate) =>
            candidate.startsWith("/Applications/")
              ? desktopCommands.some((command) => command === candidate)
              : access(candidate).then(
                  () => true,
                  () => false,
                ),
        }),
      ).resolves.toEqual({
        ...startOptions("managed", order),
        command: commands[0],
        commandSource: "resolved-managed",
        ...(commands.length > 1 ? { managedFallbackCommandPaths: commands.slice(1) } : {}),
      });
    },
  );

  it("fails clearly when the managed package is absent even with an ancestor shim", async () => {
    const pluginRoot = path.join(root, "extensions", "codex");
    await mkdir(pluginRoot, { recursive: true });
    await writeExecutable(managedCommandPath(root, "linux"));
    await expect(
      resolveManagedCodexAppServerStartOptions(startOptions("managed"), {
        platform: "linux",
        pluginRoot,
      }),
    ).rejects.toThrow("Managed Codex app-server binary was not found");
  });

  it("requires a loader-registered owner instead of guessing from the runtime module", async () => {
    await expect(
      resolveManagedCodexAppServerStartOptions(startOptions("managed"), {
        platform: "linux",
      }),
    ).rejects.toThrow("Codex plugin root is unavailable");
  });
});

// Same slot test/setup.shared.ts seeds; managed-binary.ts captured this object.
const installedState = (globalThis as Record<PropertyKey, unknown>)[
  Symbol.for("openclaw.codexInstalledAppServer")
] as {
  selection?: Promise<unknown>;
  selected?: { command: string; nativeCommand: string; version: string };
  rejected?: string;
};

const NATIVE_TRIPLES: Record<string, string> = {
  "linux-x64": "x86_64-unknown-linux-musl",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
};
const NEWER = new SemVer(CODEX_APP_SERVER_VERSION).inc("minor").version;

describe.skipIf(process.platform === "win32")("installed Codex selection", () => {
  let root: string;
  let bin: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openclaw-codex-installed-")));
    bin = path.join(root, "prefix", "bin");
    await mkdir(bin, { recursive: true });
    vi.spyOn(embeddedAgentLog, "info").mockImplementation(() => undefined);
    // Each case makes this process's first decision.
    delete installedState.selection;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    installedState.selection = Promise.resolve(undefined);
    delete installedState.selected;
    delete installedState.rejected;
    setManagedCodexPluginRoot(undefined);
    await rm(root, { recursive: true, force: true });
  });

  /** npm global layout: bin/codex -> lib/node_modules/@openai/codex/bin/codex.js. */
  async function installNpmCodex(versionScript: string) {
    const target = `${process.platform}-${process.arch}`;
    const packageRoot = path.join(root, "prefix", "lib", "node_modules", "@openai", "codex");
    const platformRoot = path.join(packageRoot, "node_modules", "@openai", `codex-${target}`);
    const native = path.join(platformRoot, "vendor", NATIVE_TRIPLES[target]!, "bin", "codex");
    const launcher = await writePackageLauncher(path.join(root, "prefix", "lib"));
    await mkdir(path.dirname(native), { recursive: true });
    await writeFile(
      path.join(platformRoot, "package.json"),
      JSON.stringify({ name: `@openai/codex-${target}` }),
    );
    await writeFile(native, `#!/bin/sh\n${versionScript}\n`);
    await chmod(native, 0o755);
    await symlink(launcher, path.join(bin, "codex"));
    expect(path.dirname(path.dirname(launcher))).toBe(packageRoot);
    return { launcher, native };
  }

  /** Makes this process's decision: what discovery reports and what managed starts use. */
  async function select(
    probes: {
      probeHandshake?: (command: string) => Promise<string | undefined>;
      runVersion?: (nativeCommand: string) => Promise<string>;
    } = {},
    selectionTimeoutMs?: number,
  ) {
    const clientVersion = await resolveManagedCodexClientVersion("package-first", {
      probes: { env: { PATH: bin }, probeHandshake: async () => NEWER, ...probes },
      selectionTimeoutMs,
    });
    return { clientVersion, selected: installedState.selected };
  }
  const BUNDLED = { clientVersion: CODEX_APP_SERVER_VERSION, selected: undefined };

  function expectChoice(message: string) {
    expect(embeddedAgentLog.info).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(message));
  }

  it("selects a newer npm-installed Codex after its version and handshake probes", async () => {
    const { launcher, native } = await installNpmCodex(`echo "codex-cli ${NEWER}"`);
    const probeHandshake = vi.fn(async () => NEWER);

    await expect(select({ probeHandshake })).resolves.toEqual({
      clientVersion: NEWER,
      selected: { command: launcher, nativeCommand: native, version: NEWER },
    });
    expect(probeHandshake).toHaveBeenCalledExactlyOnceWith(launcher);
    expectChoice(
      `Codex app-server: using installed ${path.join(bin, "codex")} ${NEWER} (newer than bundled ${CODEX_APP_SERVER_VERSION})`,
    );
  });

  it.each([
    { output: `echo "codex-cli ${CODEX_APP_SERVER_VERSION}"`, reason: "is not newer" },
    { output: 'echo "codex-cli 0.149.0"', reason: "0.149.0 is not newer" },
    { output: `echo "codex-cli ${NEWER}-alpha.4"`, reason: "is a prerelease" },
    { output: 'echo "codex-cli 1.0.0"', reason: "1.0.0 is a different major version" },
    { output: 'echo "garbage"', reason: "did not report a parseable version" },
    { output: "exit 3", reason: "--version failed: Version check failed (3)" },
  ])("keeps the bundled package when the installed Codex $reason", async ({ output, reason }) => {
    await installNpmCodex(output);
    const probeHandshake = vi.fn(async () => NEWER);

    await expect(select({ probeHandshake })).resolves.toEqual(BUNDLED);
    expect(probeHandshake).not.toHaveBeenCalled();
    expectChoice(`Codex app-server: using bundled ${CODEX_APP_SERVER_VERSION} (installed `);
    expectChoice(reason);
  });

  it("keeps the bundled package without a codex on PATH", async () => {
    await expect(select()).resolves.toEqual(BUNDLED);
    expectChoice(`Codex app-server: using bundled ${CODEX_APP_SERVER_VERSION} (no codex on PATH)`);
  });

  it.each([
    {
      name: "fails the handshake",
      probe: async () => {
        throw new Error("timed out after 15000 ms");
      },
      reason: "failed the app-server handshake: timed out after 15000 ms",
    },
    {
      name: "reports another app-server version",
      probe: async () => CODEX_APP_SERVER_VERSION,
      reason: `reported ${CODEX_APP_SERVER_VERSION} from app-server`,
    },
  ])("keeps the bundled package when a newer Codex $name", async ({ probe, reason }) => {
    await installNpmCodex(`echo "codex-cli ${NEWER}"`);

    await expect(select({ probeHandshake: probe })).resolves.toEqual(BUNDLED);
    expectChoice(reason);
  });

  it("reserves bundled startup time across the complete cold selection", async () => {
    await installNpmCodex(`echo "codex-cli ${NEWER}"`);
    const probeHandshake = vi.fn(async () => NEWER);
    vi.useFakeTimers({ toFake: ["performance"] });
    try {
      await expect(
        select({
          runVersion: async () => {
            vi.advanceTimersByTime(INSTALLED_CODEX_PROBE_TIMEOUT_MS + 1);
            return `codex-cli ${NEWER}`;
          },
          probeHandshake,
        }),
      ).resolves.toEqual(BUNDLED);
      expect(probeHandshake).not.toHaveBeenCalled();
      expectChoice("selection timed out before the app-server handshake");
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns the bundled pin within a caller's shorter selection budget and ignores late success", async () => {
    await installNpmCodex(`echo "codex-cli ${NEWER}"`);
    const entered = createDeferred<void>();
    const completed = createDeferred<string>();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const selected = select(
        {
          runVersion: async () => `codex-cli ${NEWER}`,
          probeHandshake: async () => {
            entered.resolve();
            return completed.promise;
          },
        },
        100,
      );
      await entered.promise;
      await vi.advanceTimersByTimeAsync(100);
      await expect(selected).resolves.toEqual(BUNDLED);
      completed.resolve(NEWER);
      await expect(select()).resolves.toEqual(BUNDLED);
      expectChoice("installed Codex selection exceeded its startup budget");
    } finally {
      completed.resolve(NEWER);
      vi.useRealTimers();
    }
  });

  it("rejects script wrappers that are not the official npm launcher", async () => {
    await writeFile(path.join(bin, "codex"), `#!/bin/sh\necho "codex-cli ${NEWER}"\n`);
    await chmod(path.join(bin, "codex"), 0o755);

    await expect(select()).resolves.toEqual(BUNDLED);
    expectChoice("is not a native Codex executable or the official @openai/codex launcher");
  });

  it("accepts a standalone native Codex as its own native artifact", async () => {
    const standalone = path.join(root, "standalone", "bin", "codex");
    await mkdir(path.dirname(standalone), { recursive: true });
    await writeFile(standalone, "\u007fELF native fixture");
    await chmod(standalone, 0o755);
    await symlink(standalone, path.join(bin, "codex"));
    const runVersion = vi.fn(async () => `codex-cli ${NEWER}\n`);

    await expect(select({ runVersion })).resolves.toEqual({
      clientVersion: NEWER,
      selected: { command: standalone, nativeCommand: standalone, version: NEWER },
    });
    expect(runVersion).toHaveBeenCalledExactlyOnceWith(standalone);
  });

  it("does not adopt a desktop-owned binary found through a PATH symlink", async () => {
    const desktop = path.join(root, "Codex.app", "Contents", "Resources", "codex");
    await mkdir(path.dirname(desktop), { recursive: true });
    await writeFile(desktop, "\u007fELF native fixture");
    await chmod(desktop, 0o755);
    await symlink(desktop, path.join(bin, "codex"));
    vi.spyOn(desktopAppPaths, "resolveMacOSDesktopCodexAppServerCommandCandidates").mockReturnValue(
      [desktop],
    );
    const runVersion = vi.fn(async () => `codex-cli ${NEWER}`);
    const probeHandshake = vi.fn(async () => NEWER);

    await expect(
      resolveManagedCodexClientVersion("package-only", {
        platform: "darwin",
        probes: { env: { PATH: bin }, platform: "darwin", runVersion, probeHandshake },
      }),
    ).resolves.toBe(CODEX_APP_SERVER_VERSION);
    expect(runVersion).not.toHaveBeenCalled();
    expect(probeHandshake).not.toHaveBeenCalled();
    expectChoice("belongs to a macOS desktop app");
  });

  it("starts the selected installed Codex first with the package as its fallback", async () => {
    const pluginRoot = path.join(root, "plugin");
    const packaged = await writePackageLauncher(pluginRoot);
    const selected = {
      command: "/usr/local/lib/node_modules/@openai/codex/bin/codex.js",
      nativeCommand: "/usr/local/lib/node_modules/@openai/codex/vendor/codex",
      version: NEWER,
    };
    installedState.selection = Promise.resolve(selected);
    installedState.selected = selected;
    const pathExists = async () => true;

    await expect(
      resolveManagedCodexAppServerStartOptions(startOptions("managed"), {
        platform: "linux",
        pluginRoot,
        pathExists,
      }),
    ).resolves.toMatchObject({
      command: selected.command,
      commandSource: "resolved-managed",
      managedFallbackCommandPaths: [packaged],
    });
    expect(resolveManagedCodexNativeCommand(selected.command)).toBe(selected.nativeCommand);
    await expect(
      resolveManagedCodexAppServerStartOptions(startOptions("managed"), {
        platform: "linux",
        pluginRoot,
        pathExists,
        preferInstalled: false,
      }),
    ).resolves.toMatchObject({ command: packaged });
  });

  it("starts and reports the desktop app for desktop-first without probing PATH", async () => {
    const pluginRoot = path.join(root, "plugin");
    const packaged = await writePackageLauncher(pluginRoot);
    const desktopInstalled = async (command: string) =>
      command.includes("Codex.app") || command === packaged;

    await expect(
      resolveManagedCodexAppServerStartOptions(startOptions("managed", "desktop-first"), {
        platform: "darwin",
        pluginRoot,
        pathExists: desktopInstalled,
      }),
    ).resolves.toMatchObject({
      command: expect.stringContaining("Codex.app"),
      managedFallbackCommandPaths: expect.arrayContaining([packaged]),
    });
    await expect(
      resolveManagedCodexClientVersion("desktop-first", {
        platform: "darwin",
        pathExists: desktopInstalled,
      }),
    ).resolves.toBe(CODEX_APP_SERVER_VERSION);
    // Neither the start nor discovery began a PATH selection.
    expect(installedState.selection).toBeUndefined();

    // Without the desktop app, desktop-first starts reach the installed Codex.
    await installNpmCodex(`echo "codex-cli ${NEWER}"`);
    await expect(
      resolveManagedCodexClientVersion("desktop-first", {
        platform: "darwin",
        pathExists: async () => false,
        probes: { env: { PATH: bin }, probeHandshake: async () => NEWER },
      }),
    ).resolves.toBe(NEWER);
  });

  it.each(["launcher", "native executable"])(
    "drops an installed Codex whose %s disappeared after selection",
    async (missing) => {
      const pluginRoot = path.join(root, "plugin");
      const packaged = await writePackageLauncher(pluginRoot);
      const selected = {
        command: "/opt/codex/lib/node_modules/@openai/codex/bin/codex.js",
        nativeCommand: "/opt/codex/lib/node_modules/@openai/codex-linux-x64/vendor/codex",
        version: NEWER,
      };
      installedState.selection = Promise.resolve(selected);
      installedState.selected = selected;
      const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
      const gone = missing === "launcher" ? selected.command : selected.nativeCommand;

      await expect(
        resolveManagedCodexAppServerStartOptions(startOptions("managed"), {
          platform: "linux",
          pluginRoot,
          pathExists: async (command) => command !== gone,
        }),
      ).resolves.toMatchObject({ command: packaged });
      await expect(resolveManagedCodexClientVersion("package-first")).resolves.toBe(
        CODEX_APP_SERVER_VERSION,
      );
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining(
          `installed ${selected.command} ${NEWER} failed to start (executable`,
        ),
      );
    },
  );

  it("lets every start that captured a rejected installed Codex fall back, logging once", () => {
    const selected = {
      command: "/opt/codex/bin/codex",
      nativeCommand: "/opt/codex/bin/codex",
      version: NEWER,
    };
    installedState.selection = Promise.resolve(selected);
    installedState.selected = selected;
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);

    expect(rejectInstalledCodexAppServer(selected.command, new Error("spawn EACCES"))).toBe(true);
    expect(rejectInstalledCodexAppServer(selected.command, new Error("spawn EACCES"))).toBe(true);
    expect(rejectInstalledCodexAppServer("/usr/bin/other-codex", new Error("boom"))).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    // A concurrent start of the same launcher that initializes cleanly still yields.
    expect(() => assertInstalledCodexAppServerVersion(selected.command, NEWER)).toThrow(
      "another start already rejected this installed Codex",
    );
    expect(() => assertInstalledCodexAppServerVersion("/usr/bin/other-codex", NEWER)).not.toThrow();
  });
});
