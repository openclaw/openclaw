/**
 * Run the same synthetic 40-installation sandbox preparation against --owner checkouts.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/sandbox-tool-preparation-measure.ts --owner .
 * Repeat A/A and alternate baseline/candidate. Includes worker dispatch and bridge construction;
 * counts main-thread JS filesystem calls, not kernel syscalls. No Docker or live state is used.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import v8 from "node:v8";
import type { SandboxContext } from "../../src/agents/sandbox/types.js";
import type { SkillSnapshot } from "../../src/skills/types.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    owner: { type: "string", default: "." },
    phase: { type: "string", default: "transport" },
    iterations: { type: "string", default: "30" },
    skills: { type: "string", default: "40" },
  },
});
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  label: "--iterations",
  min: 1,
  fallback: 30,
});
const skills = parseStrictIntegerOption({
  raw: values.skills,
  label: "--skills",
  min: 1,
  fallback: 40,
});
assert(["transport", "computation"].includes(values.phase));
const owner = path.resolve(values.owner);
const load = (file: string) => import(pathToFileURL(path.join(owner, file)).href);
const { preparePluginToolExecutionCapabilities } = (await load(
  "src/agents/plugin-tool-execution.ts",
)) as typeof import("../../src/agents/plugin-tool-execution.js");
const { createSandboxFsBridge } = (await load(
  "src/agents/sandbox/fs-bridge.ts",
)) as typeof import("../../src/agents/sandbox/fs-bridge.js");
const { resolveSandboxConfigForAgent } = (await load(
  "src/agents/sandbox/config.ts",
)) as typeof import("../../src/agents/sandbox/config.js");
const paths = (await load("src/agents/sandbox/fs-paths.ts")) as Partial<
  typeof import("../../src/agents/sandbox/fs-paths.js")
>;
const refresh = (await load("src/skills/runtime/refresh.ts")) as Partial<
  typeof import("../../src/skills/runtime/refresh.js")
>;
fs.mkdirSync(".local", { recursive: true });
const root = fs.realpathSync(fs.mkdtempSync(path.resolve(".local/sandbox-tools-perf-")));
const cfg = resolveSandboxConfigForAgent();
const workspaceDir = path.join(root, "workspace");
const snapshot: SkillSnapshot = { prompt: "", skills: [], resolvedSkills: [] };
const sandbox: SandboxContext = {
  enabled: true,
  backendId: "fixture",
  sessionKey: "sandbox:synthetic",
  workspaceDir,
  agentWorkspaceDir: workspaceDir,
  workspaceAccess: "none",
  runtimeId: "fixture",
  runtimeLabel: "Fixture",
  containerName: "fixture",
  containerWorkdir: "/workspace",
  docker: cfg.docker,
  tools: cfg.tools,
  browserAllowHostControl: false,
  skillUsagePaths: [],
  backend: {
    id: "fixture",
    runtimeId: "fixture",
    runtimeLabel: "Fixture",
    workdir: "/workspace",
    capabilities: { readOnlyResourceMounts: true },
    async buildExecSpec() {
      throw new Error("No execution in preparation benchmark");
    },
    async runShellCommand() {
      throw new Error("No execution in preparation benchmark");
    },
  },
};
try {
  for (let index = 0; index < skills; index++) {
    const name = `skill-${index}`;
    const baseDir = path.join(root, "installed", name);
    const filePath = path.join(baseDir, "SKILL.md");
    const readPath = path.join(workspaceDir, "skills", name, "SKILL.md");
    for (const file of [filePath, readPath]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `---\nname: ${name}\ndescription: Synthetic helper\n---\n`);
    }
    snapshot.skills.push({ name, source: { filePath, fileHost: "gateway" } });
    snapshot.resolvedSkills!.push({
      name,
      description: "Synthetic helper",
      baseDir,
      filePath,
      source: "openclaw-managed",
      fileHost: "gateway",
      disableModelInvocation: false,
      sourceInfo: {
        path: filePath,
        source: "openclaw-managed",
        scope: "user",
        origin: "top-level",
      },
    });
    sandbox.skillUsagePaths!.push({
      skillName: name,
      skillFile: filePath,
      readPath,
      skillSource: "workspace",
    });
  }
  async function run() {
    if (refresh.prepareSandboxFsContext) {
      sandbox.fsPreparation =
        values.phase === "computation" && paths.resolveSandboxFsPreparation
          ? paths.resolveSandboxFsPreparation({
              sandbox,
              skillUsagePaths: sandbox.skillUsagePaths!,
            })
          : await refresh.prepareSandboxFsContext(sandbox);
    }
    sandbox.fsBridge = createSandboxFsBridge({
      sandbox: { ...sandbox, backend: sandbox.backend! },
    });
    const capabilities = preparePluginToolExecutionCapabilities({
      sandbox,
      skillsSnapshot: snapshot,
    })(() => {});
    assert.equal(Object.keys(capabilities.sandbox!.installedSkillRoots).length, skills);
  }
  // Production has already used this existing worker to discover/project its skills.
  await refresh.prepareSkillStatusFacts!({
    entries: [],
    workspaceDir,
    managedSkillsDir: path.join(root, "installed"),
  });
  for (let index = 0; index < 5; index++) {
    await run();
  }
  const calls: Record<string, number> = {};
  const restore: Array<() => void> = [];
  for (const name of ["existsSync", "statSync", "lstatSync", "realpathSync"] as const) {
    const original = fs[name];
    const native = fs.realpathSync.native;
    const wrapped = new Proxy(original, {
      apply(fn, self, args) {
        calls[name] = (calls[name] ?? 0) + 1;
        return Reflect.apply(fn, self, args);
      },
    });
    Object.assign(fs, { [name]: wrapped });
    if (name === "realpathSync") {
      fs.realpathSync.native = new Proxy(native, {
        apply(fn, self, args) {
          calls.realpathNative = (calls.realpathNative ?? 0) + 1;
          return Reflect.apply(fn, self, args);
        },
      });
    }
    restore.push(() => {
      Object.assign(fs, { [name]: original });
      fs.realpathSync.native = native;
    });
  }
  syncBuiltinESMExports();
  try {
    await run();
  } finally {
    for (const reset of restore.toReversed()) {
      reset();
    }
    syncBuiltinESMExports();
  }
  global.gc?.();
  const heap = v8.getHeapStatistics();
  const allocated = "total_allocated_bytes" in heap ? heap.total_allocated_bytes : null;
  const thread = process.threadCpuUsage();
  const total = process.cpuUsage();
  const loadBefore = loadavg();
  const start = performance.now();
  for (let index = 0; index < iterations; index++) {
    await run();
  }
  const elapsedMs = performance.now() - start;
  const mainCpu = process.threadCpuUsage(thread);
  const totalCpu = process.cpuUsage(total);
  const heapAfter = v8.getHeapStatistics();
  console.log(
    JSON.stringify({
      owner,
      phase: values.phase,
      node: process.version,
      skills,
      iterations,
      loadBefore,
      mainThreadFsCallsPerRun: calls,
      elapsedMsPerRun: elapsedMs / iterations,
      mainCpuUsPerRun: (mainCpu.user + mainCpu.system) / iterations,
      processCpuUsPerRun: (totalCpu.user + totalCpu.system) / iterations,
      mainAllocatedBytesPerRun:
        allocated === null || !("total_allocated_bytes" in heapAfter)
          ? null
          : (heapAfter.total_allocated_bytes - allocated) / iterations,
      rss: process.memoryUsage().rss,
    }),
  );
} finally {
  await refresh.closeSkillsWatchers?.(true);
  fs.rmSync(root, { recursive: true, force: true });
}
