import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginDoctorStateMigration } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { resolvePreferredOpenClawTmpDir, tempWorkspace } from "openclaw/plugin-sdk/temp-path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeCompatibilityConfig, stateMigrations } from "./doctor-contract-api.js";

const migration = stateMigrations[0];
const migrated = { changes: ["Migrated 1 Canvas document(s) into core storage"], warnings: [] };

async function createCanvasDoctorWorkspace() {
  const workspace = await tempWorkspace({
    rootDir: resolvePreferredOpenClawTmpDir(),
    prefix: "openclaw-canvas-doctor-",
  });
  const stateDir = path.join(workspace.dir, "state");
  const customRoot = path.join(workspace.dir, "custom");
  const coreDocumentsDir = path.join(stateDir, "canvas", "documents");
  return Object.assign(workspace, {
    coreDocumentsDir,
    target: path.join(coreDocumentsDir, "cv_existing"),
    source: path.join(customRoot, "documents", "cv_existing"),
    params: {
      config: { plugins: { entries: { canvas: { config: { host: { root: customRoot } } } } } },
      env: process.env,
      stateDir,
      oauthDir: path.join(stateDir, "credentials"),
      context: { openPluginStateKeyedStore: () => undefined as never },
    } satisfies Parameters<PluginDoctorStateMigration["detectLegacyState"]>[0],
  });
}

async function writeDocument(dir: string, content: string) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "index.html"), content, "utf8");
}

const readDoc = (dir: string, file = "index.html") => fs.readFile(path.join(dir, file), "utf8");

afterEach(() => vi.restoreAllMocks());

describe("Canvas doctor", () => {
  it("removes retired file-host settings without mutating the input", () => {
    const host = { enabled: false, root: "~/canvas", port: 18793, liveReload: true };
    const cfg = { plugins: { entries: { canvas: { enabled: true, config: { host } } } } };
    const original = structuredClone(cfg);
    const result = normalizeCompatibilityConfig({ cfg });
    expect(result.config.plugins?.entries?.canvas).toEqual({
      enabled: true,
      config: { host: { enabled: false } },
    });
    expect(result.changes).toHaveLength(1);
    expect(cfg).toEqual(original);
    expect(normalizeCompatibilityConfig({ cfg: result.config })).toEqual({
      config: result.config,
      changes: [],
    });
  });
  it("ignores the default core document root", async () => {
    await using workspace = await createCanvasDoctorWorkspace();
    await fs.mkdir(workspace.target, { recursive: true });
    await expect(
      migration?.detectLegacyState({ ...workspace.params, config: {} }),
    ).resolves.toBeNull();
  });

  it("moves custom-root documents into the stable core layout", async () => {
    await using workspace = await createCanvasDoctorWorkspace();
    const { source, target, coreDocumentsDir, params } = workspace;
    await fs.mkdir(path.join(source, "collection.media"), { recursive: true });
    await writeDocument(source, "<p>existing</p>");
    await fs.writeFile(path.join(source, "collection.media", "asset.txt"), "asset");

    await expect(migration?.detectLegacyState(params)).resolves.toEqual({
      preview: [
        `- Canvas documents: ${path.dirname(source)} -> ${coreDocumentsDir} (1 document(s))`,
      ],
    });
    await expect(migration?.migrateLegacyState(params)).resolves.toEqual(migrated);
    await expect(readDoc(target)).resolves.toBe("<p>existing</p>");
    await expect(readDoc(target, "collection.media/asset.txt")).resolves.toBe("asset");
    await expect(fs.access(source)).rejects.toThrow();
  });

  it("leaves a conflicting legacy document in place", async () => {
    await using workspace = await createCanvasDoctorWorkspace();
    const { source, target, params } = workspace;
    await writeDocument(source, "legacy");
    await writeDocument(target, "core");
    const result = await migration?.migrateLegacyState(params);
    expect(result).toEqual({ changes: [], warnings: [expect.any(String)] });
    await expect(readDoc(source)).resolves.toBe("legacy");
    await expect(readDoc(target)).resolves.toBe("core");
  });

  it("cleans partial copies and retries the migration", async () => {
    await using workspace = await createCanvasDoctorWorkspace();
    const { source, coreDocumentsDir, target, params } = workspace;
    await writeDocument(source, "complete");
    const copy = vi.spyOn(fs, "cp").mockImplementationOnce(async (_source, destination) => {
      const destinationPath =
        typeof destination === "string" ? destination : fileURLToPath(destination);
      await writeDocument(destinationPath, "partial");
      throw new Error("interrupted copy");
    });

    const failed = await migration?.migrateLegacyState(params);
    expect(failed).toEqual({ changes: [], warnings: [expect.any(String)] });
    await expect(fs.access(target)).rejects.toThrow();
    await expect(readDoc(source)).resolves.toBe("complete");
    expect(
      (await fs.readdir(coreDocumentsDir)).filter((name) => name.startsWith(".canvas-migrate-")),
    ).toEqual([]);

    copy.mockRestore();
    await expect(migration?.migrateLegacyState(params)).resolves.toEqual(migrated);
    await expect(readDoc(target)).resolves.toBe("complete");
  });
});
