import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import type { SandboxBackendHandle, SandboxFsBridge } from "openclaw/plugin-sdk/sandbox";
import { expect } from "vitest";
import { z } from "zod";

type ExecResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export function buildOpenShellPolicyYaml(params: {
  port: number;
  binaryPath: string;
  hostIp?: string;
}): string {
  const hostIp = params.hostIp?.trim();
  // An explicit override keeps its shipped single-/32 policy; only the default
  // uses NVIDIA's host_gateway_alias.rs ranges across managed Docker bridges.
  // Upstream's 172.0.0.0/8 intentionally extends beyond RFC1918.
  const allowedIps = hostIp
    ? [`${hostIp}/32`]
    : ["10.0.0.0/8", "172.0.0.0/8", "192.168.0.0/16", "fc00::/7"];
  return `version: 1
filesystem_policy: {include_workdir: true, read_only: [/usr, /lib, /proc, /dev/urandom, /app, /etc, /var/log, /opt], read_write: [/sandbox, /tmp, /dev/null]}
landlock: {compatibility: best_effort}
process: {run_as_user: sandbox, run_as_group: sandbox}
network_policies:
  host_echo:
    name: host-echo
    endpoints: [{host: host.openshell.internal, port: ${params.port}, protocol: rest, enforcement: enforce, access: full, allowed_ips: ${JSON.stringify(allowedIps)}}]
    binaries: [{path: ${JSON.stringify(params.binaryPath)}}]
`;
}

export async function runCommand(params: {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string | Uint8Array;
  allowFailure?: boolean;
  timeoutMs?: number;
}): Promise<ExecResult> {
  return await new Promise((resolve, reject) => {
    const child = execFile(
      params.command,
      params.args,
      {
        cwd: params.cwd,
        env: params.env,
        encoding: "utf8",
        timeout: params.timeoutMs && params.timeoutMs > 0 ? params.timeoutMs : 0,
        killSignal: "SIGKILL",
        maxBuffer: Infinity,
      },
      (error, stdout, stderr) => {
        const command = `${params.command} ${params.args.join(" ")}`;
        if (error?.killed) {
          return reject(new Error(`command timed out: ${command}`));
        }
        if (error && typeof error.code !== "number" && !error.signal) {
          return reject(new Error(error.message, { cause: error }));
        }
        const code = typeof error?.code === "number" ? error.code : error ? 1 : 0;
        if (code === 0 || params.allowFailure) {
          return resolve({ code, stdout, stderr });
        }
        const diagnostics = Object.entries({ stdout, stderr })
          .filter(([, output]) => output.trim())
          .map(([label, output]) => `${label}:\n${output}`);
        reject(
          new Error([`command failed: ${command}`, `exit: ${code}`, ...diagnostics].join("\n")),
        );
      },
    );
    child.stdin?.end(params.stdin);
  });
}

export async function cleanupOpenShellWorkspace(params: {
  command: string;
  env: NodeJS.ProcessEnv;
  workspace: string;
  sandboxNames: string[];
}): Promise<void> {
  const { command, env, workspace, sandboxNames } = params;
  const deadline = Date.now() + 2 * 60_000;
  const remainingMs = () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error("OpenShell sandbox cleanup did not complete within 120 seconds");
    }
    return remaining;
  };
  const run = (args: string[], timeoutMs = remainingMs()) =>
    runCommand({ command, env, args, timeoutMs });
  const runSandbox = (args: string[]) => run(["--workspace", workspace, "sandbox", ...args]);
  const ownedNames = new Set(sandboxNames);
  const inventoryLimit = String(ownedNames.size + 1);
  const listNames = async () => {
    const result = await runSandbox(["list", "--limit", inventoryLimit, "--output", "json"]);
    remainingMs();
    const sandboxes = z
      .array(z.object({ name: z.string().min(1) }))
      .parse(JSON.parse(result.stdout));
    const names = sandboxes.map((sandbox) => sandbox.name);
    // This isolated workspace contains only the fixture's owned sandboxes. An extra
    // row or unexpected name must fail, never masquerade as a complete inventory.
    if (new Set(names).size !== names.length || names.some((name) => !ownedNames.has(name))) {
      throw new Error("Unexpected sandbox inventory in OpenShell fixture workspace");
    }
    return names;
  };
  const presentNames = await listNames();
  const failures: unknown[] = [];
  for (const sandboxName of [...ownedNames].filter((name) => presentNames.includes(name))) {
    try {
      await runSandbox(["delete", sandboxName]);
      // OpenShell v0.0.109 acknowledges deletion before its controller removes the
      // durable row. Observe absence before deleting the workspace; never retry errors.
      while (failures.length === 0 && (await listNames()).includes(sandboxName)) {
        await delay(Math.min(250, remainingMs()));
      }
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "OpenShell sandbox cleanup failed");
  }
  await run(["workspace", "delete", workspace], 30_000);
}

export async function runBackendExec(params: {
  backend: SandboxBackendHandle;
  command: string;
  env?: Record<string, string>;
  allowFailure?: boolean;
  timeoutMs?: number;
}): Promise<ExecResult> {
  const { backend, command, env } = params;
  const workdir = expectDefined(
    await backend.validateWorkdir?.(backend.workdir),
    "OpenShell validated working directory",
  );
  const execSpec = await backend.buildExecSpec({ command, workdir, env: env ?? {}, usePty: false });
  return await runPreparedBackendExec({ ...params, execSpec });
}

export async function runPreparedBackendExec(params: {
  backend: SandboxBackendHandle;
  execSpec: Awaited<ReturnType<SandboxBackendHandle["buildExecSpec"]>>;
  allowFailure?: boolean;
  timeoutMs?: number;
}): Promise<ExecResult> {
  const { execSpec } = params;
  let result: ExecResult | null | undefined;
  try {
    result = await runCommand({
      command: execSpec.argv[0] ?? "ssh",
      args: execSpec.argv.slice(1),
      env: execSpec.env,
      allowFailure: params.allowFailure,
      timeoutMs: params.timeoutMs,
    });
    return result;
  } finally {
    await params.backend.finalizeExec?.({
      status: result?.code === 0 ? "completed" : "failed",
      exitCode: result?.code ?? 1,
      timedOut: false,
      token: execSpec.finalizeToken,
    });
  }
}

export async function verifyRemoteExecOverlap(params: {
  backend: SandboxBackendHandle;
  twin: SandboxBackendHandle;
  bridge: SandboxFsBridge;
}): Promise<void> {
  const probeDir = "exec-overlap";
  const exec = (backend: SandboxBackendHandle, command: string) =>
    runBackendExec({ backend, command, timeoutMs: 60_000 });
  await params.bridge.mkdirp({ filePath: probeDir });
  await exec(params.twin, "true");
  const waitingScript = `import pathlib,time
root=pathlib.Path("exec-overlap")
root.joinpath("ready").write_text("ready")
deadline=time.monotonic()+30
for name in ("command-release", "file-release"):
    target=root.joinpath(name)
    while not target.is_file() or target.read_text() != name:
        if time.monotonic() >= deadline:
            raise RuntimeError("remote execution prevented concurrent " + name)
        time.sleep(0.05)
print("remote-exec-overlapped-command-and-file")`;
  const releaseScript = `import pathlib,time
root=pathlib.Path("exec-overlap")
deadline=time.monotonic()+30
while not root.joinpath("ready").exists():
    if time.monotonic() >= deadline:
        raise RuntimeError("waiting command did not start")
    time.sleep(0.05)
root.joinpath("command-release").write_text("command-release")`;
  // A process that waits for the next turn's write must not retain the runtime lease.
  // Observe rejection immediately, but join it in finally even if the writer fails.
  const waiting = exec(params.backend, `python3 -c '${waitingScript}'`);
  const settled = Promise.allSettled([waiting]);
  try {
    await exec(params.twin, `python3 -c '${releaseScript}'`);
    await params.bridge.writeFile({
      filePath: `${probeDir}/file-release`,
      data: "file-release",
    });
    await expect(waiting).resolves.toMatchObject({
      code: 0,
      stdout: "remote-exec-overlapped-command-and-file\n",
    });
  } finally {
    await settled;
    await params.bridge.remove({ filePath: probeDir, recursive: true });
  }
}

export async function stressBackend(params: {
  backends: SandboxBackendHandle[];
  bridge: SandboxFsBridge;
  mode: "mirror" | "remote";
  workspaceDir: string;
}): Promise<void> {
  const { backends, bridge, mode, workspaceDir } = params;
  const createExclusive = (filePath: string, data: string) =>
    bridge.createFileExclusive?.({ filePath, data });
  const expectedIds: string[] = [];
  const expectedFiles: Record<string, string> = {};
  const waves = 8;
  const concurrency = 8;
  for (let wave = 0; wave < waves; wave++) {
    // Keep all writes under one directory so mirror upload cost stays independent of task count.
    const results = await Promise.allSettled(
      Array.from({ length: concurrency }, async (_, slot) => {
        const id = `${wave}-${slot}`;
        expectedFiles[`@${slot % 2 === 0 ? "exec" : "file"}-${id}`] =
          slot % 2 === 0 ? `value-${id}` : id;
        if (slot === 3) {
          expectedFiles[`@renamed-${id}`] = id;
        }
        const backend = backends[(wave + Math.floor(slot / 2)) % backends.length]!;
        if (slot % 2 === 0) {
          expectedIds.push(id);
          const exitCode = slot === 0 ? 23 : 0;
          const serialMutation =
            mode === "mirror"
              ? `n=$(cat stress/count 2>/dev/null || echo 0); sleep 0.02; printf '%s\\n' "$((n + 1))" > stress/count; printf '%s\\n' '${id}' >> stress/ledger; `
              : "";
          const result = await runBackendExec({
            backend,
            command: `mkdir -p stress; ${serialMutation}printf '%s' "$STRESS_VALUE" > 'stress/@exec-${id}'; exit ${exitCode}`,
            env: { STRESS_VALUE: `value-${id}` },
            allowFailure: true,
            timeoutMs: 60_000,
          });
          expect(result.code).toBe(exitCode);
          return;
        }
        const filePath = `stress/@file-${id}`;
        await bridge.writeFile({ filePath, data: id, mkdir: true });
        const temporaryPath = `stress/tmp-${id}`;
        switch (slot) {
          case 1:
            return expect(createExclusive(filePath, "overwrite")).resolves.toBe("exists");
          case 3:
            await expect(createExclusive(temporaryPath, id)).resolves.toBe("created");
            return bridge.rename({ from: temporaryPath, to: `stress/@renamed-${id}` });
          case 5:
            await bridge.mkdirp({ filePath: temporaryPath });
            return bridge.remove({ filePath: temporaryPath, recursive: true });
          case 7:
            return expect(bridge.stat({ filePath })).resolves.toMatchObject({
              type: "file",
              size: Buffer.byteLength(id),
            });
        }
      }),
    );
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        "OpenShell stress wave failed",
      );
    }
    await expect(bridge.readFile({ filePath: `stress/@file-${wave}-1` })).resolves.toEqual(
      Buffer.from(`${wave}-1`),
    );
  }
  // Read the remote tree without exec preparation: a fresh mirror upload could hide divergence.
  const inventory = await backends[0]!.runShellCommand({
    script: `python3 -c 'import json,pathlib,sys; root=pathlib.Path(sys.argv[1]); print(json.dumps({str(p.relative_to(root)):p.read_text() for p in root.rglob("*") if p.is_file()}))' "$1"`,
    args: [`${backends[0]!.workdir}/stress`],
  });
  const remoteFiles = JSON.parse(inventory.stdout.toString("utf8")) as Record<string, string>;
  if (mode === "mirror") {
    const ledger = expectDefined(remoteFiles.ledger, "OpenShell mirror command ledger");
    expect(ledger.trim().split("\n").toSorted()).toEqual(expectedIds.toSorted());
    expectedFiles.ledger = ledger;
    expectedFiles.count = `${expectedIds.length}\n`;
  }
  expect(remoteFiles).toEqual(expectedFiles);
  if (mode === "mirror") {
    expect((await fs.readdir(path.join(workspaceDir, "stress"))).toSorted()).toEqual(
      Object.keys(expectedFiles).toSorted(),
    );
    for (const [file, expected] of Object.entries(expectedFiles)) {
      await expect(bridge.readFile({ filePath: `stress/${file}` })).resolves.toEqual(
        Buffer.from(expected),
      );
    }
  } else {
    await expect(fs.stat(path.join(workspaceDir, "stress"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  }
}
