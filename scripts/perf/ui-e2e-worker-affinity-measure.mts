// Measure worker preparation implied by the real UI E2E shard selection.
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const revision = process.argv[2];
assert(
  revision,
  "usage: node --import tsx scripts/perf/ui-e2e-worker-affinity-measure.mts REV [--plan-only]",
);
Object.assign(process.env, { CI: "true", OPENCLAW_VITEST_WORKER_CACHE: "0" });
if (process.argv.includes("--prepare-worker")) {
  const { createVitestWorkerRun } = await import("../lib/vitest-worker-run.mts");
  const workers = createVitestWorkerRun(process.env, undefined, "runtime");
  try {
    const manifest = await workers.prepare();
    console.log(
      "WORKER " +
        JSON.stringify({
          inputs: Object.keys(manifest.inputs).length,
          outputs: Object.keys(manifest.outputs).length,
          inputDigest: createHash("sha256")
            .update(
              JSON.stringify(
                Object.entries(manifest.inputs).toSorted(([left], [right]) =>
                  left.localeCompare(right),
                ),
              ),
            )
            .digest("hex"),
        }),
    );
  } finally {
    await workers.dispose();
  }
  process.exit(0);
}
const borrowers = new Set(
  [
    "guest-person-identities",
    "model-providers-profile-outcomes",
    "plugin-panel-icons",
    "post-deploy-session-entry",
    "question-guest",
    "route-asset-requests",
    "screen-requester-routing",
    "team-scale-cold-load",
  ].map((name) => `ui/src/e2e/${name}.e2e.test.ts`),
);
const owner = "test/vitest/vitest.ui-e2e.sequencer.ts";
const source = spawnSync("git", ["show", `${revision}:${owner}`], { encoding: "utf8" });
assert.equal(source.status, 0, source.stderr);
const temporaryModule = path.join(root, "test/vitest", `.worker-affinity-${randomUUID()}.ts`);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ui-worker-affinity-"));
Object.assign(process.env, {
  CI: "true",
  OPENCLAW_UI_E2E_SKIP_REAL_GATEWAY: "1",
  OPENCLAW_UI_E2E_SKIP_PRODUCTION_ARTIFACT: "1",
  OPENCLAW_VITEST_MAX_WORKERS: "4",
});
try {
  fs.writeFileSync(
    temporaryModule,
    source.stdout + "\nexport { estimateFileSeconds, effectiveProjectWorkers };\n",
  );
  const { UiE2eSequencer, estimateFileSeconds, effectiveProjectWorkers } = await import(
    pathToFileURL(temporaryModule).href
  );
  const { createVitest } = await import("vitest/node");
  const vitest = await createVitest("test", {
    config: "test/vitest/vitest.ui-e2e.config.ts",
    configLoader: "runner",
    watch: false,
    maxWorkers: 4,
  });
  const groups: string[][] = [];
  const inventory: string[] = [];
  const selected: string[] = [];
  const shardLoads: Array<{ index: number; files: number; estimatedSeconds: number }> = [];
  try {
    const specifications = await vitest.globTestSpecifications();
    const sequencer = new UiE2eSequencer(vitest);
    const identity = (spec: (typeof specifications)[number]) =>
      `${spec.project.name}:${path.relative(root, spec.moduleId).replaceAll("\\", "/")}`;
    inventory.push(...specifications.map(identity));
    for (let index = 1; index <= 9; index++) {
      vitest.config.shard = { index, count: 9 };
      const shard = await sequencer.shard(specifications);
      selected.push(...shard.map(identity));
      shardLoads.push({
        index,
        files: shard.length,
        estimatedSeconds: shard.reduce(
          (sum: number, spec: (typeof specifications)[number]) =>
            sum + estimateFileSeconds(spec.moduleId) / effectiveProjectWorkers(spec),
          0,
        ),
      });
      const group = shard
        .map((spec: (typeof specifications)[number]) =>
          path.relative(root, spec.moduleId).replaceAll("\\", "/"),
        )
        .filter((file: string) => borrowers.has(file));
      if (group.length) {
        groups.push(group);
      }
    }
  } finally {
    await vitest.close();
  }
  assert.deepEqual(selected.toSorted(), inventory.toSorted());
  assert.deepEqual(groups.flat().toSorted(), [...borrowers].toSorted());
  const digest = createHash("sha256").update(JSON.stringify(inventory.toSorted())).digest("hex");
  console.log(
    JSON.stringify({ revision, inventory: inventory.length, digest, groups, shardLoads }),
  );
  if (!process.argv.includes("--plan-only")) {
    const results = [];
    for (const [index] of groups.entries()) {
      const cache = path.join(scratch, String(index));
      fs.mkdirSync(cache);
      const metrics = path.join(cache, "time.txt");
      const started = performance.now();
      const result: SpawnSyncReturns<string> = spawnSync(
        "/usr/bin/time",
        [
          "-f",
          "%U %S %M",
          "-o",
          metrics,
          process.execPath,
          "--import",
          "tsx",
          process.argv[1]!,
          revision,
          "--prepare-worker",
        ],
        {
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
          env: {
            ...process.env,
            NODE_COMPILE_CACHE: path.join(cache, "node"),
          },
        },
      );
      const elapsedMs = performance.now() - started;
      const output = result.stdout + result.stderr;
      assert.equal(result.status, 0, output.slice(-12_000));
      const worker = output.split("\n").find((line) => line.startsWith("WORKER "));
      assert(worker, "native worker preparation did not return its manifest");
      const [user, system, maxProcessRssKiB] = fs
        .readFileSync(metrics, "utf8")
        .trim()
        .split(/\s+/u)
        .map(Number);
      const preparations = [...output.matchAll(/\[vitest-workers\] prepared /gu)].length;
      assert.equal(preparations, 1);
      results.push({
        elapsedMs,
        cpuSeconds: user! + system!,
        maxProcessRssKiB,
        preparations,
        manifest: JSON.parse(worker.slice("WORKER ".length)),
      });
    }
    console.log(JSON.stringify({ revision, results }));
  }
} finally {
  fs.rmSync(temporaryModule, { force: true });
  fs.rmSync(scratch, { recursive: true, force: true });
}
