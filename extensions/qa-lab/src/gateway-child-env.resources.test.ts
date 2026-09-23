import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildQaRuntimeEnv } from "./gateway-child-env.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const tempDirs = createTempDirHarness();
afterEach(() => tempDirs.cleanup());

describe("QA child resource ownership", () => {
  it("runs the lifecycle preload before a fixture preload that imports the coordinator", async () => {
    const ownedRoot = process.env.VITEST_OPENCLAW_RESOURCE_ROOT;
    if (!ownedRoot) {
      throw new Error("expected owned Vitest resource root");
    }
    const fixtureRoot = await tempDirs.makeTempDir("qa-lifecycle-preload-order-");
    const fixturePath = path.join(fixtureRoot, "fixture-preload.mjs");
    const receiptPath = path.join(fixtureRoot, "receipt.json");
    const databasePath = path.join(ownedRoot, "qa-preload-override", "openclaw.sqlite");
    const coordinatorModule = pathToFileURL(
      path.join(process.cwd(), "src/infra/state-database-coordinator.ts"),
    ).href;
    await writeFile(
      fixturePath,
      `
      import fs from "node:fs";
      import path from "node:path";
      const coordinatorModule = await import(${JSON.stringify(coordinatorModule)});
      const claims = path.join(${JSON.stringify(ownedRoot)}, ".vitest-resource-owner", "claims");
      // Observe only this child's real admissions, not parallel workers' registry writes.
      const admitted = [];
      const mkdirSync = fs.mkdirSync;
      fs.mkdirSync = (...args) => {
        const result = mkdirSync(...args);
        if (path.dirname(String(args[0])) === claims) admitted.push(String(args[0]));
        return result;
      };
      let coordinator;
      try {
        coordinator = coordinatorModule.acquireGatewayLifecycleCoordinator({
          databasePath: ${JSON.stringify(databasePath)},
          busyTimeoutMs: 0,
        });
      } finally {
        fs.mkdirSync = mkdirSync;
      }
      const pending = admitted.length === 1 && !fs.existsSync(path.join(admitted[0], "released"));
      coordinator.release();
      fs.writeFileSync(${JSON.stringify(receiptPath)}, JSON.stringify({
        pending,
        released: admitted.length === 1 && fs.existsSync(path.join(admitted[0], "released")),
        runtimeDirectory: coordinatorModule.resolveStateLifecycleRuntimeDirectory(${JSON.stringify(databasePath)}),
      }));
      globalThis.qaFixturePreload = "loaded";
    `,
    );
    const fixturePreload = `--import=tsx --import=${pathToFileURL(fixturePath).href}`;
    const env = buildQaRuntimeEnv({
      baseEnv: process.env,
      configPath: path.join(fixtureRoot, "openclaw.json"),
      gatewayToken: "qa-fixture-token",
      homeDir: fixtureRoot,
      stateDir: path.join(fixtureRoot, "state"),
      tempRoot: fixtureRoot,
      xdgConfigHome: path.join(fixtureRoot, "config"),
      xdgDataHome: path.join(fixtureRoot, "data"),
      xdgCacheHome: path.join(fixtureRoot, "cache"),
      developmentSourceRoot: process.cwd(),
      runtimeEnvPatch: { NODE_OPTIONS: fixturePreload },
    });
    expect(env.NODE_OPTIONS).toContain("vitest-resource-context-preload.test-support.mjs");
    expect(env.NODE_OPTIONS).toContain(fixturePreload);

    const source = `
      import fs from "node:fs";
      console.log(JSON.stringify({
        fixturePreload: globalThis.qaFixturePreload,
        ...JSON.parse(fs.readFileSync(${JSON.stringify(receiptPath)}, "utf8")),
      }));
    `;
    const child = spawnSync(
      process.execPath,
      ["--disable-warning=DEP0205", "--input-type=module", "-e", source],
      { cwd: process.cwd(), env, encoding: "utf8" },
    );
    expect(child.stderr).toBe("");
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({
      fixturePreload: "loaded",
      pending: true,
      released: true,
      runtimeDirectory: ownedRoot,
    });
  });
});
