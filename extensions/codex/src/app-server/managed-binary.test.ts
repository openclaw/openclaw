// Codex tests cover managed binary plugin behavior.
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CodexAppServerStartOptions } from "./config.js";
import {
  resolveManagedCodexAppServerStartOptions,
  resolveManagedCodexNativeCommand,
} from "./managed-binary.js";

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
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  return pathApi.join(root, "node_modules", ".bin", platform === "win32" ? "codex.cmd" : "codex");
}

const MACOS_DESKTOP_CODEX_APP_SERVER_COMMAND = "/Applications/Codex.app/Contents/Resources/codex";
const MACOS_DESKTOP_CHATGPT_APP_SERVER_COMMAND =
  "/Applications/ChatGPT.app/Contents/Resources/codex";
const HOST_NATIVE_PLATFORM = process.platform === "win32" ? "win32" : "linux";
const HOST_NATIVE_ARCH = "arm64" as const;
const HOST_NATIVE_TRIPLE =
  HOST_NATIVE_PLATFORM === "win32" ? "aarch64-pc-windows-msvc" : "aarch64-unknown-linux-musl";
const HOST_NATIVE_PACKAGE_VERSION = `0.145.0-${HOST_NATIVE_PLATFORM}-${HOST_NATIVE_ARCH}`;
const HOST_NATIVE_BINARY_NAME = HOST_NATIVE_PLATFORM === "win32" ? "codex.exe" : "codex";
const HOST_NATIVE_ALIAS = `@openai/codex-${HOST_NATIVE_PLATFORM}-${HOST_NATIVE_ARCH}`;

describe("managed Codex app-server binary", () => {
  it("resolves the platform-native artifact behind the managed npm launcher", async () => {
    const installRoot = await mkdtemp(path.join(os.tmpdir(), "openclaw-codex-launcher-"));
    const launcherRoot = path.join(installRoot, "node_modules", "@openai", "codex");
    const platformPackageRoot = path.join(
      installRoot,
      "node_modules",
      "@openai",
      HOST_NATIVE_ALIAS.split("/")[1]!,
    );
    const packageJsonPath = path.join(platformPackageRoot, "package.json");
    const expected = path.join(
      platformPackageRoot,
      "vendor",
      HOST_NATIVE_TRIPLE,
      "bin",
      HOST_NATIVE_BINARY_NAME,
    );
    await mkdir(path.dirname(expected), { recursive: true });
    await writeFile(
      packageJsonPath,
      JSON.stringify({ name: "@openai/codex", version: HOST_NATIVE_PACKAGE_VERSION }),
    );
    await writeFile(expected, "native codex\n");

    expect(
      resolveManagedCodexNativeCommand(managedCommandPath(installRoot, HOST_NATIVE_PLATFORM), {
        platform: HOST_NATIVE_PLATFORM,
        arch: HOST_NATIVE_ARCH,
        resolvePackageJson: (packageName, root) =>
          packageName === HOST_NATIVE_ALIAS && root === launcherRoot ? packageJsonPath : undefined,
        pathExists: (candidate) => candidate === expected,
      }),
    ).toBe(expected);
  });

  it("treats an exact-version native package binary as its own identity", async () => {
    const installRoot = await mkdtemp(path.join(os.tmpdir(), "openclaw-codex-native-"));
    const packageRoot = path.join(installRoot, "node_modules", "@openai", "codex");
    const command = path.join(
      packageRoot,
      "vendor",
      HOST_NATIVE_TRIPLE,
      "bin",
      HOST_NATIVE_BINARY_NAME,
    );
    await mkdir(path.dirname(command), { recursive: true });
    await writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "@openai/codex", version: HOST_NATIVE_PACKAGE_VERSION }),
    );
    await writeFile(command, "native codex\n");
    const resolvePackageJson = vi.fn(() => "/repo/stale/package.json");
    const pathExists = vi.fn(() => true);

    expect(
      resolveManagedCodexNativeCommand(command, {
        platform: HOST_NATIVE_PLATFORM,
        arch: HOST_NATIVE_ARCH,
        resolvePackageJson,
        pathExists,
      }),
    ).toBe(await realpath(command));
    expect(resolvePackageJson).not.toHaveBeenCalled();
    expect(pathExists).not.toHaveBeenCalled();
  });

  it("rejects a stale-version native package binary as managed identity", async () => {
    const installRoot = await mkdtemp(path.join(os.tmpdir(), "openclaw-codex-stale-native-"));
    const packageRoot = path.join(installRoot, "node_modules", "@openai", "codex");
    const command = path.join(
      packageRoot,
      "vendor",
      HOST_NATIVE_TRIPLE,
      "bin",
      HOST_NATIVE_BINARY_NAME,
    );
    await mkdir(path.dirname(command), { recursive: true });
    await writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "@openai/codex",
        version: `0.144.6-${HOST_NATIVE_PLATFORM}-${HOST_NATIVE_ARCH}`,
      }),
    );
    await writeFile(command, "stale native codex\n");

    expect(
      resolveManagedCodexNativeCommand(command, {
        platform: HOST_NATIVE_PLATFORM,
        arch: HOST_NATIVE_ARCH,
      }),
    ).toBeUndefined();
  });

  it("does not treat a lookalike native suffix as a managed package identity", () => {
    const command = "/repo/notvendor/aarch64-unknown-linux-musl/bin/codex";

    expect(
      resolveManagedCodexNativeCommand(command, {
        platform: "linux",
        arch: "arm64",
      }),
    ).toBeUndefined();
  });

  it("reports the desktop bundle binary as its native artifact", () => {
    expect(
      resolveManagedCodexNativeCommand(MACOS_DESKTOP_CHATGPT_APP_SERVER_COMMAND, {
        platform: "darwin",
        arch: "arm64",
      }),
    ).toBe(MACOS_DESKTOP_CHATGPT_APP_SERVER_COMMAND);
  });

  it("leaves explicit command overrides unchanged", async () => {
    const explicitOptions = startOptions("config");
    const pathExists = vi.fn(async () => false);

    await expect(
      resolveManagedCodexAppServerStartOptions(explicitOptions, {
        platform: "darwin",
        pathExists,
      }),
    ).resolves.toBe(explicitOptions);
    expect(pathExists).not.toHaveBeenCalled();
  });

  it("keeps the pinned package ahead of stale desktop bundles for ordinary turns", async () => {
    const pluginRoot = path.join("/tmp", "openclaw", "extensions", "codex");
    const pluginLocalCommand = managedCommandPath(pluginRoot, "darwin");
    const pathExists = vi.fn(
      async (filePath: string) =>
        filePath === MACOS_DESKTOP_CHATGPT_APP_SERVER_COMMAND ||
        filePath === MACOS_DESKTOP_CODEX_APP_SERVER_COMMAND ||
        filePath === pluginLocalCommand,
    );

    await expect(
      resolveManagedCodexAppServerStartOptions(startOptions("managed"), {
        platform: "darwin",
        pluginRoot,
        pathExists,
      }),
    ).resolves.toEqual({
      ...startOptions("managed"),
      command: pluginLocalCommand,
      commandSource: "resolved-managed",
      managedFallbackCommandPaths: [
        MACOS_DESKTOP_CHATGPT_APP_SERVER_COMMAND,
        MACOS_DESKTOP_CODEX_APP_SERVER_COMMAND,
      ],
    });
  });

  it("prefers the ChatGPT.app desktop bundle for Computer Use", async () => {
    const pluginRoot = path.join("/tmp", "openclaw", "extensions", "codex");
    const pluginLocalCommand = managedCommandPath(pluginRoot, "darwin");
    const pathExists = vi.fn(
      async (filePath: string) =>
        filePath === MACOS_DESKTOP_CHATGPT_APP_SERVER_COMMAND || filePath === pluginLocalCommand,
    );

    await expect(
      resolveManagedCodexAppServerStartOptions(startOptions("managed", "desktop-first"), {
        platform: "darwin",
        pluginRoot,
        pathExists,
      }),
    ).resolves.toEqual({
      ...startOptions("managed", "desktop-first"),
      command: MACOS_DESKTOP_CHATGPT_APP_SERVER_COMMAND,
      commandSource: "resolved-managed",
      managedFallbackCommandPaths: [pluginLocalCommand],
    });
  });

  it("falls back to the legacy Codex.app desktop bundle when ChatGPT.app is absent", async () => {
    const pluginRoot = path.join("/tmp", "openclaw", "extensions", "codex");
    const pluginLocalCommand = managedCommandPath(pluginRoot, "darwin");
    const pathExists = vi.fn(
      async (filePath: string) =>
        filePath === MACOS_DESKTOP_CODEX_APP_SERVER_COMMAND || filePath === pluginLocalCommand,
    );

    await expect(
      resolveManagedCodexAppServerStartOptions(startOptions("managed", "desktop-first"), {
        platform: "darwin",
        pluginRoot,
        pathExists,
      }),
    ).resolves.toEqual({
      ...startOptions("managed", "desktop-first"),
      command: MACOS_DESKTOP_CODEX_APP_SERVER_COMMAND,
      commandSource: "resolved-managed",
      managedFallbackCommandPaths: [pluginLocalCommand],
    });
  });

  it("falls back to the plugin-local binary when neither desktop bundle exists", async () => {
    const pluginRoot = path.join("/tmp", "openclaw", "extensions", "codex");
    const pluginLocalCommand = managedCommandPath(pluginRoot, "darwin");
    const pathExists = vi.fn(async (filePath: string) => filePath === pluginLocalCommand);

    await expect(
      resolveManagedCodexAppServerStartOptions(startOptions("managed", "desktop-first"), {
        platform: "darwin",
        pluginRoot,
        pathExists,
      }),
    ).resolves.toEqual({
      ...startOptions("managed", "desktop-first"),
      command: pluginLocalCommand,
      commandSource: "resolved-managed",
    });
    expect(pathExists).toHaveBeenCalledWith(MACOS_DESKTOP_CHATGPT_APP_SERVER_COMMAND, "darwin");
    expect(pathExists).toHaveBeenCalledWith(MACOS_DESKTOP_CODEX_APP_SERVER_COMMAND, "darwin");
  });

  it("finds Codex in the package install root used by packaged plugins", async () => {
    const installRoot = path.join("/tmp", "openclaw-plugin-package", "codex");
    const pluginRoot = path.join(installRoot, "dist", "extensions", "codex");
    const installedCommand = managedCommandPath(installRoot, "linux");
    const pathExists = vi.fn(async (filePath: string) => filePath === installedCommand);

    await expect(
      resolveManagedCodexAppServerStartOptions(startOptions("managed"), {
        platform: "linux",
        pluginRoot,
        pathExists,
      }),
    ).resolves.toEqual({
      ...startOptions("managed"),
      command: installedCommand,
      commandSource: "resolved-managed",
    });
  });

  it("finds Codex bins hoisted into an isolated npm project root", async () => {
    const projectRoot = path.join("/tmp", "state", "npm", "projects", "openclaw-codex-hash");
    const pluginRoot = path.join(projectRoot, "node_modules", "@openclaw", "codex");
    const installedCommand = managedCommandPath(projectRoot, "linux");
    const pathExists = vi.fn(async (filePath: string) => filePath === installedCommand);

    await expect(
      resolveManagedCodexAppServerStartOptions(startOptions("managed"), {
        platform: "linux",
        pluginRoot,
        pathExists,
      }),
    ).resolves.toEqual({
      ...startOptions("managed"),
      command: installedCommand,
      commandSource: "resolved-managed",
    });
  });

  it("finds Windows Codex shims hoisted into an isolated npm project root", async () => {
    const projectRoot = path.win32.join(
      "C:\\",
      "Users",
      "test",
      ".openclaw",
      "npm",
      "projects",
      "openclaw-codex-hash",
    );
    const pluginRoot = path.win32.join(projectRoot, "node_modules", "@openclaw", "codex");
    const installedCommand = managedCommandPath(projectRoot, "win32");
    const pathExists = vi.fn(async (filePath: string) => filePath === installedCommand);

    await expect(
      resolveManagedCodexAppServerStartOptions(startOptions("managed"), {
        platform: "win32",
        pluginRoot,
        pathExists,
      }),
    ).resolves.toEqual({
      ...startOptions("managed"),
      command: installedCommand,
      commandSource: "resolved-managed",
    });
  });

  it("falls back to the resolved Codex package bin when no command shim exists", async () => {
    const installRoot = await mkdtemp(path.join(os.tmpdir(), "openclaw-codex-package-"));
    const pluginRoot = path.join(installRoot, "dist", "extensions", "codex");
    const packageRoot = path.join(installRoot, "node_modules", "@openai", "codex");
    const packageBin = path.join(packageRoot, "bin", "codex.js");
    await mkdir(path.dirname(packageBin), { recursive: true });
    await writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "@openai/codex",
        version: "0.145.0",
        bin: {
          codex: "bin/codex.js",
        },
      }),
    );
    await writeFile(packageBin, "#!/usr/bin/env node\n");
    const resolvedPackageBin = await realpath(packageBin);

    const pathExists = vi.fn(async (filePath: string) => filePath === resolvedPackageBin);

    await expect(
      resolveManagedCodexAppServerStartOptions(startOptions("managed"), {
        platform: HOST_NATIVE_PLATFORM,
        pluginRoot,
        pathExists,
      }),
    ).resolves.toEqual({
      ...startOptions("managed"),
      command: resolvedPackageBin,
      commandSource: "resolved-managed",
    });
  });

  it("prefers the pinned pnpm-store package over a conflicting hoisted shim", async () => {
    const installRoot = await mkdtemp(path.join(os.tmpdir(), "openclaw-codex-pnpm-store-"));
    const pluginRoot = path.join(
      installRoot,
      "node_modules",
      ".pnpm",
      "@openclaw+codex@2026.7.2",
      "node_modules",
      "@openclaw",
      "codex",
    );
    const hoistedPackageRoot = path.join(installRoot, "node_modules", "@openai", "codex");
    const exactPackageRoot = path.join(
      installRoot,
      "node_modules",
      ".pnpm",
      "@openai+codex@0.145.0",
      "node_modules",
      "@openai",
      "codex",
    );
    const exactNativeCommand = path.join(
      installRoot,
      "node_modules",
      ".pnpm",
      `@openai+codex@${HOST_NATIVE_PACKAGE_VERSION}`,
      "node_modules",
      "@openai",
      "codex",
      "vendor",
      HOST_NATIVE_TRIPLE,
      "bin",
      HOST_NATIVE_BINARY_NAME,
    );
    const hoistedCommand = managedCommandPath(installRoot, HOST_NATIVE_PLATFORM);
    for (const [packageRoot, version] of [
      [hoistedPackageRoot, "0.144.6"],
      [exactPackageRoot, "0.145.0"],
    ] as const) {
      await mkdir(path.join(packageRoot, "bin"), { recursive: true });
      await writeFile(
        path.join(packageRoot, "package.json"),
        JSON.stringify({
          name: "@openai/codex",
          version,
          bin: { codex: "bin/codex.js" },
        }),
      );
      await writeFile(path.join(packageRoot, "bin", "codex.js"), "#!/usr/bin/env node\n");
    }
    await mkdir(path.dirname(exactNativeCommand), { recursive: true });
    await writeFile(exactNativeCommand, "native codex\n");
    const pathExists = vi.fn(
      async (filePath: string) => filePath === exactNativeCommand || filePath === hoistedCommand,
    );

    await expect(
      resolveManagedCodexAppServerStartOptions(startOptions("managed"), {
        platform: HOST_NATIVE_PLATFORM,
        arch: HOST_NATIVE_ARCH,
        pluginRoot,
        pathExists,
      }),
    ).resolves.toEqual({
      ...startOptions("managed"),
      command: exactNativeCommand,
      commandSource: "resolved-managed",
      managedFallbackCommandPaths: [hoistedCommand],
    });
  });

  it("uses the Linux pnpm platform package for Android", async () => {
    const installRoot = path.posix.join("/tmp", "openclaw-android-codex");
    const pluginRoot = path.posix.join(installRoot, "extensions", "codex");
    const expected = path.posix.join(
      installRoot,
      "node_modules",
      ".pnpm",
      "@openai+codex@0.145.0-linux-arm64",
      "node_modules",
      "@openai",
      "codex",
      "vendor",
      "aarch64-unknown-linux-musl",
      "bin",
      "codex",
    );

    await expect(
      resolveManagedCodexAppServerStartOptions(startOptions("managed"), {
        platform: "android",
        arch: "arm64",
        pluginRoot,
        pathExists: vi.fn(async (candidate) => candidate === expected),
      }),
    ).resolves.toEqual({
      ...startOptions("managed"),
      command: expected,
      commandSource: "resolved-managed",
    });
  });

  it("fails clearly when the managed Codex binary is missing", async () => {
    await expect(
      resolveManagedCodexAppServerStartOptions(startOptions("managed"), {
        platform: "darwin",
        pluginRoot: path.join("/tmp", "openclaw", "extensions", "codex"),
        pathExists: vi.fn(async () => false),
      }),
    ).rejects.toThrow("Managed Codex app-server binary was not found");
  });
});
