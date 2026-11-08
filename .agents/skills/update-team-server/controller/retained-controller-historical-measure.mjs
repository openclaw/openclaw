// Opt-in synthetic owner measurement; never reads a deployment host or real data.
// Run on disposable Linux: node --import ./test-environment.mjs ./retained-controller-historical-measure.mjs before|after historical|same-incident OUTPUT [--scale]
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { adoptionRequest, historicalShellFixture, prepare, preserved } from "./retained-controller-historical-shell-test-support.mjs";
import { invoke } from "./retained-repair-lifecycle-test-support.mjs";

const [mode, scenario, output, scale] = process.argv.slice(2);
assert(["before", "after"].includes(mode) && ["historical", "same-incident"].includes(scenario) && output && [undefined, "--scale"].includes(scale));
const historical = scenario === "historical", refuses = historical && mode === "before";
const directory = resolve(output), results = [];
mkdirSync(directory, { recursive: true });
const shapeRoot = mkdtempSync(join(tmpdir(), "historical-adoption-shape-"));
const shape = join(shapeRoot, "shape.db"), workspace = join(shapeRoot, "workspace-shape");
try {
for (let sample = 1; sample <= 5; sample++) {
  const cleanup = [], f = historicalShellFixture({ after: fn => cleanup.push(fn), diagnostic: console.log }, { historical });
  try {
  if (scale && !existsSync(shape)) {
    assert.equal(Number(statfsSync(f.root).type), 0x9123683e, "scale fixture requires btrfs");
    const db = new DatabaseSync(f.agentDatabasePath);
    db.exec("BEGIN");
    const node = db.prepare("INSERT INTO session_nodes VALUES (?,?,?,?,NULL)"), window = db.prepare("INSERT INTO session_windows VALUES (?,?)"), watermark = db.prepare("INSERT INTO transcript_rewrite_watermarks VALUES (?,?)");
    for (let i = 0; i < 5999; i++) {
      const session = "synthetic-session-" + i, key = "agent:controller-test-agent:" + i;
      node.run(key, session, JSON.stringify({ sessionId: session, updatedAt: 2 }), 2); window.run(session, key); watermark.run(session, "generation-" + i);
    }
    db.exec("COMMIT; CREATE TABLE synthetic_padding (payload BLOB)");
    const pad = db.prepare("INSERT INTO synthetic_padding VALUES (zeroblob(?))");
    for (let i = 0; i < 560; i++) pad.run(64 * 1024 * 1024);
    db.close();
    const bytes = Buffer.alloc(17742, 120);
    mkdirSync(workspace);
    for (let i = 0; i < 62000; i++) writeFileSync(join(workspace, "synthetic-" + i), bytes);
    writeFileSync(join(directory, "shape.json"), JSON.stringify({ agentDbBytes: statSync(f.agentDatabasePath).size,
      agentDbAllocatedBytes: statSync(f.agentDatabasePath).blocks * 512, sessions: 6000, workspaceFiles: 62000,
      workspaceBytes: bytes.length * 62000, filesystem: "btrfs" }, null, 2));
    copyFileSync(f.agentDatabasePath, shape, constants.COPYFILE_FICLONE_FORCE);
  } else if (scale) copyFileSync(shape, f.agentDatabasePath, constants.COPYFILE_FICLONE_FORCE);
  const preload = join(f.root, "measurement.mjs");
  writeFileSync(preload, `import inspector from "node:inspector"; import fs from "node:fs";
const session = new inspector.Session(); session.connect();
session.post("HeapProfiler.startSampling", { samplingInterval: 65536, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
process.once("exit", () => session.post("HeapProfiler.stopSampling", (error, result) => {
  if (error) throw error;
  fs.writeFileSync(process.env.CONTROLLER_MEASURE_SAMPLE + "/" + process.pid + ".json", JSON.stringify({
    ...process.resourceUsage(), sampledAllocatedBytes: result.profile.samples.reduce((sum, sample) => sum + sample.size, 0)
  })); session.disconnect();
}));\n`);
  f.env.NODE_OPTIONS = "--import " + preload;
  function measure(owner, sample, run) {
    const path = join(directory, owner + "-" + sample); mkdirSync(path);
    f.env.CONTROLLER_MEASURE_SAMPLE = path;
    const started = performance.now(), result = run(), wallMs = performance.now() - started;
    const processes = readdirSync(path).map(name => JSON.parse(readFileSync(join(path, name))));
    results.push({ owner, sample, wallMs, nodeProcesses: processes.length,
      userCpuMs: processes.reduce((sum, p) => sum + p.userCPUTime / 1000, 0),
      systemCpuMs: processes.reduce((sum, p) => sum + p.systemCPUTime / 1000, 0),
      sampledAllocatedBytes: processes.reduce((sum, p) => sum + p.sampledAllocatedBytes, 0),
      peakChildRssKiB: Math.max(...processes.map(p => p.maxRSS)) });
    return result;
  }
    const before = preserved(f), request = adoptionRequest(f, historical && mode === "after" ? f.historical : undefined);
    f.library = request.replacement[1].path;
    measure("adoption", sample, () => {
      const result = invoke(f, "retained-controller-adoption", historical && mode === "after" ? "historical-successor" : "prepare", request);
      if (refuses) { assert.notEqual(result.status, 0); assert.match(result.stderr, /completion does not match/); return; }
      assert.equal(result.status, 0, result.stderr);
      const applied = invoke(f, "retained-controller-adoption", "apply", JSON.parse(result.stdout));
      assert.equal(applied.status, 0, applied.stderr); return JSON.parse(applied.stdout);
    });
    f.library = f.env.OPENCLAW_TEAM_RELEASE_LIB;
    const prepared = measure("prepare", sample, () => prepare(f, randomUUID()));
    if (refuses) { assert.notEqual(prepared.status, 0); assert.match(prepared.stderr, /completion does not match/); }
    else { assert.equal(prepared.status, 0, prepared.stderr); assert.match(prepared.stdout, /PREPARED .*restart=0 activation=0 original-journal=retained/); }
    assert.deepEqual(preserved(f), before);
    console.log(JSON.stringify(results.slice(-2)));
  } finally { for (const fn of cleanup.reverse()) fn(); }
}
  writeFileSync(join(directory, "metrics.json"), JSON.stringify({ mode, scenario, allocationSamplingInterval: 65536, includesCollectedObjects: true, results }, null, 2));
} finally { rmSync(shapeRoot, { recursive: true, force: true }); }
