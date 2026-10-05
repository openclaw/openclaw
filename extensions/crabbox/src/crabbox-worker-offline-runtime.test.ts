import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { openFixtureReceiptChannel } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createCrabboxOfflineRuntimeSetup } from "../cli-runtime-api.js";
import { createNodePackageFixture } from "./crabbox-worker-node-enrollment.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const run = promisify(execFile);
let receipts: Awaited<ReturnType<typeof openFixtureReceiptChannel>>;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(() => receipts.close());

describe.skipIf(process.platform === "win32")("offline runtime cache installation", () => {
  it("installs verified local archives through npm without enrollment, and rejects changed bytes", async () => {
    const home = fs.realpathSync(tempDirs.make("offline-runtime-home-"));
    const source = fs.realpathSync(tempDirs.make("offline-runtime-archives-"));
    const nodeBytes = await createNodePackageFixture(
      (prefix) => tempDirs.make(prefix),
      "offline-runtime",
      receipts,
    );
    const workerBytes = Buffer.from("synthetic portable worker archive");
    const archive = (name: string, bytes: Buffer) => {
      const localPath = path.join(source, name);
      fs.writeFileSync(localPath, bytes);
      return {
        localPath,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    };
    const nodeBootstrap = {
      ...archive("node.tgz", nodeBytes),
      openclawVersion: "2026.8.1",
      enabledPluginIds: ["demo"],
    };
    const worker = archive("worker.tgz", workerBytes);
    const workerBundle = {
      ...worker,
      packageRelativePath: `worker-artifacts/${worker.sha256}.tgz`,
    };
    const setup = await createCrabboxOfflineRuntimeSetup({
      nodeBootstrap,
      workerBundle,
      target: "linux",
    });
    expect(setup.forwardedEnv).toEqual({});
    const env = { HOME: home, PATH: process.env.PATH, NPM_CONFIG_IGNORE_SCRIPTS: "true" };
    await run("/bin/sh", ["-c", setup.command], { env, timeout: 30_000 });
    const runtime = path.join(
      home,
      ".openclaw-worker",
      "node-runtimes",
      nodeBootstrap.sha256,
      "node_modules",
      "openclaw",
    );
    expect(JSON.parse(fs.readFileSync(path.join(runtime, "installed.json"), "utf8"))).toEqual({
      scriptsRan: true,
    });
    expect(fs.readFileSync(path.join(runtime, workerBundle.packageRelativePath))).toEqual(
      workerBytes,
    );
    expect(fs.existsSync(path.join(home, ".openclaw"))).toBe(false);
    const original = fs.statSync(runtime).ino;
    await run("/bin/sh", ["-c", setup.command], { env, timeout: 30_000 });
    expect(fs.statSync(runtime).ino).toBe(original);
    const changed = await createCrabboxOfflineRuntimeSetup({
      nodeBootstrap,
      workerBundle: {
        ...workerBundle,
        sha256: "f".repeat(64),
        packageRelativePath: `worker-artifacts/${"f".repeat(64)}.tgz`,
      },
    });
    await expect(
      run("/bin/sh", ["-c", changed.command], { env, timeout: 30_000 }),
    ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("integrity verification") });
    expect(fs.readFileSync(path.join(runtime, workerBundle.packageRelativePath))).toEqual(
      workerBytes,
    );
    expect(fs.readdirSync(path.dirname(path.dirname(runtime)))).toEqual([
      "node_modules",
      "package.json",
    ]);
  });
});
