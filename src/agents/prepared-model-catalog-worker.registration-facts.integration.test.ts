import fs from "node:fs";
import path from "node:path";
import { threadId } from "node:worker_threads";
import { expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolvePluginRuntimeLoadContext } from "../plugins/runtime/load-context.resolve.js";
import { readFixtureLines } from "./prepared-model-catalog-worker.shared.test-support.js";
import { PROVIDER_ID, writeFixtureFiles } from "./prepared-model-catalog-worker.test-support.js";
import { createCatalogFleetFixture } from "./test-helpers/prepared-model-catalog-fleet-fixture.js";
import {
  loadCompletedFullCatalog,
  usePreparedCatalogWorkerFixtures,
} from "./test-helpers/prepared-model-catalog-worker-fixture.js";

const { makeTempDir } = usePreparedCatalogWorkerFixtures();
const createFleetFixture = createCatalogFleetFixture(makeTempDir);

it.each([true, false])(
  "keeps unrelated setup outside catalog requests (explicit allowlist=%s)",
  async (explicitAllowlist) => {
    const setupId = "unrelated-setup-fixture";
    const fixture = await createFleetFixture(
      (seed) => {
        const observations = path.join(seed.root, "setup-observations.jsonl");
        fs.writeFileSync(observations, "");
        const observe = (event: string) =>
          `require("node:fs").appendFileSync(${JSON.stringify(observations)}, JSON.stringify({ event: ${JSON.stringify(event)}, threadId: require("node:worker_threads").threadId }) + "\\n");`;
        const setupDir = path.join(seed.root, setupId);
        fs.mkdirSync(setupDir);
        writeFixtureFiles(setupDir, {
          "package.json": {
            name: setupId,
            version: "1.0.0",
            type: "commonjs",
            openclaw: { extensions: ["./index.cjs"], setupEntry: "./setup-api.cjs" },
          },
          "openclaw.plugin.json": {
            id: setupId,
            setup: { requiresRuntime: true },
            configSchema: { type: "object", properties: { configured: { type: "boolean" } } },
          },
          "index.cjs": `module.exports = { id: ${JSON.stringify(setupId)}, register() {} };`,
          "setup-api.cjs": `${observe("setup-import")}
module.exports = { id: ${JSON.stringify(setupId)}, register(api) {
  api.registerAutoEnableProbe(({ config }) => {
    ${observe("setup-probe")}
    return config.acp?.enabled ? "fixture setup configured" : null;
  });
} };`,
        });
        seed.config.plugins.allow.push(setupId);
        if (!explicitAllowlist) {
          const plugins: NonNullable<OpenClawConfig["plugins"]> = seed.config.plugins;
          delete plugins.allow;
        }
        seed.config.plugins.load.paths.push(setupDir);
        seed.config.plugins.entries[setupId] = { enabled: true, config: { configured: true } };
      },
      true,
      { agentCount: 1, publication: "individual" },
    );
    const readObservations = (): Array<{ event: string; threadId: number }> =>
      readFixtureLines(fixture.root, "setup-observations.jsonl")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    const snapshot = fixture.snapshots[0]!;
    const catalog = await loadCompletedFullCatalog(snapshot);
    expect(catalog.entries).toContainEqual(expect.objectContaining({ provider: PROVIDER_ID }));
    const refreshed = await snapshot.loadFullModelCatalog!({ refresh: true, wait: true });
    expect(refreshed.entries).toContainEqual(expect.objectContaining({ provider: PROVIDER_ID }));
    expect.soft(readObservations().filter((entry) => entry.threadId !== threadId)).toEqual([]);
    // Setup remains available at its explicit parent-owned preparation boundary.
    const setup = resolvePluginRuntimeLoadContext({
      config: {
        ...fixture.config,
        acp: { enabled: true },
        plugins: { ...fixture.config.plugins, allow: [PROVIDER_ID] },
      },
      env: process.env,
      workspaceDir: fixture.workspaceDir,
      metadataSnapshot: snapshot.metadataSnapshot,
    });
    expect(setup.autoEnabledReasons[setupId]).toContain("fixture setup configured");
    expect(readObservations()).toContainEqual({ event: "setup-probe", threadId });
  },
);
