import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import original from "../../../test/fixtures/model-catalog/muse-meta-account.json" with { type: "json" };
import expected from "../../../test/fixtures/model-catalog/muse-meta-expected.json" with { type: "json" };
import { MusePool, openMuseSession } from "./runtime.js";
import { MuseCatalogReader } from "./verify-setup.js";

it("preserves native executable identities and distinguishes mislabeled Wonder variants", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "muse-catalog-labels-"));
  const reader = new MuseCatalogReader();
  vi.stubEnv("OPENCLAW_STATE_DIR", workspace);
  vi.stubEnv(
    "MUSE_FIXTURE_CATALOG_PATH",
    fileURLToPath(
      new URL("../../../test/fixtures/model-catalog/muse-meta-account.json", import.meta.url),
    ),
  );
  try {
    const rows = await reader.read({
      config: {
        plugins: {
          entries: {
            muse: {
              config: {
                binaryPath: fileURLToPath(new URL("./test-support/fake-muse.mjs", import.meta.url)),
              },
            },
          },
        },
      },
      signal: new AbortController().signal,
      assertCurrent: () => {},
    });
    expect(rows).toEqual(expected);
  } finally {
    await reader.dispose();
    vi.unstubAllEnvs();
    await rm(workspace, { recursive: true, force: true });
  }
});

it("does not satisfy Full Contributor access with its similarly labeled sibling", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "muse-catalog-membership-"));
  const reader = new MuseCatalogReader();
  const fixture = join(workspace, "catalog.json");
  await writeFile(
    fixture,
    JSON.stringify({
      ...original,
      models: original.models.filter((row) => row.modelId !== "muse-wonder-full-1.0-contributor"),
    }),
  );
  vi.stubEnv("OPENCLAW_STATE_DIR", workspace);
  vi.stubEnv("MUSE_FIXTURE_CATALOG_PATH", fixture);
  try {
    await expect(
      reader.verify({
        config: {
          plugins: {
            entries: {
              muse: {
                config: {
                  binaryPath: fileURLToPath(
                    new URL("./test-support/fake-muse.mjs", import.meta.url),
                  ),
                },
              },
            },
          },
        },
        workspaceDir: workspace,
        provider: "meta",
        modelId: "muse-wonder-full-1.0-contributor",
        signal: new AbortController().signal,
        assertCurrent: () => {},
      }),
    ).rejects.toThrow("cannot access meta/muse-wonder-full-1.0-contributor");
  } finally {
    await reader.dispose();
    vi.unstubAllEnvs();
    await rm(workspace, { recursive: true, force: true });
  }
});

it("keeps meaningful provider labels and unknown future IDs without guessing an offering", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "muse-catalog-future-"));
  const reader = new MuseCatalogReader();
  const fixture = join(workspace, "catalog.json");
  const models = [
    {
      modelId: "muse-wonder-full-1.0-contributor",
      displayLabel: "Official Full Subscriber Label",
      providerId: "meta",
    },
    {
      modelId: "muse-wonder-2.0-contributor",
      displayLabel: "muse-wonder-2.0-contributor",
      providerId: "meta",
    },
    { modelId: "future-opaque-id", displayLabel: "Provider's New Model", providerId: "meta" },
  ];
  await writeFile(
    fixture,
    JSON.stringify({ source: "providerCatalog", providerId: "meta", models }),
  );
  vi.stubEnv("OPENCLAW_STATE_DIR", workspace);
  vi.stubEnv("MUSE_FIXTURE_CATALOG_PATH", fixture);
  const log = join(workspace, "requests.jsonl");
  vi.stubEnv("MUSE_REQUEST_LOG", log);
  const binaryPath = fileURLToPath(new URL("./test-support/fake-muse.mjs", import.meta.url));
  const pool = new MusePool(binaryPath, true);
  try {
    const rows = await reader.read({
      config: { plugins: { entries: { muse: { config: { binaryPath } } } } },
      signal: new AbortController().signal,
      assertCurrent: () => {},
    });
    expect(rows.map((row) => [row.id, row.name])).toEqual(
      models.map((model) => [model.modelId, model.displayLabel]),
    );
    const lease = await pool.acquire(workspace, undefined, true);
    try {
      for (const modelId of [
        ...expected.map((row) => row.id),
        ...models.map((row) => row.modelId),
      ]) {
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
    ).toEqual([...expected.map((row) => row.id), ...models.map((row) => row.modelId)]);
  } finally {
    await reader.dispose();
    await pool.dispose();
    vi.unstubAllEnvs();
    await rm(workspace, { recursive: true, force: true });
  }
});

it.runIf(process.platform !== "win32")(
  "closes a catalog host cancelled during initialization",
  async () => {
    const workspace = await mkdtemp(join(tmpdir(), "muse-catalog-"));
    const fixture = fileURLToPath(new URL("./test-support/fake-muse.mjs", import.meta.url));
    const reader = new MuseCatalogReader();
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
    vi.stubEnv("OPENCLAW_STATE_DIR", workspace);
    vi.stubEnv("MUSE_FIXTURE_INITIALIZE_GATE", gatePath);
    const controller = new AbortController();
    try {
      const verification = reader.verify({
        config: { plugins: { entries: { muse: { config: { binaryPath: fixture } } } } },
        workspaceDir: workspace,
        provider: "meta",
        modelId: "muse-spark-1.3",
        signal: controller.signal,
        assertCurrent: () => {},
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
      vi.unstubAllEnvs();
      await rm(workspace, { recursive: true, force: true });
    }
  },
);
