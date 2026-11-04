/**
 * Native rootless Podman 5.7.0 proof; WORKSPACE is an existing synthetic btrfs tree.
 * Choose a new ROOT directory, then prepare the private hooks/store/timing wrapper:
 *
 * python3 - "$ROOT" <<'PYSETUP'
 * import json, pathlib, shlex, shutil, sys
 * r = pathlib.Path(sys.argv[1]).resolve()
 * r.mkdir()
 * for name in ['storage', 'runroot', 'hooks', 'proof', 'tmp', 'bin']:
 *     (r / name).mkdir()
 * (r / 'package.json').write_text('{"type":"module"}\n')
 * (r / 'engine-cpu.txt').touch()
 * hook = r / 'poststop.py'
 * hook.write_text('import pathlib,sys,time\np=pathlib.Path(sys.argv[1])\nsys.stdin.read()\n(p/"hook-start").touch()\ntime.sleep(float((p/"delay").read_text()))\n(p/"hook-end").touch()\n')
 * (r / 'hooks/poststop.json').write_text(json.dumps({'version':'1.0.0',
 *   'hook':{'path':sys.executable,'args':[sys.executable,str(hook),str(r/'proof')], 'timeout':30},
 *   'when':{'always':True}, 'stages':['poststop']}))
 * q = shlex.quote
 * wrapper = r / 'bin/podman'
 * wrapper.write_text('#!/bin/sh\nexec /usr/bin/time -q -a -o ' + q(str(r/'engine-cpu.txt')) + " -f '%U %S %M' " + q(shutil.which('podman')) + ' "$@"\n')
 * wrapper.chmod(0o755)
 * PYSETUP
 *
 * podman --remote=false --root "$ROOT/storage" --runroot "$ROOT/runroot" --storage-driver vfs --cgroup-manager systemd --events-backend file --hooks-dir "$ROOT/hooks" pull docker.io/library/busybox:1.37.0
 * node_modules/.bin/esbuild scripts/perf/sandbox-cgroup-retirement-measure.mts --bundle --splitting --platform=node --format=esm --packages=external --outdir="$ROOT/bundle"
 * ln -s "$PWD/node_modules" "$ROOT/node_modules"
 * PATH="$ROOT/bin:$PATH" node "$ROOT/bundle/sandbox-cgroup-retirement-measure.js" "$ROOT" "$WORKSPACE"
 * PATH="$ROOT/bin:$PATH" node "$ROOT/bundle/sandbox-cgroup-retirement-measure.js" "$ROOT" "$WORKSPACE" --allocation
 *
 * Run timing/CPU and allocation campaigns separately. Invoke under the existing
 * systemd user manager, never a production engine store. Remove the private image,
 * verify the private container inventory is empty, then remove task-owned resources.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  execContainer,
  type SandboxContainerEngine,
} from "../../src/agents/sandbox/container-engine.js";
import { containerHasTerminated } from "../../src/agents/sandbox/container-inspect.js";
import { capturePodmanBuilderCgroup } from "../../src/agents/sandbox/podman-cgroup.js";
import { hasErrnoCode } from "../../src/infra/errno.js";

function requiredArgument(index: number): string {
  const value = process.argv[index];
  assert(value, "Usage: sandbox-cgroup-retirement-measure <private-store-root> <workspace>");
  return value;
}
const entrypoint = requiredArgument(1);
const root = requiredArgument(2);
const workspace = requiredArgument(3);
assert(process.platform === "linux" && process.getuid?.() !== 0, "Run as a rootless Linux user");
const proof = path.join(root, "proof");
const engine: SandboxContainerEngine = {
  id: "podman",
  command: "podman",
  displayName: "Podman",
  globalArgs: [
    "--remote=false",
    "--root",
    path.join(root, "storage"),
    "--runroot",
    path.join(root, "runroot"),
    "--storage-driver",
    "vfs",
    "--cgroup-manager",
    "systemd",
    "--events-backend",
    "file",
    "--hooks-dir",
    path.join(root, "hooks"),
  ],
};
const command = (args: string[]) => execContainer(engine, args);
const sampleAllocations = process.argv.includes("--allocation");
const inspector = new Session();
if (sampleAllocations) {
  inspector.connect();
  await inspector.post("HeapProfiler.enable");
}
function allocated(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, child) => sum + allocated(child), 0);
}
async function engineCpuMs() {
  const lines = await fs.readFile(path.join(root, "engine-cpu.txt"), "utf8");
  return lines
    .trim()
    .split("\n")
    .filter(Boolean)
    .reduce((sum, line) => {
      const [user, system] = line.split(" ");
      const ms = (Number(user) + Number(system)) * 1_000;
      assert(Number.isFinite(ms), "Invalid engine CPU measurement");
      return sum + ms;
    }, 0);
}
async function measure<T>(operation: () => Promise<T>) {
  const cliStart = await engineCpuMs();
  if (sampleAllocations) {
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
  const profile = sampleAllocations
    ? (await inspector.post("HeapProfiler.stopSampling")).profile
    : undefined;
  return {
    value,
    ms,
    ownerCpuMs: (cpu.user + cpu.system) / 1000,
    cliCpuMs: (await engineCpuMs()) - cliStart,
    sampledAllocationBytes: profile ? allocated(profile.head) : undefined,
  };
}
async function waitFile(file: string) {
  const deadline = performance.now() + 5_000;
  while (!(await fs.stat(file).catch(() => undefined))) {
    assert(performance.now() < deadline, `Timed out waiting for ${file}`);
    await delay(5);
  }
}
async function writers(cgroup: string): Promise<string[]> {
  const directory = path.join("/sys/fs/cgroup", cgroup);
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
    if (hasErrnoCode(error, "ENOENT")) {
      return [];
    }
    throw error;
  });
  const processes: string[] = [];
  for (const entry of entries) {
    if (entry.name === "cgroup.procs") {
      processes.push(
        ...(await fs.readFile(path.join(directory, entry.name), "utf8"))
          .trim()
          .split(/\s+/u)
          .filter(Boolean),
      );
    } else if (entry.isDirectory()) {
      processes.push(...(await writers(path.join(cgroup, entry.name))));
    }
  }
  return processes;
}
async function sample(name: string, mode: "before" | "after", cleanupSeconds: number) {
  await fs.writeFile(path.join(proof, "delay"), String(cleanupSeconds));
  await fs.rm(path.join(workspace, "writes"), { force: true });
  for (const file of ["hook-start", "hook-end"]) {
    await fs.rm(path.join(proof, file), { force: true });
  }
  const id = (
    await command([
      "run",
      "-d",
      "--init",
      "--network",
      "none",
      "--name",
      name,
      "--mount",
      `type=bind,source=${proof},destination=/proof`,
      "--mount",
      `type=bind,source=${workspace},destination=/workspace`,
      "docker.io/library/busybox:1.37.0",
      "sh",
      "-c",
      "while true; do echo x >> /workspace/writes; sleep 0.01; done & wait",
    ])
  ).stdout.trim();
  let capture: Awaited<ReturnType<typeof capturePodmanBuilderCgroup>>;
  try {
    const cgroup = (
      await command(["inspect", "--format", "{{.State.CgroupPath}}", id])
    ).stdout.trim();
    const { value, ...captureMetrics } = await measure(async () =>
      mode === "after" ? await capturePodmanBuilderCgroup(engine, id) : undefined,
    );
    capture = value;
    if (mode === "after") {
      assert(capture, "Exact cgroup capture unavailable");
    }
    await waitFile(path.join(workspace, "writes"));
    let killMs = 0;
    let proofMs = 0;
    const { value: _unused, ...retirement } = await measure(async () => {
      const started = performance.now();
      await command(["kill", id]);
      killMs = performance.now() - started;
      const proofStart = performance.now();
      if (capture) {
        await capture.waitStopped();
      } else {
        await command(["wait", id]);
        assert(await containerHasTerminated(engine, id), "Engine termination unconfirmed");
      }
      proofMs = performance.now() - proofStart;
    });
    const surviving = await writers(cgroup);
    assert.equal(surviving.length, 0, "Writer survived the stopped proof");
    const bytesAtProof = (await fs.stat(path.join(workspace, "writes"))).size;
    await waitFile(path.join(proof, "hook-end"));
    const stable = bytesAtProof === (await fs.stat(path.join(workspace, "writes"))).size;
    assert(stable, "Writer modified bytes after stopped proof");
    console.log(
      JSON.stringify({
        name,
        mode,
        cleanupSeconds,
        sampleAllocations,
        capture: captureMetrics,
        killMs,
        proofMs,
        retirement,
        surviving,
        stable,
        cgroup,
        load: os.loadavg(),
        rss: process.memoryUsage().rss,
      }),
    );
  } finally {
    await capture?.close();
    await command(["rm", "-f", id]);
  }
}
if (process.argv[4] === "--crash-owner") {
  const id = (
    await command([
      "run",
      "-d",
      "--init",
      "--network",
      "none",
      "--name",
      "cgroup-owner-crash",
      "docker.io/library/busybox:1.37.0",
      "sleep",
      "300",
    ])
  ).stdout.trim();
  assert(await capturePodmanBuilderCgroup(engine, id));
  process.stdout.write(`${id}\n`, () => process.kill(process.pid, "SIGKILL"));
} else {
  try {
    assert.match((await command(["--version"])).stdout, /5\.7\.0/u);
    console.log(
      JSON.stringify({
        environment: {
          uid: process.getuid?.(),
          kernel: os.release(),
          node: process.version,
          workspace,
          engine: engine.globalArgs,
        },
      }),
    );
    for (let i = 0; i < 2; i++) {
      await sample(`cgroup-aa-${i}`, "before", 3);
    }
    for (let i = 0; i < 5; i++) {
      const modes = i % 2 === 0 ? (["before", "after"] as const) : (["after", "before"] as const);
      for (const mode of modes) {
        await sample(`cgroup-${i}-${mode}`, mode, 3);
      }
    }
    await fs.writeFile(path.join(proof, "delay"), "0");
    const id = (
      await command([
        "run",
        "-d",
        "--init",
        "--network",
        "none",
        "--name",
        "cgroup-negative",
        "docker.io/library/busybox:1.37.0",
        "sleep",
        "300",
      ])
    ).stdout.trim();
    try {
      await command(["exec", id, "sh", "-c", "sleep 300 >/dev/null 2>&1 &"]);
      const capture = await capturePodmanBuilderCgroup(engine, id);
      assert(capture);
      const start = performance.now();
      try {
        await assert.rejects(capture.waitStopped(), /still populated/u);
        console.log(
          JSON.stringify({
            negative: "installer exited with lingering child; termination deliberately omitted",
            rejected: true,
            ms: performance.now() - start,
          }),
        );
      } finally {
        await capture.close();
      }
    } finally {
      await command(["rm", "-f", id]);
    }
    // A fresh process performs cleanup after the capturing owner exits without disposal.
    const orphan = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [entrypoint, root, workspace, "--crash-owner"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("exit", (_code, signal) => {
        if (signal === "SIGKILL" && /^[a-f0-9]{64}\s*$/u.test(stdout)) {
          resolve(stdout.trim());
        } else {
          reject(new Error(`Capture owner failed before intentional SIGKILL: ${stderr}`));
        }
      });
    });
    await command(["kill", orphan]);
    await command(["rm", "-f", orphan]);
    assert.equal((await command(["ps", "-aq"])).stdout.trim(), "");
    console.log(
      JSON.stringify({
        cleanup: "empty private container inventory",
        nativeFreshProcessRemoval: true,
      }),
    );
  } finally {
    if (sampleAllocations) {
      inspector.disconnect();
    }
  }
}
