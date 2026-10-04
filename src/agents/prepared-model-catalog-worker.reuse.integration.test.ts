import fs from "node:fs";
import path from "node:path";
import { threadId } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { saveAuthProfileStore } from "./auth-profiles/store-runtime.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import { getPreparedModelCatalogWorkerPoolSnapshot } from "./prepared-model-catalog-worker.js";
import {
  EXTERNAL_AUTH_PROFILE_ID as EXTERNAL_ID,
  PROVIDER_ID,
} from "./prepared-model-catalog-worker.test-support.js";
import {
  getPreparedModelFullCatalogAuth,
  loadPreparedModelRuntimeAuth,
} from "./prepared-model-runtime-auth.js";
import { closePreparedModelRuntimeSnapshots } from "./prepared-model-runtime.lifecycle.js";
import { registerPreparedModelRuntimePublicationListener } from "./prepared-model-runtime.publication-events.js";
import { readCatalogCaptureFootprint } from "./test-helpers/catalog-capture-footprint.js";
import { createCatalogFleetFixture } from "./test-helpers/prepared-model-catalog-fleet-fixture.js";
import { usePreparedCatalogWorkerFixtures } from "./test-helpers/prepared-model-catalog-worker-fixture.js";

const { makeTempDir } = usePreparedCatalogWorkerFixtures();
const createFleetFixture = createCatalogFleetFixture(makeTempDir);

it("prepares known provider owners once while keeping catalog execution and auth request-local", async () => {
  vi.stubEnv("CODEX_HOME", makeTempDir("openclaw-reuse-empty-codex-"));
  const agentIds = ["fleet-a", "fleet-b"];
  const providerIds = ["worker-reuse-0", "worker-reuse-1", "worker-reuse-2"];
  const profileId = (provider: string) => `${provider}:reuse`;
  const credential = (agentId: string) => `synthetic-${agentId}`;
  const fixture = await createFleetFixture(
    (seed) => {
      const bundledRoot = path.join(seed.root, "bundled");
      const fixtureEnv: NodeJS.ProcessEnv = seed.env;
      fs.mkdirSync(bundledRoot);
      // Nonbundled providers all enter the runtime-augment base, masking scope expansion.
      for (const [name, value] of Object.entries({
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
        OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
      })) {
        fixtureEnv[name] = value;
        vi.stubEnv(name, value);
      }
      const record = (file: string, fields: string) => `
    if (require("node:worker_threads").threadId !== ${threadId}) {
      fs.appendFileSync(${JSON.stringify(path.join(seed.root, file))},
        JSON.stringify({ ${fields} }) + "\\n");
    }`;
      const registration = (provider: string) =>
        record(
          "registrations.jsonl",
          `provider: ${JSON.stringify(provider)}, filename: __filename`,
        );
      const execution = (provider: string) =>
        `require("node:v8").queryObjects(WeakRef);` +
        record(
          "heap.jsonl",
          `memory: process.memoryUsage(), payloads: globalThis[Symbol.for("catalog.reuse.payloads")].filter(ref => ref.deref()).length`,
        ) +
        record(
          "executions.jsonl",
          `provider: ${JSON.stringify(provider)}, agentDir: context.agentDir`,
        ) +
        `
        const retained = globalThis[Symbol.for("catalog.retired.registries.proof")];
        if (retained && ++retained.requests % ${2 * providerIds.length} === 0) {
          fs.writeFileSync(${JSON.stringify(path.join(seed.root, "retention.json"))}, JSON.stringify({
            registries: retained.registries.filter(ref => ref.deref()).length,
            captured: retained.registries.length,
            nativeExports: retained.exports.filter(ref => ref.deref()).length,
            controlCollected: retained.control.deref() === undefined,
            memory: process.memoryUsage(),
          }));
        }
      `;
      fs.writeFileSync(path.join(seed.root, "executions.jsonl"), "");
      // Module evaluation alone misses fresh registries built from retained source modules.
      // Node keeps native ESM exports after their capture files are retired. Identity-sensitive
      // registrations must not let those exports retain the rest of a disposed registry.
      fs.writeFileSync(
        path.join(seed.root, "plugin", "retained.mjs"),
        'export const speech = { id: "retained-speech", label: "Retention fixture", isConfigured: () => true, synthesize: async () => ({ audio: new Uint8Array() }) };',
      );
      const retention = `
  api.registerSpeechProvider(require("./retained.mjs").speech);
  const instance = globalThis[Symbol.for("openclaw.pluginInstanceState")].values.get(require("./retained.mjs").speech);
  const state = globalThis[Symbol.for("catalog.retired.registries.proof")] ??= { registries: [], exports: [], requests: 0, control: new WeakRef({}) };
  state.registries.push(new WeakRef(instance.owner.registry));
  state.exports.push(new WeakRef(require("./retained.mjs").speech));
`;
      const baseEntry = path.join(seed.root, "plugin", "index.cjs");
      fs.writeFileSync(
        path.join(seed.root, "plugin", "payload.mjs"),
        `export const payload = {
  rows: Array.from({ length: 100_000 }, (_, index) => ({ index })),
  buffer: new Uint8Array(1024 * 1024),
};`,
      );
      fs.writeFileSync(
        baseEntry,
        `const { payload } = require("./payload.mjs");
(globalThis[Symbol.for("catalog.reuse.payloads")] ??= []).push(new WeakRef(payload));
` +
          fs
            .readFileSync(baseEntry, "utf8")
            // This proof has only provider publication, not a second native acquisition.
            .replace(/ {6}loadModelCatalog: async \(\) => \{[\s\S]*?\n {6}\},\n/u, "")
            .replace(
              "  register(api) {",
              `  register(api) {${registration(PROVIDER_ID)}${retention}`,
            )
            .replace(
              "run(context) {",
              `run(context) {
if (payload.rows[99_999].index !== 99_999) throw Error("native payload unavailable");
${execution(PROVIDER_ID)}`,
            ),
      );
      for (const provider of providerIds) {
        const directory = path.join(bundledRoot, provider);
        fs.mkdirSync(directory);
        fs.writeFileSync(
          path.join(directory, "index.cjs"),
          `const fs = require("node:fs");
module.exports = { id: ${JSON.stringify(provider)}, register(api) {
  ${registration(provider)}
  api.registerProvider({
    id: ${JSON.stringify(provider)}, label: "Scoped reuse fixture", auth: [],
    catalog: { run(context) {
      ${execution(provider)}
      const auth = context.resolveProviderApiKey(${JSON.stringify(provider)});
      return { provider: {
        api: "openai-completions", baseUrl: "https://reuse.invalid/v1",
        models: [{ id: "auth-" + auth.discoveryApiKey, name: "Agent credential model" }],
      }, outcomes: [{ provider: ${JSON.stringify(provider)}, status: "ready" }] };
    } },
  });
} };
`,
        );
        fs.writeFileSync(
          path.join(directory, "openclaw.plugin.json"),
          JSON.stringify({
            id: provider,
            providers: [provider],
            modelCatalog: { discovery: { [provider]: "runtime" } },
            configSchema: { type: "object", additionalProperties: false },
          }),
        );
        fs.writeFileSync(
          path.join(directory, "package.json"),
          JSON.stringify({
            name: `@openclaw/${provider}`,
            version: "0.0.0",
            openclaw: { extensions: ["./index.cjs"] },
          }),
        );
        seed.config.plugins.allow.push(provider);
        Object.assign(seed.config.plugins.entries, { [provider]: { enabled: true } });
      }
      for (const agentId of agentIds) {
        const profiles: AuthProfileStore["profiles"] = {};
        for (const provider of providerIds) {
          profiles[profileId(provider)] = { type: "api_key", provider, key: credential(agentId) };
        }
        saveAuthProfileStore(
          { version: 1, profiles },
          path.join(seed.env.OPENCLAW_STATE_DIR!, "agents", agentId, "agent"),
        );
      }
    },
    false,
    { agentCount: agentIds.length, publication: "individual" },
  );
  const registrations = () =>
    fs
      .readFileSync(path.join(fixture.root, "registrations.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { provider: string; filename: string });
  const executions = () =>
    fs
      .readFileSync(path.join(fixture.root, "executions.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { provider: string; agentDir: string });
  for (const provider of providerIds) {
    expect(
      fixture.snapshots[0]!.metadataSnapshot.plugins.find(({ id }) => id === provider),
    ).toMatchObject({ origin: "bundled", modelCatalog: { discovery: { [provider]: "runtime" } } });
  }
  expect(
    fixture.snapshots.some((snapshot) =>
      snapshot.pluginRegistry?.agentHarnesses.some(
        ({ harness }) => typeof harness.loadModelCatalog === "function",
      ),
    ),
  ).toBe(false);
  // Individual publication avoids the fleet lifecycle's eager changed-provider renewal.
  // Auth-only warmup then prepares the base without turning a scoped read into full demand.
  const initialAuth = await loadPreparedModelRuntimeAuth(fixture.snapshots[0]!, {
    providerIds: [PROVIDER_ID],
  });
  expect(initialAuth?.authStore.profiles[EXTERNAL_ID]).toMatchObject({
    access: "v1:A",
  });
  expect(registrations().map(({ provider }) => provider)).toEqual([PROVIDER_ID]);
  expect(executions()).toEqual([]);
  const filename = registrations()[0]!.filename;
  const offset = filename.indexOf(`${path.sep}openclaw-plugin-build-`);
  expect(offset).toBeGreaterThan(0);
  const captureRoot = filename.slice(0, offset);
  expect(path.basename(captureRoot)).toMatch(/^openclaw-model-catalog-/);
  expect(readCatalogCaptureFootprint(captureRoot).captures).toHaveLength(1);
  const refreshScope = async (agentIndex: number, provider: string) => {
    const snapshot = fixture.snapshots[agentIndex]!;
    const key = credential(agentIds[agentIndex]!);
    const before = executions().length;
    const completed = createDeferred<ModelCatalogSnapshot>();
    // A bounded foreground read may return pending rows; wait for this exact publication.
    // Equal inventory may retain identity, so identity inequality is not a completion signal.
    const unsubscribe = registerPreparedModelRuntimePublicationListener((event) => {
      if (event.phase !== "catalog-published") {
        return;
      }
      const catalog = snapshot.readFullModelCatalog!();
      if (
        catalog &&
        !catalog.pendingProviders?.includes(provider) &&
        catalog.providerOutcomes?.some((outcome) => outcome.provider === provider)
      ) {
        completed.resolve(catalog);
      }
    });
    try {
      const [, catalog] = await withTestTimeout(
        Promise.all([
          snapshot.loadFullModelCatalog!({ providerIds: [provider], refresh: true }),
          completed.promise,
        ]),
        30_000,
        `Scoped catalog did not publish: ${snapshot.agentId}/${provider}`,
      );
      expect(catalog.refreshFailed).toBeFalsy();
      expect(executions().slice(before)).toEqual([{ provider, agentDir: snapshot.agentDir }]);
      expect(
        catalog.entries.filter((entry) => entry.provider === provider).map(({ id }) => id),
      ).toEqual([`auth-${key}`]);
      expect(
        getPreparedModelFullCatalogAuth(catalog)?.authStore.profiles[profileId(provider)],
      ).toMatchObject({ key });
    } finally {
      unsubscribe();
    }
  };
  for (const [index, provider] of providerIds.entries()) {
    const before = registrations().length;
    await refreshScope(index % 2, provider);
    // The first catalog demand prepares every credential owner without invoking their hooks.
    expect(
      registrations()
        .slice(before)
        .map((entry) => entry.provider)
        .toSorted(),
    ).toEqual(index === 0 ? [PROVIDER_ID, ...providerIds].toSorted() : []);
    const expanded = registrations();
    const footprint = readCatalogCaptureFootprint(captureRoot);
    // Retired capture files disappear even though Node retains their native ESM payloads.
    expect(footprint.captures).toHaveLength(1);
    await refreshScope((index + 1) % 2, provider);
    expect(registrations()).toEqual(expanded);
    expect(readCatalogCaptureFootprint(captureRoot)).toEqual(footprint);
  }
  const retained = JSON.parse(fs.readFileSync(path.join(fixture.root, "retention.json"), "utf8"));
  console.log("Retired catalog registries", JSON.stringify(retained));
  expect(retained.controlCollected).toBe(true);
  // The auth-only base is replaced once for all known owners; both native exports stay rooted.
  expect(retained.captured).toBe(2);
  expect(retained.nativeExports).toBe(retained.captured);
  expect(retained.registries).toBe(1);
  const warmedRegistrations = registrations();
  const warmedFootprint = readCatalogCaptureFootprint(captureRoot);
  expect(warmedFootprint.bytes).toBeGreaterThan(0);
  const refreshedAuth = [];
  for (const [index, snapshot] of fixture.snapshots.entries()) {
    // External refresh is request-local; durable auth writes would replace these owners.
    const token = index === 0 ? "B" : "C";
    fs.writeFileSync(fixture.externalAuthPath, token);
    const auth = await loadPreparedModelRuntimeAuth(snapshot, { providerIds: [PROVIDER_ID] });
    expect(auth?.authStore.profiles[EXTERNAL_ID]).toMatchObject({
      access: `v1:${token}`,
    });
    for (const provider of providerIds) {
      expect(auth?.authStore.profiles[profileId(provider)]).toMatchObject({
        key: credential(agentIds[index]!),
      });
    }
    refreshedAuth.push(auth);
  }
  expect(initialAuth?.authStore.profiles[EXTERNAL_ID]).toMatchObject({
    access: "v1:A",
  });
  expect(refreshedAuth[0]?.authStore.profiles[EXTERNAL_ID]).toMatchObject({
    access: "v1:B",
  });
  expect(executions()).toHaveLength(providerIds.length * agentIds.length);
  for (const provider of providerIds.toReversed()) {
    for (const agentIndex of [1, 0]) {
      await refreshScope(agentIndex, provider);
      expect(registrations()).toEqual(warmedRegistrations);
      expect(readCatalogCaptureFootprint(captureRoot)).toEqual(warmedFootprint);
    }
  }
  expect(
    JSON.parse(fs.readFileSync(path.join(fixture.root, "retention.json"), "utf8")),
  ).toMatchObject({
    captured: 2,
    nativeExports: 2,
    registries: 1,
    controlCollected: true,
  });
  const heap = fs
    .readFileSync(path.join(fixture.root, "heap.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { memory: NodeJS.MemoryUsage; payloads: number });
  expect(heap).toHaveLength(providerIds.length * agentIds.length * 2);
  expect(heap.map(({ payloads }) => payloads)).toEqual(heap.map(() => 2));
  expect(heap.at(-1)!.memory.heapUsed - heap[0]!.memory.heapUsed).toBeLessThan(16 * 1024 * 1024);
  expect(heap.at(-1)!.memory.arrayBuffers - heap[0]!.memory.arrayBuffers).toBeLessThan(1024 * 1024);
  console.log("Provider-scope heap", JSON.stringify({ first: heap[0], last: heap.at(-1) }));
  expect(getPreparedModelCatalogWorkerPoolSnapshot()).toMatchObject({
    workers: 1,
    workersCreated: 1,
    activeTasks: 0,
    pendingTasks: 0,
  });
  await closePreparedModelRuntimeSnapshots();
  expect(fs.existsSync(captureRoot)).toBe(false);
});
