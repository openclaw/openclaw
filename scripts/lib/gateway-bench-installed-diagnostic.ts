import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { hashFile } from "./gateway-bench-installed-package.ts";

const phaseSchema = z.object({
  phase: z.string(),
  durationMs: z.number().nonnegative(),
  totalMs: z.number().nonnegative(),
  startMs: z.number().nonnegative().optional(),
  calls: z.number().int().positive().optional(),
  monotonicUs: z.number().positive(),
  performanceMs: z.number().nonnegative(),
});
const attachmentSchema = z.object({
  pid: z.number().int().positive(),
  parentPid: z.number().int().positive(),
  mainThread: z.literal(true),
  threadId: z.literal(0),
  entry: z.string(),
  execArgv: z.array(z.string()),
  attachedMonotonicUs: z.number().positive(),
  attachedPerformanceMs: z.number().nonnegative(),
  timeOrigin: z.number().positive(),
  exitedMonotonicUs: z.number().positive(),
  code: z.number().int(),
  phases: z.array(phaseSchema),
  droppedPhases: z.number().int().nonnegative(),
  observerErrors: z.array(z.string()),
});
const profileSchema = z.object({
  startTime: z.number().positive(),
  endTime: z.number().positive(),
  nodes: z
    .array(z.object({ id: z.number().int(), callFrame: z.object({ functionName: z.string() }) }))
    .nonempty(),
  samples: z.array(z.number().int()).nonempty(),
  timeDeltas: z.array(z.number()),
});

export async function readInstalledDiagnosticState(config: string) {
  let backupExists = false;
  try {
    await fs.stat(`${config}.bak`);
    backupExists = true;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
  return { configSha256: await hashFile(config), backupExists };
}

export async function prepareInstalledCpuProfile(output: string, entry: string) {
  // Named diagnostic artifacts must never enter the immutable install or synthetic state.
  const directory = `${output}.profiles`;
  await fs.mkdir(directory);
  const attachmentPath = path.join(directory, "main-attachment.json");
  const preload = new URL("./gateway-bench-startup-cpu-preload.mjs", import.meta.url);
  preload.searchParams.set("parentPid", String(process.pid));
  preload.searchParams.set("entry", entry);
  preload.searchParams.set("attachment", attachmentPath);
  return {
    directory,
    attachmentPath,
    entry,
    nodeArgs: [
      "--cpu-prof",
      `--cpu-prof-dir=${directory}`,
      "--cpu-prof-interval=1000",
      "--import",
      preload.href,
    ],
  };
}

export async function collectInstalledCpuProfile(
  capture: Awaited<ReturnType<typeof prepareInstalledCpuProfile>>,
  pid: number | undefined,
) {
  assert.ok(pid, "Profiled Gateway PID is missing");
  const attachment = attachmentSchema.parse(
    JSON.parse(await fs.readFile(capture.attachmentPath, "utf8")),
  );
  assert.equal(attachment.pid, pid, "CPU attachment belongs to another process");
  assert.equal(attachment.parentPid, process.pid);
  assert.equal(attachment.entry, capture.entry);
  assert.equal(attachment.code, 0);
  assert.equal(attachment.droppedPhases, 0);
  assert.deepEqual(attachment.observerErrors, []);
  for (const arg of capture.nodeArgs) {
    assert.ok(attachment.execArgv.includes(arg), `Missing profile argument: ${arg}`);
  }
  const profiles = await Promise.all(
    (await fs.readdir(capture.directory))
      .filter((name) => name.endsWith(".cpuprofile"))
      .toSorted()
      .map(async (name) => {
        const file = path.join(capture.directory, name);
        return { name, sha256: await hashFile(file), bytes: (await fs.stat(file)).size };
      }),
  );
  const main = profiles.filter(({ name }) =>
    new RegExp(`^CPU\\.\\d{8}\\.\\d{6}\\.${pid}\\.0\\.\\d+\\.cpuprofile$`, "u").test(name),
  );
  assert.equal(main.length, 1, "Expected exactly one main-isolate native CPU profile");
  const mainProfile = main[0];
  assert.ok(mainProfile);
  const profile = profileSchema.parse(
    JSON.parse(await fs.readFile(path.join(capture.directory, mainProfile.name), "utf8")),
  );
  assert.ok(profile.endTime > profile.startTime);
  assert.equal(profile.samples.length, profile.timeDeltas.length);
  const nodeIds = new Set(profile.nodes.map((node) => node.id));
  assert.equal(nodeIds.size, profile.nodes.length, "CPU profile repeats a node ID");
  assert.ok(
    profile.samples.every((id) => nodeIds.has(id)),
    "CPU sample references an unknown node",
  );
  // Native profiles choose their own epoch and may end at the last sample.
  // Validate the preload's observations within its own clock domains.
  assert.ok(
    attachment.exitedMonotonicUs >= attachment.attachedMonotonicUs,
    "Preload monotonic interval ends before attachment",
  );
  let previousMonotonicUs = attachment.attachedMonotonicUs;
  let previousPerformanceMs = attachment.attachedPerformanceMs;
  for (const phase of attachment.phases) {
    assert.ok(
      phase.monotonicUs >= previousMonotonicUs && phase.monotonicUs <= attachment.exitedMonotonicUs,
      "Startup phase leaves the preload monotonic interval or moves backwards",
    );
    assert.ok(
      phase.performanceMs >= previousPerformanceMs,
      "Startup phase performance clock moves backwards",
    );
    previousMonotonicUs = phase.monotonicUs;
    previousPerformanceMs = phase.performanceMs;
  }
  return {
    directory: capture.directory,
    attachmentPath: capture.attachmentPath,
    attachmentSha256: await hashFile(capture.attachmentPath),
    attachment,
    mainProfile: mainProfile.name,
    profiles,
    startTimeUs: profile.startTime,
    endTimeUs: profile.endTime,
    samples: profile.samples.length,
    negativeTimeDeltas: profile.timeDeltas.filter((delta) => delta < 0).length,
    clockDomains: {
      controller: { pid: process.pid, source: "process.hrtime.bigint", unit: "microseconds" },
      gateway: { pid: attachment.pid, source: "process.hrtime.bigint", unit: "microseconds" },
      nativeProfile: { origin: "runtime-defined", unit: "microseconds" },
      alignment: "not-established",
    },
  };
}
