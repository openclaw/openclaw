import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { resolveNpmRunner } from "../../../scripts/npm-runner.mts";
import { getWindowsSystem32ExePath } from "../../../src/infra/windows-install-roots.js";
import { createNodeEvalArgs } from "../../../src/test-utils/node-process.js";
import { withTempDir } from "../../../src/test-utils/temp-dir.js";
import { installPackedSdkConsumer, signalCommandProcess } from "./package.e2e.test-support.js";

const execFileAsync = promisify(execFile);

async function packFixture(
  root: string,
  name: string,
  source: string,
  dependencies?: Record<string, string>,
) {
  const manifest = { name, version: "1.0.0", type: "module", main: "./index.js", dependencies };
  const slug = name.replace("@", "").replace("/", "-");
  const packageRoot = path.join(root, slug);
  await fs.mkdir(packageRoot);
  await fs.writeFile(path.join(packageRoot, "package.json"), JSON.stringify(manifest));
  await fs.writeFile(path.join(packageRoot, "index.js"), source);
  const runner = resolveNpmRunner({
    npmArgs: ["pack", "--ignore-scripts", "--pack-destination", root],
  });
  await execFileAsync(runner.command, runner.args, {
    cwd: packageRoot,
    env: runner.env ?? process.env,
    shell: runner.shell,
    windowsVerbatimArguments: runner.windowsVerbatimArguments,
    timeout: 30_000,
  });
  return { manifest, tarball: path.join(root, `${slug}-1.0.0.tgz`) };
}

describe("packed SDK command support", () => {
  it.each([true, false])("preserves dependency declarations (declared: %s)", async (declared) => {
    await withTempDir("sdk-packed-sources-", async (tempRoot) => {
      const root = path.join(tempRoot, "sources with spaces # and %");
      await fs.mkdir(root);
      vi.stubEnv("npm_config_cache", path.join(tempRoot, "cache"));
      vi.stubEnv("npm_config_offline", "true");
      try {
        const sdk = await packFixture(
          root,
          "@openclaw/sdk",
          'export { value } from "@openclaw/nested";',
          declared ? { "@openclaw/nested": "1.0.0" } : undefined,
        );
        const nested = await packFixture(
          root,
          "@openclaw/nested",
          'export const value = "nested";',
        );
        const undeclared = await packFixture(root, "@openclaw/undeclared", "export {};");
        await installPackedSdkConsumer([sdk, nested, undeclared], root);
        await execFileAsync(
          process.execPath,
          createNodeEvalArgs(`
            import assert from "node:assert/strict";
            if (${declared}) {
              const { value } = await import("@openclaw/sdk");
              assert.equal(value, "nested");
              await assert.rejects(import("@openclaw/undeclared"), (error) =>
                error.code === "ERR_MODULE_NOT_FOUND" && error.message.includes("@openclaw/undeclared")
              );
            } else {
              await assert.rejects(import("@openclaw/sdk"), (error) =>
                error.code === "ERR_MODULE_NOT_FOUND" && error.message.includes("@openclaw/nested")
              );
            }
          `),
          { cwd: root, timeout: 30_000 },
        );
        const consumer = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
        expect(Object.keys(consumer.dependencies)).toEqual(["@openclaw/sdk"]);
        const installed = JSON.parse(
          await fs.readFile(path.join(root, "node_modules/@openclaw/sdk/package.json"), "utf8"),
        );
        expect(installed.dependencies).toEqual(
          declared ? { "@openclaw/nested": "1.0.0" } : undefined,
        );
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  it("does not redirect an incompatible declared version to a local tarball", async () => {
    await withTempDir("sdk-packed-version-", async (root) => {
      vi.stubEnv("npm_config_cache", path.join(root, "cache"));
      vi.stubEnv("npm_config_offline", "true");
      try {
        const sdk = await packFixture(root, "@openclaw/sdk", "export {};", {
          "@openclaw/nested": "99.0.0",
        });
        const nested = await packFixture(root, "@openclaw/nested", "export {};");
        // A cold offline cache makes the unmet registry edge fail deterministically.
        // An unqualified name-only override would incorrectly install version 1.0.0.
        await expect(installPackedSdkConsumer([sdk, nested], root)).rejects.toThrow("ENOTCACHED");
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  it("force-kills Windows package command process trees", () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const killMock = vi.fn();
      const child = {
        pid: 12345,
        kill: killMock,
      } as unknown as ReturnType<typeof spawn>;
      const runTaskkill = vi.fn().mockReturnValueOnce({ status: 0 });

      signalCommandProcess(child, runTaskkill);

      const taskkillPath = getWindowsSystem32ExePath("taskkill.exe");
      expect(runTaskkill).toHaveBeenCalledTimes(1);
      expect(runTaskkill).toHaveBeenCalledWith(taskkillPath, ["/PID", "12345", "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      expect(killMock).not.toHaveBeenCalled();
    } finally {
      if (platformDescriptor) {
        Object.defineProperty(process, "platform", platformDescriptor);
      }
    }
  });
});
