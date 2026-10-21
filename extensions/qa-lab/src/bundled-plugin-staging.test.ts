import { lstat, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createQaBundledPluginsDir,
  resolveQaOwnerPluginIdsForProviderIds,
} from "./bundled-plugin-staging.js";
import { readQaLiveProviderConfigOverrides } from "./providers/live-config.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const fixtureTmpRoot = vi.hoisted(() => process.env.TMPDIR || "/tmp");
vi.mock("openclaw/plugin-sdk/temp-path", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/temp-path")>()),
  resolvePreferredOpenClawTmpDir: () => fixtureTmpRoot,
}));
const tempDirs = createTempDirHarness();
afterEach(() => tempDirs.cleanup());

async function fixture() {
  const repoRoot = await tempDirs.makeTempDir("qa-bundled-");
  const tempRoot = await tempDirs.makeTempDir("qa-bundled-target-");
  const write = async (relative: string, value: unknown) => {
    const file = path.join(repoRoot, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, typeof value === "string" ? value : JSON.stringify(value), "utf8");
  };
  await write("package.json", { name: "openclaw", type: "module" });
  return {
    repoRoot,
    tempRoot,
    write,
    files: (entries: Record<string, unknown>) =>
      Promise.all(Object.entries(entries).map(([file, value]) => write(file, value))),
    stage: (allowedPluginIds: string[]) =>
      createQaBundledPluginsDir({ repoRoot, tempRoot, allowedPluginIds }),
  };
}

const modulePackage = { type: "module" };
const providerConfig = {
  baseUrl: "https://api.example.test/v1",
  api: "openai-responses" as const,
  models: [],
};

describe("qa bundled plugin dir", () => {
  it("stages a scoped mixed-source tree with working SDK, chunks, and dependency links", async () => {
    const f = await fixture();
    const selected = ["qa-channel", "memory-core", "runtime-only", "source-only"];
    const sdkImport = 'import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";';
    await f.files({
      "package.json": {
        name: "openclaw",
        type: "module",
        exports: { "./plugin-sdk/account-id": { default: "./dist/plugin-sdk/account-id.js" } },
      },
      "dist/plugin-sdk/account-id.js": "export const normalizeAccountId = (v) => v.toLowerCase();",
      "dist/extensions/qa-channel/index.js": `${sdkImport}\nexport const accountId = normalizeAccountId("QA");`,
      "extensions/qa-channel/openclaw.plugin.json": {
        id: "qa-channel",
        toolMetadata: { qa_read: { replaySafe: true } },
      },
      "dist/shared-chunk.js": "export {};",
      "dist-runtime/runtime-chunk.js": 'export const marker = "runtime";',
      "dist-runtime/extensions/runtime-only/package.json": modulePackage,
      "dist-runtime/extensions/runtime-only/index.js":
        'export { marker } from "../../runtime-chunk.js";',
      "extensions/source-only/package.json": modulePackage,
      "extensions/source-only/index.ts":
        `${sdkImport}\n` +
        'import { marker } from "fake-dep";\nexport const accountId = `${normalizeAccountId("QA")}:${marker}`;',
      "store/fake-dep/package.json": { name: "fake-dep", ...modulePackage },
      "store/fake-dep/index.js": 'export const marker = "ok";',
    });
    for (const id of ["qa-channel", "memory-core", "image-generation-core", "unused-plugin"]) {
      await f.write(`dist/extensions/${id}/package.json`, modulePackage);
    }
    await mkdir(path.join(f.repoRoot, "node_modules"));
    await symlink(
      path.join(f.repoRoot, "store/fake-dep"),
      path.join(f.repoRoot, "node_modules/fake-dep"),
      "dir",
    );

    const { bundledPluginsDir: plugins } = await f.stage([...selected, "external-fixture"]);
    const root = path.join(f.repoRoot, ".artifacts/qa-runtime", path.basename(f.tempRoot));
    const staged = (...parts: string[]) => path.join(root, ...parts);
    const plugin = (file: string) => path.join(plugins, file);
    const read = (file: string) => readFile(file, "utf8");
    expect(plugins).toBe(staged("dist/extensions"));
    expect((await readdir(plugins)).toSorted()).toEqual(
      [...selected, "image-generation-core"].toSorted(),
    );
    for (const [file, text] of [
      [staged("package.json"), '"name":"openclaw"'],
      [plugin("qa-channel/openclaw.plugin.json"), '"replaySafe":true'],
      [staged("node_modules/fake-dep/index.js"), 'marker = "ok"'],
    ] as const) {
      await expect(read(file)).resolves.toContain(text);
    }
    for (const id of ["qa-channel", "memory-core", "image-generation-core"]) {
      expect((await lstat(plugin(id))).isDirectory()).toBe(true);
    }
    for (const [file, key, expected] of [
      ["qa-channel/index.js", "accountId", "qa"],
      ["runtime-only/index.js", "marker", "runtime"],
      ["source-only/index.ts", "accountId", "qa:ok"],
    ] as const) {
      const loaded: Record<string, unknown> = await import(pathToFileURL(plugin(file)).href);
      expect(loaded[key]).toBe(expected);
    }
    for (const file of ["shared-chunk.js", "runtime-chunk.js"]) {
      const stat = await lstat(staged("dist", file));
      expect(stat.isFile() || stat.isSymbolicLink()).toBe(true);
    }
    expect((await lstat(staged("node_modules/fake-dep"))).isSymbolicLink()).toBe(true);
  });

  it("rejects invalid bundled plugin ids before staging paths are built", async () => {
    const f = await fixture();
    await expect(f.stage(["../escape"])).rejects.toThrow("invalid QA bundled plugin id: ../escape");
  });

  it("resolves CLI and configured Responses aliases to their shared plugin owner", async () => {
    const f = await fixture();
    await f.write("dist/extensions/cli-owner/openclaw.plugin.json", {
      id: "cli-owner",
      providers: ["fixture", "fixture"],
      cliBackends: ["codex-cli"],
    });
    await expect(
      resolveQaOwnerPluginIdsForProviderIds({
        repoRoot: f.repoRoot,
        providerIds: ["codex-cli", "custom-openai"],
        providerConfigs: { "custom-openai": providerConfig },
      }),
    ).resolves.toEqual(["cli-owner", "openai"]);
  });

  it("copies only selected provider configs while preserving inherited and explicit auth", async () => {
    const f = await fixture();
    const apiKey = { source: "env", id: "OPENCLAW_LIVE_CODEX_API_KEY" };
    await f.write("openclaw.json", {
      models: {
        providers: {
          "custom-openai": providerConfig,
          openai: { apiKey },
          inherited: { baseUrl: "", api: "openai-responses", models: [] },
          ignored: { ...providerConfig, baseUrl: "https://ignored.example.test/v1" },
        },
      },
    });
    const overrides = await readQaLiveProviderConfigOverrides({
      providerIds: ["custom-openai", "openai", "inherited"],
      env: { OPENCLAW_QA_LIVE_PROVIDER_CONFIG_PATH: path.join(f.repoRoot, "openclaw.json") },
    });
    expect(overrides).toEqual({
      "custom-openai": providerConfig,
      openai: { apiKey, models: [] },
      inherited: { api: "openai-responses", models: [] },
    });
  });

  it.each([
    ["2026.4.7", "2026.4.8"],
    ["2026.4.9", "2026.4.9"],
  ])("uses highest host/plugin/facade floor (%s)", async (facadeFloor, expected) => {
    const f = await fixture();
    await f.write("package.json", { version: "2026.4.7-1" });
    for (const [id, floor] of [
      ["memory-core", "2026.4.7"],
      ["qa-channel", "2026.4.8"],
      ["image-generation-core", facadeFloor],
    ]) {
      await f.write(`extensions/${id}/package.json`, {
        openclaw: { install: { minHostVersion: `>=${floor}` } },
      });
    }
    expect((await f.stage(["memory-core", "qa-channel"])).runtimeHostVersion).toBe(expected);
  });
});
