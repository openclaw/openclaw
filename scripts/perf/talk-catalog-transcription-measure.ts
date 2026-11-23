// Synthetic owner measurement; this does not measure WebSocket or production latency.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { OpenClawConfig } from "../../src/config/types.js";
import { createGatewayBenchEnv, summarizeNumbers } from "../lib/gateway-bench-runtime.ts";

const { values } = parseArgs({
  options: {
    baseline: { type: "string" },
    "state-dir": { type: "string" },
    "workspace-fixture": { type: "string" },
    output: { type: "string" },
    allocations: { type: "boolean", default: false },
    profile: { type: "boolean", default: false },
  },
});
assert(
  values.baseline && values["state-dir"] && values["workspace-fixture"] && values.output,
  "Required: --baseline <commit> --state-dir <agent-startup-inspection seed> --workspace-fixture <team-shape fixture> --output <new directory>",
);
const collectGarbage = global.gc;
assert(collectGarbage, "Run with --expose-gc");
const root = fileURLToPath(new URL("../../", import.meta.url));
const stateDir = path.resolve(values["state-dir"]);
const workspaceFixture = path.resolve(values["workspace-fixture"]);
const marker = JSON.parse(
  await readFile(path.join(stateDir, ".agent-startup-inspection.json"), "utf8"),
);
assert(marker.marker === "openclaw-agent-startup-inspection-v1" && marker.seedIncomplete === false);
const workspace = JSON.parse(
  await readFile(path.join(workspaceFixture, "team-shape-summary.json"), "utf8"),
);
assert(workspace.format === "openclaw-team-shape-v1" && workspace.worktreeFiles >= 62000);
const output = path.resolve(values.output);
await mkdir(output);
const frozen = path.join(output, "baseline");
await mkdir(frozen);
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
const baseline = git("rev-parse", "--verify", "--end-of-options", values.baseline).trim();
const files = [
  "src/gateway/talk/handlers/catalog.ts",
  "src/gateway/talk/handlers/provider-catalog.ts",
  "src/gateway/talk/session-config.ts",
  "src/gateway/talk/file-transcription.ts",
];
const destinations = new Map(
  files.map((file) => [path.join(root, file), path.join(frozen, path.basename(file))]),
);
const hashes: Record<string, { base: string; candidate: string }> = {};
for (const file of files) {
  const source = git("show", `${baseline}:${file}`);
  const digest = (text: string) => createHash("sha256").update(text).digest("hex");
  hashes[file] = {
    base: digest(source),
    candidate: digest(await readFile(path.join(root, file), "utf8")),
  };
  // Freeze affected owners; both arms deliberately share unchanged dependencies.
  const rewritten = source.replace(/(?:from |import\()"(\.[^"]+)"/g, (match, specifier: string) => {
    const absolute = path.resolve(root, path.dirname(file), specifier);
    return match.replace(specifier, destinations.get(absolute.replace(/\.js$/, ".ts")) ?? absolute);
  });
  await writeFile(path.join(frozen, path.basename(file)), rewritten);
}
process.env = {
  ...createGatewayBenchEnv(path.join(stateDir, "home"), path.join(stateDir, "openclaw.json"), {
    startupTrace: false,
  }),
  OPENCLAW_STATE_DIR: stateDir,
};
const baseCatalog: typeof import("../../src/gateway/talk/handlers/catalog.js") = await import(
  pathToFileURL(path.join(frozen, "catalog.ts")).href
);
const baseFile: typeof import("../../src/gateway/talk/file-transcription.js") = await import(
  pathToFileURL(path.join(frozen, "file-transcription.ts")).href
);
const currentCatalog = await import("../../src/gateway/talk/handlers/catalog.js");
const currentFile = await import("../../src/gateway/talk/file-transcription.js");
const { withLocalGatewayRequestScope } = await import("../../src/gateway/local-request-context.js");
const { getPluginRuntimeGatewayRequestScope } =
  await import("../../src/plugins/runtime/gateway-request-scope.js");
const { getActiveGatewayRootWorkCount } =
  await import("../../src/process/gateway-work-admission.js");
const { loadPluginMetadataSnapshot } =
  await import("../../src/plugins/plugin-metadata-snapshot.js");
const { resolveRuntimePluginRegistry } = await import("../../src/plugins/loader.js");
const { withPluginRuntimeGenerationScope } =
  await import("../../src/plugins/runtime/generation-scope.js");
const config: OpenClawConfig = {
  agents: {
    ownership: "explicit",
    entries: Object.fromEntries(
      Array.from({ length: 32 }, (_, i) => [
        i === 0 ? "main" : `fixture-${i}`,
        { workspace: path.join(workspaceFixture, "fixture-worktrees/team-shape-project-0") },
      ]),
    ),
  },
  talk: { agentId: "main" },
  models: {
    providers: {
      openai: { baseUrl: "https://unused.invalid/v1", apiKey: "synthetic-key", models: [] },
    },
  },
  plugins: {
    entries: {
      "voice-call": {
        config: {
          streaming: { provider: "openai", providers: { openai: { apiKey: "synthetic-key" } } },
        },
      },
    },
  },
  tools: {
    media: {
      models: [{ provider: "openai", model: "gpt-4o-mini-transcribe", capabilities: ["audio"] }],
    },
  },
};
const metadataSnapshot = loadPluginMetadataSnapshot({ config });
const pluginRegistry = resolveRuntimePluginRegistry({ config, metadataSnapshot, activate: false });
assert(pluginRegistry);
const realNow = Date.now;
let clock = realNow();
Date.now = () => clock;
const inspector = new Session();
inspector.connect();
const sampleAllocation = async () => {
  if (values.allocations) {
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 1024,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
};
const stopAllocation = async () =>
  values.allocations
    ? (await inspector.post("HeapProfiler.stopSampling")).profile.samples.reduce(
        (sum, sample) => sum + sample.size,
        0,
      )
    : undefined;
const rows: Array<{
  group: number;
  arm: "A1" | "A2" | "B";
  hostLoad: number[];
  warm: ReturnType<typeof summarizeNumbers>;
  refresh: ReturnType<typeof summarizeNumbers>;
  refreshHandler: ReturnType<typeof summarizeNumbers>;
  owner: ReturnType<typeof summarizeNumbers>;
  cpuMs: number;
  allocatedBytes: number | undefined;
  ownerCpuMs: number;
  ownerAllocatedBytes: number | undefined;
}> = [];
try {
  await withPluginRuntimeGenerationScope({ pluginRegistry, metadataSnapshot }, async () => {
    for (let group = 0; group < 5; group++) {
      for (const arm of ["A1", "A2", "B"] as const) {
        const handler = (arm === "B" ? currentCatalog : baseCatalog).talkCatalogHandler;
        const resolver = (arm === "B" ? currentFile : baseFile).resolveTalkFileTranscriptionConfig;
        const context = await withLocalGatewayRequestScope(
          { deps: {}, getRuntimeConfig: () => config },
          () => getPluginRuntimeGatewayRequestScope()?.context,
        );
        assert(context);
        const call = async () => {
          let ok = false;
          let json = "";
          const start = performance.now();
          // The real embedded context exercises the unscoped operator-read branch.
          await handler({
            params: {},
            req: { type: "req", id: "fixture", method: "talk.catalog" },
            context,
            client: {
              connId: "fixture",
              connectionSignal: new AbortController().signal,
              connect: {
                minProtocol: 1,
                maxProtocol: 1,
                client: { id: "test", version: "fixture", platform: "test", mode: "test" },
                scopes: ["operator.read"],
              },
            },
            isWebchatConnect: () => false,
            respond: (success, data) => {
              ok = success;
              json = JSON.stringify(data) ?? "";
            },
          });
          return { ms: performance.now() - start, ok, json };
        };
        const settle = async () => {
          const deadline = realNow() + 30000;
          while (getActiveGatewayRootWorkCount()) {
            assert(realNow() < deadline, "catalog refresh did not settle");
            await delay(1);
          }
        };
        for (let warmup = 0; warmup < 4; warmup++) {
          clock += 30001;
          await call();
          await settle();
        }
        const initial = await call();
        assert(initial.ok);
        assert.match(initial.json, /"source":"streaming"/);
        assert.match(initial.json, /"mediaProviders":\[/);
        collectGarbage();
        await sampleAllocation();
        const cpu = process.cpuUsage();
        const warm: number[] = [],
          refresh: number[] = [],
          refreshHandler: number[] = [];
        for (let i = 0; i < 20; i++) {
          for (let j = 0; j < 10; j++) {
            const result = await call();
            assert(result.ok);
            assert.equal(result.json, initial.json);
            warm.push(result.ms);
          }
          clock += 30001;
          const start = performance.now();
          const result = await call();
          assert(result.ok);
          assert.equal(result.json, initial.json);
          refreshHandler.push(result.ms);
          await settle();
          refresh.push(performance.now() - start);
        }
        const used = process.cpuUsage(cpu);
        const allocatedBytes = await stopAllocation();
        collectGarbage();
        await sampleAllocation();
        if (values.profile) {
          await inspector.post("Profiler.enable");
          await inspector.post("Profiler.start");
        }
        const ownerCpu = process.cpuUsage();
        const owner: number[] = [];
        for (let i = 0; i < 1000; i++) {
          const start = performance.now();
          const resolved = await resolver(config, "main");
          owner.push(performance.now() - start);
          assert(resolved?.ready);
        }
        const ownerUsed = process.cpuUsage(ownerCpu);
        if (values.profile) {
          const profile = await inspector.post("Profiler.stop");
          await writeFile(
            path.join(output, `cpu-${group}-${arm}.cpuprofile`),
            JSON.stringify(profile.profile),
          );
        }
        const row = {
          group,
          arm,
          hostLoad: loadavg(),
          warm: summarizeNumbers(warm),
          refresh: summarizeNumbers(refresh),
          refreshHandler: summarizeNumbers(refreshHandler),
          owner: summarizeNumbers(owner),
          cpuMs: (used.user + used.system) / 1000,
          allocatedBytes,
          ownerCpuMs: (ownerUsed.user + ownerUsed.system) / 1000,
          ownerAllocatedBytes: await stopAllocation(),
        };
        rows.push(row);
        console.log(JSON.stringify(row));
      }
    }
  });
  await writeFile(
    path.join(output, "results.json"),
    JSON.stringify(
      {
        baseline,
        head: git("rev-parse", "HEAD").trim(),
        hashes,
        node: process.version,
        platform: process.platform,
        sessionCount: marker.summary.sessionCount,
        databaseBytes: (await stat(path.join(stateDir, "agents/main/agent/openclaw-agent.sqlite")))
          .size,
        workspaceFiles: workspace.worktreeFiles,
        workspaceFileBytes: workspace.worktreeFileBytes,
        allocations: values.allocations,
        rows,
      },
      null,
      2,
    ),
  );
} finally {
  Date.now = realNow;
  inspector.disconnect();
  await rm(frozen, { recursive: true, force: true });
}
process.exit(0);
