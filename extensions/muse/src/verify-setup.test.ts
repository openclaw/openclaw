import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import original from "../../../test/fixtures/model-catalog/muse-meta-account.json" with { type: "json" };
import expected from "../../../test/fixtures/model-catalog/muse-meta-expected.json" with { type: "json" };
import { MusePool, openMuseSession } from "./runtime.js";
import { MuseCatalogReader } from "./verify-setup.js";

const binaryPath = fileURLToPath(new URL("./test-support/fake-muse.mjs", import.meta.url));
let workspace: string;
let reader: MuseCatalogReader;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "muse-catalog-"));
  reader = new MuseCatalogReader();
  vi.stubEnv("OPENCLAW_STATE_DIR", workspace);
  vi.stubEnv(
    "MUSE_FIXTURE_CATALOG_PATH",
    fileURLToPath(
      new URL("../../../test/fixtures/model-catalog/muse-meta-account.json", import.meta.url),
    ),
  );
});

afterEach(async () => {
  try {
    await reader.dispose();
  } finally {
    vi.unstubAllEnvs();
    await rm(workspace, { recursive: true, force: true });
  }
});

function context(signal = new AbortController().signal) {
  return {
    config: { plugins: { entries: { muse: { config: { binaryPath } } } } },
    workspaceDir: workspace,
    provider: "meta",
    modelId: "muse-wonder-full-1.0-contributor",
    signal,
    assertCurrent: () => {},
  };
}

async function catalog(value: unknown) {
  const path = join(workspace, "catalog.json");
  await writeFile(path, JSON.stringify(value));
  vi.stubEnv("MUSE_FIXTURE_CATALOG_PATH", path);
}

it("preserves native executable identities and distinguishes mislabeled Wonder variants", async () => {
  expect(await reader.read(context())).toEqual(expected);
});

it("does not satisfy Full Contributor access with its similarly labeled sibling", async () => {
  await catalog({
    ...original,
    models: original.models.filter((row) => row.modelId !== "muse-wonder-full-1.0-contributor"),
  });
  await expect(reader.verify(context())).rejects.toThrow(
    "cannot access meta/muse-wonder-full-1.0-contributor",
  );
});

it("keeps meaningful provider labels and unknown future IDs without guessing an offering", async () => {
  const makeModel = (modelId: string, displayLabel = modelId) => ({
    modelId,
    displayLabel,
    providerId: "meta",
  });
  const models = [
    makeModel("muse-wonder-full-1.0-contributor", "Official Full Subscriber Label"),
    makeModel("muse-wonder-2.0-contributor"),
    makeModel("future-opaque-id", "Provider's New Model"),
  ];
  const modelIds = [...expected.map((row) => row.id), ...models.map((row) => row.modelId)];
  await catalog({ source: "providerCatalog", providerId: "meta", models });
  const log = join(workspace, "requests.jsonl");
  vi.stubEnv("MUSE_REQUEST_LOG", log);
  const pool = new MusePool(binaryPath, true);
  try {
    const rows = await reader.read(context());
    expect(rows.map((row) => [row.id, row.name])).toEqual(
      models.map((model) => [model.modelId, model.displayLabel]),
    );
    const lease = await pool.acquire(workspace, undefined, true);
    try {
      for (const modelId of modelIds) {
        await openMuseSession(lease.runtime, { workspace, modelId, approvalMode: "denyUnmatched" });
      }
    } finally {
      lease.release();
    }
    const requests = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      requests.filter((row) => row.method === "session/start").map((row) => row.params.modelId),
    ).toEqual(modelIds);
  } finally {
    await pool.dispose();
  }
});

it.runIf(process.platform !== "win32")(
  "closes a catalog host cancelled during initialization",
  async () => {
    const server = createServer();
    const initialized = new Promise<{ pid: number; resume: () => void }>((resolve) => {
      server.once("connection", (socket) => {
        socket.once("data", (data) =>
          resolve({ pid: Number(data.toString()), resume: () => socket.write("resume") }),
        );
      });
    });
    const gatePath = join(workspace, "initialize.sock");
    await new Promise<void>((resolve) => {
      server.listen(gatePath, resolve);
    });
    vi.stubEnv("MUSE_FIXTURE_INITIALIZE_GATE", gatePath);
    const controller = new AbortController();
    try {
      const verification = reader.verify({
        ...context(controller.signal),
        modelId: "muse-spark-1.3",
      });
      const rejected = expect(verification).rejects.toThrow();
      const child = await initialized;
      controller.abort();
      child.resume();
      await rejected;
      expect(() => process.kill(child.pid, 0)).toThrow();
    } finally {
      await reader.dispose();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  },
);
