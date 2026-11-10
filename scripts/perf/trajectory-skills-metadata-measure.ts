/**
 * Owner proof alongside the canonical Gateway campaign (#183101):
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/trajectory-skills-metadata-measure.ts \
 *   --state-dir "$PWD/.local/skills-metadata-candidate" --mode timing --iterations 1000
 * Repeat with --mode allocation and a fresh state directory; compare five alternating
 * base/candidate runs. Freeze baseline source in a repository-relative overlay and
 * use OPENCLAW_BENCH_BASELINE_DIR plus --import ./scripts/perf/worker-retained-heap-preload.ts.
 * Pass --compare-golden <baseline>/persisted-normalized.jsonl for exact SQLite bytes.
 * Only metadata/envelope timestamps are normalized. CLI/environment fixture values
 * are fixed across arms; credential-looking strings are synthetic. Timing measures
 * the complete metadata owner; sampling includes collected objects in the main isolate.
 * Projection, fixture construction, persistence and golden verification are untimed.
 * Run the separate canonical team-shape-stress.ts campaign for whole-Gateway proof.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import path from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { Skill } from "../../src/skills/loading/skill-contract.js";
import type { SkillEntry, SkillSnapshot } from "../../src/skills/types.js";
import type { DB } from "../../src/state/openclaw-agent-db.generated.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "1000" },
    variant: { type: "string", default: "candidate" },
    "compare-golden": { type: "string" },
  },
});
assert(global.gc, "Use --expose-gc");
assert(values["state-dir"], "Use a new isolated --state-dir");
assert(["timing", "allocation"].includes(values.mode));
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  fallback: 1000,
  min: 1,
  label: "--iterations",
});
assert(iterations <= 100_000, "Use at most 100000 iterations");
const root = path.resolve(values["state-dir"]);
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const modulePath = "src/trajectory/metadata.ts";
const source = path.join(process.env.OPENCLAW_BENCH_BASELINE_DIR ?? repositoryRoot, modulePath);
const sourceSha256 = createHash("sha256").update(fs.readFileSync(source)).digest("hex");
assert(!fs.existsSync(root), "Refusing to reuse existing state");
fs.mkdirSync(root, { recursive: true });
fs.mkdirSync(path.join(root, "home"));
fs.mkdirSync(path.join(root, "tmp"));
Object.assign(process.env, {
  HOME: path.join(root, "home"),
  OPENCLAW_HOME: path.join(root, "home"),
  OPENCLAW_STATE_DIR: root,
  OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
  OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  OPENCLAW_TRAJECTORY: "1",
  TMPDIR: path.join(root, "tmp"),
});
const originalArgv = process.argv;
process.argv = [
  "node",
  "/synthetic/home/metadata-benchmark.js",
  "--token",
  "synthetic-argv-secret",
];
const { buildTrajectoryRunMetadata } = await import("../../src/trajectory/metadata.js");
const { registerSecretValueForRedaction } =
  await import("../../src/logging/secret-redaction-registry.js");
const { projectSkillSnapshot, closeSkillsWatchers } =
  await import("../../src/skills/runtime/refresh.js");
const { loadPluginMetadataSnapshot } =
  await import("../../src/plugins/plugin-metadata-snapshot.js");
const { replaceSessionEntry } = await import("../../src/config/sessions/session-accessor.js");
const { createTrajectoryRuntimeRecorder } = await import("../../src/trajectory/runtime.js");
const { closeOpenClawAgentDatabasesAsync } = await import("../../src/state/openclaw-agent-db.js");
const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.js");
const { withOpenClawAgentDatabaseReadOnly } =
  await import("../../src/state/openclaw-agent-db-readonly.js");
const { getNodeSqliteKysely, executeSqliteQuerySync } =
  await import("../../src/infra/kysely-sync.js");
const { readTrajectoryPayload } = await import("../../src/trajectory/runtime-payload.js");
const env = {
  HOME: "/synthetic/home",
  USERPROFILE: "C:\\Synthetic\\User",
  OPENCLAW_STATE_DIR: "/synthetic/home/.openclaw",
  GIT_COMMIT: "abcdef0123456789",
};
const workspaceDir = "/synthetic/home/workspace";
const pluginMetadataSnapshot = loadPluginMetadataSnapshot({
  config: { plugins: { enabled: false } },
  workspaceDir,
  env,
});
function entry(index: number, generation: number): SkillEntry {
  const name = `synthetic-${String(index).padStart(3, "0")}`;
  const baseDir = `${workspaceDir}/skills/${name}`;
  const skill: Skill = {
    name,
    description: `Synthetic workflow ${index}, revision ${generation}.`,
    filePath: `${baseDir}/SKILL.md`,
    baseDir,
    source: "workspace",
    disableModelInvocation: false,
    sourceInfo: {
      path: `${baseDir}/SKILL.md`,
      baseDir,
      source: "workspace",
      scope: "project",
      origin: "top-level",
    },
  };
  return {
    skill,
    frontmatter: {},
    invocation: { userInvocable: true, disableModelInvocation: false },
  };
}
async function snapshot(skills: number | SkillEntry[], generation: number) {
  const eligible =
    typeof skills === "number"
      ? Array.from({ length: skills }, (_, index) => entry(index, generation))
      : skills;
  const result = await projectSkillSnapshot({
    workspaceDir,
    eligible,
    config: { skills: { limits: { maxSkillsInPrompt: 100, maxSkillsPromptChars: 100_000 } } },
    snapshotVersion: generation,
  });
  assert.equal(result.resolvedSkills?.length, eligible.length);
  assert(
    result.resolvedSkills.every(
      (skill) => Object.isFrozen(skill) && Object.isFrozen(skill.sourceInfo),
    ),
  );
  return result;
}
const capture = (skillsSnapshot: SkillSnapshot | undefined, redactionEnv = env) =>
  buildTrajectoryRunMetadata({
    env: redactionEnv,
    workspaceDir,
    timeoutMs: 30_000,
    pluginMetadataSnapshot,
    skillsSnapshot,
    provider: "synthetic",
    modelId: "mock",
    sessionKey: "agent:main:synthetic",
    agentId: "main",
  });
const inspector = new Session();
const gcEvents: Array<{ kind: number; start: number; duration: number }> = [];
const observer = new PerformanceObserver((list) => {
  for (const event of list.getEntries()) {
    const detail = (event as import("node:perf_hooks").PerformanceNodeEntry).detail;
    gcEvents.push({ kind: detail.kind, start: event.startTime, duration: event.duration });
  }
});
let sampling = false;
try {
  const forty = await snapshot(40, 1);
  const hundred = await snapshot(100, 1);
  const replaced = await snapshot(40, 2);
  const cases: Array<{ name: string; snapshot?: SkillSnapshot; env?: typeof env }> = [
    { name: "forty-cold", snapshot: forty },
    { name: "hundred-cold", snapshot: hundred },
    { name: "forty-warm", snapshot: forty },
    { name: "hundred-warm", snapshot: hundred },
    { name: "generation-replaced", snapshot: replaced },
    { name: "old-generation-reused", snapshot: forty },
    { name: "home-changed", snapshot: forty, env: { ...env, HOME: "/other/home" } },
    { name: "state-changed", snapshot: forty, env: { ...env, OPENCLAW_STATE_DIR: workspaceDir } },
    { name: "userprofile-changed", snapshot: forty, env: { ...env, USERPROFILE: workspaceDir } },
    {
      name: "fallback",
      snapshot: {
        prompt: "Synthetic fallback",
        version: 1,
        skills: [
          { name: "fallback", primaryEnv: "SYNTHETIC_API_KEY", requiredEnv: ["SYNTHETIC_TOKEN"] },
        ],
      },
    },
    { name: "missing" },
  ];
  const secrets = [
    "Basic c3ludGhldGljOnNlY3JldA==",
    "AKIAABCDEFGHIJKLMNOP",
    "person@example.invalid",
    "https://synthetic:password@example.invalid/path?token=synthetic-token",
    "Cookie: synthetic-cookie",
  ];
  const secretEntries = secrets.map((secret, index) => {
    const next = entry(index, 3);
    next.skill.sourceInfo.source = secret;
    next.skill.sourceInfo.path = `${workspaceDir}/${secret}`;
    return next;
  });
  const secretSnapshot = await snapshot(secretEntries, 3);
  cases.push(
    { name: "secret-looking-frozen", snapshot: secretSnapshot },
    { name: "secret-looking-frozen-warm", snapshot: secretSnapshot },
  );
  const unusual = entry(0, 4).skill;
  Object.assign(unusual.sourceInfo, {
    authorization: "synthetic-private-authorization",
    "person@example.invalid": "synthetic-identifier-value",
    nested: { token: "synthetic-private-token", description: "Bearer synthetic-long-credential" },
  });
  const mutable = {
    prompt: "Synthetic mutable",
    version: 4,
    skills: [{ name: unusual.name }],
    resolvedSkills: [unusual],
  };
  cases.push({ name: "mutable-extra-fields", snapshot: mutable });
  const goldens = cases.map((testCase) => ({
    name: testCase.name,
    metadata: capture(testCase.snapshot, testCase.env),
  }));
  unusual.sourceInfo.source = "Cookie: replacement-synthetic-cookie";
  goldens.push({ name: "mutable-updated", metadata: capture(mutable) });
  const lateSecret = "synthetic-late-registered-value";
  const lateEntry = entry(0, 5);
  lateEntry.skill.sourceInfo.source = lateSecret;
  const lateSnapshot = await snapshot([lateEntry], 5);
  goldens.push({ name: "before-secret-registration", metadata: capture(lateSnapshot) });
  registerSecretValueForRedaction(lateSecret);
  const afterRegistration = capture(lateSnapshot);
  assert(!JSON.stringify(afterRegistration.skills).includes(lateSecret));
  goldens.push({ name: "after-secret-registration", metadata: afterRegistration });
  goldens.push({ name: "after-secret-registration-warm", metadata: capture(lateSnapshot) });
  const nestedEntry = entry(0, 7);
  const nestedSource = { source: "synthetic-before-update" };
  Object.assign(nestedEntry.skill.sourceInfo, { extension: nestedSource });
  const nestedSnapshot = await snapshot([nestedEntry], 7);
  assert(Object.isFrozen(nestedEntry.skill.sourceInfo));
  assert(!Object.isFrozen(nestedSource));
  goldens.push({ name: "frozen-with-mutable-nested-source", metadata: capture(nestedSnapshot) });
  nestedSource.source = "Basic c3ludGhldGljOnNlY3JldA==";
  const nestedUpdated = capture(nestedSnapshot);
  assert(!JSON.stringify(nestedUpdated.skills).includes("c3ludGhldGljOnNlY3JldA=="));
  goldens.push({ name: "frozen-with-updated-nested-source", metadata: nestedUpdated });
  const accessorSkill = entry(0, 8).skill;
  let sourceValue = "synthetic-initial-source";
  Object.defineProperty(accessorSkill.sourceInfo, "source", {
    enumerable: true,
    get: () => sourceValue,
  });
  Object.freeze(accessorSkill.sourceInfo);
  Object.freeze(accessorSkill);
  const accessorSnapshot: SkillSnapshot = {
    prompt: "Synthetic custom accessor",
    skills: [{ name: accessorSkill.name }],
    resolvedSkills: [accessorSkill],
  };
  goldens.push({ name: "frozen-source-accessor-before", metadata: capture(accessorSnapshot) });
  sourceValue = "Basic c3ludGhldGljOnNlY3JldA==";
  goldens.push({ name: "frozen-source-accessor-after", metadata: capture(accessorSnapshot) });
  const fieldAccessorSkill = entry(0, 9).skill;
  let description = "Synthetic initial description";
  Object.defineProperty(fieldAccessorSkill, "description", {
    enumerable: true,
    get: () => description,
  });
  Object.freeze(fieldAccessorSkill.sourceInfo);
  Object.freeze(fieldAccessorSkill);
  const fieldAccessorSnapshot: SkillSnapshot = {
    prompt: "Synthetic custom field accessor",
    skills: [{ name: fieldAccessorSkill.name }],
    resolvedSkills: [fieldAccessorSkill],
  };
  goldens.push({ name: "frozen-skill-accessor-before", metadata: capture(fieldAccessorSnapshot) });
  description = "Cookie: synthetic-description-cookie";
  // Descriptions retain their existing trajectory semantics; exact bytes decide equivalence.
  goldens.push({ name: "frozen-skill-accessor-after", metadata: capture(fieldAccessorSnapshot) });
  const relativeEntry = entry(0, 6);
  relativeEntry.skill.filePath = "synthetic-relative/SKILL.md";
  relativeEntry.skill.baseDir = "synthetic-relative";
  const relativeSnapshot = await snapshot([relativeEntry], 6);
  const originalCwd = process.cwd();
  try {
    for (const [name, cwd] of [
      ["cwd-repository", repositoryRoot],
      ["cwd-parent", path.dirname(repositoryRoot)],
    ] as const) {
      process.chdir(cwd);
      goldens.push({ name, metadata: capture(relativeSnapshot) });
      goldens.push({
        name: `${name}-relative-home`,
        metadata: capture(relativeSnapshot, { ...env, HOME: "synthetic-relative" }),
      });
    }
  } finally {
    process.chdir(originalCwd);
  }
  const withTrigger = (baseSnapshot: SkillSnapshot, action: () => void): SkillSnapshot => {
    const trigger = entry(1, 20).skill;
    Object.defineProperty(trigger.sourceInfo, "source", {
      enumerable: true,
      get: () => {
        action();
        return "synthetic-trigger";
      },
    });
    assert(baseSnapshot.resolvedSkills);
    return {
      ...baseSnapshot,
      skills: [{ name: trigger.name }, ...baseSnapshot.skills],
      resolvedSkills: [trigger, ...baseSnapshot.resolvedSkills],
    };
  };
  const mixedSecret = "synthetic-mixed-late-registered-value";
  const mixedSecretEntry = entry(0, 21);
  mixedSecretEntry.skill.sourceInfo.source = mixedSecret;
  const mixedSecretSnapshot = await snapshot([mixedSecretEntry], 21);
  goldens.push({ name: "mixed-secret-warm", metadata: capture(mixedSecretSnapshot) });
  const mixedSecretCapture = capture(
    withTrigger(mixedSecretSnapshot, () => registerSecretValueForRedaction(mixedSecret)),
  );
  assert(!JSON.stringify(mixedSecretCapture.skills).includes(mixedSecret));
  goldens.push({ name: "mixed-secret-registered-during-capture", metadata: mixedSecretCapture });
  const mixedHomeSnapshot = await snapshot(1, 22);
  const mixedEnv = { ...env };
  goldens.push({ name: "mixed-home-warm", metadata: capture(mixedHomeSnapshot, mixedEnv) });
  goldens.push({
    name: "mixed-home-changed-during-capture",
    metadata: capture(
      withTrigger(mixedHomeSnapshot, () => {
        mixedEnv.HOME = "/synthetic/other-home";
      }),
      mixedEnv,
    ),
  });
  mixedEnv.HOME = env.HOME;
  goldens.push({ name: "mixed-home-restored", metadata: capture(mixedHomeSnapshot, mixedEnv) });
  const mixedCwdEntry = entry(0, 23);
  mixedCwdEntry.skill.filePath = "synthetic-mixed-relative/SKILL.md";
  mixedCwdEntry.skill.baseDir = "synthetic-mixed-relative";
  const mixedCwdSnapshot = await snapshot([mixedCwdEntry], 23);
  goldens.push({ name: "mixed-cwd-warm", metadata: capture(mixedCwdSnapshot) });
  try {
    goldens.push({
      name: "mixed-cwd-changed-during-capture",
      metadata: capture(
        withTrigger(mixedCwdSnapshot, () => process.chdir(path.dirname(originalCwd))),
      ),
    });
  } finally {
    process.chdir(originalCwd);
  }
  goldens.push({ name: "mixed-cwd-restored", metadata: capture(mixedCwdSnapshot) });
  // Keep full captures too: the recorder intentionally bounds inventory arrays to 64.
  const normalizedCapture =
    JSON.stringify(
      goldens.map(({ name, metadata }) => ({
        name,
        metadata: { ...metadata, capturedAt: "<timestamp>" },
      })),
    ) + "\n";
  fs.writeFileSync(path.join(root, "captures-normalized.json"), normalizedCapture);
  const scenarios = [];
  for (const [name, skills, count] of [
    ["40-skills", forty, 40],
    ["100-skills", hundred, 100],
  ] as const) {
    // Production projection creates fresh immutable catalog identities before timing.
    const coldSnapshots: SkillSnapshot[] = [];
    for (let generation = 100; generation < 120; generation++) {
      coldSnapshots.push(await snapshot(count, generation));
    }
    global.gc();
    await nextTurn();
    const coldCpuMs: number[] = [];
    const coldWallMs: number[] = [];
    for (const coldSnapshot of coldSnapshots) {
      const cpu = process.threadCpuUsage();
      const started = performance.now();
      capture(coldSnapshot);
      coldWallMs.push(performance.now() - started);
      const consumed = process.threadCpuUsage(cpu);
      coldCpuMs.push((consumed.user + consumed.system) / 1000);
    }
    for (let warm = 0; warm < 50; warm++) {
      capture(skills);
    }
    global.gc();
    await nextTurn();
    await nextTurn();
    if (values.mode === "allocation") {
      inspector.connect();
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 8192,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
      sampling = true;
    }
    observer.observe({ entryTypes: ["gc"] });
    const cpu = process.threadCpuUsage();
    const started = performance.now();
    let last: Record<string, unknown> | undefined;
    for (let index = 0; index < iterations; index++) {
      last = capture(skills);
    }
    const ended = performance.now();
    const consumed = process.threadCpuUsage(cpu);
    assert(last?.skills);
    await nextTurn();
    await nextTurn();
    observer.disconnect();
    let allocation;
    if (sampling) {
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      sampling = false;
      inspector.disconnect();
      const sampledBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
      fs.writeFileSync(path.join(root, `${name}.heapprofile`), JSON.stringify(profile));
      allocation = {
        sampledBytes,
        bytesPerRun: sampledBytes / iterations,
        samples: profile.samples.length,
        samplingInterval: 8192,
      };
    }
    const collections = gcEvents.filter((event) => event.start >= started && event.start < ended);
    scenarios.push({
      name,
      iterations,
      cold: {
        count: coldSnapshots.length,
        mainCpuMeanMs: coldCpuMs.reduce((sum, value) => sum + value, 0) / coldCpuMs.length,
        mainCpuMaxMs: Math.max(...coldCpuMs),
        wallMeanMs: coldWallMs.reduce((sum, value) => sum + value, 0) / coldWallMs.length,
        wallMaxMs: Math.max(...coldWallMs),
      },
      wallMsPerRun: (ended - started) / iterations,
      mainCpuMsPerRun: (consumed.user + consumed.system) / 1000 / iterations,
      allocation,
      gc: [...new Set(collections.map((event) => event.kind))].map((kind) => {
        const pauses = collections
          .filter((event) => event.kind === kind)
          .map((event) => event.duration);
        return {
          kind,
          count: pauses.length,
          totalMs: pauses.reduce((sum, duration) => sum + duration, 0),
          maxMs: Math.max(...pauses),
        };
      }),
    });
  }
  const sessionId = "synthetic-skills-metadata";
  const target = {
    agentId: "main",
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
    storePath: path.join(root, "agents/main/sessions/sessions.json"),
  };
  await replaceSessionEntry(target, { sessionId, updatedAt: 1 });
  const recorder = await createTrajectoryRuntimeRecorder({
    ...target,
    sessionTarget: target,
    runId: "synthetic-skills-run",
    provider: "synthetic",
    modelId: "mock",
    workspaceDir,
  });
  assert(recorder);
  for (const golden of goldens) {
    recorder.recordEvent("trace.metadata", {
      ...golden.metadata,
      fixture: golden.name,
      capturedAt: "<timestamp>",
    });
  }
  await recorder.flush();
  assert.equal(recorder.describeFlushState(), undefined);
  await closeOpenClawAgentDatabasesAsync();
  const persisted = withOpenClawAgentDatabaseReadOnly(
    (database) => {
      const db = getNodeSqliteKysely<DB>(database.db);
      return executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("trajectory_runtime_events")
          .select(["seq", "event_json", "event_payload", "event_codec", "event_utf8_bytes"])
          .where("run_id", "=", "synthetic-skills-run")
          .orderBy("seq"),
      ).rows;
    },
    { agentId: "main" },
  );
  assert(persisted.found);
  assert.equal(persisted.value.length, goldens.length);
  const normalized =
    persisted.value
      .map((row) => {
        const line = readTrajectoryPayload(row);
        const event = JSON.parse(line);
        assert.equal(typeof event.ts, "string");
        return line.replace(`"ts":${JSON.stringify(event.ts)}`, '"ts":"<timestamp>"');
      })
      .join("\n") + "\n";
  fs.writeFileSync(path.join(root, "persisted-normalized.jsonl"), normalized);
  if (values["compare-golden"]) {
    assert.equal(
      normalized,
      fs.readFileSync(values["compare-golden"], "utf8"),
      "Persisted golden differs",
    );
    assert.equal(
      normalizedCapture,
      fs.readFileSync(
        path.join(path.dirname(values["compare-golden"]), "captures-normalized.json"),
        "utf8",
      ),
      "Full capture golden differs",
    );
  }
  const result = {
    variant: values.variant,
    mode: values.mode,
    node: process.version,
    sourceSha256,
    scenarios,
    persistedEvents: goldens.length,
    goldenHash: createHash("sha256").update(normalized).digest("hex"),
    captureHash: createHash("sha256").update(normalizedCapture).digest("hex"),
    goldenCompared: Boolean(values["compare-golden"]),
    memory: process.memoryUsage(),
  };
  fs.writeFileSync(path.join(root, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  process.argv = originalArgv;
  observer.disconnect();
  if (sampling) {
    await inspector.post("HeapProfiler.stopSampling");
  }
  inspector.disconnect();
  await closeSkillsWatchers();
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
}
