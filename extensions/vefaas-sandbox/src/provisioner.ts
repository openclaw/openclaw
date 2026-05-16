import {
  createSshSandboxSessionFromConfigText,
  runPluginCommandWithTimeout,
  type PluginCommandRunResult,
  type SshSandboxSession,
} from "openclaw/plugin-sdk/sandbox";
import type { ResolvedVefaasPluginConfig, VefaasSandboxCreateSpec } from "./config.js";

export type VefaasProvisionerAction =
  | "get"
  | "create"
  | "delete"
  | "ssh-config"
  | "opencode-start"
  | "opencode-events"
  | "opencode-stop"
  | "snapshot";

export type VefaasOpenCodeAttemptPayload = {
  attemptId: string;
  prompt?: string;
  sessionId?: string;
  workspaceDir?: string;
  metadata?: Record<string, unknown>;
};

export type VefaasProvisionerContext = {
  config: ResolvedVefaasPluginConfig;
  sandboxName: string;
};

type VefaasProvisionerRunParams =
  | {
      context: VefaasProvisionerContext;
      action: "get" | "delete" | "ssh-config";
      cwd?: string;
      timeoutMs?: number;
    }
  | {
      context: VefaasProvisionerContext;
      action: "create";
      spec: VefaasSandboxCreateSpec;
      cwd?: string;
      timeoutMs?: number;
    }
  | {
      context: VefaasProvisionerContext;
      action: "opencode-start";
      attempt: VefaasOpenCodeAttemptPayload;
      cwd?: string;
      timeoutMs?: number;
    }
  | {
      context: VefaasProvisionerContext;
      action: "opencode-events" | "opencode-stop" | "snapshot";
      attemptId: string;
      cwd?: string;
      timeoutMs?: number;
    };

type CommandRunner = (params: {
  argv: string[];
  cwd?: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}) => Promise<PluginCommandRunResult>;

let commandRunner: CommandRunner = runPluginCommandWithTimeout;

export function setVefaasProvisionerCommandRunnerForTest(runner?: CommandRunner): void {
  commandRunner = runner ?? runPluginCommandWithTimeout;
}

export function buildVefaasProvisionerArgv(params: VefaasProvisionerRunParams): string[] {
  const argv = [params.context.config.command, params.action, "--name", params.context.sandboxName];
  if (params.action === "create") {
    argv.push("--spec-json", JSON.stringify(params.spec));
  } else if (params.action === "opencode-start") {
    argv.push("--attempt-json", JSON.stringify(params.attempt));
  } else if (
    params.action === "opencode-events" ||
    params.action === "opencode-stop" ||
    params.action === "snapshot"
  ) {
    argv.push("--attempt-id", params.attemptId);
  }
  return argv;
}

export async function runVefaasProvisioner(
  params: VefaasProvisionerRunParams,
): Promise<PluginCommandRunResult> {
  return await commandRunner({
    argv: buildVefaasProvisionerArgv(params),
    cwd: params.cwd,
    timeoutMs: params.timeoutMs ?? params.context.config.timeoutMs,
    env: process.env,
  });
}

export async function createVefaasSshSession(params: {
  context: VefaasProvisionerContext;
}): Promise<SshSandboxSession> {
  const result = await runVefaasProvisioner({
    context: params.context,
    action: "ssh-config",
  });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || "VEFaaS sandbox ssh-config failed");
  }
  return await createSshSandboxSessionFromConfigText({
    configText: result.stdout,
  });
}
