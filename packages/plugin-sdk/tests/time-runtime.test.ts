import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../src/config/types.openclaw.js";
import { loadOpenClawPluginsAsync } from "../../../src/plugins/loader.js";
import { resetPluginLoaderTestStateForTest } from "../../../src/plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../../../src/plugins/plugin-metadata-lifecycle.js";
import {
  createColdPluginFixture,
  createColdPluginHermeticEnv,
} from "../../../src/plugins/test-helpers/cold-plugin-fixtures.js";
import { withEnvAsync } from "../../../src/test-utils/env.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";

const roots = useAutoCleanupTempDirTracker(afterEach);
const traceKey = Symbol.for("openclaw.test.plugin-time-runtime");

afterEach(() => {
  clearPluginMetadataLifecycleCaches();
  resetPluginLoaderTestStateForTest();
  Reflect.deleteProperty(globalThis, traceKey);
});

it.each([Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER])(
  "keeps delayed plugin work alive for an oversized deadline of %s",
  async (timeoutMs) => {
    const { raceWithTimeout }: typeof import("@openclaw/plugin-sdk/time-runtime") = await import(
      createRequire(import.meta.url).resolve("@openclaw/plugin-sdk/time-runtime")
    );
    const warnings: Error[] = [];
    const onWarning = (warning: Error) => warnings.push(warning);
    process.on("warning", onWarning);
    try {
      const delayedPluginWork = new Promise<string>((resolve) => {
        setTimeout(() => resolve("done"), 20);
      });

      await expect(raceWithTimeout(delayedPluginWork, timeoutMs, () => "expired")).resolves.toBe(
        "done",
      );
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(warnings.filter((warning) => warning.name === "TimeoutOverflowWarning")).toEqual([]);
    } finally {
      process.off("warning", onWarning);
    }
  },
);

it.each([2_147_483_647, 1.5])("preserves the supported native deadline %s", async (timeoutMs) => {
  const { raceWithTimeout }: typeof import("@openclaw/plugin-sdk/time-runtime") = await import(
    createRequire(import.meta.url).resolve("@openclaw/plugin-sdk/time-runtime")
  );
  const scheduled = vi.spyOn(globalThis, "setTimeout");
  try {
    await expect(
      raceWithTimeout(Promise.resolve("done"), timeoutMs, () => "expired"),
    ).resolves.toBe("done");
    expect(scheduled).toHaveBeenCalledWith(expect.any(Function), timeoutMs);
  } finally {
    scheduled.mockRestore();
  }
});

it("keeps delayed work alive when a loaded plugin supplies oversized deadlines", async () => {
  const root = roots.make("plugin-time-runtime-");
  const pluginRoot = path.join(root, "plugin");
  const emptyBundled = path.join(root, "bundled");
  fs.mkdirSync(pluginRoot);
  fs.mkdirSync(emptyBundled);
  const fixture = createColdPluginFixture({
    rootDir: pluginRoot,
    pluginId: "timeout-proof",
    manifest: { channels: [], providers: [], providerAuthChoices: [] },
  });
  fs.writeFileSync(
    fixture.runtimeSource,
    [
      'const { raceWithTimeout } = require("openclaw/plugin-sdk/time-runtime");',
      'const trace = globalThis[Symbol.for("openclaw.test.plugin-time-runtime")];',
      'module.exports = { id: "timeout-proof", register() {',
      "trace.result = (async () => {",
      "const warnings = [];",
      "const onWarning = (warning) => warnings.push(warning);",
      'process.on("warning", onWarning);',
      "try {",
      "const outcomes = [];",
      "for (const timeoutMs of [Infinity, Number.MAX_SAFE_INTEGER]) {",
      'outcomes.push(await raceWithTimeout(new Promise((resolve) => setTimeout(() => resolve("done"), 20)), timeoutMs, () => "expired"));',
      "}",
      "await new Promise((resolve) => setImmediate(resolve));",
      'return { outcomes, overflowWarnings: warnings.filter((warning) => warning.name === "TimeoutOverflowWarning").length };',
      "} finally {",
      'process.off("warning", onWarning);',
      "}",
      "})();",
      "} };",
    ].join("\n"),
  );
  const cfg: OpenClawConfig = {
    plugins: {
      load: { paths: [pluginRoot] },
      slots: { memory: "none" },
      entries: { "timeout-proof": { enabled: true } },
    },
  };
  const env = {
    ...createColdPluginHermeticEnv(root, { bundledPluginsDir: emptyBundled }),
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_STATE_DIR: path.join(root, "state"),
  };
  const trace: { result?: Promise<{ outcomes: string[]; overflowWarnings: number }> } = {};
  Reflect.set(globalThis, traceKey, trace);

  await withEnvAsync(env, async () => {
    const registry = await loadOpenClawPluginsAsync({
      config: cfg,
      env,
      workspaceDir: path.join(root, "workspace"),
      activate: false,
    });
    expect(registry.diagnostics.filter((item) => item.level === "error")).toEqual([]);
    await expect(trace.result).resolves.toEqual({
      outcomes: ["done", "done"],
      overflowWarnings: 0,
    });
  });
});
