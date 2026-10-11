import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { captureClawInstallSchemaVersionFacts } from "../claws/provenance-runtime-read.js";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { WorkerTaskPool } from "../infra/worker-task-pool.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { createPreparedModelCatalogWorkerInput } from "./prepared-model-catalog-worker.js";
import {
  createCatalogFixture,
  PLUGIN_ID,
  PROVIDER_ID,
} from "./prepared-model-catalog-worker.test-support.js";
import type {
  PreparedModelCatalogWorkerTask,
  PreparedModelWorkerResult,
} from "./prepared-model-catalog-worker.types.js";
import { AuthStorage } from "./sessions/auth-storage.js";
import { usePreparedCatalogWorkerFixtures } from "./test-helpers/prepared-model-catalog-worker-fixture.js";

const { makeTempDir } = usePreparedCatalogWorkerFixtures();

const NATIVE_ESM_BUFFER_BYTES = 4 * 1024 * 1024;

type CatalogRow = {
  evaluations: number;
  bornAt: number;
  registers: number;
  marker: string;
  url: string;
  arrayBuffers: number;
  sawHandle?: boolean;
  handleRevision?: number;
  apiCalls?: number;
  staleRejected?: boolean;
  staleError?: string;
  staleEvaluations?: number;
  laterValue?: string;
  laterEvaluations?: number;
  laterError?: string;
  neighborResult?: string;
  retiredResult?: string;
  directEffects?: string[];
};

type Sample = CatalogRow & { catalogModelIds: string[] };

function writePackage(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: PLUGIN_ID, type: "module" }),
  );
  fs.writeFileSync(
    path.join(dir, "openclaw.plugin.json"),
    JSON.stringify({
      id: PLUGIN_ID,
      configSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          marker: { type: "string" },
          revision: { type: "number" },
        },
      },
    }),
  );
}

function writePlugin(dir: string): string {
  writePackage(dir);
  const entry = path.join(dir, "index.js");
  fs.writeFileSync(
    entry,
    `import fs from "node:fs";
const retained = new Uint8Array(${NATIVE_ESM_BUFFER_BYTES});
retained[0] = 7;
let handle;
let registers = 0;
const evaluations = globalThis[Symbol.for("openclaw.retentionWidthEvaluations")] ??= { count: 0 };
evaluations.count += 1;
const bornAt = evaluations.count;
export function register(api) {
  if (retained[0] !== 7) throw new Error("retained native ESM buffer was collected");
  registers += 1;
  handle = api;
  api.registerProvider({
    id: ${JSON.stringify(PROVIDER_ID)},
    label: "Retention width",
    auth: [],
    catalog: { async run() {
      const marker = String(handle?.pluginConfig?.marker ?? "missing-handle");
      fs.appendFileSync(process.env.OPENCLAW_WORKER_CATALOG_MARKER, JSON.stringify({
        phase: "catalog",
        evaluations: evaluations.count,
        bornAt,
        registers,
        marker,
        sawHandle: typeof handle?.registerProvider === "function",
        url: import.meta.url,
        arrayBuffers: process.memoryUsage().arrayBuffers,
      }) + "\\n");
      return { provider: { api: "openai-completions", baseUrl: "https://heap.invalid/v1", models: [{ id: marker, name: "Retention" }] } };
    } },
  });
}
`,
  );
  return entry;
}

function catalogRows(markerPath: string): CatalogRow[] {
  if (!fs.existsSync(markerPath)) {
    return [];
  }
  const text = fs.readFileSync(markerPath, "utf8").trim();
  if (!text) {
    return [];
  }
  return text
    .split("\n")
    .map((line) => JSON.parse(line) as CatalogRow & { phase?: string })
    .filter((row) => row.phase === "catalog");
}

async function measure(
  label: string,
  requests: Array<{
    entry: string;
    workspaceDir: string;
    agentDir: string;
    agentId: string;
    marker: string;
    revision: number;
  }>,
  options?: {
    captureDir?: string;
    rejectRequestAt?: number;
    beforeRequest?: (index: number, captureDir: string) => void;
  },
): Promise<Sample[]> {
  const fixture = await Promise.resolve(createCatalogFixture(makeTempDir, 0));
  const samples: Sample[] = [];
  const captureDir = options?.captureDir ?? makeTempDir(`openclaw-retention-width-${label}-`);
  const pool = new WorkerTaskPool<PreparedModelCatalogWorkerTask, PreparedModelWorkerResult>({
    workerUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.preparedModelCatalog),
    maxWorkers: 1,
    idleTimeoutMs: 0,
    restartOnError: false,
    workerOptions: {
      resourceLimits: { maxOldGenerationSizeMb: 512 },
      workerData: {
        sourceCaptureDirectory: captureDir,
      },
      env: fixture.env,
    },
  });
  try {
    for (const [index, request] of requests.entries()) {
      options?.beforeRequest?.(index, captureDir);
      fs.mkdirSync(request.workspaceDir, { recursive: true });
      fs.mkdirSync(request.agentDir, { recursive: true });
      const config = {
        ...fixture.config,
        plugins: {
          ...fixture.config.plugins,
          load: { paths: [request.entry] },
          entries: {
            [PLUGIN_ID]: {
              enabled: true,
              config: { marker: request.marker, revision: request.revision },
            },
          },
        },
        models: {
          providers: {
            [PROVIDER_ID]: {
              baseUrl: "https://retention.invalid/v1",
              api: "openai-completions" as const,
              models: [],
            },
          },
        },
      };
      const metadata = loadPluginMetadataSnapshot({
        config,
        env: fixture.env,
        workspaceDir: request.workspaceDir,
        allowCurrent: false,
      });
      const value = createPreparedModelCatalogWorkerInput({
        agentFacts: {
          input: {
            agentId: request.agentId,
            agentDir: request.agentDir,
            inheritedAuthDir: request.agentDir,
            workspaceDir: request.workspaceDir,
            config,
            env: fixture.env,
          },
          env: fixture.env,
          authStore: { version: 1, profiles: {} },
          credentials: {},
          templateAuthStorage: AuthStorage.inMemory({}),
          providerIds: [PROVIDER_ID],
          configuredModelRefs: [],
          configuredRuntimeModels: [],
          runtimeCapabilityModels: [],
          configuredGeneratedCatalogPluginIds: [],
        },
        pluginMetadataSnapshot: metadata,
      });
      const before = catalogRows(fixture.marker).length;
      const result = await pool.run(
        {
          value,
          request: {
            kind: "catalog",
            syntheticAuth: [],
            clawInstallSchemaVersions: captureClawInstallSchemaVersionFacts({ env: fixture.env }),
          },
        },
        {
          timeoutMs: 60_000,
          onRequest: () => ({ input: index !== options?.rejectRequestAt }),
        },
      );
      if (index === options?.rejectRequestAt) {
        expect(result).toMatchObject({
          status: "failed",
          error: "prepared model catalog request retired before discovery",
        });
        continue;
      }
      const catalogModelIds =
        result.status === "ok" && result.kind === "catalog"
          ? result.snapshot.entries.map((entry) => entry.id)
          : [];
      const row = catalogRows(fixture.marker).at(-1);
      if (result.status !== "ok" || !row || catalogRows(fixture.marker).length === before) {
        throw new Error(
          `${label} ${request.agentId} rev ${request.revision} did not record a catalog: ${JSON.stringify(result)}`,
        );
      }
      samples.push({ ...row, catalogModelIds });
    }
  } finally {
    await pool.close();
  }
  return samples;
}

it.each([true, false])(
  "isolates native ESM workspaces (shared installed path: %s)",
  async (sharedPath) => {
    const root = makeTempDir("openclaw-retention-shared-");
    const entry = writePlugin(path.join(root, "plugin"));
    const alpha = {
      entry,
      workspaceDir: path.join(root, "workspace-alpha"),
      agentDir: path.join(root, "agent-alpha"),
      agentId: "alpha",
    };
    const beta = {
      entry: sharedPath ? entry : writePlugin(path.join(root, "plugin-beta")),
      workspaceDir: path.join(root, "workspace-beta"),
      agentDir: path.join(root, "agent-beta"),
      agentId: "beta",
    };
    const samples = await measure("per-workspace-path", [
      { ...alpha, marker: "alpha", revision: 0 },
      { ...alpha, marker: "alpha", revision: 0 },
      { ...beta, marker: "beta", revision: 0 },
      { ...alpha, marker: "alpha", revision: 0 },
      { ...alpha, marker: "alpha", revision: 1 },
      { ...beta, marker: "beta", revision: 0 },
    ]);
    expect(samples.map((sample) => sample.evaluations)).toEqual([1, 1, 2, 2, 2, 2]);
    expect(samples[0]?.url).toBe(samples[1]?.url);
    expect(samples[0]?.url).toBe(samples[3]?.url);
    expect(samples[0]?.url).toBe(samples[4]?.url);
    expect(samples[2]?.url).toBe(samples[5]?.url);
    expect(samples[0]?.url).not.toBe(samples[2]?.url);
    expect(samples.every((sample) => sample.sawHandle === true)).toBe(true);
    expect(samples.map((sample) => sample.marker)).toEqual([
      "alpha",
      "alpha",
      "beta",
      "alpha",
      "alpha",
      "beta",
    ]);
    const secondWorkspaceGrowth = samples[2]!.arrayBuffers - samples[1]!.arrayBuffers;
    const refreshGrowth = samples.at(-1)!.arrayBuffers - samples[2]!.arrayBuffers;
    expect(secondWorkspaceGrowth).toBeGreaterThanOrEqual(NATIVE_ESM_BUFFER_BYTES);
    expect(refreshGrowth).toBeLessThan(NATIVE_ESM_BUFFER_BYTES);
  },
  180_000,
);

it("re-registers the previous config after a failed native ESM refresh", async () => {
  const root = makeTempDir("openclaw-retention-failed-refresh-");
  const workspace = {
    entry: writePlugin(path.join(root, "plugin")),
    workspaceDir: path.join(root, "workspace"),
    agentDir: path.join(root, "agent"),
    agentId: "alpha",
  };
  const samples = await measure(
    "failed-refresh",
    [
      { ...workspace, marker: "alpha", revision: 0 },
      { ...workspace, marker: "failed-successor", revision: 1 },
      { ...workspace, marker: "alpha", revision: 0 },
    ],
    { rejectRequestAt: 1 },
  );
  expect(samples.map((sample) => sample.catalogModelIds)).toEqual([["alpha"], ["alpha"]]);
  expect(samples.map((sample) => sample.registers)).toEqual([1, 3]);
  expect(samples.map((sample) => sample.evaluations)).toEqual([1, 1]);
  expect(samples[0]?.url).toBe(samples[1]?.url);
}, 180_000);

function writeRetiredHandlePlugin(dir: string): string {
  writePackage(dir);
  fs.writeFileSync(
    path.join(dir, "retired-side.js"),
    `import { callRetainedHandle } from "./index.js";
const state = globalThis[Symbol.for("openclaw.nativeEsmHandleRetired")] ??= { evaluations: 0, apiCalls: 0 };
state.evaluations += 1;
state.apiCalls = callRetainedHandle();
export const evaluations = state.evaluations;
export const apiCalls = state.apiCalls;
`,
  );
  const entry = path.join(dir, "index.js");
  fs.writeFileSync(
    entry,
    `import fs from "node:fs";
let handle;
let registers = 0;
let catalogs = 0;
const retiredState = globalThis[Symbol.for("openclaw.nativeEsmHandleRetired")] ??= { evaluations: 0, apiCalls: 0 };
export function callRetainedHandle() {
  retiredState.apiCalls += 1;
  handle.registerProvider({
    id: "stale-caller",
    label: "Stale caller",
    auth: [],
    catalog: { async run() {
      return { provider: { api: "openai-completions", baseUrl: "https://heap.invalid/v1", models: [{ id: "stolen", name: "Stolen" }] } };
    } },
  });
  return retiredState.apiCalls;
}
export function register(api) {
  registers += 1;
  handle = api;
  api.registerProvider({
    id: ${JSON.stringify(PROVIDER_ID)},
    label: "Retained handle",
    auth: [],
    catalog: { async run() {
      catalogs += 1;
      const marker = String(handle?.pluginConfig?.marker ?? "missing-handle");
      if (marker === "alpha" && catalogs === 1) {
        let openGate;
        const gate = new Promise((resolve) => {
          openGate = resolve;
        });
        globalThis[Symbol.for("openclaw.nativeEsmHandleGate")] = openGate;
        globalThis[Symbol.for("openclaw.nativeEsmHandleImport")] = gate.then(() => import("./retired-side.js"));
      }
      let staleRejected = false;
      let staleEvaluations = 0;
      let staleError;
      if (marker === "beta" && catalogs === 2) {
        const openGate = globalThis[Symbol.for("openclaw.nativeEsmHandleGate")];
        if (typeof openGate === "function") {
          openGate();
        }
        try {
          const imported = await globalThis[Symbol.for("openclaw.nativeEsmHandleImport")];
          staleEvaluations = imported?.evaluations ?? 0;
          staleError = "loaded";
        } catch (error) {
          staleRejected = true;
          const message = error instanceof Error ? error.message : "";
          staleError = message.includes("no live workspace owner")
            ? "no-live-owner"
            : error instanceof Error
              ? error.name
              : "rejected";
        }
      }
      fs.appendFileSync(process.env.OPENCLAW_WORKER_CATALOG_MARKER, JSON.stringify({
        phase: "catalog",
        evaluations: 0,
        bornAt: catalogs,
        registers,
        marker,
        sawHandle: typeof handle?.registerProvider === "function",
        handleRevision: Number(handle?.pluginConfig?.revision ?? -1),
        apiCalls: retiredState.apiCalls,
        staleRejected,
        staleError,
        staleEvaluations,
        url: import.meta.url,
        arrayBuffers: process.memoryUsage().arrayBuffers,
      }) + "\\n");
      return { provider: { api: "openai-completions", baseUrl: "https://heap.invalid/v1", models: [{ id: marker, name: "Retained handle" }] } };
    } },
  });
}
`,
  );
  return entry;
}

function captureFiles(dir: string): string[] {
  const found: string[] = [];
  const pending = [dir];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) {
      continue;
    }
    for (const child of fs.readdirSync(current, { withFileTypes: true })) {
      if (child.isSymbolicLink()) {
        continue;
      }
      const childPath = path.join(current, child.name);
      if (child.isDirectory()) {
        pending.push(childPath);
      } else {
        found.push(path.relative(dir, childPath));
      }
    }
  }
  return found.toSorted();
}

it("rejects a released workspace API handle before native ESM capture", async () => {
  const root = makeTempDir("openclaw-retention-handle-");
  const entry = writeRetiredHandlePlugin(path.join(root, "plugin"));
  const alpha = {
    entry,
    workspaceDir: path.join(root, "workspace-alpha"),
    agentDir: path.join(root, "agent-alpha"),
    agentId: "alpha",
  };
  const beta = {
    entry,
    workspaceDir: path.join(root, "workspace-beta"),
    agentDir: path.join(root, "agent-beta"),
    agentId: "beta",
  };
  const captureDir = makeTempDir("openclaw-retention-handle-captures-");
  let filesBeforeStaleImport: string[] | undefined;
  const samples = await measure(
    "retired-handle",
    [
      { ...alpha, marker: "alpha", revision: 0 },
      { ...beta, marker: "beta", revision: 0 },
      { ...alpha, marker: "alpha", revision: 1 },
      { ...beta, marker: "beta", revision: 0 },
    ],
    {
      captureDir,
      beforeRequest(index) {
        if (index === 3) {
          filesBeforeStaleImport = captureFiles(captureDir);
        }
      },
    },
  );
  const stale = samples[3];
  expect(samples.map((sample) => sample.marker)).toEqual(["alpha", "beta", "alpha", "beta"]);
  expect(samples.every((sample) => sample.sawHandle === true)).toBe(true);
  expect(samples[0]?.url).not.toBe(samples[1]?.url);
  expect(stale?.staleRejected).toBe(true);
  expect(stale?.staleError).toBe("no-live-owner");
  expect(stale?.staleEvaluations).toBe(0);
  expect(stale?.apiCalls).toBe(0);
  expect(stale?.catalogModelIds).toEqual(["beta"]);
  expect(samples[2]?.handleRevision).toBe(1);
  expect(stale?.handleRevision).toBe(0);
  expect(filesBeforeStaleImport).toBeDefined();
  expect(captureFiles(captureDir)).toEqual(filesBeforeStaleImport);
}, 180_000);

function writeDirectHandlePlugin(dir: string): string {
  writePackage(dir);
  const entry = path.join(dir, "index.js");
  fs.writeFileSync(
    entry,
    `import fs from "node:fs";
let handle;
let registers = 0;
let catalogs = 0;
const slot = globalThis[Symbol.for("openclaw.directHandleEffects")] ??= {
  call: undefined,
  effects: [],
  openGate: undefined,
  retired: undefined,
};
function classifyDirectError(error) {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("calling workspace generation")) return "rejected";
  if (message.includes("no live workspace owner")) return "no-live-owner";
  return "other";
}
function noteEffect(modelId) {
  if (!slot.effects.includes(modelId)) {
    slot.effects.push(modelId);
  }
}
function directRegister(modelId) {
  try {
    const result = handle.registerProvider({
      id: "direct-" + modelId,
      label: "Direct handle",
      auth: [],
      catalog: { async run() {
        noteEffect(modelId);
        return { provider: { api: "openai-completions", baseUrl: "https://heap.invalid/v1", models: [{ id: modelId, name: "Direct" }] } };
      } },
    });
    return result === undefined ? "closed" : "admitted";
  } catch (error) {
    return classifyDirectError(error);
  }
}
if (!slot.call) {
  slot.call = directRegister;
}
export function register(api) {
  registers += 1;
  handle = api;
  api.registerProvider({
    id: ${JSON.stringify(PROVIDER_ID)},
    label: "Direct handle",
    auth: [],
    catalog: { async run() {
      catalogs += 1;
      const marker = String(handle?.pluginConfig?.marker ?? "missing-handle");
      let neighborResult = "pending";
      let retiredResult = "pending";
      if (marker === "alpha" && catalogs === 1) {
        let openGate;
        const gate = new Promise((resolve) => {
          openGate = resolve;
        });
        slot.openGate = openGate;
        slot.retired = gate.then(() => slot.call("stolen"));
      }
      if (marker === "beta" && catalogs === 1) {
        neighborResult = slot.call("neighbor");
        if (typeof slot.openGate === "function") {
          slot.openGate();
        }
        try {
          retiredResult = await slot.retired;
        } catch (error) {
          retiredResult = classifyDirectError(error);
        }
      }
      const modelIds = [marker];
      fs.appendFileSync(process.env.OPENCLAW_WORKER_CATALOG_MARKER, JSON.stringify({
        phase: "catalog",
        evaluations: 0,
        bornAt: catalogs,
        registers,
        marker,
        sawHandle: typeof handle?.registerProvider === "function",
        handleRevision: Number(handle?.pluginConfig?.revision ?? -1),
        neighborResult,
        retiredResult,
        directEffects: slot.effects.slice(),
        url: import.meta.url,
        arrayBuffers: process.memoryUsage().arrayBuffers,
      }) + "\\n");
      return { provider: { api: "openai-completions", baseUrl: "https://heap.invalid/v1", models: modelIds.map((id) => ({ id, name: "Direct handle" })) } };
    } },
  });
}
`,
  );
  return entry;
}

it("rejects a neighbor and a released generation through the replaced API handle", async () => {
  const root = makeTempDir("openclaw-retention-direct-handle-");
  const entry = writeDirectHandlePlugin(path.join(root, "plugin"));
  const alpha = {
    entry,
    workspaceDir: path.join(root, "workspace-alpha"),
    agentDir: path.join(root, "agent-alpha"),
    agentId: "alpha",
  };
  const beta = {
    entry,
    workspaceDir: path.join(root, "workspace-beta"),
    agentDir: path.join(root, "agent-beta"),
    agentId: "beta",
  };
  const samples = await measure("direct-handle", [
    { ...alpha, marker: "alpha", revision: 0 },
    { ...alpha, marker: "alpha", revision: 1 },
    { ...beta, marker: "beta", revision: 0 },
    { ...alpha, marker: "alpha", revision: 1 },
  ]);
  expect(samples.map((sample) => sample.marker)).toEqual(["alpha", "alpha", "beta", "alpha"]);
  expect(samples[0]?.url).toBe(samples[1]?.url);
  expect(samples[0]?.url).toBe(samples[3]?.url);
  expect(samples[0]?.url).not.toBe(samples[2]?.url);
  expect(samples[1]?.registers).toBe(2);
  expect(samples[1]?.handleRevision).toBe(1);
  expect(samples[1]?.catalogModelIds).toEqual(["alpha"]);
  expect(samples[2]?.handleRevision).toBe(0);
  expect(samples[2]?.neighborResult).toBe("rejected");
  expect(samples[2]?.retiredResult).toBe("rejected");
  expect(samples[2]?.directEffects).toEqual([]);
  expect(samples[2]?.catalogModelIds).toEqual(["beta"]);
  expect(samples[3]?.catalogModelIds).toEqual(["alpha"]);
  expect(samples.every((sample) => sample.catalogModelIds.includes("stolen"))).toBe(false);
  expect(samples.every((sample) => sample.catalogModelIds.includes("neighbor"))).toBe(false);
}, 180_000);

function writeCompilerPlugin(dir: string): string {
  writePackage(dir);
  fs.writeFileSync(
    path.join(dir, "later.ts"),
    `const state = globalThis[Symbol.for("openclaw.nativeEsmCompilerLater")] ??= { evaluations: 0 };
state.evaluations += 1;
export const marker = "compiled-later";
export const evaluations = state.evaluations;
`,
  );
  fs.writeFileSync(
    path.join(dir, "helper.ts"),
    `export function armLater(): Promise<string> {
  return import("./later.ts").then((loaded) => {
    const marker = loaded.marker;
    return typeof marker === "string" ? marker : "missing-later";
  });
}
`,
  );
  const entry = path.join(dir, "index.js");
  fs.writeFileSync(
    entry,
    `import fs from "node:fs";
import { armLater } from "./helper.ts";
let handle;
let registers = 0;
let catalogs = 0;
const bornState = globalThis[Symbol.for("openclaw.nativeEsmCompilerBorn")] ??= { count: 0 };
bornState.count += 1;
const bornAt = bornState.count;
export function register(api) {
  registers += 1;
  handle = api;
  api.registerProvider({
    id: ${JSON.stringify(PROVIDER_ID)},
    label: "Retained compiler",
    auth: [],
    catalog: { async run() {
      catalogs += 1;
      const marker = String(handle?.pluginConfig?.marker ?? "missing-handle");
      let laterValue = "pending";
      let laterError;
      if (catalogs === 3) {
        try {
          laterValue = await armLater();
        } catch (error) {
          const message = error instanceof Error ? error.message : "";
          laterError = message.includes("no live workspace owner")
            ? "no-live-owner"
            : message.includes("Cannot find module")
              ? "missing-module"
              : "rejected";
        }
      }
      const laterState = globalThis[Symbol.for("openclaw.nativeEsmCompilerLater")];
      const row = {
        phase: "catalog",
        evaluations: bornState.count,
        bornAt,
        registers,
        marker,
        sawHandle: typeof handle?.registerProvider === "function",
        laterValue,
        laterEvaluations: laterState?.evaluations ?? 0,
        url: import.meta.url,
        arrayBuffers: process.memoryUsage().arrayBuffers,
      };
      if (laterError) {
        row.laterError = laterError;
      }
      fs.appendFileSync(process.env.OPENCLAW_WORKER_CATALOG_MARKER, JSON.stringify(row) + "\\n");
      const modelId = laterValue === "pending" ? marker : laterValue;
      return { provider: { api: "openai-completions", baseUrl: "https://heap.invalid/v1", models: [{ id: modelId, name: "Retained compiler" }] } };
    } },
  });
}
`,
  );
  return entry;
}

it("keeps a compiled TypeScript helper import after the native module is retained", async () => {
  const root = makeTempDir("openclaw-retention-compiler-");
  const entry = writeCompilerPlugin(path.join(root, "plugin"));
  const workspace = {
    entry,
    workspaceDir: path.join(root, "workspace"),
    agentDir: path.join(root, "agent"),
    agentId: "alpha",
    marker: "alpha",
  };
  const samples = await measure("retained-compiler", [
    { ...workspace, revision: 0 },
    { ...workspace, revision: 1 },
    { ...workspace, revision: 1 },
  ]);
  expect(samples.map((sample) => sample.marker)).toEqual(["alpha", "alpha", "alpha"]);
  expect(samples.map((sample) => sample.evaluations)).toEqual([1, 1, 1]);
  expect(samples.map((sample) => sample.registers)).toEqual([1, 2, 2]);
  expect(samples[0]?.url).toBe(samples[2]?.url);
  expect(samples.map((sample) => sample.laterEvaluations)).toEqual([0, 0, 1]);
  expect(samples[2]?.laterValue).toBe("compiled-later");
  expect(samples[2]?.laterError).toBeUndefined();
  expect(samples.map((sample) => sample.catalogModelIds)).toEqual([
    ["alpha"],
    ["alpha"],
    ["compiled-later"],
  ]);
}, 180_000);
