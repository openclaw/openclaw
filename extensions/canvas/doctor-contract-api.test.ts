import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginDoctorStateMigration } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { resolvePreferredOpenClawTmpDir, tempWorkspace } from "openclaw/plugin-sdk/temp-path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  legacyConfigRules,
  normalizeCompatibilityConfig,
  stateMigrations,
} from "./doctor-contract-api.js";

const migration = stateMigrations[0];
const canvasDoctorWorkspaceRoot = resolvePreferredOpenClawTmpDir();
const migrated = { changes: ["Migrated 1 Canvas document(s) into core storage"], warnings: [] };

async function createCanvasDoctorWorkspace(documentId = "cv_existing") {
  const workspace = await tempWorkspace({
    rootDir: canvasDoctorWorkspaceRoot,
    prefix: "openclaw-canvas-doctor-",
  });
  const stateDir = path.join(workspace.dir, "state");
  const customRoot = path.join(workspace.dir, "custom");
  const coreDocumentsDir = path.join(stateDir, "canvas", "documents");
  const params: Parameters<PluginDoctorStateMigration["detectLegacyState"]>[0] = {
    config: { plugins: { entries: { canvas: { config: { host: { root: customRoot } } } } } },
    env: process.env,
    stateDir,
    oauthDir: path.join(stateDir, "credentials"),
    context: { openPluginStateKeyedStore: () => undefined as never },
  };
  return Object.assign(workspace, {
    stateDir,
    customRoot,
    coreDocumentsDir,
    coreDocumentDir: path.join(coreDocumentsDir, documentId),
    legacyDocumentDir: path.join(customRoot, "documents", documentId),
    params,
  });
}

async function writeDocument(dir: string, content: string) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "index.html"), content, "utf8");
}

const readDoc = (dir: string, file = "index.html") => fs.readFile(path.join(dir, file), "utf8");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Canvas doctor", () => {
  it("flags and removes retired file-host settings", () => {
    expect(legacyConfigRules.map((rule) => rule.path)).toEqual([
      ["canvasHost"],
      ["plugins", "entries", "canvas", "config", "host", "root"],
      ["plugins", "entries", "canvas", "config", "host", "port"],
      ["plugins", "entries", "canvas", "config", "host", "liveReload"],
    ]);
    expect(legacyConfigRules.every((rule) => rule.message.includes("doctor --fix"))).toBe(true);
    const host = { enabled: false, root: "~/canvas", port: 18793, liveReload: true };
    const cfg = { plugins: { entries: { canvas: { enabled: true, config: { host } } } } };

    const result = normalizeCompatibilityConfig({ cfg });

    expect(result.config.plugins?.entries?.canvas).toEqual({
      enabled: true,
      config: { host: { enabled: false } },
    });
    expect(result.changes).toEqual([
      "Removed retired Canvas host config: plugins.entries.canvas.config.host.root, plugins.entries.canvas.config.host.port, plugins.entries.canvas.config.host.liveReload.",
    ]);
    expect(cfg.plugins?.entries?.canvas?.config).toEqual({
      host: { enabled: false, root: "~/canvas", port: 18793, liveReload: true },
    });
    expect(normalizeCompatibilityConfig({ cfg: result.config })).toEqual({
      config: result.config,
      changes: [],
    });
  });
  it("ignores the default core document root", async () => {
    await using workspace = await createCanvasDoctorWorkspace();
    await fs.mkdir(workspace.coreDocumentDir, { recursive: true });

    await expect(
      migration?.detectLegacyState({ ...workspace.params, config: {} }),
    ).resolves.toBeNull();
  });

  it("moves custom-root documents into the stable core layout", async () => {
    await using workspace = await createCanvasDoctorWorkspace();
    const { stateDir, customRoot, legacyDocumentDir, coreDocumentDir, params } = workspace;
    await fs.mkdir(path.join(legacyDocumentDir, "collection.media"), { recursive: true });
    await writeDocument(legacyDocumentDir, "<p>existing</p>");
    await fs.writeFile(path.join(legacyDocumentDir, "collection.media", "asset.txt"), "asset");

    await expect(migration?.detectLegacyState(params)).resolves.toEqual({
      preview: [
        `- Canvas documents: ${path.join(customRoot, "documents")} -> ${path.join(stateDir, "canvas", "documents")} (1 document(s))`,
      ],
    });
    await expect(migration?.migrateLegacyState(params)).resolves.toEqual(migrated);
    await expect(readDoc(coreDocumentDir)).resolves.toBe("<p>existing</p>");
    await expect(readDoc(coreDocumentDir, "collection.media/asset.txt")).resolves.toBe("asset");
    await expect(fs.access(legacyDocumentDir)).rejects.toThrow();
  });

  it("leaves a conflicting legacy document in place", async () => {
    await using workspace = await createCanvasDoctorWorkspace("cv_conflict");
    const { legacyDocumentDir, coreDocumentDir, params } = workspace;
    await writeDocument(legacyDocumentDir, "legacy");
    await writeDocument(coreDocumentDir, "core");

    const result = await migration?.migrateLegacyState(params);

    expect(result?.changes).toEqual([]);
    expect(result?.warnings).toHaveLength(1);
    await expect(readDoc(legacyDocumentDir)).resolves.toBe("legacy");
    await expect(readDoc(coreDocumentDir)).resolves.toBe("core");
  });

  it("cleans partial copies and retries the migration", async () => {
    await using workspace = await createCanvasDoctorWorkspace("cv_retry");
    const { legacyDocumentDir, coreDocumentsDir, coreDocumentDir, params } = workspace;
    await writeDocument(legacyDocumentDir, "complete");
    const copy = vi.spyOn(fs, "cp").mockImplementationOnce(async (_source, destination) => {
      const destinationPath =
        typeof destination === "string" ? destination : fileURLToPath(destination);
      await writeDocument(destinationPath, "partial");
      throw new Error("interrupted copy");
    });

    const failed = await migration?.migrateLegacyState(params);

    expect(failed?.changes).toEqual([]);
    expect(failed?.warnings).toHaveLength(1);
    await expect(fs.access(coreDocumentDir)).rejects.toThrow();
    await expect(readDoc(legacyDocumentDir)).resolves.toBe("complete");
    expect(
      (await fs.readdir(coreDocumentsDir)).filter((name) => name.startsWith(".canvas-migrate-")),
    ).toEqual([]);

    copy.mockRestore();
    await expect(migration?.migrateLegacyState(params)).resolves.toEqual(migrated);
    await expect(readDoc(coreDocumentDir)).resolves.toBe("complete");
  });
});
