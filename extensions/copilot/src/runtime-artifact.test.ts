import fs from "node:fs/promises";
import path from "node:path";
import { RuntimeConnection } from "@github/copilot-sdk";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureCopilotRuntimeArtifact,
  validateCopilotRuntimeArtifact,
} from "./runtime-artifact.js";
import { fingerprintCopilotPackage, loadCopilotSdkWithIdentity } from "./sdk-loader.js";

vi.mock("./sdk-loader.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sdk-loader.js")>()),
  loadCopilotSdkWithIdentity: vi.fn(),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  vi.stubEnv("COPILOT_CLI_PATH", "");
  vi.stubEnv("COPILOT_SDK_DEFAULT_CONNECTION", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

async function fixture() {
  const root = tempDirs.make("copilot-runtime-artifact-");
  const sdkRoot = path.join(root, "sdk");
  // Public platform package names published by @github/copilot-sdk.
  const report = process.report.getReport() as { header: { glibcVersionRuntime?: string } };
  const os =
    process.platform === "linux" && !report.header.glibcVersionRuntime
      ? "linuxmusl"
      : process.platform;
  const platform = `${os}-${process.arch}`;
  const packageName = `@github/copilot-sdk-${platform}`;
  const runtimeRoot = path.join(root, "runtime");
  const prebuild = path.join(runtimeRoot, "prebuilds", platform);
  const installedRuntime = path.join(sdkRoot, "node_modules", packageName);
  await fs.mkdir(prebuild, { recursive: true });
  await fs.mkdir(path.dirname(installedRuntime), { recursive: true });
  await fs.writeFile(
    path.join(runtimeRoot, "package.json"),
    JSON.stringify({ name: packageName, version: "1.0.14" }),
  );
  await fs.symlink(runtimeRoot, installedRuntime, "junction");
  await fs.writeFile(
    path.join(sdkRoot, "package.json"),
    JSON.stringify({
      name: "@github/copilot-sdk",
      version: "1.0.14",
      optionalDependencies: { [packageName]: "1.0.14" },
    }),
  );
  const sdkEntry = path.join(sdkRoot, "index.js");
  await fs.writeFile(sdkEntry, "export const sdk = 'original';");
  const executable = path.join(
    prebuild,
    process.platform === "win32" ? "copilot-runtime.exe" : "copilot-runtime",
  );
  await fs.writeFile(executable, "packaged runtime launcher");
  const nativeRuntime = path.join(prebuild, "runtime.node");
  await fs.writeFile(nativeRuntime, "original native runtime");
  vi.mocked(loadCopilotSdkWithIdentity).mockResolvedValue({
    sdk: { RuntimeConnection } as typeof import("@github/copilot-sdk"),
    identity: {
      entryPath: sdkEntry,
      packageRoot: sdkRoot,
      fingerprint: await fingerprintCopilotPackage(sdkRoot),
    },
  });
  return { root, runtimeRoot, installedRuntime, executable, nativeRuntime, sdkEntry };
}

describe("Copilot runtime artifacts", () => {
  it("preserves native links across equivalent captures and invalidates changed bytes", async () => {
    const files = await fixture();
    const original = await captureCopilotRuntimeArtifact();
    expect(original.connection).toMatchObject({ kind: "stdio", path: files.executable });
    const nativeCapture = path.join(files.root, "native-capture");
    await fs.rename(files.nativeRuntime, nativeCapture);
    await fs.symlink(nativeCapture, files.nativeRuntime, "file");
    const replacement = path.join(files.root, "replacement");
    await fs.cp(files.runtimeRoot, replacement, { recursive: true });
    await fs.unlink(files.installedRuntime);
    await fs.symlink(replacement, files.installedRuntime, "junction");

    const captured = await captureCopilotRuntimeArtifact();
    expect(captured.connection.path).toContain(`${path.sep}replacement${path.sep}`);
    expect(captured.binding).toEqual(original.binding);
    await expect(validateCopilotRuntimeArtifact(captured.binding)).resolves.toBe(true);
    await fs.writeFile(nativeCapture, "changed captured runtime");
    await expect(validateCopilotRuntimeArtifact(captured.binding)).resolves.toBe(false);
  });

  it("requires restart when the loaded SDK changes on disk", async () => {
    const files = await fixture();
    const captured = await captureCopilotRuntimeArtifact();
    await fs.writeFile(files.sdkEntry, "export const sdk = 'replacement';");

    await expect(validateCopilotRuntimeArtifact(captured.binding)).resolves.toBe(false);
    await expect(captureCopilotRuntimeArtifact()).rejects.toThrow("Restart OpenClaw");
  });

  it.each(["inprocess", "invalid"])(
    "refuses to replace the SDK default transport %s",
    async (transport) => {
      await fixture();
      vi.stubEnv("COPILOT_SDK_DEFAULT_CONNECTION", transport);
      await expect(captureCopilotRuntimeArtifact()).rejects.toThrow("stdio transport");
      vi.stubEnv("COPILOT_SDK_DEFAULT_CONNECTION", "STDIO");
      await expect(captureCopilotRuntimeArtifact()).resolves.toMatchObject({
        connection: { kind: "stdio" },
      });
    },
  );

  it("refuses to replace an explicitly selected external runtime", async () => {
    const files = await fixture();
    const customRuntime = path.join(files.root, "custom-runtime");
    await fs.writeFile(customRuntime, "custom runtime");

    await expect(
      captureCopilotRuntimeArtifact({ COPILOT_CLI_PATH: customRuntime }),
    ).rejects.toThrow("custom COPILOT_CLI_PATH");
    await expect(
      captureCopilotRuntimeArtifact({ COPILOT_CLI_PATH: files.executable }),
    ).resolves.toMatchObject({
      connection: { path: files.executable },
    });
  });
});
