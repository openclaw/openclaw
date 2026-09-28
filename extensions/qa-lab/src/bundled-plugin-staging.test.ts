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

async function writeJsonFixture(filePath: string, value: unknown, space?: number) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value, null, space), "utf8");
}

async function writeTempProviderConfig(value: unknown) {
  const configPath = path.join(await tempDirs.makeTempDir("qa-provider-config-"), "openclaw.json");
  await writeJsonFixture(configPath, value);
  return configPath;
}

describe("qa bundled plugin dir", () => {
  it("creates a scoped bundled plugin tree with the always-staged runtime facade", async () => {
    const repoRoot = await tempDirs.makeTempDir("qa-bundled-scope-");
    await writeFile(
      path.join(repoRoot, "package.json"),
      JSON.stringify(
        {
          name: "openclaw",
          type: "module",
          exports: {
            "./plugin-sdk/account-id": {
              default: "./dist/plugin-sdk/account-id.js",
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await mkdir(path.join(repoRoot, "dist", "extensions", "qa-channel"), { recursive: true });
    await mkdir(path.join(repoRoot, "dist", "extensions", "memory-core"), { recursive: true });
    await mkdir(path.join(repoRoot, "dist", "extensions", "image-generation-core"), {
      recursive: true,
    });
    await mkdir(path.join(repoRoot, "dist", "extensions", "unused-plugin"), { recursive: true });
    await mkdir(path.join(repoRoot, "dist", "plugin-sdk"), { recursive: true });
    await writeFile(
      path.join(repoRoot, "dist", "plugin-sdk", "account-id.js"),
      "export const normalizeAccountId = (value) => value.toLowerCase();\n",
      "utf8",
    );
    await writeFile(
      path.join(repoRoot, "dist", "extensions", "qa-channel", "package.json"),
      JSON.stringify({ name: "@openclaw/qa-channel", type: "module" }, null, 2),
      "utf8",
    );
    await writeFile(
      path.join(repoRoot, "dist", "extensions", "qa-channel", "index.js"),
      [
        'import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";',
        'export const accountId = normalizeAccountId("QA");',
        "",
      ].join("\n"),
      "utf8",
    );
    await mkdir(path.join(repoRoot, "extensions", "qa-channel"), { recursive: true });
    await writeFile(
      path.join(repoRoot, "extensions", "qa-channel", "openclaw.plugin.json"),
      JSON.stringify({
        id: "qa-channel",
        toolMetadata: { qa_read: { replaySafe: true } },
      }),
      "utf8",
    );
    await writeFile(path.join(repoRoot, "dist", "shared-chunk-abc123.js"), "export {};\n", "utf8");
    const tempRoot = await tempDirs.makeTempDir("qa-bundled-target-");

    const { bundledPluginsDir, stagedRoot } = await createQaBundledPluginsDir({
      repoRoot,
      tempRoot,
      allowedPluginIds: ["qa-channel", "memory-core"],
    });

    expect((await readdir(bundledPluginsDir)).toSorted()).toEqual([
      "image-generation-core",
      "memory-core",
      "qa-channel",
    ]);
    expect(bundledPluginsDir).toBe(
      path.join(
        repoRoot,
        ".artifacts",
        "qa-runtime",
        path.basename(tempRoot),
        "dist",
        "extensions",
      ),
    );
    expect(stagedRoot).toBe(
      path.join(repoRoot, ".artifacts", "qa-runtime", path.basename(tempRoot)),
    );
    await expect(readFile(path.join(stagedRoot, "package.json"), "utf8")).resolves.toContain(
      '"name": "openclaw"',
    );
    const qaChannel = (await import(
      `${pathToFileURL(path.join(bundledPluginsDir, "qa-channel", "index.js")).href}?t=${Date.now()}`
    )) as { accountId: string };
    expect(qaChannel.accountId).toBe("qa");
    await expect(
      readFile(path.join(bundledPluginsDir, "qa-channel", "openclaw.plugin.json"), "utf8"),
    ).resolves.toContain('"replaySafe":true');
    expect((await lstat(path.join(bundledPluginsDir, "qa-channel"))).isDirectory()).toBe(true);
    expect((await lstat(path.join(bundledPluginsDir, "memory-core"))).isDirectory()).toBe(true);
    expect((await lstat(path.join(bundledPluginsDir, "image-generation-core"))).isDirectory()).toBe(
      true,
    );
    const sharedChunkStat = await lstat(
      path.join(
        repoRoot,
        ".artifacts",
        "qa-runtime",
        path.basename(tempRoot),
        "dist",
        "shared-chunk-abc123.js",
      ),
    );
    if (sharedChunkStat.isFile()) {
      expect(sharedChunkStat.isFile()).toBe(true);
    } else {
      expect(sharedChunkStat.isSymbolicLink()).toBe(true);
    }
  });

  it("preserves dist-runtime-only root chunks when dist also exists", async () => {
    const repoRoot = await tempDirs.makeTempDir("qa-bundled-mixed-runtime-");
    await writeFile(
      path.join(repoRoot, "package.json"),
      JSON.stringify({ name: "openclaw", type: "module" }, null, 2),
      "utf8",
    );
    await mkdir(path.join(repoRoot, "dist"), { recursive: true });
    await writeFile(
      path.join(repoRoot, "dist", "shared-dist.js"),
      'export const dist = "dist";\n',
      "utf8",
    );
    await mkdir(path.join(repoRoot, "dist-runtime", "extensions", "runtime-only"), {
      recursive: true,
    });
    await writeFile(
      path.join(repoRoot, "dist-runtime", "runtime-chunk.js"),
      'export const marker = "runtime";\n',
      "utf8",
    );
    await writeFile(
      path.join(repoRoot, "dist-runtime", "extensions", "runtime-only", "package.json"),
      JSON.stringify({ name: "@openclaw/runtime-only", type: "module" }, null, 2),
      "utf8",
    );
    await writeFile(
      path.join(repoRoot, "dist-runtime", "extensions", "runtime-only", "index.js"),
      ['import { marker } from "../../runtime-chunk.js";', "export { marker };", ""].join("\n"),
      "utf8",
    );
    const tempRoot = await tempDirs.makeTempDir("qa-bundled-mixed-target-");

    const { bundledPluginsDir } = await createQaBundledPluginsDir({
      repoRoot,
      tempRoot,
      allowedPluginIds: ["runtime-only"],
    });

    expect(bundledPluginsDir).toBe(
      path.join(
        repoRoot,
        ".artifacts",
        "qa-runtime",
        path.basename(tempRoot),
        "dist",
        "extensions",
      ),
    );
    const runtimeOnly = (await import(
      `${pathToFileURL(path.join(bundledPluginsDir, "runtime-only", "index.js")).href}?t=${Date.now()}`
    )) as { marker: string };
    expect(runtimeOnly.marker).toBe("runtime");
    const runtimeChunkStat = await lstat(
      path.join(
        repoRoot,
        ".artifacts",
        "qa-runtime",
        path.basename(tempRoot),
        "dist",
        "runtime-chunk.js",
      ),
    );
    if (runtimeChunkStat.isFile()) {
      expect(runtimeChunkStat.isFile()).toBe(true);
    } else {
      expect(runtimeChunkStat.isSymbolicLink()).toBe(true);
    }
  });

  it("rejects invalid bundled plugin ids before staging paths are built", async () => {
    const repoRoot = await tempDirs.makeTempDir("qa-bundled-invalid-id-");
    await writeFile(
      path.join(repoRoot, "package.json"),
      JSON.stringify({ name: "openclaw", type: "module" }, null, 2),
      "utf8",
    );
    const tempRoot = await tempDirs.makeTempDir("qa-bundled-invalid-target-");

    await expect(
      createQaBundledPluginsDir({
        repoRoot,
        tempRoot,
        allowedPluginIds: ["../escape"],
      }),
    ).rejects.toThrow("invalid QA bundled plugin id: ../escape");
  });

  it("leaves external allowed plugins to configured load paths", async () => {
    const repoRoot = await tempDirs.makeTempDir("qa-bundled-external-id-");
    await writeFile(
      path.join(repoRoot, "package.json"),
      JSON.stringify({ name: "openclaw", type: "module" }, null, 2),
      "utf8",
    );
    const tempRoot = await tempDirs.makeTempDir("qa-bundled-external-target-");

    const { bundledPluginsDir } = await createQaBundledPluginsDir({
      repoRoot,
      tempRoot,
      allowedPluginIds: ["external-fixture"],
    });

    await expect(readdir(bundledPluginsDir)).resolves.not.toContain("external-fixture");
  });

  it("stages source-only bundled plugins into a repo-like runtime root with node_modules", async () => {
    const repoRoot = await tempDirs.makeTempDir("qa-bundled-source-stage-");
    const fakeDepStoreRoot = await tempDirs.makeTempDir("qa-bundled-source-store-");
    await writeFile(
      path.join(repoRoot, "package.json"),
      JSON.stringify(
        {
          name: "openclaw",
          type: "module",
          exports: {
            "./plugin-sdk/account-id": {
              default: "./dist/plugin-sdk/account-id.js",
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await mkdir(path.join(repoRoot, "dist", "plugin-sdk"), { recursive: true });
    await writeFile(
      path.join(repoRoot, "dist", "plugin-sdk", "account-id.js"),
      "export const normalizeAccountId = (value) => value.toLowerCase();\n",
      "utf8",
    );
    await mkdir(path.join(repoRoot, "extensions", "qa-channel"), { recursive: true });
    await writeFile(
      path.join(repoRoot, "extensions", "qa-channel", "package.json"),
      JSON.stringify({ name: "@openclaw/qa-channel", type: "module" }, null, 2),
      "utf8",
    );
    await writeFile(
      path.join(repoRoot, "extensions", "qa-channel", "index.ts"),
      [
        'import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";',
        'import { marker } from "fake-dep";',
        'export const accountId = `${normalizeAccountId("QA")}:${marker}`;',
        "",
      ].join("\n"),
      "utf8",
    );
    const fakeDepPackageDir = path.join(fakeDepStoreRoot, "fake-dep");
    await mkdir(fakeDepPackageDir, { recursive: true });
    await writeFile(
      path.join(fakeDepPackageDir, "package.json"),
      JSON.stringify({ name: "fake-dep", type: "module" }, null, 2),
      "utf8",
    );
    await writeFile(
      path.join(fakeDepPackageDir, "index.js"),
      'export const marker = "ok";\n',
      "utf8",
    );
    await mkdir(path.join(repoRoot, "node_modules"), { recursive: true });
    await symlink(fakeDepPackageDir, path.join(repoRoot, "node_modules", "fake-dep"), "dir");
    const tempRoot = await tempDirs.makeTempDir("qa-bundled-source-target-");

    const { bundledPluginsDir, stagedRoot } = await createQaBundledPluginsDir({
      repoRoot,
      tempRoot,
      allowedPluginIds: ["qa-channel"],
    });

    expect(bundledPluginsDir).toBe(
      path.join(
        repoRoot,
        ".artifacts",
        "qa-runtime",
        path.basename(tempRoot),
        "dist",
        "extensions",
      ),
    );
    if (!stagedRoot) {
      throw new Error("expected staged runtime root");
    }
    const qaChannel = (await import(
      `${pathToFileURL(path.join(bundledPluginsDir, "qa-channel", "index.ts")).href}?t=${Date.now()}`
    )) as { accountId: string };
    expect(qaChannel.accountId).toBe("qa:ok");
    await expect(
      lstat(path.join(stagedRoot, "node_modules", "fake-dep")).then((stats) =>
        stats.isSymbolicLink(),
      ),
    ).resolves.toBe(true);
    await expect(
      readFile(path.join(stagedRoot, "node_modules", "fake-dep", "index.js"), "utf8"),
    ).resolves.toContain('marker = "ok"');
  });

  it("maps cli backend provider ids to their owning bundled plugin ids", async () => {
    const repoRoot = await tempDirs.makeTempDir("qa-plugin-owner-");
    await writeJsonFixture(
      path.join(repoRoot, "dist", "extensions", "openai", "openclaw.plugin.json"),
      {
        id: "openai",
        providers: ["openai", "openai"],
        cliBackends: ["codex-cli"],
      },
    );

    await expect(
      resolveQaOwnerPluginIdsForProviderIds({
        repoRoot,
        providerIds: ["codex-cli"],
      }),
    ).resolves.toEqual(["openai"]);
  });

  it("maps configured OpenAI Responses provider aliases to the OpenAI plugin", async () => {
    const repoRoot = await tempDirs.makeTempDir("qa-plugin-owner-");
    await writeJsonFixture(
      path.join(repoRoot, "dist", "extensions", "openai", "openclaw.plugin.json"),
      {
        id: "openai",
        providers: ["openai"],
        cliBackends: ["codex-cli"],
      },
    );

    await expect(
      resolveQaOwnerPluginIdsForProviderIds({
        repoRoot,
        providerIds: ["custom-openai"],
        providerConfigs: {
          "custom-openai": {
            baseUrl: "https://api.example.test/v1",
            api: "openai-responses",
            models: [
              {
                id: "model-a",
                name: "model-a",
                api: "openai-responses",
                reasoning: true,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128_000,
                maxTokens: 4096,
              },
            ],
          },
        },
      }),
    ).resolves.toEqual(["openai"]);
  });

  it("copies selected live provider configs from the host config", async () => {
    const configPath = await writeTempProviderConfig({
      models: {
        providers: {
          "custom-openai": {
            baseUrl: "https://api.example.test/v1",
            api: "openai-responses",
            models: [
              {
                id: "model-a",
                name: "model-a",
                api: "openai-responses",
                reasoning: true,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128_000,
                maxTokens: 4096,
              },
            ],
          },
          ignored: {
            baseUrl: "https://ignored.example.test/v1",
            api: "openai-responses",
            models: [],
          },
        },
      },
    });

    const overrides = await readQaLiveProviderConfigOverrides({
      providerIds: ["custom-openai"],
      env: { OPENCLAW_QA_LIVE_PROVIDER_CONFIG_PATH: configPath },
    });
    expect(Object.keys(overrides)).toEqual(["custom-openai"]);
    expect(overrides["custom-openai"]?.baseUrl).toBe("https://api.example.test/v1");
    expect(overrides["custom-openai"]?.api).toBe("openai-responses");
  });

  it("copies OpenAI auth-only live provider configs for default OpenAI runs", async () => {
    const configPath = await writeTempProviderConfig({
      models: {
        providers: {
          openai: {
            apiKey: {
              source: "env",
              id: "OPENCLAW_LIVE_CODEX_API_KEY",
            },
          },
        },
      },
    });

    const overrides = await readQaLiveProviderConfigOverrides({
      providerIds: ["openai"],
      env: { OPENCLAW_QA_LIVE_PROVIDER_CONFIG_PATH: configPath },
    });
    expect(Object.keys(overrides)).toEqual(["openai"]);
    expect(overrides["openai"]).not.toHaveProperty("baseUrl");
    expect(overrides["openai"]?.models).toEqual([]);
    expect(overrides["openai"]?.apiKey).toEqual({
      source: "env",
      id: "OPENCLAW_LIVE_CODEX_API_KEY",
    });
  });

  it("omits empty base URLs without dropping provider configs that inherit auth", async () => {
    const configPath = await writeTempProviderConfig({
      models: {
        providers: {
          openai: {
            baseUrl: "",
            api: "openai-responses",
            models: [],
          },
        },
      },
    });

    const overrides = await readQaLiveProviderConfigOverrides({
      providerIds: ["openai"],
      env: { OPENCLAW_QA_LIVE_PROVIDER_CONFIG_PATH: configPath },
    });
    expect(Object.keys(overrides)).toEqual(["openai"]);
    expect(overrides["openai"]).not.toHaveProperty("baseUrl");
    expect(overrides["openai"]?.api).toBe("openai-responses");
  });

  it("raises the QA runtime host version to the highest allowed plugin floor", async () => {
    const repoRoot = await tempDirs.makeTempDir("qa-runtime-version-");
    await writeJsonFixture(path.join(repoRoot, "package.json"), { version: "2026.4.7-1" });
    const bundledRoot = path.join(repoRoot, "extensions");
    await writeJsonFixture(path.join(bundledRoot, "qa-channel", "package.json"), {
      openclaw: { install: { minHostVersion: ">=2026.4.8" } },
    });

    await writeJsonFixture(path.join(bundledRoot, "memory-core", "package.json"), {
      openclaw: { install: { minHostVersion: ">=2026.4.7" } },
    });

    await expect(
      resolveQaRuntimeHostVersion({
        repoRoot,
        allowedPluginIds: ["memory-core", "qa-channel"],
      }),
    ).resolves.toBe("2026.4.8");
  });

  it("includes the always-staged runtime facade when raising the QA runtime host version", async () => {
    const repoRoot = await tempDirs.makeTempDir("qa-runtime-version-runtime-facade-");
    await writeJsonFixture(path.join(repoRoot, "package.json"), { version: "2026.4.7-1" });
    const bundledRoot = path.join(repoRoot, "extensions");
    await writeJsonFixture(path.join(bundledRoot, "qa-channel", "package.json"), {
      openclaw: { install: { minHostVersion: ">=2026.4.8" } },
    });
    await writeJsonFixture(path.join(bundledRoot, "image-generation-core", "package.json"), {
      openclaw: { install: { minHostVersion: ">=2026.4.9" } },
    });

    await expect(
      resolveQaRuntimeHostVersion({
        repoRoot,
        allowedPluginIds: ["qa-channel"],
      }),
    ).resolves.toBe("2026.4.9");
  });
});
