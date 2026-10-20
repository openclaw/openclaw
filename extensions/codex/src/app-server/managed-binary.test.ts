import { access, chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { embeddedAgentLog as log } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { SemVer } from "semver";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildMigrationProvider } from "../../migration-provider-api.js";
import type { CodexAppServerStartOptions as StartOptions } from "./config-contracts.js";
import { resolveCodexAppServerRuntimeOptions } from "./config-runtime.js";
import * as desktopAppPaths from "./desktop-app-paths.js";
import {
  assertInstalledCodexAppServerVersion as assertVersion,
  INSTALLED_CODEX_PROBE_TIMEOUT_MS as PROBE_TIMEOUT,
  rejectInstalledCodexAppServer as rejectInstalled,
  resolveManagedCodexAppServerStartOptions as resolveOptions,
  resolveManagedCodexClientVersion as resolveVersion,
  resolveManagedCodexNativeCommand as nativeCommand,
  setManagedCodexPluginRoot as setPluginRoot,
} from "./managed-binary.js";
import { CODEX_APP_SERVER_VERSION as VERSION } from "./version.js";

let root: string;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  root = tempDirs.make("openclaw-codex-");
});
afterEach(() => setPluginRoot(undefined));
function startOptions(managedCommandOrder?: StartOptions["managedCommandOrder"]): StartOptions {
  return {
    transport: "stdio",
    command: "codex",
    commandSource: "managed",
    ...(managedCommandOrder ? { managedCommandOrder } : {}),
    args: ["app-server", "--listen", "stdio://"],
    headers: {},
  };
}

function resolveStart(
  options: Parameters<typeof resolveOptions>[1] = {},
  order?: StartOptions["managedCommandOrder"],
) {
  return resolveOptions(startOptions(order), {
    platform: "linux",
    pluginRoot: root,
    ...options,
  });
}

function resolvedStart(command: string, order?: StartOptions["managedCommandOrder"]) {
  return { ...startOptions(order), command, commandSource: "resolved-managed" };
}

function managedCommandPath(owner: string, platform: NodeJS.Platform): string {
  return path.join(owner, "node_modules", ".bin", platform === "win32" ? "codex.cmd" : "codex");
}

async function writeFixture(file: string, contents: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents);
}

async function writeExecutable(file: string, contents = "#!/usr/bin/env node\n"): Promise<void> {
  await writeFixture(file, contents);
  await chmod(file, 0o755);
}

async function writePackage(owner: string, name: string, bin?: string) {
  await writeFixture(
    path.join(owner, "package.json"),
    JSON.stringify({
      name,
      ...(bin ? { type: "module", bin: { codex: bin } } : {}),
    }),
  );
}

async function writePackageLauncher(owner: string): Promise<string> {
  const packageRoot = path.join(owner, "node_modules", "@openai", "codex");
  const launcher = path.join(packageRoot, "bin", "codex.js");
  await writeExecutable(launcher);
  await writePackage(packageRoot, "@openai/codex", "bin/codex.js");
  return launcher;
}

describe("managed Codex app-server binary", () => {
  it("resolves native dependencies from the real package behind an isolated install shim", async () => {
    const platform = process.platform === "win32" ? "win32" : "linux";
    const modulesDir = path.join(root, "node_modules");
    const realScopeDir = path.join(modulesDir, ".pnpm", "codex-slot", "node_modules", "@openai");
    const packageRoot = path.join(realScopeDir, "codex");
    const platformRoot = path.join(realScopeDir, `codex-${platform}-x64`);
    const native = path.join(
      platformRoot,
      "vendor",
      platform === "win32" ? "x86_64-pc-windows-msvc" : "x86_64-unknown-linux-musl",
      "bin",
      platform === "win32" ? "codex.exe" : "codex",
    );
    const command = managedCommandPath(root, platform);
    await mkdir(path.join(modulesDir, "@openai"), { recursive: true });
    await writePackage(packageRoot, "@openai/codex");
    await writePackage(platformRoot, `@openai/codex-${platform}-x64`);
    await writeFixture(native, "native artifact fixture");
    await writeFixture(command, "launcher fixture");
    await symlink(
      packageRoot,
      path.join(modulesDir, "@openai", "codex"),
      platform === "win32" ? "junction" : "dir",
    );

    expect(nativeCommand(command, { platform, arch: "x64" })).toBe(native);
  });

  it("reports the signed desktop bundle binary as its native artifact", () => {
    const command =
      "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
    expect(nativeCommand(command, { platform: "darwin", arch: "arm64" })).toBe(command);
  });

  it.each([true, false])(
    "uses embedded vendor binaries only when the platform package is absent (present=%s)",
    (platformPackagePresent) => {
      const packageRoot = "/repo/node_modules/@openai/codex";
      const embedded = `${packageRoot}/vendor/aarch64-apple-darwin/bin/codex`;
      expect(
        nativeCommand(`${packageRoot}/bin/codex.js`, {
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
    const generation = path.join(root, "npm/projects/openclaw-codex-fixture--g-0123456789abcdef");
    const pluginRoot = path.join(generation, "node_modules", "@openclaw", "codex");
    await mkdir(pluginRoot, { recursive: true });
    const launcher = await writePackageLauncher(generation);
    // The flat project and an ancestor shim do not own this plugin's dependency.
    await writePackageLauncher(path.join(root, "npm", "projects", "openclaw-codex-fixture"));
    await writeExecutable(managedCommandPath(root, platform));

    await expect(resolveStart({ platform, pluginRoot })).resolves.toEqual(resolvedStart(launcher));
  });

  it("shares the registered owner with separately loaded runtime modules", async () => {
    const launcher = await writePackageLauncher(root);
    setPluginRoot(root);
    vi.resetModules();
    const runtimeCopy = await import("./managed-binary.js");
    await expect(
      runtimeCopy.resolveManagedCodexAppServerStartOptions(startOptions(), {
        platform: "linux",
      }),
    ).resolves.toMatchObject({ command: launcher });
  });

  it("resolves a managed start after loading only the public migration provider", async () => {
    buildMigrationProvider();

    await expect(
      resolveStart({ pluginRoot: undefined, preferInstalled: false }),
    ).resolves.toMatchObject({ commandSource: "resolved-managed" });
  });

  it("preserves an explicit command override without managed discovery", async () => {
    const explicit = resolveCodexAppServerRuntimeOptions({
      pluginConfig: { appServer: { command: "/operator/config-codex" } },
      env: { OPENCLAW_CODEX_APP_SERVER_BIN: "/operator/env-codex" },
      codexConfigToml: null,
      requirementsToml: null,
    }).start;
    const pathExists = vi.fn(async () => false);
    expect(explicit).toMatchObject({ commandSource: "config", command: "/operator/config-codex" });
    await expect(resolveOptions(explicit, { pathExists })).resolves.toBe(explicit);
    expect(pathExists).not.toHaveBeenCalled();
  });

  it.each([
    {
      order: "package-only",
      desktopCommands: [
        "/Applications/ChatGPT.app/Contents/Resources/codex",
        "/Applications/Codex.app/Contents/Resources/codex",
      ],
    },
    {
      order: "desktop-first",
      desktopCommands: [
        "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
      ],
    },
  ] as const)(
    "honors macOS $order ordering with desktop bundles present",
    async ({ order, desktopCommands }) => {
      const launcher = await writePackageLauncher(root);
      const commands = order === "package-only" ? [launcher] : [...desktopCommands, launcher];
      await expect(
        resolveOptions(startOptions(order), {
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
        ...startOptions(order),
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
    await expect(resolveStart({ pluginRoot })).rejects.toThrow(
      "Managed Codex app-server binary was not found",
    );
  });

  it("requires a loader-registered owner instead of guessing from the runtime module", async () => {
    await expect(resolveStart({ pluginRoot: undefined })).rejects.toThrow(
      "Codex plugin root is unavailable",
    );
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
const NEWER = new SemVer(VERSION).inc("minor").version;

describe.skipIf(process.platform === "win32")("installed Codex selection", () => {
  let bin: string;
  beforeEach(async () => {
    bin = path.join(root, "prefix", "bin");
    await mkdir(bin, { recursive: true });
    vi.spyOn(log, "info").mockImplementation(() => undefined);
    // Each case makes this process's first decision.
    delete installedState.selection;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    installedState.selection = Promise.resolve(undefined);
    delete installedState.selected;
    delete installedState.rejected;
  });

  /** npm global layout: bin/codex -> lib/node_modules/@openai/codex/bin/codex.js. */
  async function installNpmCodex(versionScript = `echo "codex-cli ${NEWER}"`) {
    const target = `${process.platform}-${process.arch}`;
    const packageRoot = path.join(root, "prefix", "lib", "node_modules", "@openai", "codex");
    const platformRoot = path.join(packageRoot, "node_modules", "@openai", `codex-${target}`);
    const native = path.join(platformRoot, "vendor", NATIVE_TRIPLES[target]!, "bin", "codex");
    const launcher = await writePackageLauncher(path.join(root, "prefix", "lib"));
    await writePackage(platformRoot, `@openai/codex-${target}`);
    await writeExecutable(native, `#!/bin/sh\n${versionScript}\n`);
    await symlink(launcher, path.join(bin, "codex"));
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
    const clientVersion = await resolveVersion("package-first", {
      probes: { env: { PATH: bin }, probeHandshake: async () => NEWER, ...probes },
      selectionTimeoutMs,
    });
    return { clientVersion, selected: installedState.selected };
  }
  const BUNDLED = { clientVersion: VERSION, selected: undefined };
  const expectBundled = (probes?: Parameters<typeof select>[0]) =>
    expect(select(probes)).resolves.toEqual(BUNDLED);

  function selectInstalled(command = "/opt/codex/bin/codex", nativePath = command) {
    const selected = { command, nativeCommand: nativePath, version: NEWER };
    installedState.selection = Promise.resolve(selected);
    installedState.selected = selected;
    return selected;
  }

  function expectChoice(message: string) {
    expect(log.info).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(message));
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
      `Codex app-server: using installed ${path.join(bin, "codex")} ${NEWER} (newer than bundled ${VERSION})`,
    );
  });

  it.each([
    { output: `echo "codex-cli ${VERSION}"`, reason: "is not newer" },
    { output: 'echo "codex-cli 0.149.0"', reason: "0.149.0 is not newer" },
    { output: `echo "codex-cli ${NEWER}-alpha.4"`, reason: "is a prerelease" },
    { output: 'echo "codex-cli 1.0.0"', reason: "1.0.0 is a different major version" },
    { output: 'echo "garbage"', reason: "did not report a parseable version" },
    { output: "exit 3", reason: "--version failed: Version check failed (3)" },
  ])("keeps the bundled package when the installed Codex $reason", async ({ output, reason }) => {
    await installNpmCodex(output);
    const probeHandshake = vi.fn(async () => NEWER);

    await expectBundled({ probeHandshake });
    expect(probeHandshake).not.toHaveBeenCalled();
    expectChoice(`Codex app-server: using bundled ${VERSION} (installed `);
    expectChoice(reason);
  });

  it("keeps the bundled package without a codex on PATH", async () => {
    await expectBundled();
    expectChoice(`Codex app-server: using bundled ${VERSION} (no codex on PATH)`);
  });

  it.each([
    ["timeout", "failed the app-server handshake: timed out after 15000 ms"],
    ["mismatch", `reported ${VERSION} from app-server`],
  ])("keeps the bundled package on handshake %s", async (failure, reason) => {
    await installNpmCodex();
    await expectBundled({
      probeHandshake: async () => {
        if (failure === "mismatch") {
          return VERSION;
        }
        throw new Error("timed out after 15000 ms");
      },
    });
    expectChoice(reason);
  });

  it("reserves bundled startup time across the complete cold selection", async () => {
    await installNpmCodex();
    const probeHandshake = vi.fn(async () => NEWER);
    vi.useFakeTimers({ toFake: ["performance"] });
    await expectBundled({
      runVersion: async () => {
        vi.advanceTimersByTime(PROBE_TIMEOUT + 1);
        return `codex-cli ${NEWER}`;
      },
      probeHandshake,
    });
    expect(probeHandshake).not.toHaveBeenCalled();
    expectChoice("selection timed out before the app-server handshake");
  });

  it("returns the bundled pin within a caller's shorter selection budget and ignores late success", async () => {
    await installNpmCodex();
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
      await expectBundled();
      expectChoice("installed Codex selection exceeded its startup budget");
    } finally {
      completed.resolve(NEWER);
    }
  });

  it("rejects script wrappers that are not the official npm launcher", async () => {
    await writeExecutable(path.join(bin, "codex"), `#!/bin/sh\necho "codex-cli ${NEWER}"\n`);

    await expectBundled();
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
    await writeExecutable(desktop, "\u007fELF native fixture");
    await symlink(desktop, path.join(bin, "codex"));
    vi.spyOn(desktopAppPaths, "resolveMacOSDesktopCodexAppServerCommandCandidates").mockReturnValue(
      [desktop],
    );
    const runVersion = vi.fn(async () => `codex-cli ${NEWER}`);
    const probeHandshake = vi.fn(async () => NEWER);

    await expect(
      resolveVersion("package-only", {
        platform: "darwin",
        probes: { env: { PATH: bin }, platform: "darwin", runVersion, probeHandshake },
      }),
    ).resolves.toBe(VERSION);
    expect(runVersion).not.toHaveBeenCalled();
    expect(probeHandshake).not.toHaveBeenCalled();
    expectChoice("belongs to a macOS desktop app");
  });

  it.each(["available", "missing"])(
    "starts the selected installed binary when %s, otherwise the package",
    async (availability) => {
      const packaged = await writePackageLauncher(root);
      const selected = selectInstalled("/opt/codex/launcher", "/opt/codex/native");
      const missing = availability === "missing";
      const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
      const pathExists = async (command: string) => !missing || command !== selected.nativeCommand;
      await expect(resolveStart({ pathExists })).resolves.toMatchObject(
        missing
          ? { command: packaged }
          : {
              command: selected.command,
              commandSource: "resolved-managed",
              managedFallbackCommandPaths: [packaged],
            },
      );
      if (missing) {
        await expect(resolveVersion("package-first")).resolves.toBe(VERSION);
        expect(warn).toHaveBeenCalledExactlyOnceWith(
          expect.stringContaining(
            `installed ${selected.command} ${NEWER} failed to start (executable`,
          ),
        );
      } else {
        expect(nativeCommand(selected.command)).toBe(selected.nativeCommand);
        await expect(resolveStart({ pathExists, preferInstalled: false })).resolves.toMatchObject({
          command: packaged,
        });
      }
    },
  );

  it("starts and reports the desktop app for desktop-first without probing PATH", async () => {
    const packaged = await writePackageLauncher(root);
    const desktopInstalled = async (command: string) =>
      command.includes("Codex.app") || command === packaged;

    await expect(
      resolveStart(
        {
          platform: "darwin",
          pathExists: desktopInstalled,
        },
        "desktop-first",
      ),
    ).resolves.toMatchObject({
      command: expect.stringContaining("Codex.app"),
      managedFallbackCommandPaths: expect.arrayContaining([packaged]),
    });
    await expect(
      resolveVersion("desktop-first", {
        platform: "darwin",
        pathExists: desktopInstalled,
      }),
    ).resolves.toBe(VERSION);
    // Neither the start nor discovery began a PATH selection.
    expect(installedState.selection).toBeUndefined();

    // Without the desktop app, desktop-first starts reach the installed Codex.
    await installNpmCodex();
    await expect(
      resolveVersion("desktop-first", {
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
      const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
      const gone = missing === "launcher" ? selected.command : selected.nativeCommand;

      await expect(
        resolveOptions(startOptions(), {
          platform: "linux",
          pluginRoot,
          pathExists: async (command) => command !== gone,
        }),
      ).resolves.toMatchObject({ command: packaged });
      await expect(resolveVersion("package-first")).resolves.toBe(VERSION);
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining(
          `installed ${selected.command} ${NEWER} failed to start (executable`,
        ),
      );
    },
  );

  it("lets every start that captured a rejected installed Codex fall back, logging once", () => {
    const selected = selectInstalled();
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);

    expect(rejectInstalled(selected.command, new Error("spawn EACCES"))).toBe(true);
    expect(rejectInstalled(selected.command, new Error("spawn EACCES"))).toBe(true);
    expect(rejectInstalled("/usr/bin/other-codex", new Error("boom"))).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    // A concurrent start of the same launcher that initializes cleanly still yields.
    expect(() => assertVersion(selected.command, NEWER)).toThrow(
      "another start already rejected this installed Codex",
    );
    expect(() => assertVersion("/usr/bin/other-codex", NEWER)).not.toThrow();
  });
});
