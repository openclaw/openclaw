import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { resetFacadeRuntimeStateForTest } from "../plugin-sdk/facade-runtime.js";
import { setBundledPluginsDirOverrideForTest } from "../plugins/bundled-dir.js";
import { writePersistedInstalledPluginIndexInstallRecordsSync } from "../plugins/installed-plugin-index-records.js";

const originalBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
const originalDisableBundledPlugins = process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
const originalStateDir = process.env.OPENCLAW_STATE_DIR;
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeExternalAnthropicVertexPlugin(rootDir: string): void {
  fs.mkdirSync(rootDir, { recursive: true });
  fs.writeFileSync(
    path.join(rootDir, "package.json"),
    JSON.stringify({
      name: "@openclaw/anthropic-vertex-provider",
      version: "0.0.0",
      type: "module",
      openclaw: {
        extensions: ["./index.js", "./api.js"],
      },
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(rootDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "anthropic-vertex",
      providers: ["anthropic-vertex"],
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(rootDir, "api.js"),
    [
      "export function createAnthropicVertexStreamFnForModel(model, env) {",
      "  return async () => ({ marker: 'external-vertex', baseUrl: model.baseUrl, envMarker: env.OPENCLAW_TEST_MARKER });",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(path.join(rootDir, "index.js"), "export default {};\n", "utf8");
}

// Mirrors the real published @openclaw/anthropic-vertex-provider npm package
// layout: `scripts/lib/plugin-npm-runtime-build.mjs` writes each public surface
// entry under `./dist/<entry>.js` and the published package only ships `dist/**`.
// The pre-#82781 registry resolver only checked the package root, so this layout
// failed to resolve `anthropic-vertex/api.js` even when the plugin was installed.
function writeExternalAnthropicVertexPluginWithDist(rootDir: string): void {
  fs.mkdirSync(rootDir, { recursive: true });
  fs.mkdirSync(path.join(rootDir, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(rootDir, "package.json"),
    JSON.stringify({
      name: "@openclaw/anthropic-vertex-provider",
      version: "0.0.0",
      type: "module",
      main: "./dist/index.js",
      files: ["dist/**"],
      openclaw: {
        extensions: ["./index.ts"],
      },
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(rootDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "anthropic-vertex",
      providers: ["anthropic-vertex"],
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(rootDir, "dist", "api.js"),
    [
      "export function createAnthropicVertexStreamFnForModel(model, env) {",
      "  return async () => ({ marker: 'external-vertex-dist', baseUrl: model.baseUrl, envMarker: env.OPENCLAW_TEST_MARKER });",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(path.join(rootDir, "dist", "index.js"), "export default {};\n", "utf8");
}

afterEach(() => {
  vi.resetModules();
  clearRuntimeConfigSnapshot();
  resetFacadeRuntimeStateForTest();
  setBundledPluginsDirOverrideForTest(undefined);
  if (originalBundledPluginsDir === undefined) {
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  } else {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = originalBundledPluginsDir;
  }
  if (originalDisableBundledPlugins === undefined) {
    delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
  } else {
    process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = originalDisableBundledPlugins;
  }
  if (originalStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("anthropic-vertex stream facade", () => {
  it("loads the stream facade from an installed external provider when bundled surfaces are absent", async () => {
    const bundledDir = makeTempDir("openclaw-empty-bundled-vertex-");
    const stateDir = makeTempDir("openclaw-state-vertex-");
    const pluginRoot = makeTempDir("openclaw-external-vertex-");
    writeExternalAnthropicVertexPlugin(pluginRoot);
    writePersistedInstalledPluginIndexInstallRecordsSync(
      {
        "anthropic-vertex": {
          source: "npm",
          spec: "@openclaw/anthropic-vertex-provider",
          installPath: pluginRoot,
          resolvedName: "@openclaw/anthropic-vertex-provider",
          resolvedVersion: "0.0.0",
        },
      },
      { stateDir },
    );
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledDir;
    process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";
    process.env.OPENCLAW_STATE_DIR = stateDir;
    setBundledPluginsDirOverrideForTest(bundledDir);
    setRuntimeConfigSnapshot({});

    const { createAnthropicVertexStreamFnForModel } = await import("./anthropic-vertex-stream.js");
    const streamFn = createAnthropicVertexStreamFnForModel(
      { baseUrl: "https://us-central1-aiplatform.googleapis.com" },
      { OPENCLAW_TEST_MARKER: "registry" },
    );

    await expect(streamFn({} as never, {} as never, {} as never)).resolves.toEqual({
      marker: "external-vertex",
      baseUrl: "https://us-central1-aiplatform.googleapis.com",
      envMarker: "registry",
    });
  });

  it("loads the stream facade from an installed external provider whose public surfaces live under package-local dist/ (regression test for #82781)", async () => {
    const bundledDir = makeTempDir("openclaw-empty-bundled-vertex-dist-");
    const stateDir = makeTempDir("openclaw-state-vertex-dist-");
    const pluginRoot = makeTempDir("openclaw-external-vertex-dist-");
    writeExternalAnthropicVertexPluginWithDist(pluginRoot);
    writePersistedInstalledPluginIndexInstallRecordsSync(
      {
        "anthropic-vertex": {
          source: "npm",
          spec: "@openclaw/anthropic-vertex-provider",
          installPath: pluginRoot,
          resolvedName: "@openclaw/anthropic-vertex-provider",
          resolvedVersion: "0.0.0",
        },
      },
      { stateDir },
    );
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledDir;
    process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";
    process.env.OPENCLAW_STATE_DIR = stateDir;
    setBundledPluginsDirOverrideForTest(bundledDir);
    setRuntimeConfigSnapshot({});

    const { createAnthropicVertexStreamFnForModel } = await import("./anthropic-vertex-stream.js");
    const streamFn = createAnthropicVertexStreamFnForModel(
      { baseUrl: "https://us-central1-aiplatform.googleapis.com" },
      { OPENCLAW_TEST_MARKER: "registry-dist" },
    );

    await expect(streamFn({} as never, {} as never, {} as never)).resolves.toEqual({
      marker: "external-vertex-dist",
      baseUrl: "https://us-central1-aiplatform.googleapis.com",
      envMarker: "registry-dist",
    });
  });
});
