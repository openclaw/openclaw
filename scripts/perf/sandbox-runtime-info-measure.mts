/**
 * Native Podman runtime-discovery/start proof. Run only against a private store.
 * Prepare ROOT/hooks with a poststop hook which touches ROOT/proof/hook-start,
 * sleeps for the seconds in ROOT/proof/delay, then touches ROOT/proof/hook-end.
 * Put a podman wrapper first in PATH which pins that private store, logs one argv
 * per line to ROOT/commands.jsonl, and records '%U %S' with /usr/bin/time in
 * ROOT/engine-cpu.txt. Use the rootless systemd setup documented in
 * sandbox-cgroup-retirement-measure.mts; mount a synthetic workspace on btrfs.
 * Bundle with esbuild --bundle --splitting --platform=node --format=esm
 * --packages=external, using the checkout's exact external package versions.
 * Run: node <bundle>/sandbox-runtime-info-measure.js ROOT WORKSPACE
 * Repeat with --allocation for sampled JS allocation, separate from timing.
 * Remove task containers/images and unmount the private filesystem afterward.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { execContainer, PODMAN_SANDBOX_ENGINE } from "../../src/agents/sandbox/container-engine.js";
import { resolvePodmanSandboxRuntimeInfo } from "../../src/agents/sandbox/podman-runtime.js";

const root = process.argv[2] ?? "";
const workspace = process.argv[3] ?? "";
assert(root && workspace, "Usage: sandbox-runtime-info-measure ROOT WORKSPACE [--allocation]");
assert(process.platform === "linux" && process.getuid?.() !== 0, "Use a rootless Linux user");
const proof = path.join(root, "proof");
const allocation = process.argv.includes("--allocation");
const inspector = new Session();
const command = (args: string[]) => execContainer(PODMAN_SANDBOX_ENGINE, args);
if (allocation) {
  inspector.connect();
  await inspector.post("HeapProfiler.enable");
}
function allocated(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, child) => sum + allocated(child), 0);
}
async function cpuMs() {
  return (await fs.readFile(path.join(root, "engine-cpu.txt"), "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .reduce((sum, line) => {
      const [user, system] = line.split(" ");
      const ms = (Number(user) + Number(system)) * 1000;
      assert(Number.isFinite(ms));
      return sum + ms;
    }, 0);
}
async function measure<T>(operation: () => Promise<T>) {
  const cliStart = await cpuMs();
  if (allocation) {
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 512,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const cpuStart = process.cpuUsage();
  const start = performance.now();
  const value = await operation();
  const ms = performance.now() - start;
  const cpu = process.cpuUsage(cpuStart);
  const profile = allocation
    ? (await inspector.post("HeapProfiler.stopSampling")).profile
    : undefined;
  return {
    value,
    ms,
    ownerCpuMs: (cpu.user + cpu.system) / 1000,
    cliCpuMs: (await cpuMs()) - cliStart,
    sampledAllocationBytes: profile ? allocated(profile.head) : undefined,
  };
}
async function waitFile(file: string) {
  const deadline = performance.now() + 10_000;
  while (!(await fs.stat(file).catch(() => undefined))) {
    assert(performance.now() < deadline, `Timed out waiting for ${file}`);
    await delay(5);
  }
}
async function infoCount() {
  const commands = (await fs.readFile(path.join(root, "commands.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean);
  return commands.filter((line) => (JSON.parse(line) as string[])[0] === "info").length;
}
async function sample(name: string, mode: "before" | "after") {
  await fs.writeFile(path.join(proof, "delay"), "3");
  for (const file of ["hook-start", "hook-end"]) {
    await fs.rm(path.join(proof, file), { force: true });
  }
  const image = "docker.io/library/busybox:1.37.0";
  const retiring = (
    await command(["run", "-d", "--init", "--network", "none", image, "sleep", "300"])
  ).stdout.trim();
  const target = (
    await command([
      "create",
      "--init",
      "--network",
      "none",
      "--name",
      name,
      "--mount",
      `type=bind,source=${workspace},destination=/workspace`,
      image,
      "sleep",
      "300",
    ])
  ).stdout.trim();
  try {
    await command(["kill", retiring]);
    await waitFile(path.join(proof, "hook-start"));
    const countBefore = await infoCount();
    let discoveryMs = 0;
    let startMs = 0;
    const result = await measure(async () => {
      const began = performance.now();
      if (mode === "before") {
        await command([
          "info",
          "--format",
          "{{.Host.Security.Rootless}}\t{{.Host.ServiceIsRemote}}\t{{.Host.RemoteSocket.Path}}\t{{.Version.Version}}",
        ]);
      } else {
        assert.equal((await resolvePodmanSandboxRuntimeInfo()).rootless, true);
      }
      discoveryMs = performance.now() - began;
      const started = performance.now();
      await command(["start", target]);
      startMs = performance.now() - started;
    });
    const probes = (await infoCount()) - countBefore;
    assert.equal(probes, mode === "before" ? 1 : 0);
    assert.equal(
      (await command(["inspect", "--format", "{{.State.Running}}", target])).stdout.trim(),
      "true",
    );
    await waitFile(path.join(proof, "hook-end"));
    console.log(
      JSON.stringify({
        name,
        mode,
        allocation,
        discoveryMs,
        startMs,
        probes,
        ...result,
        load: os.loadavg(),
      }),
    );
  } finally {
    await fs.writeFile(path.join(proof, "delay"), "0");
    await command(["rm", "-f", target]);
    await command(["rm", "-f", retiring]);
  }
}
try {
  const cold = await measure(() => resolvePodmanSandboxRuntimeInfo());
  console.log(
    JSON.stringify({ cold, node: process.version, uid: process.getuid?.(), kernel: os.release() }),
  );
  for (let i = 0; i < 2; i++) {
    await sample(`runtime-info-aa-${i}`, "before");
  }
  for (let i = 0; i < 5; i++) {
    const modes = i % 2 === 0 ? (["before", "after"] as const) : (["after", "before"] as const);
    for (const mode of modes) {
      await sample(`runtime-info-${i}-${mode}`, mode);
    }
  }
  assert.equal((await command(["ps", "-aq"])).stdout.trim(), "");
} finally {
  inspector.disconnect();
}
