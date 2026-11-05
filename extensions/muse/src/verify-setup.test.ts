import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import original from "../../../test/fixtures/model-catalog/muse-meta-account.json" with { type: "json" };
import expected from "../../../test/fixtures/model-catalog/muse-meta-expected.json" with { type: "json" };
import { MuseCatalogReader } from "./verify-setup.js";

const binaryPath = fileURLToPath(new URL("./test-support/fake-muse.mjs", import.meta.url));
let workspace: string;
let reader: MuseCatalogReader;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "muse-catalog-"));
  reader = new MuseCatalogReader();
  vi.stubEnv("OPENCLAW_STATE_DIR", workspace);
  await catalog(original.models);
});

afterEach(async () => {
  try {
    await reader.dispose();
  } finally {
    vi.unstubAllEnvs();
    await rm(workspace, { recursive: true, force: true });
  }
});

const context = (signal = new AbortController().signal) => ({
  config: { plugins: { entries: { muse: { config: { binaryPath } } } } },
  workspaceDir: workspace,
  provider: "meta",
  modelId: "muse-wonder-full-1.0-contributor",
  signal,
  assertCurrent: () => {},
});

async function catalog(models: unknown) {
  const path = join(workspace, "catalog.json");
  await writeFile(path, JSON.stringify({ ...original, models }));
  vi.stubEnv("MUSE_FIXTURE_CATALOG_PATH", path);
}

it("preserves native executable identities and distinguishes mislabeled Wonder variants", async () => {
  expect(await reader.read(context())).toEqual(expected);
});

it("does not satisfy Full Contributor access with its similarly labeled sibling", async () => {
  await catalog(
    original.models.filter((row) => row.modelId !== "muse-wonder-full-1.0-contributor"),
  );
  await expect(reader.verify(context())).rejects.toThrow(
    "cannot access meta/muse-wonder-full-1.0-contributor",
  );
});

it("keeps meaningful provider labels and unknown future IDs without guessing an offering", async () => {
  const labels = {
    "muse-wonder-full-1.0-contributor": "Official Full Subscriber Label",
    "muse-wonder-2.0-contributor": "muse-wonder-2.0-contributor",
    "future-opaque-id": "Provider's New Model",
  };
  await catalog(
    Object.entries(labels).map(([modelId, displayLabel]) => ({
      modelId,
      displayLabel,
      providerId: "meta",
    })),
  );
  expect((await reader.read(context())).map((row) => [row.id, row.name])).toEqual(
    Object.entries(labels),
  );
});

it.runIf(process.platform !== "win32")("closes a catalog host cancelled at startup", async () => {
  await using server = createServer();
  const gatePath = join(workspace, "initialize.sock");
  await once(server.listen(gatePath), "listening");
  const connected = once(server, "connection");
  vi.stubEnv("MUSE_FIXTURE_INITIALIZE_GATE", gatePath);
  const controller = new AbortController();
  try {
    const verification = reader.verify(context(controller.signal));
    const rejected = expect(verification).rejects.toThrow();
    const socket: Socket = (await connected)[0];
    const [pid] = await once(socket, "data");
    controller.abort();
    socket.write("resume");
    await rejected;
    expect(() => process.kill(Number(pid), 0)).toThrow();
  } finally {
    await reader.dispose();
  }
});
