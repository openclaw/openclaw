// Run inside an isolated Linux network namespace with a supported Node runtime:
// node scripts/bench-plugin-registration.mts <baseline-entry> <candidate-entry> <plugin-id> <baseline-root> <candidate-root> [runs]
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [baselineEntry, candidateEntry, pluginId, baseline, candidate, runsArg = "5"] =
  process.argv.slice(2);
const runs = Number(runsArg);
assert.ok(
  baselineEntry && candidateEntry && pluginId && baseline && candidate,
  "Expected two host entries, plugin ID, and two plugin roots",
);
assert.ok(Number.isInteger(runs) && runs >= 5, "Use at least five interleaved samples per package");
assert.equal(
  process.platform,
  "linux",
  "Process CPU and RSS measurement requires Linux /usr/bin/time",
);

type Sample = {
  arm: string;
  sample: number;
  elapsedMs: number;
  loadMs: number;
  registerMs: number;
  cpuSeconds: number;
  maxRssKiB: number;
  hostLoad: number[];
  discovery: InspectedPlugin[];
};
type InspectedPlugin = {
  id: string;
  status: string;
  rootDir: string;
  source: string;
  origin: string;
};
const samples: Sample[] = [];
const arms = [
  { arm: "baseline", entry: baselineEntry, pluginRoot: baseline },
  { arm: "candidate", entry: candidateEntry, pluginRoot: candidate },
];
for (let sample = 1; sample <= runs; sample++) {
  for (const { arm, entry, pluginRoot } of arms) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-registration-"));
    try {
      for (const name of ["home", "state", "tmp", "workspace"]) {
        fs.mkdirSync(path.join(root, name));
      }
      const config = path.join(root, "state", "openclaw.json");
      fs.writeFileSync(
        config,
        JSON.stringify({
          plugins: {
            allow: [pluginId],
            load: { paths: [path.resolve(pluginRoot)] },
            entries: { [pluginId]: { enabled: true } },
            slots: { memory: "none" },
          },
          agents: { defaults: { workspace: path.join(root, "workspace") } },
        }),
        { mode: 0o600 },
      );
      const hostLoad = os.loadavg();
      const start = performance.now();
      const usagePath = path.join(root, "usage.json");
      const result = spawnSync(
        "/usr/bin/timeout",
        [
          "--kill-after=3",
          "120",
          "/usr/bin/time",
          "-f",
          '{"user":%U,"system":%S,"rss":%M}',
          "-o",
          usagePath,
          process.execPath,
          path.resolve(entry),
          "plugins",
          "inspect",
          "--all",
          "--runtime",
          "--json",
        ],
        {
          cwd: path.join(root, "workspace"),
          env: {
            PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
            HOME: path.join(root, "home"),
            XDG_CONFIG_HOME: path.join(root, "home", ".config"),
            OPENCLAW_HOME: path.join(root, "home"),
            OPENCLAW_STATE_DIR: path.join(root, "state"),
            OPENCLAW_CONFIG_PATH: config,
            TMPDIR: path.join(root, "tmp"),
            OPENCLAW_DIAGNOSTICS: "plugin.load-profile",
            NODE_DISABLE_COMPILE_CACHE: "1",
            NO_COLOR: "1",
          },
          encoding: "utf8",
          timeout: 130_000,
          maxBuffer: 20 * 1024 * 1024,
        },
      );
      assert.equal(result.status, 0, result.stderr || result.error?.message || "CLI failed");
      const inventory = JSON.parse(result.stdout) as Array<{ plugin: InspectedPlugin }>;
      const matches: InspectedPlugin[] = inventory
        .map((row) => row.plugin)
        .filter((row) => row.id === pluginId);
      const [plugin, ...duplicates] = matches.filter((row) => row.status === "loaded");
      assert.ok(plugin, "Plugin was not discovered or did not load");
      assert.equal(duplicates.length, 0, "Expected exactly one loaded plugin with the selected ID");
      assert.equal(
        fs.realpathSync(plugin.rootDir),
        fs.realpathSync(pluginRoot),
        "Loaded plugin must come from the requested external package root",
      );
      const discovery = matches.map(({ id, status, rootDir, source, origin }) => ({
        id,
        status,
        rootDir,
        source,
        origin,
      }));
      const phases = [...result.stderr.matchAll(/phase=(\S+) plugin=(\S+) elapsedMs=([\d.]+)/gu)];
      const elapsed = (phase: string) => {
        const found = phases.find((row) => row[1] === phase && row[2] === pluginId);
        assert.ok(found, `Missing ${phase} profile`);
        return Number(found[3]);
      };
      const usage = JSON.parse(fs.readFileSync(usagePath, "utf8")) as {
        user: number;
        system: number;
        rss: number;
      };
      const row = {
        arm,
        sample,
        elapsedMs: performance.now() - start,
        loadMs: elapsed("tool-discovery"),
        registerMs: elapsed("tool-discovery:register"),
        cpuSeconds: usage.user + usage.system,
        maxRssKiB: usage.rss,
        hostLoad,
        discovery,
      };
      samples.push(row);
      console.log(JSON.stringify(row));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
}
for (const arm of ["baseline", "candidate"]) {
  const rows = samples.filter((row) => row.arm === arm);
  const summary = Object.fromEntries(
    (["elapsedMs", "loadMs", "registerMs", "cpuSeconds", "maxRssKiB"] as const).map((metric) => {
      const values = rows.map((row) => row[metric]).toSorted((a, b) => a - b);
      return [
        metric,
        {
          median: values[Math.floor(values.length / 2)],
          p95: values[Math.ceil(values.length * 0.95) - 1],
          min: values[0],
          max: values.at(-1),
        },
      ];
    }),
  );
  console.log(JSON.stringify({ arm, summary }));
}
