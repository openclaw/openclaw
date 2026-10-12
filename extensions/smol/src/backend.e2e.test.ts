// Live e2e against a real smol engine; enabled with OPENCLAW_E2E_SMOL=1.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  prepareSandboxProcessCleanup,
  type SandboxBackendExecSpec,
  type SandboxBackendHandle,
} from "openclaw/plugin-sdk/sandbox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSmolSandboxBackendFactory,
  createSmolSandboxBackendManager,
  resolveSmolMachineName,
} from "./backend.js";
import { describeSmolMachine } from "./cli.js";
import { resolveSmolPluginConfig } from "./config.js";
import {
  createSmolBackendSandboxConfig,
  createSmolRuntimeEntryFixture,
} from "./smol.test-support.js";

const SMOL_E2E = process.env.OPENCLAW_E2E_SMOL === "1";
const SMOL_E2E_TIMEOUT_MS = 10 * 60_000;

const pluginConfig = resolveSmolPluginConfig({
  command: process.env.OPENCLAW_E2E_SMOL_COMMAND?.trim() || "smol",
  image: process.env.OPENCLAW_E2E_SMOL_IMAGE?.trim() || "python:3.12-slim",
  cpus: 1,
  memoryMb: 1024,
});

type ExecResult = { code: number; stdout: string; stderr: string };

/** Launch a prepared exec the way the Gateway does: argv + env, stdin closed. */
async function runExecSpec(spec: SandboxBackendExecSpec, timeoutMs = 60_000): Promise<ExecResult> {
  const [command, ...args] = spec.argv;
  if (!command) {
    throw new Error("exec spec has no command");
  }
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: spec.env, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    if (spec.stdinMode === "pipe-closed") {
      child.stdin.end();
    }
  });
}

async function runExec(
  handle: SandboxBackendHandle,
  params: { command: string; env?: Record<string, string> },
): Promise<ExecResult> {
  const spec = await handle.buildExecSpec({
    command: params.command,
    env: params.env ?? {},
    usePty: false,
  });
  let result: ExecResult | undefined;
  try {
    result = await runExecSpec(spec);
    return result;
  } finally {
    await handle.finalizeExec?.({
      status: result?.code === 0 ? "completed" : "failed",
      exitCode: result?.code ?? 1,
      timedOut: false,
      token: spec.finalizeToken,
    });
  }
}

function text(buffer: Buffer): string {
  return buffer.toString("utf8");
}

describe.skipIf(!SMOL_E2E)("smol sandbox backend (live engine)", () => {
  const factory = createSmolSandboxBackendFactory({ pluginConfig });
  const manager = createSmolSandboxBackendManager({ pluginConfig });
  const scopes = {
    rw: `e2e:smol:rw:${randomUUID()}`,
    ro: `e2e:smol:ro:${randomUUID()}`,
  };
  let rootDir = "";
  let workspaceDir = "";
  let agentWorkspaceDir = "";

  beforeAll(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-smol-e2e-"));
    workspaceDir = path.join(rootDir, "workspace");
    agentWorkspaceDir = path.join(rootDir, "agent");
    await fs.mkdir(workspaceDir);
    await fs.mkdir(agentWorkspaceDir);
    await fs.writeFile(path.join(workspaceDir, "hello.txt"), "hello from host\n");
    await fs.writeFile(path.join(agentWorkspaceDir, "AGENTS.md"), "# agent workspace\n");
  });

  afterAll(async () => {
    for (const scopeKey of Object.values(scopes)) {
      const machineName = resolveSmolMachineName({ scopeKey });
      await manager
        .removeRuntime({ entry: createSmolRuntimeEntryFixture(machineName), config: {} })
        .catch(() => undefined);
    }
    if (rootDir) {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it(
    "creates one machine per scope, mounts the workspaces, and runs staged execs",
    async () => {
      const createParams = {
        sessionKey: scopes.rw,
        scopeKey: scopes.rw,
        workspaceDir,
        agentWorkspaceDir,
        cfg: createSmolBackendSandboxConfig(),
      };
      const handle = await factory(createParams);
      const machineName = resolveSmolMachineName(createParams);
      expect(handle.runtimeId).toBe(machineName);

      // First guest command creates, starts, and waits for the machine.
      const hello = await handle.runShellCommand({
        script: 'cat -- "$1"',
        args: ["/workspace/hello.txt"],
      });
      expect(text(hello.stdout)).toBe("hello from host\n");
      const machine = await describeSmolMachine({ config: pluginConfig }, machineName);
      expect(machine?.state).toBe("running");

      // The agent workspace sits beside the sandbox workspace, as under Docker.
      const agent = await handle.runShellCommand({
        script: 'cat -- "$1"',
        args: ["/agent/AGENTS.md"],
      });
      expect(text(agent.stdout)).toBe("# agent workspace\n");

      // Guest writes land in the host workspace without a sync step.
      await handle.runShellCommand({
        script: 'printf "%s\\n" "$2" > "$1"',
        args: ["/workspace/from-guest.txt", "written in guest"],
      });
      await expect(fs.readFile(path.join(workspaceDir, "from-guest.txt"), "utf8")).resolves.toBe(
        "written in guest\n",
      );

      // Exec: env export, PATH addition, workdir, closed stdin, exit codes.
      const exec = await runExec(handle, {
        command: 'printf "%s|%s|%s\\n" "$FOO" "$(pwd)" "${PATH%%:*}"; cat; echo "stdin=$?"',
        env: { FOO: "bar", PATH: "/opt/extra:/usr/local/bin:/usr/bin:/bin" },
      });
      expect(exec).toMatchObject({ code: 0, stdout: "bar|/workspace|/opt/extra\nstdin=0\n" });
      const failing = await runExec(handle, { command: "echo oops >&2; exit 7" });
      expect(failing.code).toBe(7);
      expect(failing.stderr).toContain("oops");

      // finalizeExec removed the staged exec scripts.
      const leftovers = await handle.runShellCommand({
        script: "ls -d /tmp/openclaw-sandbox-exec-* 2>/dev/null | wc -l",
      });
      expect(text(leftovers.stdout).trim()).toBe("0");

      // The default marker-based process cleanup reaches guest processes.
      const cleanup = prepareSandboxProcessCleanup(handle, {});
      const [markerKey, markerValue] = Object.entries(cleanup.env)[0] ?? [];
      expect(markerKey).toBeTruthy();
      const background = await handle.buildExecSpec({
        command: "sleep 300",
        env: cleanup.env,
        usePty: false,
      });
      const backgroundRun = runExecSpec(background, 120_000);
      const findMarked = () =>
        handle.runShellCommand({
          script:
            'for env_file in /proc/[0-9]*/environ; do tr "\\0" "\\n" < "$env_file" 2>/dev/null | grep -Fqx "$1" && echo found; done; true',
          args: [`${markerKey}=${markerValue}`],
        });
      await expect
        .poll(async () => text((await findMarked()).stdout).includes("found"), {
          timeout: 30_000,
          interval: 500,
        })
        .toBe(true);
      await cleanup.terminate();
      const terminated = await backgroundRun;
      expect(terminated.code).not.toBe(0);
      await handle.finalizeExec?.({
        status: "failed",
        exitCode: terminated.code,
        timedOut: false,
        token: background.finalizeToken,
      });
      expect(text((await findMarked()).stdout)).toBe("");

      // network: "none" leaves the machine without egress.
      const egress = await handle.runShellCommand({
        script:
          'python3 -c "import socket; socket.create_connection((\\"1.1.1.1\\", 80), timeout=3)"',
        allowFailure: true,
      });
      expect(egress.code).not.toBe(0);

      // A second handle for the same scope adopts the machine instead of recreating it.
      const adopted = await factory({ ...createParams, registeredRuntimeIds: [machineName] });
      expect(adopted.runtimeId).toBe(machineName);
      const again = await adopted.runShellCommand({ script: "echo adopted" });
      expect(text(again.stdout)).toBe("adopted\n");

      // Manager: inventory, image match, removal.
      const entry = createSmolRuntimeEntryFixture(machineName, pluginConfig.image);
      await expect(manager.describeRuntime({ entry, config: {} })).resolves.toMatchObject({
        running: true,
        configLabelMatch: true,
      });
      await manager.removeRuntime({ entry, config: {} });
      await expect(describeSmolMachine({ config: pluginConfig }, machineName)).resolves.toBe(
        undefined,
      );
      await expect(manager.describeRuntime({ entry, config: {} })).resolves.toMatchObject({
        running: false,
      });
      // Removing twice is a no-op, matching `openclaw sandbox recreate` retries.
      await manager.removeRuntime({ entry, config: {} });
    },
    SMOL_E2E_TIMEOUT_MS,
  );

  it(
    "mounts read-only workspaces read-only",
    async () => {
      const handle = await factory({
        sessionKey: scopes.ro,
        scopeKey: scopes.ro,
        workspaceDir,
        agentWorkspaceDir,
        cfg: createSmolBackendSandboxConfig({}, "ro"),
      });
      const read = await handle.runShellCommand({
        script: 'cat -- "$1"',
        args: ["/workspace/hello.txt"],
      });
      expect(text(read.stdout)).toBe("hello from host\n");
      for (const target of ["/workspace/blocked.txt", "/agent/blocked.txt"]) {
        const write = await handle.runShellCommand({
          script: 'echo blocked > "$1"',
          args: [target],
          allowFailure: true,
        });
        expect(write.code, target).not.toBe(0);
        expect(text(write.stderr), target).toMatch(/read-only/iu);
      }
      await expect(fs.stat(path.join(workspaceDir, "blocked.txt"))).rejects.toThrow();
    },
    SMOL_E2E_TIMEOUT_MS,
  );
});
