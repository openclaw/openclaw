import { lstat, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createQaBundledPluginsDir,
  resolveQaOwnerPluginIdsForProviderIds,
  resolveQaRuntimeHostVersion,
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
  return { repoRoot, tempRoot, write };
}

const providerConfig = {
  baseUrl: "https://api.example.test/v1",
  api: "openai-responses" as const,
  models: [],
};

describe("qa bundled plugin dir", () => {
  it("stages a scoped mixed-source tree with working SDK, chunks, and dependency links", async () => {
    const f = await fixture();
    await f.write("package.json", {
      name: "openclaw",
      type: "module",
      exports: { "./plugin-sdk/account-id": { default: "./dist/plugin-sdk/account-id.js" } },
    });
    await f.write(
      "dist/plugin-sdk/account-id.js",
      "export const normalizeAccountId = (v) => v.toLowerCase();",
    );
    for (const id of ["qa-channel", "memory-core", "image-generation-core", "unused-plugin"]) {
      await f.write(`dist/extensions/${id}/package.json`, {
        name: `@openclaw/${id}`,
        type: "module",
      });
    }
    await f.write(
      "dist/extensions/qa-channel/index.js",
      [
        'import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";',
        'export const accountId = normalizeAccountId("QA");',
      ].join("\n"),
    );
    await f.write("extensions/qa-channel/openclaw.plugin.json", {
      id: "qa-channel",
      toolMetadata: { qa_read: { replaySafe: true } },
    });
    await f.write("dist/shared-chunk.js", "export {};");
    await f.write("dist-runtime/runtime-chunk.js", 'export const marker = "runtime";');
    await f.write("dist-runtime/extensions/runtime-only/package.json", { type: "module" });
    await f.write(
      "dist-runtime/extensions/runtime-only/index.js",
      'export { marker } from "../../runtime-chunk.js";',
    );
    await f.write("extensions/source-only/package.json", { type: "module" });
    await f.write(
      "extensions/source-only/index.ts",
      [
        'import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";',
        'import { marker } from "fake-dep";',
        'export const accountId = `${normalizeAccountId("QA")}:${marker}`;',
      ].join("\n"),
    );
    await f.write("store/fake-dep/package.json", { name: "fake-dep", type: "module" });
    await f.write("store/fake-dep/index.js", 'export const marker = "ok";');
    await mkdir(path.join(f.repoRoot, "node_modules"));
    await symlink(
      path.join(f.repoRoot, "store/fake-dep"),
      path.join(f.repoRoot, "node_modules/fake-dep"),
      "dir",
    );

    const { bundledPluginsDir, stagedRoot } = await createQaBundledPluginsDir({
      ...f,
      allowedPluginIds: [
        "qa-channel",
        "memory-core",
        "runtime-only",
        "source-only",
        "external-fixture",
      ],
    });
    expect(stagedRoot).toBe(
      path.join(f.repoRoot, ".artifacts/qa-runtime", path.basename(f.tempRoot)),
    );
    expect(bundledPluginsDir).toBe(path.join(stagedRoot, "dist/extensions"));
    expect((await readdir(bundledPluginsDir)).toSorted()).toEqual([
      "image-generation-core",
      "memory-core",
      "qa-channel",
      "runtime-only",
      "source-only",
    ]);
    await expect(readFile(path.join(stagedRoot, "package.json"), "utf8")).resolves.toContain(
      '"name":"openclaw"',
    );
    await expect(
      readFile(path.join(bundledPluginsDir, "qa-channel/openclaw.plugin.json"), "utf8"),
    ).resolves.toContain('"replaySafe":true');
    for (const id of ["qa-channel", "memory-core", "image-generation-core"]) {
      expect((await lstat(path.join(bundledPluginsDir, id))).isDirectory()).toBe(true);
    }
    const compiled: { accountId: string } = await import(
      pathToFileURL(path.join(bundledPluginsDir, "qa-channel/index.js")).href
    );
    const runtime: { marker: string } = await import(
      pathToFileURL(path.join(bundledPluginsDir, "runtime-only/index.js")).href
    );
    const source: { accountId: string } = await import(
      pathToFileURL(path.join(bundledPluginsDir, "source-only/index.ts")).href
    );
    expect(compiled.accountId).toBe("qa");
    expect(runtime.marker).toBe("runtime");
    expect(source.accountId).toBe("qa:ok");
    for (const file of ["shared-chunk.js", "runtime-chunk.js"]) {
      const stat = await lstat(path.join(stagedRoot, "dist", file));
      expect(stat.isFile() || stat.isSymbolicLink()).toBe(true);
    }
    expect((await lstat(path.join(stagedRoot, "node_modules/fake-dep"))).isSymbolicLink()).toBe(
      true,
    );
    await expect(
      readFile(path.join(stagedRoot, "node_modules/fake-dep/index.js"), "utf8"),
    ).resolves.toContain('marker = "ok"');
  });

  it("rejects invalid bundled plugin ids before staging paths are built", async () => {
    const f = await fixture();
    await expect(
      createQaBundledPluginsDir({ ...f, allowedPluginIds: ["../escape"] }),
    ).rejects.toThrow("invalid QA bundled plugin id: ../escape");
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
    { facadeFloor: "2026.4.7", expected: "2026.4.8" },
    { facadeFloor: "2026.4.9", expected: "2026.4.9" },
  ])(
    "raises host version to the highest floor including runtime facade $facadeFloor",
    async ({ facadeFloor, expected }) => {
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
      await expect(
        resolveQaRuntimeHostVersion({
          repoRoot: f.repoRoot,
          allowedPluginIds: ["memory-core", "qa-channel"],
        }),
      ).resolves.toBe(expected);
    },
  );
});
