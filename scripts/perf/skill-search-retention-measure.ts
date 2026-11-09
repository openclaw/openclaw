/**
 * Native-GC owner probe for retained skill catalogs. Complements, rather than
 * replaces, the dist-Gateway campaign. Run with --expose-gc --import scripts/tsx.mjs.
 * Compare pinned --root trees with identical options; snapshots remain local.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import inspector from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { getHeapSpaceStatistics, writeHeapSnapshot } from "node:v8";
import type { InstalledSkill } from "../../src/agents/installed-skill-catalog.js";
import { createSyntheticSourceInfo, type Skill } from "../../src/skills/loading/skill-contract.js";

const { values } = parseArgs({
  options: {
    root: { type: "string", default: process.cwd() },
    output: { type: "string" },
    catalogs: { type: "string", default: "20" },
    skills: { type: "string", default: "512" },
    variants: { type: "string", default: "20" },
    rounds: { type: "string", default: "2" },
    snapshots: { type: "boolean", default: false },
    allocations: { type: "boolean", default: false },
  },
});
assert(global.gc, "--expose-gc is required");
assert(values.output, "--output is required");
const output = path.resolve(values.output);
mkdirSync(output, { recursive: true });
const catalogs = Number(values.catalogs);
const skills = Number(values.skills);
const variants = Number(values.variants);
const rounds = Number(values.rounds);
assert([catalogs, skills, variants, rounds].every((v) => Number.isSafeInteger(v) && v > 0));
assert(variants <= skills);
const root = path.resolve(values.root);
const catalogOwner: typeof import("../../src/agents/installed-skill-catalog.js") = await import(
  pathToFileURL(path.join(root, "src/agents/installed-skill-catalog.ts")).href
);
const runtime: typeof import("../../src/agents/installed-skill-runtime.js") = await import(
  pathToFileURL(path.join(root, "src/agents/installed-skill-runtime.ts")).href
);
const bodies = readdirSync(path.join(root, "skills"), { withFileTypes: true }).flatMap((entry) => {
  if (!entry.isDirectory()) {
    return [];
  }
  try {
    return [readFileSync(path.join(root, "skills", entry.name, "SKILL.md"), "utf8")];
  } catch {
    return [];
  }
});
assert(bodies.length);
const publications: Skill[] = Array.from({ length: skills }, (_, index) => {
  const template = bodies[index % bodies.length]!;
  const readContent = (
    `# Synthetic guide ${index}\n` + template.repeat(Math.ceil(16384 / template.length))
  ).slice(0, 16384);
  return {
    name: `guide-${index}`,
    description: `Guide ${index} for file search, messages and scheduled tasks. ${template.replace(/[^a-zA-Z ]/g, " ").slice(0, 450)}`,
    filePath: `node://synthetic/guide-${index}/SKILL.md`,
    baseDir: `node://synthetic/guide-${index}`,
    source: "synthetic",
    sourceInfo: createSyntheticSourceInfo(`node://synthetic/guide-${index}/SKILL.md`, {
      source: "synthetic",
    }),
    readContent,
    contentHash: createHash("sha256").update(readContent).digest("hex"),
    disableModelInvocation: false,
  };
});
let held: InstalledSkill[][] = [];
const digest = createHash("sha256");
const timings: number[] = [];
const samples: object[] = [];
async function collect(label: string) {
  await yieldTurn();
  global.gc!();
  await yieldTurn();
  global.gc!();
  await yieldTurn();
  const spaces = getHeapSpaceStatistics();
  const sample = {
    label,
    usage: process.memoryUsage(),
    oldGenerationBytes: spaces
      .filter((space) => ["old_space", "large_object_space"].includes(space.space_name))
      .reduce((sum, space) => sum + space.space_used_size, 0),
    heldCatalogs: held.length,
    load: loadavg(),
  };
  samples.push(sample);
  console.log(JSON.stringify(sample));
  if (values.snapshots) {
    writeHeapSnapshot(path.join(output, `${label}.heapsnapshot`));
  }
}
await collect("initial");
const profiler = values.allocations ? new inspector.Session() : undefined;
profiler?.connect();
await profiler?.post("HeapProfiler.startSampling", {
  samplingInterval: 16384,
  includeObjectsCollectedByMajorGC: true,
  includeObjectsCollectedByMinorGC: true,
});
const cpu = { user: 0, system: 0 };
for (let round = 0; round < rounds; round++) {
  for (let agent = 0; agent < catalogs; agent++) {
    const selected = publications.slice(agent % variants);
    const started = performance.now();
    const beforeCpu = process.threadCpuUsage();
    const catalog = runtime.prepareInstalledSkillCatalog({
      snapshot: {
        prompt: "",
        skills: selected.map(({ name }) => ({ name })),
        discoverySkills: selected,
      },
      workspaceDir: "/synthetic/workspace",
    });
    for (const query of ["file search", "scheduled tasks", "message"]) {
      digest.update(
        JSON.stringify(
          await catalogOwner.searchInstalledSkills(catalog, query, 5, undefined, () => true),
        ),
      );
    }
    const spent = process.threadCpuUsage(beforeCpu);
    cpu.user += spent.user;
    cpu.system += spent.system;
    timings.push(performance.now() - started);
    held.push(catalog);
    await yieldTurn();
  }
  await collect(`active-${round}`);
  held = [];
  await collect(`idle-${round}`);
}
let allocatedBytes: number | undefined;
if (profiler) {
  const { profile } = await profiler.post("HeapProfiler.stopSampling");
  const sum = (node: inspector.HeapProfiler.SamplingHeapProfileNode): number =>
    node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
  allocatedBytes = sum(profile.head);
  profiler.disconnect();
}
timings.sort((a, b) => a - b);
console.log(
  JSON.stringify({
    root,
    catalogs,
    skills,
    variants,
    rounds,
    digest: digest.digest("hex"),
    cpu,
    allocatedBytes,
    p50Ms: timings[Math.floor(timings.length * 0.5)],
    p95Ms: timings[Math.floor(timings.length * 0.95)],
    samples,
  }),
);
