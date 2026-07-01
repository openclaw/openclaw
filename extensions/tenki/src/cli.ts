// Tenki plugin module implements cli behavior.
import {
  createSshSandboxSessionFromConfigText,
  runPluginCommandWithTimeout,
  shellEscape,
  type SshSandboxSession,
} from "openclaw/plugin-sdk/sandbox";
import type { ResolvedTenkiPluginConfig } from "./config.js";

export {
  buildExecRemoteCommand,
  buildRemoteWorkdirValidationCommand,
  buildValidatedExecRemoteCommand,
  shellEscape,
} from "openclaw/plugin-sdk/sandbox";

export type TenkiExecContext = {
  config: ResolvedTenkiPluginConfig;
  sandboxName: string;
  timeoutMs?: number;
};

export function resolveTenkiCommand(command: string): string {
  return command;
}

export function buildTenkiBaseArgv(config: ResolvedTenkiPluginConfig): string[] {
  return [resolveTenkiCommand(config.command)];
}

export function buildTenkiGetArgs(sandboxName: string): string[] {
  return ["sandbox", "get", "--session", sandboxName, "--json"];
}

export function buildTenkiDeleteArgs(sandboxName: string): string[] {
  return ["sandbox", "delete", "--session", sandboxName];
}

export function buildTenkiSshConfigArgs(sandboxName: string): string[] {
  return ["sandbox", "ssh-config", "--session", sandboxName];
}

export function buildTenkiCreateArgs(params: { sandboxName: string; config: ResolvedTenkiPluginConfig }): string[] {
  return ["sandbox", "create", "--name", params.sandboxName, "--from", params.config.from, ...(params.config.policy ? ["--policy", params.config.policy] : []), ...(params.config.gpu ? ["--gpu"] : []), ...(params.config.autoProviders ? ["--auto-providers"] : ["--no-auto-providers"]), ...params.config.providers.flatMap((provider) => ["--provider", provider]), "--", "true"];
}

export function buildRemoteCommand(argv: string[]): string {
  return argv.map((entry) => shellEscape(entry)).join(" ");
}

export function applyGatewayEndpointToSshConfig(params: {
  configText: string;
  gatewayEndpoint?: string;
}): string {
  const endpoint = params.gatewayEndpoint?.trim();
  if (!endpoint) {
    return params.configText;
  }
  return params.configText.replace(/^(\s*ProxyCommand\s+)(.*)$/m, (line, prefix, command) => {
    if (!command.includes("ssh-proxy")) {
      return line;
    }
    if (/(^|\s)--server(\s|=)|(^|\s)--gateway-endpoint(\s|=)/.test(command)) {
      return line;
    }
    return `${prefix}${command} --server ${shellEscape(endpoint)}`;
  });
}

export async function runTenkiCli(params: {
  context: TenkiExecContext;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
}): Promise<{ code: number; stdout: string; stderr: string }> {
  return await runPluginCommandWithTimeout({
    argv: [...buildTenkiBaseArgv(params.context.config), ...params.args],
    cwd: params.cwd,
    timeoutMs: params.timeoutMs ?? params.context.timeoutMs ?? params.context.config.timeoutMs,
    env: params.context.config.gatewayEndpoint ? { ...process.env, TENKI_API_ENDPOINT: params.context.config.gatewayEndpoint } : process.env,
  });
}

export async function createTenkiSshSession(params: {
  context: TenkiExecContext;
}): Promise<SshSandboxSession> {
  const result = await runTenkiCli({
    context: params.context,
    args: buildTenkiSshConfigArgs(params.context.sandboxName),
  });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || "tenki sandbox ssh-config failed");
  }
  return await createSshSandboxSessionFromConfigText({
    configText: applyGatewayEndpointToSshConfig({
      configText: result.stdout,
      gatewayEndpoint: params.context.config.gatewayEndpoint,
    }),
  });
}
