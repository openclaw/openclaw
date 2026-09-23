/**
 * SSH sandbox transport helpers.
 *
 * Materializes temporary SSH config, validates remote shell snippets, runs commands, and uploads workspace trees.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseSshTarget } from "../../infra/ssh-tunnel.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import { resolveUserPath } from "../../utils.js";
import type { SandboxBackendCommandResult } from "./backend-handle.types.js";
import {
  createRemoteShellSandboxSession,
  type RemoteShellSandboxSession,
} from "./remote-shell-transport.js";
import { sanitizeEnvVars } from "./sanitize-env-vars.js";

export type SshSandboxSettings = {
  command: string;
  target: string;
  strictHostKeyChecking: boolean;
  updateHostKeys: boolean;
  identityFile?: string;
  certificateFile?: string;
  knownHostsFile?: string;
  identityData?: string;
  certificateData?: string;
  knownHostsData?: string;
};

/** Temporary SSH session descriptor with an isolated config file. */
export type SshSandboxSession = {
  command: string;
  configPath: string;
  host: string;
  /** Revalidate runtime authority after asynchronous upload preparation. */
  assertCurrent?: () => void;
};

/** Parameters for one SSH sandbox command execution. */
export type RunSshSandboxCommandParams = {
  session: SshSandboxSession;
  remoteCommand: string;
  stdin?: Buffer | string;
  allowFailure?: boolean;
  signal?: AbortSignal;
  tty?: boolean;
};

function normalizeInlineSshMaterial(contents: string, filename: string): string {
  const withoutBom = contents.replace(/^\uFEFF/, "");
  const normalizedNewlines = withoutBom.replace(/\r\n?/g, "\n");
  const normalizedEscapedNewlines = normalizedNewlines
    .replace(/\\r\\n/g, "\\n")
    .replace(/\\r/g, "\\n");
  const expanded =
    filename === "identity" || filename === "certificate.pub"
      ? normalizedEscapedNewlines.replace(/\\n/g, "\n")
      : normalizedEscapedNewlines;
  return expanded.endsWith("\n") ? expanded : `${expanded}\n`;
}

function buildSshFailureMessage(stderr: string, exitCode?: number): string {
  const trimmed = stderr.trim();
  if (
    trimmed.includes("error in libcrypto") &&
    (trimmed.includes('Load key "') || trimmed.includes("Permission denied (publickey)"))
  ) {
    return `${trimmed}\nSSH sandbox failed to load the configured identity. The private key contents may be malformed (for example CRLF or escaped newlines). Prefer identityFile when possible.`;
  }
  return (
    trimmed ||
    (exitCode !== undefined
      ? `ssh exited with code ${exitCode}`
      : "ssh exited with a non-zero status")
  );
}

/** Build the local ssh argv for a prepared sandbox session. */
export function buildSshSandboxArgv(params: {
  session: SshSandboxSession;
  remoteCommand: string;
  tty?: boolean;
}): string[] {
  return [
    params.session.command,
    "-F",
    params.session.configPath,
    ...(params.tty ? ["-tt", "-o", "RequestTTY=force"] : ["-T", "-o", "RequestTTY=no"]),
    params.session.host,
    params.remoteCommand,
  ];
}

/** Create a temporary SSH session from already-rendered ssh config text. */
export async function createSshSandboxSessionFromConfigText(params: {
  configText: string;
  host?: string;
  command?: string;
}): Promise<SshSandboxSession> {
  const host = params.host?.trim() || parseSshConfigHost(params.configText);
  if (!host) {
    throw new Error("Failed to parse SSH config output.");
  }
  return await createSshSandboxSession(
    params.command?.trim() || "ssh",
    host,
    () => params.configText,
  );
}

/** Create a temporary SSH session from structured sandbox SSH settings. */
export async function createSshSandboxSessionFromSettings(
  settings: SshSandboxSettings,
): Promise<SshSandboxSession> {
  const parsed = parseSshTarget(settings.target);
  if (!parsed) {
    throw new Error(`Invalid sandbox SSH target: ${settings.target}`);
  }

  return await createSshSandboxSession(
    settings.command.trim() || "ssh",
    "openclaw-sandbox",
    async (configDir) => {
      // Inline secret material is written into the temp config dir with strict
      // permissions so ssh can consume it without exposing values in argv/env.
      const materializedIdentity = settings.identityData
        ? await writeSecretMaterial(configDir, "identity", settings.identityData)
        : undefined;
      const materializedCertificate = settings.certificateData
        ? await writeSecretMaterial(configDir, "certificate.pub", settings.certificateData)
        : undefined;
      const materializedKnownHosts = settings.knownHostsData
        ? await writeSecretMaterial(configDir, "known_hosts", settings.knownHostsData)
        : undefined;
      const identityFile = materializedIdentity ?? resolveOptionalLocalPath(settings.identityFile);
      const certificateFile =
        materializedCertificate ?? resolveOptionalLocalPath(settings.certificateFile);
      const knownHostsFile =
        materializedKnownHosts ?? resolveOptionalLocalPath(settings.knownHostsFile);
      assertSshConfigLineValue(identityFile, "identityFile");
      assertSshConfigLineValue(certificateFile, "certificateFile");
      assertSshConfigLineValue(knownHostsFile, "knownHostsFile");
      const lines = [
        "Host openclaw-sandbox",
        `  HostName ${parsed.host}`,
        `  Port ${parsed.port}`,
        "  BatchMode yes",
        "  ConnectTimeout 5",
        "  ServerAliveInterval 15",
        "  ServerAliveCountMax 3",
        `  StrictHostKeyChecking ${settings.strictHostKeyChecking ? "yes" : "no"}`,
        `  UpdateHostKeys ${settings.updateHostKeys ? "yes" : "no"}`,
      ];
      if (parsed.user) {
        lines.push(`  User ${parsed.user}`);
      }
      if (knownHostsFile) {
        lines.push(`  UserKnownHostsFile ${quoteSshConfigPath(knownHostsFile)}`);
      } else if (!settings.strictHostKeyChecking) {
        lines.push("  UserKnownHostsFile /dev/null");
      }
      if (identityFile) {
        lines.push(`  IdentityFile ${quoteSshConfigPath(identityFile)}`);
      }
      if (certificateFile) {
        lines.push(`  CertificateFile ${quoteSshConfigPath(certificateFile)}`);
      }
      if (identityFile || certificateFile) {
        lines.push("  IdentitiesOnly yes");
      }
      return `${lines.join("\n")}\n`;
    },
  );
}

/** Remove temporary SSH config and materialized secret files. */
export async function disposeSshSandboxSession(session: SshSandboxSession): Promise<void> {
  await fs.rm(path.dirname(session.configPath), { recursive: true, force: true });
}

function commandSession(session: SshSandboxSession): RemoteShellSandboxSession {
  return createRemoteShellSandboxSession({
    buildCommand: ({ remoteCommand, tty }) => ({
      argv: buildSshSandboxArgv({ session, remoteCommand, tty }),
      env: sanitizeEnvVars(process.env).allowed,
    }),
    assertCurrent: session.assertCurrent,
    formatFailure: buildSshFailureMessage,
  });
}

/** Run a remote command through SSH and return buffered stdout/stderr. */
export async function runSshSandboxCommand(
  params: RunSshSandboxCommandParams,
): Promise<SandboxBackendCommandResult> {
  return commandSession(params.session).runCommand(params);
}

/** Stage exec environment privately, keeping the established SSH cleanup contract. */
export async function prepareSshSandboxExec(params: {
  session: SshSandboxSession;
  remoteCommand: string;
  env: Record<string, string>;
  tty?: boolean;
}): Promise<{ argv: string[]; cleanup: () => Promise<void> }> {
  const prepared = await commandSession(params.session).prepareExec(params);
  return { argv: prepared.argv, cleanup: prepared.cleanup };
}

/** Stream a local directory with the shared guarded tar pipeline. */
export async function uploadDirectoryToSshTarget(params: {
  session: SshSandboxSession;
  localDir: string;
  remoteDir: string;
  remoteRootDir?: string;
  signal?: AbortSignal;
}): Promise<void> {
  return commandSession(params.session).uploadDirectory(params);
}

function parseSshConfigHost(configText: string): string | null {
  const hostMatch = configText.match(/^\s*Host\s+(\S+)/m);
  return hostMatch?.[1]?.trim() || null;
}

function resolveSshTmpRoot(): string {
  return path.resolve(resolvePreferredOpenClawTmpDir() ?? os.tmpdir());
}

async function createSshSandboxSession(
  command: string,
  host: string,
  buildConfigText: (configDir: string) => string | Promise<string>,
): Promise<SshSandboxSession> {
  const configDir = await fs.mkdtemp(path.join(resolveSshTmpRoot(), "openclaw-sandbox-ssh-"));
  const configPath = path.join(configDir, "config");
  try {
    await writePrivateFile(configPath, await buildConfigText(configDir));
    return { command, configPath, host };
  } catch (error) {
    // Best-effort rollback must not replace the initialization failure.
    await fs.rm(configDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function assertSshConfigLineValue(value: string | undefined, field: string): void {
  if (value && /[\r\n"]/.test(value)) {
    throw new Error(`SSH sandbox ${field} must not contain line breaks or double quotes.`);
  }
}

// ssh_config tokenizes unquoted arguments on whitespace; default macOS key
// locations ("Application Support") would otherwise parse as extra arguments.
function quoteSshConfigPath(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

function resolveOptionalLocalPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? resolveUserPath(trimmed) : undefined;
}

async function writeSecretMaterial(
  dir: string,
  filename: string,
  contents: string,
): Promise<string> {
  const pathname = path.join(dir, filename);
  await writePrivateFile(pathname, normalizeInlineSshMaterial(contents, filename));
  return pathname;
}

async function writePrivateFile(pathname: string, contents: string): Promise<void> {
  await fs.writeFile(pathname, contents, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(pathname, 0o600);
}

export {
  shellEscape,
  buildRemoteCommand,
  buildExecRemoteCommand,
  buildValidatedExecRemoteCommand,
  buildRemoteWorkdirValidationCommand,
} from "./remote-shell-command.js";
