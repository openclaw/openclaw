/**
 * Focused owner costs for draft titles and workspace file listings (Node 26).
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/sessions-files-title-measure.ts
 *   --mode title --instrument timing --requests 2000 --output .local/title-candidate
 * Add --revision <base-sha> to load the baseline owner in the same dependency graph.
 * Run timing and allocation separately in AB/BA order; counts is a separate phase census.
 * Title inference alone is stubbed; skill discovery and model selection remain real.
 * The fixture has 40 plugins, 40 workspace skills, and 1,000 touched workspace files.
 * This is an owner microbenchmark, not a transport/65-client Gateway stress test.
 * Accept identical results with fewer skill preparations and lower CPU/allocation;
 * file metadata must stay fresh. Counts-phase timings are inclusive and diagnostic only.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { transformSync } from "esbuild";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import {
  BASE_GATEWAY_BENCH_CONFIG,
  createGatewayBenchEnv,
  writePluginFixtures,
} from "../lib/gateway-bench-runtime.ts";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    revision: { type: "string" },
    mode: { type: "string", default: "title" },
    instrument: { type: "string", default: "timing" },
    requests: { type: "string", default: "2000" },
    files: { type: "string", default: "1000" },
  },
});
assert(values.output && ["title", "files"].includes(values.mode));
assert(["timing", "allocation", "counts"].includes(values.instrument));
const requests = Number(values.requests),
  fileCount = Number(values.files);
assert(Number.isSafeInteger(requests) && requests > 0);
assert(Number.isSafeInteger(fileCount) && fileCount > 0);
const output = path.resolve(values.output);
fs.mkdirSync(output, { recursive: false });
const root = fileURLToPath(new URL("../../", import.meta.url));
const workspace = path.join(output, "workspace");
for (const directory of [workspace, path.join(output, "home"), path.join(output, "tmp")]) {
  fs.mkdirSync(directory);
}
process.env = createGatewayBenchEnv(path.join(output, "home"), path.join(output, "openclaw.json"), {
  startupTrace: false,
  caseEnv: {
    TMPDIR: path.join(output, "tmp"),
    OPENCLAW_SKIP_CHANNELS: "1",
    DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer",
  },
});
const plugins = writePluginFixtures(output, { count: 40 });
const cfg: OpenClawConfig = {
  ...BASE_GATEWAY_BENCH_CONFIG,
  agents: {
    defaults: { model: "fixture/model", utilityModel: "fixture/utility" },
    entries: { main: { workspace } },
  },
  skills: { allowBundled: [] },
  plugins: { enabled: true, allow: plugins.pluginIds, load: { paths: [plugins.pluginsDir] } },
};
fs.writeFileSync(path.join(output, "openclaw.json"), JSON.stringify(cfg));
for (let i = 0; i < 40; i++) {
  const directory = path.join(workspace, "skills", `fixture-${i}`);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "SKILL.md"),
    `---\nname: fixture-${i}\ndescription: Synthetic fixture ${i}\n---\nPerform synthetic task ${i}.\n`,
  );
}
const files = Array.from({ length: fileCount }, (_, i) => ({
  path: `file-${i}.txt`,
  kind: "modified" as const,
}));
for (const file of files) {
  fs.writeFileSync(path.join(workspace, file.path), "synthetic fixture\n");
}
// Git discovery only needs a recognizable metadata directory; no repository mutation is measured.
fs.mkdirSync(path.join(workspace, ".git"));
fs.writeFileSync(path.join(workspace, ".git", "HEAD"), "ref: refs/heads/main\n");
const fixtureTime = new Date("2026-01-01T00:00:00Z");
for (const relative of [
  ...files.map((file) => file.path),
  ".git",
  ".git/HEAD",
  "skills",
  ...Array.from({ length: 40 }, (_, i) => [
    `skills/fixture-${i}`,
    `skills/fixture-${i}/SKILL.md`,
  ]).flat(),
]) {
  fs.utimesSync(path.join(workspace, relative), fixtureTime, fixtureTime);
}
const owners = [
  "src/gateway/dashboard-session-title.ts",
  "src/gateway/server-methods/workspace-files.ts",
];
const sources = new Map(
  owners.map((file) => [
    file,
    values.revision
      ? execFileSync("git", ["show", `${values.revision}:${file}`], {
          cwd: root,
          encoding: "utf8",
          env: process.env,
        })
      : fs.readFileSync(path.join(root, file), "utf8"),
  ]),
);
type Phase = { calls: number; wallMs: number; cpuUs: number; resultItems?: number };
const phases: Record<string, Phase> = {};
let measuring = false;
Object.assign(globalThis, {
  __fileTitleCount: (name: string) => {
    if (measuring) {
      const phase = (phases[name] ??= { calls: 0, wallMs: 0, cpuUs: 0 });
      phase.calls++;
    }
  },
  __fileTitleMeasure: async (name: string, run: () => Promise<unknown>) => {
    if (!measuring) {
      return await run();
    }
    const start = performance.now(),
      cpu = process.threadCpuUsage();
    const phase = (phases[name] ??= { calls: 0, wallMs: 0, cpuUs: 0 });
    try {
      const result = await run();
      if (Array.isArray(result)) {
        phase.resultItems = result.length;
      }
      return result;
    } finally {
      const used = process.threadCpuUsage(cpu);
      phase.calls++;
      phase.wallMs += performance.now() - start;
      phase.cpuUs += used.user + used.system;
    }
  },
});
const measuredExports: Record<string, string[]> = {
  "src/skills/discovery/chat-commands.ts": ["prepareSkillCommandsForWorkspace"],
  "src/gateway/server-methods/workspace-fs.ts": [
    "openWorkspaceRoot",
    "statWorkspacePath",
    "listWorkspacePath",
  ],
};
registerHooks({
  load(url, context, nextLoad) {
    const relative = url.startsWith("file:") ? path.relative(root, fileURLToPath(url)) : "";
    if (relative === "src/auto-reply/reply/conversation-label-generator.ts") {
      return {
        format: "module",
        source:
          'export async function generateConversationLabelWithFallback() { return "Synthetic task title"; }',
        shortCircuit: true,
      };
    }
    let source = sources.get(relative);
    if (values.instrument === "counts") {
      if (relative === "src/agents/workspace-git.ts") {
        source = fs.readFileSync(path.join(root, relative), "utf8");
        const anchor = "export function insideGitCheckout(start: string): boolean {";
        assert(source.includes(anchor));
        source = source.replace(
          anchor,
          anchor + '\n globalThis.__fileTitleCount("insideGitCheckout");',
        );
      }
      for (const name of measuredExports[relative] ?? []) {
        source ??= fs.readFileSync(path.join(root, relative), "utf8");
        const anchor = `export async function ${name}(`;
        assert(source.includes(anchor), `Missing measurement anchor ${name}`);
        source = source.replace(anchor, `async function unmeasured_${name}(`);
        source += `\nexport async function ${name}(...args) { return globalThis.__fileTitleMeasure(${JSON.stringify(name)}, () => unmeasured_${name}(...args)); }\n`;
      }
    }
    return source === undefined
      ? nextLoad(url, context)
      : {
          format: "module",
          source: transformSync(source, { loader: "ts", format: "esm", target: "esnext" }).code,
          shortCircuit: true,
        };
  },
});
const { setRuntimeConfigSnapshot } = await import("../../src/config/runtime-snapshot.js");
setRuntimeConfigSnapshot(cfg);
const { prepareDashboardSessionTitle } =
  await import("../../src/gateway/dashboard-session-title.js");
const { listSessionWorkspaceFiles } =
  await import("../../src/gateway/server-methods/workspace-files.js");
const { getWorkerMessageMetrics } = await import("../../src/infra/worker-message-metrics.js");
const run =
  values.mode === "title"
    ? () =>
        prepareDashboardSessionTitle({
          cfg,
          agentId: "main",
          userMessage: "Investigate workspace files and prepare a concise implementation summary",
        })
    : () =>
        listSessionWorkspaceFiles({
          root: workspace,
          fileRoot: workspace,
          diffCwd: workspace,
          files,
        });
const first = await run();
if (values.mode === "title") {
  assert.equal(
    first,
    "Synthetic task title",
    "Real skill preparation/model selection must reach inference",
  );
}
const expected = JSON.stringify(first);
for (let i = 0; i < 20; i++) {
  assert.equal(JSON.stringify(await run()), expected);
}
globalThis.gc?.();
const inspector = values.instrument === "allocation" ? new Session() : undefined;
if (inspector) {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 4096,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const workerBefore = new Map(
  getWorkerMessageMetrics().map((metric) => [
    `${metric.kind}/${metric.direction}`,
    metric.messages,
  ]),
);
const hostLoad = loadavg(),
  cpuStart = process.threadCpuUsage(),
  start = performance.now();
measuring = true;
for (let i = 0; i < requests; i++) {
  const result = await run();
  if (values.mode === "title") {
    assert.equal(result, first);
  }
}
measuring = false;
const elapsedMs = performance.now() - start,
  cpu = process.threadCpuUsage(cpuStart);
const profile = await inspector?.post("HeapProfiler.stopSampling");
inspector?.disconnect();
const allocated = (node: HeapProfiler.SamplingHeapProfileNode): number =>
  node.selfSize + node.children.reduce((sum, child) => sum + allocated(child), 0);
const sampledBytes = profile ? allocated(profile.profile.head) : undefined;
if (values.mode === "files") {
  fs.writeFileSync(
    path.join(workspace, "file-0.txt"),
    "a later synthetic file revision with a different byte length\n",
  );
  const fresh = await listSessionWorkspaceFiles({
    root: workspace,
    fileRoot: workspace,
    diffCwd: workspace,
    files,
  });
  assert.equal(
    fresh.files.find((file) => file.path === "file-0.txt")?.size,
    fs.statSync(path.join(workspace, "file-0.txt")).size,
  );
}
const report = {
  mode: values.mode,
  instrument: values.instrument,
  revision: values.revision ?? "candidate",
  requests,
  fixture: { skills: 40, plugins: 40, touchedFiles: fileCount },
  hostLoad,
  hostLoadAfter: loadavg(),
  elapsedMs,
  cpuUsPerRequest: (cpu.user + cpu.system) / requests,
  sampledBytesPerRequest: sampledBytes === undefined ? null : sampledBytes / requests,
  memory: process.memoryUsage(),
  phases,
  workerMessages: getWorkerMessageMetrics().map((metric) => ({
    kind: metric.kind,
    direction: metric.direction,
    messages: metric.messages - (workerBefore.get(`${metric.kind}/${metric.direction}`) ?? 0),
  })),
  sourceHashes: Object.fromEntries(
    [...sources].map(([file, source]) => [file, createHash("sha256").update(source).digest("hex")]),
  ),
  resultHash: createHash("sha256").update(expected.replaceAll(output, "<fixture>")).digest("hex"),
};
fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
