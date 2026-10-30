// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/plugin-source-demand.mts
// Fresh captured generations, serial samples; first sample is cold, later samples are warm.
import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    samples: { type: "string", default: "6" },
    unused: { type: "string", default: "500" },
    demands: { type: "string", default: "20" },
  },
});
const samples = Number(values.samples);
const unused = Number(values.unused);
const demands = Number(values.demands);
assert(Number.isSafeInteger(samples) && samples > 0);
assert(Number.isSafeInteger(unused) && unused >= 0);
assert(Number.isSafeInteger(demands) && demands >= 0);
const scratch = path.resolve(".openclaw/tmp");
fs.mkdirSync(scratch, { recursive: true });
const root = fs.mkdtempSync(path.join(scratch, "source-demand-"));
for (const name of ["home", "state", "workspace", "empty-bundled", "plugin"]) {
  fs.mkdirSync(path.join(root, name));
}
process.env.HOME = path.join(root, "home");
process.env.OPENCLAW_STATE_DIR = path.join(root, "state");
process.env.OPENCLAW_CONFIG_PATH = path.join(root, "no-config.json");
process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";
process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = path.join(root, "empty-bundled");
const pluginRoot = path.join(root, "plugin");
fs.writeFileSync(
  path.join(pluginRoot, "package.json"),
  JSON.stringify({
    name: "source-demand",
    version: "1.0.0",
    openclaw: { extensions: ["./index.ts"] },
  }),
);
fs.writeFileSync(
  path.join(pluginRoot, "openclaw.plugin.json"),
  JSON.stringify({ id: "source-demand", configSchema: { type: "object", properties: {} } }),
);
fs.writeFileSync(
  path.join(pluginRoot, "index.ts"),
  "export default { id: 'source-demand', register() {} };",
);
for (let index = 0; index < unused; index++) {
  fs.writeFileSync(path.join(pluginRoot, "unused-" + index + ".ts"), "export const unused = 1;");
}
// A second real instance exercises deferred compilation and immutable package metadata demands.
const deferredRoot = path.join(root, "deferred");
fs.mkdirSync(deferredRoot);
fs.writeFileSync(
  path.join(deferredRoot, "package.json"),
  '{"optionalDependencies":{"missing-fixture":"1"}}',
);
fs.writeFileSync(
  path.join(deferredRoot, "entry.ts"),
  "export const read = async name => (await import(name)).value;",
);
for (let index = 0; index < demands; index++) {
  fs.writeFileSync(
    path.join(deferredRoot, "demand-" + index + ".ts"),
    "export const value = " + index + ";",
  );
}
const { loadOpenClawPluginsAsync } = await import("../../src/plugins/loader-runtime-load.js");
const { disposePluginRegistryInstances } = await import("../../src/plugins/runtime.js");
const { createPluginCache, retirePluginCache, withPluginCache } =
  await import("../../src/plugins/plugin-cache.js");
const { bindPluginInstanceModuleLoader } =
  await import("../../src/plugins/plugin-instance-module-loader.js");
const { PluginInstance } = await import("../../src/plugins/plugin-instance.js");
const logger = {
  debug() {},
  info() {},
  warn() {},
  error(...args: unknown[]) {
    console.error(...args);
  },
};
const config = {
  plugins: {
    allow: ["source-demand"],
    load: { paths: [path.join(pluginRoot, "index.ts")] },
    slots: { memory: "none" },
  },
};
const rows = [];
const originalWrite = fs.writeFileSync;
const originalRead = fs.readFileSync;
// oxlint-disable-next-line typescript/unbound-method -- use the intercepted module receiver below.
const originalRequire = Module.prototype.require;
let counts = { placeholders: 0, generatedWrites: 0, manifestReads: 0, esbuildAcquisitions: 0 };
fs.writeFileSync = new Proxy(originalWrite, {
  apply(target, receiver, args) {
    const [filename, data] = args;
    if (String(filename).includes(path.sep + ".source-")) {
      counts.generatedWrites++;
      if (data === "") {
        counts.placeholders++;
      }
    }
    return Reflect.apply(target, receiver, args);
  },
});
fs.readFileSync = new Proxy(originalRead, {
  apply(target, receiver, args) {
    const filename = String(args[0]);
    if (
      filename.endsWith(path.sep + "package.json") &&
      filename.includes(path.sep + "captures" + path.sep)
    ) {
      counts.manifestReads++;
    }
    return Reflect.apply(target, receiver, args);
  },
});
Module.prototype.require = function (id: string) {
  if (id === "esbuild") {
    counts.esbuildAcquisitions++;
  }
  return originalRequire.call(this, id);
};
try {
  for (let index = 0; index < samples; index++) {
    await nextTurn();
    global.gc?.();
    counts = { placeholders: 0, generatedWrites: 0, manifestReads: 0, esbuildAcquisitions: 0 };
    const cache = createPluginCache();
    const cpu = process.cpuUsage();
    const start = performance.now();
    const registry = await withPluginCache(cache, () =>
      loadOpenClawPluginsAsync({
        config,
        workspaceDir: path.join(root, "workspace"),
        activate: false,
        cache: false,
        onlyPluginIds: ["source-demand"],
        throwOnLoadError: true,
        logger,
      }),
    );
    assert.equal(
      registry.plugins.find((plugin) => plugin.id === "source-demand")?.status,
      "loaded",
    );
    const loadMs = performance.now() - start;
    const loadCounts = { ...counts };
    const instance = new PluginInstance("source-demand-deferred");
    try {
      const source = path.join(deferredRoot, "entry.ts");
      withPluginCache(cache, () =>
        bindPluginInstanceModuleLoader({
          instance,
          origin: "config",
          source,
          rootDir: deferredRoot,
        }),
      );
      const plugin = instance.loadModule(source) as { read(name: string): Promise<number> };
      for (let demand = 0; demand < demands; demand++) {
        assert.equal(await plugin.read("./demand-" + demand + ".ts"), demand);
      }
      const used = process.cpuUsage(cpu);
      rows.push({
        index,
        cold: index === 0,
        loadMs,
        totalMs: performance.now() - start,
        cpuMs: (used.user + used.system) / 1000,
        rss: process.memoryUsage().rss,
        loadCounts,
        counts: { ...counts },
      });
    } finally {
      await instance.dispose();
      const disposed = await disposePluginRegistryInstances(registry);
      assert.equal(disposed.failures.length, 0);
      const retired = await retirePluginCache(cache, undefined, { waitForSettlement: true });
      assert.equal(retired.failures.length, 0);
    }
  }
  console.log(
    JSON.stringify(
      { node: process.version, loadAverage: os.loadavg(), unused, demands, samples: rows },
      null,
      2,
    ),
  );
} finally {
  fs.writeFileSync = originalWrite;
  fs.readFileSync = originalRead;
  Module.prototype.require = originalRequire;
  fs.rmSync(root, { recursive: true, force: true });
}
