import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { listDirectoryTreeStrict } from "openclaw/plugin-sdk/file-access-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCrabboxOfflineRuntimeSetup,
  createCrabboxRuntimeCacheVerification,
  readCrabboxRuntimeInstallation,
} from "../cli-runtime-api.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const run = promisify(execFile);
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

describe.skipIf(process.platform === "win32")("offline runtime installation", () => {
  async function fixture(withBuild = false) {
    const home = await fs.realpath(tempDirs.make("crabbox-offline-runtime-"));
    const packageRoot = path.join(home, "package");
    await fs.mkdir(packageRoot);
    const worker = Buffer.from("retained worker archive bytes");
    const build = {
      bundleHash: "f".repeat(64),
      openclawVersion: "2026.8.1",
      protocolFeatures: ["fixture-protocol"],
    };
    const expansionInput = { build, archive: { sha256: digest(worker), bytes: worker.length } };
    const metadata = JSON.stringify({
      install: "bundle",
      buildId: "offline-build",
      openclawVersion: "2026.8.1",
      platforms: [{ platform: process.platform, arch: process.arch }],
    });
    const inventory = JSON.stringify([{ path: "node-runtime.json", sha256: digest(metadata) }]);
    for (const [name, bytes] of Object.entries({
      "package.json": JSON.stringify({
        name: "openclaw",
        version: "2026.8.1",
        scripts: { postinstall: "exit 99" },
      }),
      "node-runtime.json": metadata,
      "node-runtime.manifest.json": inventory,
      "openclaw.mjs": `import assert from "node:assert/strict";
import fs from "node:fs";
if (["CRABBOX_WORKER_BOOTSTRAP_TOKEN", "CRABBOX_WORKER_SETUP_CODE", "CRABBOX_WORKER_CODEX_CONFIG"].some(key => process.env[key])) throw new Error("Forwarded credentials reached runtime probe");
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") console.log("OpenClaw 2026.8.1");
else {
  assert(${withBuild}, "Must not enroll or activate plugins");
  assert.deepEqual(args.slice(0, 3), ["node", "prepare-worker-bundle", "--input"]);
  assert.deepEqual(JSON.parse(args[3]), ${JSON.stringify(expansionInput)});
  const marker = new URL("./fixture-expanded-input.json", import.meta.url);
  if (args[4] === "--verify-only") {
    assert.equal(args.length, 5);
    assert.deepEqual(JSON.parse(fs.readFileSync(marker, "utf8")), ${JSON.stringify(expansionInput)});
  } else {
    assert.equal(args.length, 4);
    fs.writeFileSync(marker, args[3]);
  }
}`,
    })) {
      await fs.writeFile(path.join(packageRoot, name), bytes);
    }
    const localPath = path.join(home, "node.tgz");
    await tar.create({ cwd: home, file: localPath, gzip: true }, ["package"]);
    const bytes = await fs.readFile(localPath);
    const workerPath = path.join(home, "worker.tgz");
    await fs.writeFile(workerPath, worker);
    const nodeBootstrap = {
      localPath,
      sha256: digest(bytes),
      bytes: bytes.length,
      manifestSha256: digest(inventory),
      buildId: "offline-build",
      openclawVersion: "2026.8.1",
      enabledPluginIds: ["fixture"],
    };
    const workerBundle = {
      localPath: workerPath,
      sha256: digest(worker),
      bytes: worker.length,
      packageRelativePath: `worker-artifacts/${digest(worker)}.tgz`,
      ...(withBuild ? { build } : {}),
    };
    const installedRoot = path.join(home, ".openclaw-worker/node-runtimes", nodeBootstrap.sha256);
    const execute = (command: string) =>
      run("bash", ["-c", command], {
        env: {
          PATH: process.env.PATH,
          HOME: home,
          CRABBOX_WORKER_BOOTSTRAP_TOKEN: "synthetic-not-a-download-token",
          CRABBOX_WORKER_SETUP_CODE: "synthetic-not-an-enrollment-code",
          CRABBOX_WORKER_CODEX_CONFIG: "synthetic-not-runtime-settings",
        },
        timeout: 10_000,
      });
    const { localPath: _nodePath, ...nodeIdentity } = nodeBootstrap;
    const { localPath: _workerPath, ...workerIdentity } = workerBundle;
    const identity = { nodeBootstrap: nodeIdentity, workerBundle: workerIdentity };
    return { home, nodeBootstrap, workerBundle, identity, installedRoot, execute, expansionInput };
  }

  it("installs local bytes without npm, enrollment, credentials or plugin activation", async () => {
    const current = await fixture();
    const setup = await createCrabboxOfflineRuntimeSetup(current);
    expect(setup.forwardedEnv).toEqual({});
    const result = await current.execute(setup.command);
    expect(readCrabboxRuntimeInstallation(result.stdout, current.identity).disposition).toBe(
      "installed",
    );
    const installed = path.join(current.installedRoot, "node_modules/openclaw");
    expect(
      await fs.readFile(path.join(installed, current.workerBundle.packageRelativePath)),
    ).toEqual(await fs.readFile(current.workerBundle.localPath));
    expect(
      JSON.parse(await fs.readFile(path.join(installed, "package.json"), "utf8")),
    ).toMatchObject({
      name: "openclaw",
      version: "2026.8.1",
    });
    await expect(fs.stat(path.join(current.home, ".openclaw"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    // Reuse has no dependency on the transferred source files.
    await fs.unlink(current.nodeBootstrap.localPath);
    await fs.unlink(current.workerBundle.localPath);
    const reused = await current.execute(setup.command);
    expect(readCrabboxRuntimeInstallation(reused.stdout, current.identity).disposition).toBe(
      "existing-verified",
    );
  });

  it("forwards build identity to the native command and requires verify-only success before its receipt", async () => {
    // Executable transport contract only: this fixture CLI checks arguments and
    // simulates the native result. Bundle integrity belongs to the real installer tests.
    const current = await fixture(true);
    const setup = await createCrabboxOfflineRuntimeSetup(current);
    const installed = await current.execute(setup.command);
    expect(readCrabboxRuntimeInstallation(installed.stdout, current.identity).disposition).toBe(
      "installed",
    );
    const marker = path.join(
      current.installedRoot,
      "node_modules/openclaw/fixture-expanded-input.json",
    );
    expect(JSON.parse(await fs.readFile(marker, "utf8"))).toEqual(current.expansionInput);
    const verify = await createCrabboxRuntimeCacheVerification(current.identity);
    const verified = await current.execute(verify.command);
    expect(readCrabboxRuntimeInstallation(verified.stdout, current.identity).disposition).toBe(
      "existing-verified",
    );
    await fs.unlink(marker);
    await expect(current.execute(verify.command)).rejects.toMatchObject({
      code: 1,
      stdout: "",
      stderr: expect.stringContaining("expanded bundle preparation failed"),
    });
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["valid", ""],
    ["absent runtime", "ENOENT"],
    ["absent worker", "prepared archive is missing"],
    ["corrupt worker", "failed integrity verification"],
    ["corrupt manifest", "inventory does not match"],
    ["broken CLI", "CLI could not verify"],
  ])(
    "verifies %s without repairing, pruning, binding Node or writing state",
    async (scenario, diagnosis) => {
      const current = await fixture();
      const installed = path.join(current.installedRoot, "node_modules/openclaw");
      if (scenario !== "absent runtime") {
        const setup = await createCrabboxOfflineRuntimeSetup(current);
        await current.execute(setup.command);
        await fs.rm(path.join(current.home, ".openclaw-worker/runtime-node"), { recursive: true });
        const archive = path.join(installed, current.workerBundle.packageRelativePath);
        // A read-only probe must not prune another retained archive.
        await fs.writeFile(path.join(path.dirname(archive), `${"d".repeat(64)}.tgz`), "retained");
        if (scenario === "absent worker") {
          await fs.unlink(archive);
        }
        if (scenario === "corrupt worker") {
          await fs.writeFile(archive, Buffer.alloc(current.workerBundle.bytes));
        }
        if (scenario === "corrupt manifest") {
          await fs.writeFile(path.join(installed, "node-runtime.manifest.json"), "[]");
        }
        if (scenario === "broken CLI") {
          await fs.writeFile(path.join(installed, "openclaw.mjs"), "process.exit(1)");
        }
      }
      const snapshot = async () => {
        const names = [
          "",
          ...(await listDirectoryTreeStrict(current.home)).map((entry) => entry.relativePath),
        ];
        return Promise.all(
          names.map(async (name) => {
            const file = path.join(current.home, name);
            const stat = await fs.lstat(file);
            return [
              name,
              stat.mode,
              stat.mtimeMs,
              stat.isFile() ? digest(await fs.readFile(file)) : null,
            ];
          }),
        );
      };
      const before = await snapshot();
      const verify = await createCrabboxRuntimeCacheVerification(current.identity);
      expect(verify.forwardedEnv).toEqual({});
      if (scenario === "valid") {
        const result = await current.execute(verify.command);
        expect(readCrabboxRuntimeInstallation(result.stdout, current.identity).disposition).toBe(
          "existing-verified",
        );
      } else {
        await expect(current.execute(verify.command)).rejects.toMatchObject({
          code: 1,
          stdout: "",
          stderr: expect.stringContaining(diagnosis),
        });
      }
      expect(await snapshot()).toEqual(before);
    },
  );

  it.each(["digest", "symlink"])(
    "refuses a local archive with an unsafe %s before publication",
    async (change) => {
      const current = await fixture();
      if (change === "digest") {
        const bytes = await fs.readFile(current.nodeBootstrap.localPath);
        bytes[0] = bytes[0]! ^ 0xff;
        await fs.writeFile(current.nodeBootstrap.localPath, bytes);
      } else {
        const original = current.nodeBootstrap.localPath + ".original";
        await fs.rename(current.nodeBootstrap.localPath, original);
        await fs.symlink(original, current.nodeBootstrap.localPath);
      }
      const setup = await createCrabboxOfflineRuntimeSetup(current);
      await expect(current.execute(setup.command)).rejects.toMatchObject({ code: 1 });
      await expect(fs.stat(current.installedRoot)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readdir(path.dirname(current.installedRoot))).toEqual([]);
    },
  );
});
