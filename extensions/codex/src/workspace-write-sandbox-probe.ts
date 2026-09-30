import fs from "node:fs/promises";
import path from "node:path";
import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/health";
import { runUtf8CommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import {
  isCodexAppServerProxyLaunch,
  resolveCodexPrivateLauncher,
} from "./app-server/launch-args.js";
import {
  resolveCodexAppServerSpawnEnv,
  resolveCodexAppServerSpawnInvocation,
} from "./app-server/transport-stdio.js";
import { resolveCodexDoctorStartOptions } from "./doctor-start-options.js";

export type CodexWorkspaceWriteSandboxProbe =
  | { status: "ok"; command: string }
  | { status: "skipped"; reason: string }
  | { status: "denied"; command: string; denial: string }
  | { status: "inconclusive"; command?: string; reason: string };

const PROBE_ARGS = [
  "sandbox",
  "-c",
  'sandbox_mode="workspace-write"',
  "-c",
  "sandbox_workspace_write.network_access=false",
  "--",
  "true",
];
const PROBE_TIMEOUT_MS = 20_000;
// Codex rust-v0.158.0, codex-rs/sandboxing/src/bwrap.rs:30-35 (USER_NAMESPACE_FAILURES).
const BWRAP_DENIAL =
  /^bwrap: (?:loopback: Failed RTM_NEW(?:ADDR|LINK)|setting up uid map: Permission denied|No permissions to create a new namespace)\b/u;

function renderCommand(argv: string[]): string {
  return argv
    .map((arg) => (/^[\w./:=+@%,-]+$/u.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`))
    .join(" ");
}

/** Runs Codex's own Linux sandbox so network isolation also exercises bwrap loopback setup. */
export async function probeCodexWorkspaceWriteSandbox(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  pluginRoot: string;
}): Promise<CodexWorkspaceWriteSandboxProbe> {
  let command: string | undefined;
  try {
    if (process.platform !== "linux") {
      return { status: "skipped", reason: "Codex bwrap is only used on Linux." };
    }
    const baseEnv = params.env ?? process.env;
    const selection = await resolveCodexDoctorStartOptions({ ...params, env: baseEnv });
    if (selection.status === "skipped") {
      return selection;
    }
    const start = selection.start;
    if (isCodexAppServerProxyLaunch(start.args)) {
      return {
        status: "skipped",
        reason: "Codex app-server proxy forwards to an externally owned runtime.",
      };
    }
    command = renderCommand([start.command, ...PROBE_ARGS]);
    const launchCwd = start.cwd ?? process.cwd();
    const { launcherArgs } = resolveCodexPrivateLauncher({
      command: start.command,
      args: start.args,
      cwd: launchCwd,
    });
    const env = resolveCodexAppServerSpawnEnv(start, baseEnv);
    const invocation = resolveCodexAppServerSpawnInvocation(
      {
        ...start,
        command: start.command.includes("/")
          ? path.resolve(launchCwd, start.command)
          : start.command,
        args: [...launcherArgs, ...PROBE_ARGS],
      },
      env,
    );
    const argv = [invocation.command, ...invocation.argv];
    command = renderCommand(argv);
    const root = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-codex-sandbox-probe-"),
    );
    try {
      const codexHome = path.join(root, "codex-home");
      const cwd = path.join(root, "workspace");
      await fs.mkdir(codexHome);
      await fs.mkdir(cwd);
      const result = await runUtf8CommandWithTimeout(argv, {
        cwd,
        baseEnv: { ...env, CODEX_HOME: codexHome },
        input: "",
        timeoutMs: PROBE_TIMEOUT_MS,
        maxOutputBytes: 64 * 1024,
        outputCapture: "head",
        terminateOnOutputLimit: true,
        killProcessTree: true,
        killSignal: "SIGKILL",
        killGraceMs: 0,
      });
      if (result.outputLimitExceeded || result.termination !== "exit" || result.signal) {
        return {
          status: "inconclusive",
          command,
          reason: result.outputLimitExceeded
            ? "Sandbox probe output exceeded its capture limit."
            : result.termination === "timeout"
              ? `Sandbox probe timed out after ${PROBE_TIMEOUT_MS} ms.`
              : `Sandbox probe ended with ${result.signal ?? result.termination}.`,
        };
      }
      if (result.code === 0) {
        return { status: "ok", command };
      }
      const denial = `${result.stdout}\n${result.stderr}`
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .find((line) => BWRAP_DENIAL.test(line));
      if (result.code !== null && denial) {
        return { status: "denied", command, denial };
      }
      return {
        status: "inconclusive",
        command,
        reason: `Sandbox probe exited with ${result.code ?? "no exit code"} without a recognized bwrap denial.`,
      };
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  } catch (error) {
    const reason = coerceErrorMessage(error);
    // A configured runtime that cannot be resolved is unverified, not absent.
    return command
      ? { status: "inconclusive", command, reason }
      : { status: "inconclusive", reason };
  }
}
