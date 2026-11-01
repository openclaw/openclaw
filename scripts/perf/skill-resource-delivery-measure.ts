import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { Session } from "node:inspector/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { transferSkillResources } from "../../src/gateway/worker-environments/skill-resource-transfer.js";
import type { WorkerWorkspaceTunnelHandle } from "../../src/gateway/worker-environments/tunnel-contract.js";
import { createSyntheticSourceInfo } from "../../src/skills/loading/skill-contract.js";
import { prepareSkillResourceDelivery } from "../../src/skills/runtime/resources.js";
import type { SkillSnapshot } from "../../src/skills/types.js";
import { startGatewayBenchDiagnostics } from "../lib/gateway-bench-diagnostics.ts";
import { writeGatewayGcTraceMarker, readGatewayGcTrace } from "../lib/gateway-bench-profile.ts";
import { sumSampledHeapBytes } from "../lib/heap-sampling.ts";

// Metadata-shaped synthetic trees, never copies of operator instructions or scripts.
const supportSizes = [
  476, 6889, 7091, 5755, 1478, 9660, 1397, 355748, 1124, 154968, 586, 1660, 11034, 424670, 36472,
  4611, 55257, 28019, 27557, 6781, 22066, 14026, 34157, 11008, 14144, 1204, 1140, 2092, 714,
];
const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    operations: { type: "string", default: "128" },
    concurrency: { type: "string", default: "8" },
    mode: { type: "string", default: "delivery" },
    content: { type: "string", default: "ascii" },
    allocations: { type: "boolean", default: false },
    "start-file": { type: "string" },
    "prepare-only": { type: "boolean", default: false },
    existing: { type: "boolean", default: false },
    functional: { type: "boolean", default: false },
    "gc-log": { type: "string" },
  },
});
assert(values["state-dir"]);
assert(typeof globalThis.gc === "function", "Run this workload with --expose-gc");
assert(!(values.allocations && values["gc-log"]), "Measure allocation and promotion separately");
assert(["delivery", "transfer"].includes(values.mode));
assert(["ascii", "unicode", "binary"].includes(values.content));
const directory = path.resolve(values["state-dir"]);
const profilePath = path.join(directory, "skill-resource-profile");
const workspace = path.join(directory, "workspace");
const operations = Number(values.operations);
const concurrency = Number(values.concurrency);
assert(Number.isSafeInteger(operations) && operations > 0);
assert(Number.isSafeInteger(concurrency) && concurrency > 0 && operations % concurrency === 0);
const snapshot: SkillSnapshot = { prompt: "", skills: [], resolvedSkills: [] };
const fileSizes = new Map<string, number>();
for (const [index, sizes] of [
  [14411, ...supportSizes],
  [38687, 8012],
].entries()) {
  const name = `synthetic-${index}`;
  const baseDir = path.join(workspace, "skills", name);
  const filePath = path.join(baseDir, "SKILL.md");
  if (!values.existing) {
    await fs.mkdir(path.join(baseDir, "references"), { recursive: true });
  }
  for (const [fileIndex, size] of sizes.entries()) {
    const target = fileIndex ? path.join(baseDir, "references", `file-${fileIndex}.txt`) : filePath;
    const header = fileIndex
      ? ""
      : `---\nname: ${name}\ndescription: Synthetic delivery fixture\n---\n`;
    const bytes = Buffer.alloc(size);
    bytes.fill(
      "# Synthetic supporting instructions\nRead the selected resource, then run the check.\n" +
        'printf "%s\\n" "synthetic fixture"\nexport FIXTURE_MODE="read-only"\n' +
        "Preserve exact file bytes and executable permissions across the transport.\n",
    );
    if (fileIndex && values.content === "binary") {
      bytes.fill(255);
    } else if (fileIndex && values.content === "unicode") {
      bytes.write("🦞", size - 4);
    }
    bytes.write(header);
    if (!values.existing) {
      await fs.writeFile(target, bytes);
    }
    fileSizes.set(target, size);
  }
  snapshot.skills.push({ name });
  snapshot.resolvedSkills!.push({
    name,
    description: "Synthetic delivery fixture",
    filePath,
    baseDir,
    source: "synthetic",
    sourceInfo: createSyntheticSourceInfo(filePath, { source: "synthetic", baseDir }),
    disableModelInvocation: false,
  });
}
const remoteDirectories = await Promise.all(
  Array.from({ length: concurrency }, async (_, index) => {
    const target = path.join(directory, `remote-${index}`);
    if (!values.existing) {
      await fs.mkdir(target, { recursive: true });
    }
    return target;
  }),
);
if (values["prepare-only"]) {
  console.log(
    JSON.stringify({
      directory,
      files: fileSizes.size,
      bytes: [...fileSizes.values()].reduce((a, b) => a + b, 0),
    }),
  );
  process.exit(0);
}
const tunnel: Pick<WorkerWorkspaceTunnelHandle, "runWorkspaceCommand"> = {
  runWorkspaceCommand: async (command) => {
    command.assertCurrent?.();
    return new Promise((resolve, reject) => {
      const child = spawn(command.argv[0]!, command.argv.slice(1), {
        stdio: "pipe",
        signal: command.signal,
      });
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (bytes) => {
        stdout += bytes;
      });
      child.stderr.on("data", (bytes) => {
        stderr += bytes;
      });
      child.on("error", reject);
      child.on("close", (code) =>
        resolve({ stdout, stderr, code, termination: "exit", signal: null, killed: false }),
      );
      child.stdin.end(command.input);
    });
  },
};
type Delivery = Awaited<ReturnType<typeof prepareSkillResourceDelivery>>;
type Transfer = Awaited<ReturnType<typeof transferSkillResources>>;
let retained: Array<Delivery | Transfer> = [];
async function batch() {
  for (const item of retained) {
    if (item && "cleanup" in item) {
      await item.cleanup();
    }
  }
  retained = await Promise.all(
    Array.from({ length: concurrency }, async (_, index) => {
      if (values.mode === "transfer") {
        return transferSkillResources({
          snapshot,
          workspaceDir: workspace,
          tunnel,
          remoteWorkspaceDir: remoteDirectories[index]!,
          assertCurrent: () => {},
        });
      }
      return prepareSkillResourceDelivery(snapshot, () => {}, [], workspace);
    }),
  );
}
await batch();
for (const item of retained) {
  if (item && "cleanup" in item) {
    await item.cleanup();
  }
}
retained = [];
if (values["gc-log"]) {
  writeGatewayGcTraceMarker("identify-start", profilePath);
}
globalThis.gc?.();
if (values["gc-log"]) {
  writeGatewayGcTraceMarker("identify-stop", profilePath);
}
await delay(25);
globalThis.gc?.();
const before = process.memoryUsage();
let reads = 0,
  readBytes = 0;
const open = fs.open;
fs.open = async (...args) => {
  const handle = await open(...args);
  const size = typeof args[0] === "string" ? fileSizes.get(args[0]) : undefined;
  if (size !== undefined) {
    reads++;
    readBytes += size;
  }
  return handle;
};
if (values.functional) {
  await batch();
  fs.open = open;
  let payloadCharacters = 0;
  let verifiedBytes = 0;
  for (const item of retained) {
    assert(item);
    if ("skills" in item) {
      for (const skill of item.skills) {
        for (const file of skill.files) {
          const expected = await fs.readFile(path.join(path.dirname(skill.sourcePath!), file.path));
          const actual = Buffer.from(file.content, file.encoding ?? "utf8");
          assert.deepEqual(actual, expected);
          verifiedBytes += actual.length;
          payloadCharacters += file.content.length;
        }
      }
    } else {
      for (const skill of item.snapshot.resolvedSkills ?? []) {
        const original = snapshot.resolvedSkills!.find((source) => source.name === skill.name)!;
        for (const [file, size] of fileSizes) {
          if (!file.startsWith(`${original.baseDir}${path.sep}`)) {
            continue;
          }
          const actual = await fs.readFile(
            path.join(skill.baseDir, path.relative(original.baseDir, file)),
          );
          const expected = await fs.readFile(file);
          assert.deepEqual(actual, expected);
          verifiedBytes += size;
        }
      }
    }
  }
  console.log(
    JSON.stringify({
      functional: true,
      mode: values.mode,
      content: values.content,
      concurrentTurns: concurrency,
      callsPerTurn: 1,
      reads,
      readBytes,
      verifiedBytes,
      payloadCharacters,
    }),
  );
  for (const item of retained) {
    if (item && "cleanup" in item) {
      await item.cleanup();
    }
  }
  process.exit(0);
}
if (values["start-file"]) {
  console.log(`READY ${process.pid}`);
  for (;;) {
    try {
      const start = Number(await fs.readFile(values["start-file"], "utf8"));
      assert(Number.isFinite(start) && Date.now() < start, "Missed synchronized start");
      await delay(start - Date.now());
      break;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
      await delay(50);
    }
  }
}
const inspector = new Session();
if (values.allocations) {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 16384,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const stopDiagnostics = startGatewayBenchDiagnostics();
if (values["gc-log"]) {
  writeGatewayGcTraceMarker("heap-start", profilePath);
}
const cpuStart = process.cpuUsage();
const start = performance.now();
for (let count = 0; count < operations; count += concurrency) {
  await batch();
}
const elapsedMs = performance.now() - start;
const cpu = process.cpuUsage(cpuStart);
if (values["gc-log"]) {
  writeGatewayGcTraceMarker("heap-stop", profilePath);
}
const diagnostics = stopDiagnostics();
let allocationBytes: number | null = null;
if (values.allocations) {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  allocationBytes = sumSampledHeapBytes(profile.head);
  inspector.disconnect();
}
fs.open = open;
globalThis.gc?.();
await delay(25);
globalThis.gc?.();
const after = process.memoryUsage();
let payloadCharacters = 0,
  jsonBytes = 0,
  instructionBytes = 0,
  supportBytesConsumed = 0;
for (const item of retained) {
  assert(item);
  if ("skills" in item) {
    payloadCharacters += item.skills.reduce(
      (sum, skill) => sum + skill.files.reduce((n, file) => n + file.content.length, 0),
      0,
    );
    jsonBytes += Buffer.byteLength(JSON.stringify(item));
  } else {
    for (const skill of item.snapshot.resolvedSkills ?? []) {
      instructionBytes += Buffer.byteLength(skill.readContent ?? "");
      const support = await fs.readFile(path.join(skill.baseDir, "references", "file-1.txt"));
      supportBytesConsumed += support.length;
    }
  }
}
console.log(
  JSON.stringify({
    scope:
      "production resource preparation; transfer mode executes the real staging script via child stdin, without Gateway placement or model inference",
    mode: values.mode,
    content: values.content,
    operations,
    concurrency,
    reads,
    readBytes,
    callsPerTurn: 1,
    filesPerTurn: reads / operations,
    bytesReadPerTurn: readBytes / operations,
    elapsedMs,
    cpuMs: (cpu.user + cpu.system) / 1000,
    allocationBytes,
    allocationBytesPerTurn: allocationBytes === null ? null : allocationBytes / operations,
    heldHeapDeltaBytes: after.heapUsed - before.heapUsed,
    heldExternalDeltaBytes: after.external - before.external,
    payloadCharacters,
    jsonBytes,
    instructionBytes,
    supportBytesConsumed,
    promotion: values["gc-log"]
      ? readGatewayGcTrace(path.resolve(values["gc-log"]), profilePath)
      : null,
    diagnostics,
  }),
);
for (const item of retained) {
  if (item && "cleanup" in item) {
    await item.cleanup();
  }
}
