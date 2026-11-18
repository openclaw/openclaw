import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { writePersistedInstalledPluginIndex } from "../plugins/installed-plugin-index-store-write.js";
import { readCurrentInstalledPluginIndex } from "../plugins/installed-plugin-index-store.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { withPluginSourceAdmissionPublisher } from "../plugins/plugin-source-admission-context.js";
import { createPluginSourceAdmissionPublisher } from "../plugins/plugin-source-admission-store.js";
import { createPreparedModelCatalogWorker } from "./prepared-model-catalog-worker.js";
import {
  createCatalogFixture,
  catalogEntry,
  catalogInput,
  makeCatalogAgentFacts,
  PROVIDER_ID,
  writeFixtureFiles,
} from "./prepared-model-catalog-worker.test-support.js";
import { usePreparedCatalogWorkerFixtures } from "./test-helpers/prepared-model-catalog-worker-fixture.js";

const { makeTempDir, retireAfterTest } = usePreparedCatalogWorkerFixtures();

it.each([false, true])(
  "persists native source admissions across catalog requests (write failure=%s)",
  async (writeFailure) => {
    const fixture = await createCatalogFixture(makeTempDir, 0);
    const pluginRoot = path.join(fixture.root, "plugin");
    const nativeSources = ["eager", "lazy"].map((name) => {
      const dependency = path.join(pluginRoot, "node_modules", `${name}-native`);
      fs.mkdirSync(dependency, { recursive: true });
      const bytes = `synthetic ${name} native companion`;
      writeFixtureFiles(dependency, {
        "package.json": { name: `${name}-native`, version: "1.0.0", main: "index.cjs" },
        "index.cjs": 'module.exports = require.resolve("./companion.exe");',
        "companion.exe": bytes,
      });
      return {
        filename: path.join(dependency, "companion.exe"),
        bytes,
        contentHash: createHash("sha256").update(bytes).digest("hex"),
      };
    });
    writeFixtureFiles(pluginRoot, {
      "package.json": {
        name: PROVIDER_ID,
        version: "1.0.0",
        dependencies: { "eager-native": "1.0.0" },
        openclaw: { extensions: ["./index.cjs"] },
      },
      "openclaw.plugin.json": {
        id: PROVIDER_ID,
        providers: [PROVIDER_ID],
        modelCatalog: { discovery: { [PROVIDER_ID]: "runtime" } },
        configSchema: { type: "object", additionalProperties: false },
      },
      "index.cjs": `const fs = require("node:fs");
const { isMainThread } = require("node:worker_threads");
const eager = isMainThread ? undefined : require("eager-native");
let invocation = 0;
module.exports = { id: ${JSON.stringify(PROVIDER_ID)}, register(api) {
  api.registerProvider({ id: ${JSON.stringify(PROVIDER_ID)}, label: "Native receipt fixture", auth: [],
    catalog: { async run() {
      if (isMainThread) throw new Error("Catalog must run in its worker");
      invocation++;
      const dependency = invocation === 1 ? "eager-native" : "lazy-native";
      const native = invocation === 1 ? eager : require(dependency);
      if (fs.readFileSync(native, "utf8") !== "synthetic " + (invocation === 1 ? "eager" : "lazy") + " native companion") {
        throw new Error("Catalog received different native bytes");
      }
      return { provider: { api: "openai-completions", baseUrl: "https://fixture.invalid/v1",
        models: [{ id: "native-refresh-" + invocation, name: "Native catalog model" }] } };
    } },
  });
} };`,
    });
    const config = {
      plugins: fixture.config.plugins,
      models: {
        providers: {
          [PROVIDER_ID]: {
            api: "openai-completions" as const,
            apiKey: "synthetic-catalog-key",
            baseUrl: "https://fixture.invalid/v1",
            models: [],
          },
        },
      },
    };
    const pluginMetadataSnapshot = loadPluginMetadataSnapshot({
      config,
      env: fixture.env,
      workspaceDir: fixture.workspaceDir,
      allowCurrent: false,
    });
    await writePersistedInstalledPluginIndex(pluginMetadataSnapshot.index, { env: fixture.env });
    const retirement = new AbortController();
    retireAfterTest(() => retirement.abort());
    const worker = createPreparedModelCatalogWorker({
      agentFacts: makeCatalogAgentFacts(catalogInput(fixture, { config })),
      pluginMetadataSnapshot,
      isCurrent: () => !retirement.signal.aborted,
      retirementSignal: retirement.signal,
    });
    const publish = createPluginSourceAdmissionPublisher({ env: fixture.env });
    let rejectPublication = writeFailure;
    const rejectingPublisher: NonNullable<typeof publish> = async (publication) => {
      if (rejectPublication) {
        rejectPublication = false;
        throw new Error("Synthetic receipt write failure");
      }
      return (await publish?.(publication)) ?? false;
    };
    for (const invocation of [1, 2]) {
      const load = () => worker.loadCatalog([PROVIDER_ID], undefined, true);
      const { modelCatalog } = writeFailure
        ? await withPluginSourceAdmissionPublisher(rejectingPublisher, load)
        : await load();
      expect(modelCatalog.entries).toContainEqual(catalogEntry(`native-refresh-${invocation}`));
      expect(modelCatalog.entries).not.toContainEqual(
        catalogEntry(`native-refresh-${invocation === 1 ? 2 : 1}`),
      );
      if (writeFailure && invocation === 1) {
        // Advisory persistence failure must still return a usable catalog; the next turn retries.
        continue;
      }
      const persisted = await readCurrentInstalledPluginIndex({ env: fixture.env });
      const receipts = Object.values(
        persisted?.plugins.find(({ pluginId }) => pluginId === PROVIDER_ID)?.sourceAdmissions ?? {},
      );
      const facts = receipts.flatMap(({ nativeArtifacts }) => Object.entries(nativeArtifacts));
      for (const source of nativeSources.slice(0, invocation)) {
        const fact = facts.find(([filename]) => filename === source.filename)?.[1];
        expect(fact, `catalog request ${invocation} persisted ${source.filename}`).toMatchObject({
          contentHash: source.contentHash,
          sizeBytes: Buffer.byteLength(source.bytes),
        });
        expect(fs.readFileSync(fact!.capturedPath, "utf8")).toBe(source.bytes);
      }
      if (invocation === 1) {
        // The next request must use the retained artifact to admit new native bytes.
        expect(facts.some(([filename]) => filename === nativeSources[1]!.filename)).toBe(false);
      }
    }
    expect(rejectPublication).toBe(false);
  },
);

