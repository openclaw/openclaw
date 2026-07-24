// Codex tests cover isolated-home Computer Use service app provisioning.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureCodexComputerUseServiceApp,
  resolveCodexComputerUseServiceHome,
} from "./computer-use-service.js";
import { resolveCodexAppServerUserHomeDir } from "./config.js";
import { resolveMacOSDesktopCodexComputerUseServiceAppCandidates } from "./desktop-app-paths.js";
import { useAutoCleanupTempDirTracker } from "./test-support.js";

const CLIENT_RELATIVE_PATH = path.join(
  "Contents",
  "SharedSupport",
  "SkyComputerUseClient.app",
  "Contents",
  "MacOS",
  "SkyComputerUseClient",
);

describe("Codex Computer Use service app", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("provisions the desktop service app into an isolated Codex home", async () => {
    const root = tempDirs.make("openclaw-computer-use-service-");
    const sourcePath = path.join(root, "ChatGPT.app", "Codex Computer Use.app");
    const codexHome = path.join(root, "agent", "codex-home");
    await writeServiceApp(sourcePath, "desktop-client");
    const copyServiceApp = vi.fn(
      async (source: string, target: string) => await fs.cp(source, target, { recursive: true }),
    );

    const result = await ensureCodexComputerUseServiceApp({
      codexHome,
      platform: "darwin",
      sourceAppCandidates: [sourcePath],
      copyServiceApp,
    });

    const targetPath = path.join(codexHome, "computer-use", "Codex Computer Use.app");
    expect(result).toMatchObject({
      status: "installed",
      changed: true,
      sourcePath,
      targetPath,
    });
    expect(copyServiceApp).toHaveBeenCalledTimes(1);
    await expect(fs.readFile(path.join(targetPath, CLIENT_RELATIVE_PATH), "utf8")).resolves.toBe(
      "desktop-client",
    );
  });

  it("leaves an existing executable service app unchanged", async () => {
    const root = tempDirs.make("openclaw-computer-use-service-");
    const codexHome = path.join(root, "agent", "codex-home");
    const targetPath = path.join(codexHome, "computer-use", "Codex Computer Use.app");
    await writeServiceApp(targetPath, "installed-client");
    const copyServiceApp = vi.fn();

    const result = await ensureCodexComputerUseServiceApp({
      codexHome,
      platform: "darwin",
      sourceAppCandidates: [path.join(root, "missing-source")],
      copyServiceApp,
    });

    expect(result).toMatchObject({ status: "already_installed", changed: false, targetPath });
    expect(copyServiceApp).not.toHaveBeenCalled();
    await expect(fs.readFile(path.join(targetPath, CLIENT_RELATIVE_PATH), "utf8")).resolves.toBe(
      "installed-client",
    );
  });

  it("leaves a service app unchanged when its bundled metadata still matches", async () => {
    const root = tempDirs.make("openclaw-computer-use-service-");
    const sourcePath = path.join(root, "ChatGPT.app", "Codex Computer Use.app");
    const codexHome = path.join(root, "agent", "codex-home");
    const targetPath = path.join(codexHome, "computer-use", "Codex Computer Use.app");
    await writeServiceApp(sourcePath, "desktop-client", "version-2");
    await writeServiceApp(targetPath, "desktop-client", "version-2");
    const copyServiceApp = vi.fn();

    const result = await ensureCodexComputerUseServiceApp({
      codexHome,
      platform: "darwin",
      sourceAppCandidates: [sourcePath],
      copyServiceApp,
    });

    expect(result).toMatchObject({
      status: "already_installed",
      changed: false,
      sourcePath,
      targetPath,
    });
    expect(copyServiceApp).not.toHaveBeenCalled();
  });

  it("atomically refreshes an executable service app when bundled metadata changes", async () => {
    const root = tempDirs.make("openclaw-computer-use-service-");
    const sourcePath = path.join(root, "ChatGPT.app", "Codex Computer Use.app");
    const codexHome = path.join(root, "agent", "codex-home");
    const targetPath = path.join(codexHome, "computer-use", "Codex Computer Use.app");
    await writeServiceApp(sourcePath, "replacement-client", "version-2", "same-code-resources");
    await writeServiceApp(targetPath, "stale-client", "version-2", "same-code-resources");

    const result = await ensureCodexComputerUseServiceApp({
      codexHome,
      platform: "darwin",
      sourceAppCandidates: [sourcePath],
      copyServiceApp: async (source, target) => await fs.cp(source, target, { recursive: true }),
    });

    expect(result).toMatchObject({ status: "installed", changed: true, sourcePath, targetPath });
    await expect(fs.readFile(path.join(targetPath, CLIENT_RELATIVE_PATH), "utf8")).resolves.toBe(
      "replacement-client",
    );
    await expect(
      fs.readFile(path.join(targetPath, "Contents", "Info.plist"), "utf8"),
    ).resolves.toBe("version-2");
  });

  it("preserves a valid target when the source fingerprint is unavailable", async () => {
    const root = tempDirs.make("openclaw-computer-use-service-");
    const sourcePath = path.join(root, "ChatGPT.app", "Codex Computer Use.app");
    const codexHome = path.join(root, "agent", "codex-home");
    const targetPath = path.join(codexHome, "computer-use", "Codex Computer Use.app");
    await writeServiceApp(sourcePath, "desktop-client", "version-2");
    await fs.rm(path.join(sourcePath, "Contents", "_CodeSignature"), {
      recursive: true,
      force: true,
    });
    await writeServiceApp(targetPath, "installed-client", "version-1");
    const copyServiceApp = vi.fn();

    const result = await ensureCodexComputerUseServiceApp({
      codexHome,
      platform: "darwin",
      sourceAppCandidates: [sourcePath],
      copyServiceApp,
    });

    expect(result).toMatchObject({ status: "already_installed", changed: false, targetPath });
    expect(copyServiceApp).not.toHaveBeenCalled();
    await expect(fs.readFile(path.join(targetPath, CLIENT_RELATIVE_PATH), "utf8")).resolves.toBe(
      "installed-client",
    );
  });

  it("accepts a matching install won by another process during target backup", async () => {
    const root = tempDirs.make("openclaw-computer-use-service-");
    const sourcePath = path.join(root, "ChatGPT.app", "Codex Computer Use.app");
    const codexHome = path.join(root, "agent", "codex-home");
    const targetPath = path.join(codexHome, "computer-use", "Codex Computer Use.app");
    await writeServiceApp(sourcePath, "replacement-client", "version-2");
    await writeServiceApp(targetPath, "stale-client", "version-1");
    const movePath = vi.fn(async (source: string, target: string) => {
      if (source === targetPath) {
        await fs.rm(targetPath, { recursive: true, force: true });
        await fs.cp(sourcePath, targetPath, { recursive: true });
        const error = new Error("target was moved by another process") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      await fs.rename(source, target);
    });

    const result = await ensureCodexComputerUseServiceApp({
      codexHome,
      platform: "darwin",
      sourceAppCandidates: [sourcePath],
      copyServiceApp: async (source, target) => await fs.cp(source, target, { recursive: true }),
      movePath,
    });

    expect(result).toMatchObject({ status: "already_installed", changed: false, targetPath });
    expect(movePath).toHaveBeenCalledTimes(2);
    await expect(fs.readFile(path.join(targetPath, CLIENT_RELATIVE_PATH), "utf8")).resolves.toBe(
      "replacement-client",
    );
  });

  it("repairs an incomplete target without exposing a partial copy", async () => {
    const root = tempDirs.make("openclaw-computer-use-service-");
    const sourcePath = path.join(root, "ChatGPT.app", "Codex Computer Use.app");
    const codexHome = path.join(root, "agent", "codex-home");
    const targetPath = path.join(codexHome, "computer-use", "Codex Computer Use.app");
    await writeServiceApp(sourcePath, "replacement-client");
    await fs.mkdir(targetPath, { recursive: true });
    await fs.writeFile(path.join(targetPath, "incomplete-marker"), "old");

    const result = await ensureCodexComputerUseServiceApp({
      codexHome,
      platform: "darwin",
      sourceAppCandidates: [sourcePath],
      copyServiceApp: async (source, target) => await fs.cp(source, target, { recursive: true }),
    });

    expect(result).toMatchObject({ status: "installed", changed: true, targetPath });
    await expect(fs.readFile(path.join(targetPath, CLIENT_RELATIVE_PATH), "utf8")).resolves.toBe(
      "replacement-client",
    );
    await expect(fs.access(path.join(targetPath, "incomplete-marker"))).rejects.toThrow();
  });

  it("preserves an incomplete target when staging fails", async () => {
    const root = tempDirs.make("openclaw-computer-use-service-");
    const sourcePath = path.join(root, "ChatGPT.app", "Codex Computer Use.app");
    const codexHome = path.join(root, "agent", "codex-home");
    const targetPath = path.join(codexHome, "computer-use", "Codex Computer Use.app");
    await writeServiceApp(sourcePath, "desktop-client");
    await fs.mkdir(targetPath, { recursive: true });
    await fs.writeFile(path.join(targetPath, "incomplete-marker"), "preserve-me");

    await expect(
      ensureCodexComputerUseServiceApp({
        codexHome,
        platform: "darwin",
        sourceAppCandidates: [sourcePath],
        copyServiceApp: async () => {
          throw new Error("copy failed");
        },
      }),
    ).rejects.toThrow("copy failed");
    await expect(fs.readFile(path.join(targetPath, "incomplete-marker"), "utf8")).resolves.toBe(
      "preserve-me",
    );
  });

  it("reports a missing desktop source without creating a target", async () => {
    const root = tempDirs.make("openclaw-computer-use-service-");
    const codexHome = path.join(root, "agent", "codex-home");

    const result = await ensureCodexComputerUseServiceApp({
      codexHome,
      platform: "darwin",
      sourceAppCandidates: [path.join(root, "missing-source")],
    });

    expect(result).toMatchObject({ status: "source_missing", changed: false });
    await expect(fs.access(path.join(codexHome, "computer-use"))).rejects.toThrow();
  });

  it("resolves isolated, explicit, user, and remote homes", () => {
    const agentDir = "/tmp/openclaw-agent";
    expect(
      resolveCodexComputerUseServiceHome({
        startOptions: createStartOptions(),
        agentDir,
      }),
    ).toBe(path.join(agentDir, "codex-home"));
    expect(
      resolveCodexComputerUseServiceHome({
        startOptions: createStartOptions({ env: { CODEX_HOME: "/tmp/custom-codex" } }),
        agentDir,
      }),
    ).toBe("/tmp/custom-codex");
    expect(
      resolveCodexComputerUseServiceHome({
        startOptions: createStartOptions({ homeScope: "user" }),
        agentDir,
      }),
    ).toBe(resolveCodexAppServerUserHomeDir());
    expect(
      resolveCodexComputerUseServiceHome({
        startOptions: {
          ...createStartOptions(),
          transport: "websocket",
          url: "ws://localhost:8765",
        },
        agentDir,
      }),
    ).toBeUndefined();
  });

  it("prefers the service app paired with the selected desktop command", () => {
    expect(
      resolveMacOSDesktopCodexComputerUseServiceAppCandidates(
        "darwin",
        "/Applications/Codex.app/Contents/Resources/codex",
      ),
    ).toEqual([
      "/Applications/Codex.app/Contents/Resources/cua_node/lib/node_modules/@oai/sky/Codex Computer Use.app",
      "/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/sky/Codex Computer Use.app",
    ]);
  });
});

async function writeServiceApp(
  appPath: string,
  contents: string,
  metadata = `metadata:${contents}`,
  codeResources = `signature:${metadata}:${contents}`,
): Promise<void> {
  const clientPath = path.join(appPath, CLIENT_RELATIVE_PATH);
  await fs.mkdir(path.dirname(clientPath), { recursive: true });
  await fs.writeFile(clientPath, contents, { mode: 0o755 });
  await fs.writeFile(path.join(appPath, "Contents", "Info.plist"), metadata);
  const codeResourcesPath = path.join(appPath, "Contents", "_CodeSignature", "CodeResources");
  await fs.mkdir(path.dirname(codeResourcesPath), { recursive: true });
  await fs.writeFile(codeResourcesPath, codeResources);
}

function createStartOptions(
  overrides: Record<string, unknown> = {},
): Parameters<typeof resolveCodexComputerUseServiceHome>[0]["startOptions"] {
  return {
    transport: "stdio",
    command: "codex",
    args: ["app-server"],
    commandSource: "config",
    homeScope: "agent",
    ...overrides,
  } as Parameters<typeof resolveCodexComputerUseServiceHome>[0]["startOptions"];
}
