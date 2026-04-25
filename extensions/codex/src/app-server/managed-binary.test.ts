import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CodexAppServerStartOptions } from "./config.js";
import {
  resolveManagedCodexAppServerPaths,
  resolveManagedCodexAppServerStartOptions,
} from "./managed-binary.js";
import {
  MANAGED_CODEX_APP_SERVER_PACKAGE,
  MANAGED_CODEX_APP_SERVER_PACKAGE_VERSION,
} from "./version.js";

function startOptions(
  commandSource: CodexAppServerStartOptions["commandSource"],
): CodexAppServerStartOptions {
  return {
    transport: "stdio",
    command: "codex",
    commandSource,
    args: ["app-server", "--listen", "stdio://"],
    headers: {},
  };
}

describe("managed Codex app-server binary", () => {
  it("leaves explicit command overrides unchanged", async () => {
    const explicitOptions = startOptions("config");
    const installPackage = vi.fn(async () => undefined);

    await expect(
      resolveManagedCodexAppServerStartOptions(explicitOptions, {
        platform: "darwin",
        env: { OPENCLAW_CODEX_APP_SERVER_CACHE_DIR: "/tmp/openclaw-codex-cache" },
        pathExists: vi.fn(async () => false),
        installPackage,
      }),
    ).resolves.toBe(explicitOptions);
    expect(installPackage).not.toHaveBeenCalled();
  });

  it("resolves an already-installed managed Codex binary from the cache", async () => {
    const cacheDir = path.join("/tmp", "openclaw-codex-managed-installed");
    const paths = resolveManagedCodexAppServerPaths({
      platform: "darwin",
      env: { OPENCLAW_CODEX_APP_SERVER_CACHE_DIR: cacheDir },
    });
    const pathExists = vi.fn(async () => true);
    const installPackage = vi.fn(async () => undefined);

    await expect(
      resolveManagedCodexAppServerStartOptions(startOptions("managed"), {
        platform: "darwin",
        env: { OPENCLAW_CODEX_APP_SERVER_CACHE_DIR: cacheDir },
        pathExists,
        installPackage,
      }),
    ).resolves.toEqual({
      ...startOptions("managed"),
      command: paths.commandPath,
      commandSource: "resolved-managed",
    });
    expect(pathExists).toHaveBeenCalledWith(paths.commandPath, "darwin");
    expect(installPackage).not.toHaveBeenCalled();
  });

  it("installs the pinned package when the managed binary is missing", async () => {
    const cacheDir = path.join("/tmp", "openclaw-codex-managed-missing");
    const paths = resolveManagedCodexAppServerPaths({
      platform: "darwin",
      env: { OPENCLAW_CODEX_APP_SERVER_CACHE_DIR: cacheDir },
    });
    let existsCalls = 0;
    const pathExists = vi.fn(async () => {
      existsCalls += 1;
      return existsCalls > 1;
    });
    const installPackage = vi.fn(async () => undefined);

    const resolved = await resolveManagedCodexAppServerStartOptions(startOptions("managed"), {
      platform: "darwin",
      env: { OPENCLAW_CODEX_APP_SERVER_CACHE_DIR: cacheDir },
      pathExists,
      installPackage,
    });

    expect(resolved).toEqual({
      ...startOptions("managed"),
      command: paths.commandPath,
      commandSource: "resolved-managed",
    });
    expect(pathExists).toHaveBeenCalledTimes(2);
    expect(installPackage).toHaveBeenCalledWith(
      expect.objectContaining({
        installRoot: paths.installRoot,
        packageName: MANAGED_CODEX_APP_SERVER_PACKAGE,
        packageVersion: MANAGED_CODEX_APP_SERVER_PACKAGE_VERSION,
        platform: "darwin",
      }),
    );
  });

  it("fails clearly when installation does not create the Codex shim", async () => {
    await expect(
      resolveManagedCodexAppServerStartOptions(startOptions("managed"), {
        platform: "darwin",
        env: { OPENCLAW_CODEX_APP_SERVER_CACHE_DIR: "/tmp/openclaw-codex-managed-broken" },
        pathExists: vi.fn(async () => false),
        installPackage: vi.fn(async () => undefined),
      }),
    ).rejects.toThrow("Managed Codex app-server binary was not created");
  });
});
