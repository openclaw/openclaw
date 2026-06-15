import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveRootPath } from "../../infra/boundary-path.js";
import { buildOwnedChildEnv, containsSecretValueInArgv } from "../../infra/owned-child-env.js";
import { parseSshTarget } from "../../infra/ssh-tunnel.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import {
  createRuntimeSecretRedactor,
  type SecretCategory,
} from "../../secrets/platform-runtime.js";
import { resolveUserPath } from "../../utils.js";
import type { SandboxBackendCommandResult } from "./backend-handle.types.js";
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
  identityDataCategory?: SecretCategory;
  certificateData?: string;
  knownHostsData?: string;
};

export type SshSandboxSession = {
  command: string;
  configPath: string;
  host: string;
};

export type RunSshSandboxCommandParams = {
  session: SshSandboxSession;
  remoteCommand: string;
  stdin?: Buffer | string;
  allowFailure?: boolean;
  signal?: AbortSignal;
  tty?: boolean;
  secretValues?: Record<string, string>;
};

const FIXED_HEREDOC_SCRIPTS = {
  "openclaw-sandbox-upload": [
    "set -euo pipefail",
    'script_id="${1:?script id required}"',
    'remote_dir="${2:?remote dir required}"',
    'if [ "$script_id" != "openclaw-sandbox-upload" ]; then exit 64; fi',
    'mkdir -p -- "$remote_dir"',
    'tar -xf - -C "$remote_dir"',
    "",
  ].join("\n"),
  "rockie-secret-runtime": [
    "set -euo pipefail",
    'script_id="${1:?script id required}"',
    'secret_name="${2:-SECRET}"',
    'if [ "$script_id" != "rockie-secret-runtime" ]; then exit 64; fi',
    "umask 077",
    'secret_file="$(mktemp)"',
    "trap 'rm -f \"$secret_file\"' EXIT",
    'cat > "$secret_file"',
    'printf "<redacted:%s>\\n" "$secret_name"',
    "",
  ].join("\n"),
} as const;

const FIXED_HEREDOC_REMOTE_WRAPPER = [
  "set -euo pipefail",
  'script_id="${1:?script id required}"',
  "shift",
  'case "$script_id" in openclaw-sandbox-upload|rockie-secret-runtime) ;; *) exit 64 ;; esac',
  "IFS= read -r script_size",
  'case "$script_size" in ""|*[!0-9]*) exit 64 ;; esac',
  "umask 077",
  'script_file="$(mktemp)"',
  "trap 'rm -f \"$script_file\"' EXIT",
  'dd bs=1 count="$script_size" of="$script_file" 2>/dev/null',
  'bash "$script_file" "$script_id" "$@"',
].join("\n");

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

type RuntimeSecretRedactor = ReturnType<typeof createRuntimeSecretRedactor>;

function redactBuffer(buffer: Buffer, redactor: RuntimeSecretRedactor | null): Buffer {
  if (!redactor) {
    return buffer;
  }
  return Buffer.from(redactor.redact(buffer.toString("utf8")), "utf8");
}

function redactErrorOutputValue(value: unknown, redactor: RuntimeSecretRedactor): unknown {
  if (Buffer.isBuffer(value)) {
    return redactBuffer(value, redactor);
  }
  if (typeof value === "string") {
    return redactor.redact(value);
  }
  return redactor.redactUnknown(value);
}

function redactSshError(error: unknown, redactor: RuntimeSecretRedactor | null): unknown {
  if (!redactor) {
    return error;
  }
  if (error instanceof Error) {
    error.message = redactor.redact(error.message);
    const record = error as Error & { stdout?: unknown; stderr?: unknown };
    if (record.stdout !== undefined) {
      record.stdout = redactErrorOutputValue(record.stdout, redactor);
    }
    if (record.stderr !== undefined) {
      record.stderr = redactErrorOutputValue(record.stderr, redactor);
    }
    return error;
  }
  return redactor.redactUnknown(error);
}

function requireSshIdentityDataCategory(category: SecretCategory | undefined): SecretCategory {
  if (!category) {
    throw new Error(
      "SSH identityData requires resolve-v2 category metadata before materialization. Use identityFile for path-based SSH identities until a platform-secret ssh_key path is wired.",
    );
  }
  return category;
}

export function shellEscape(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function buildRemoteCommand(argv: string[]): string {
  return argv.map((entry) => shellEscape(entry)).join(" ");
}

type ExecCommandQuoteState = "plain" | "single" | "double";

type ExecCommandFrame = {
  kind: "root" | "command-substitution" | "arithmetic" | "backtick";
  quote: ExecCommandQuoteState;
  escaping: boolean;
  parenDepth: number;
};

type HeredocMarker = {
  delimiter: string;
  stripLeadingTabs: boolean;
};

type PendingHeredoc = HeredocMarker & {
  frameDepth: number;
};

function assertValidExecRemoteCommand(command: string): void {
  // The SSH backend wraps model-provided shell text in `/bin/sh -c`. This parser
  // catches unbalanced syntax and unresolved placeholders before quoting it.
  const frames: ExecCommandFrame[] = [
    { kind: "root", quote: "plain", escaping: false, parenDepth: 0 },
  ];
  const pendingHeredocs: PendingHeredoc[] = [];

  for (let index = 0; index < command.length; index += 1) {
    const frame = frames.at(-1);
    if (!frame) {
      throw new Error("Malformed SSH/OpenShell exec command: parser state underflow.");
    }
    const char = command[index];

    if (frame.escaping) {
      frame.escaping = false;
      continue;
    }

    if (frame.quote === "single") {
      if (char === "'") {
        frame.quote = "plain";
      }
      continue;
    }

    if (char === "\\") {
      frame.escaping = true;
      continue;
    }

    if (frame.quote === "double") {
      if (char === '"') {
        frame.quote = "plain";
        continue;
      }
      if (char === "`") {
        frames.push(createExecCommandFrame("backtick"));
        continue;
      }
      if (char === "$" && command[index + 1] === "(" && command[index + 2] === "(") {
        frames.push(createExecCommandFrame("arithmetic", 2));
        index += 2;
        continue;
      }
      if (char === "$" && command[index + 1] === "(") {
        frames.push(createExecCommandFrame("command-substitution", 1));
        index += 1;
      }
      continue;
    }

    if (frame.kind === "arithmetic") {
      if (char === "(") {
        frame.parenDepth += 1;
        continue;
      }
      if (char === ")") {
        frame.parenDepth -= 1;
        if (frame.parenDepth === 0) {
          frames.pop();
        }
      }
      continue;
    }

    if (char === "\n") {
      const frameHeredocs = pendingHeredocs.filter(
        (pending) => pending.frameDepth === frames.length,
      );
      if (frameHeredocs.length > 0) {
        // Here-doc bodies are opaque shell payloads; skip them so placeholder
        // and quote checks only inspect executable syntax.
        index = skipHeredocBodies(command, index + 1, frameHeredocs) - 1;
        for (const pending of frameHeredocs) {
          pendingHeredocs.splice(pendingHeredocs.indexOf(pending), 1);
        }
        continue;
      }
    }

    if (frame.kind === "backtick" && char === "`") {
      frames.pop();
      continue;
    }
    if (char === "'") {
      frame.quote = "single";
      continue;
    }
    if (char === '"') {
      frame.quote = "double";
      continue;
    }
    if (char === "`") {
      frames.push(createExecCommandFrame("backtick"));
      continue;
    }
    if (char === "$" && command[index + 1] === "(" && command[index + 2] === "(") {
      frames.push(createExecCommandFrame("arithmetic", 2));
      index += 2;
      continue;
    }
    if (char === "$" && command[index + 1] === "(") {
      frames.push(createExecCommandFrame("command-substitution", 1));
      index += 1;
      continue;
    }
    if (char === "#" && isShellCommentStart(command, index)) {
      index = skipShellComment(command, index) - 1;
      continue;
    }
    if (char === "<") {
      const heredoc = readHeredoc(command, index);
      if (heredoc) {
        pendingHeredocs.push({
          ...heredoc.pending,
          frameDepth: frames.length,
        });
        index = heredoc.endIndex - 1;
        continue;
      }
      const placeholder = readPlaceholderToken(command, index);
      if (placeholder) {
        throw new Error(
          `Malformed SSH/OpenShell exec command: unresolved placeholder token ${placeholder}.`,
        );
      }
    }
    if (frame.kind === "command-substitution") {
      if (char === "(") {
        frame.parenDepth += 1;
        continue;
      }
      if (char === ")") {
        frame.parenDepth -= 1;
        if (frame.parenDepth === 0) {
          frames.pop();
        }
      }
    }
  }

  const openFrame = frames.at(-1);
  if (openFrame?.escaping) {
    throw new Error("Malformed SSH/OpenShell exec command: trailing backslash escape.");
  }
  if (pendingHeredocs.length > 0) {
    throw new Error(
      `Malformed SSH/OpenShell exec command: unterminated here-doc ${pendingHeredocs[0].delimiter}.`,
    );
  }
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const frame = frames[index];
    if (frame.quote === "single") {
      throw new Error("Malformed SSH/OpenShell exec command: unclosed single quote.");
    }
    if (frame.quote === "double") {
      throw new Error("Malformed SSH/OpenShell exec command: unclosed double quote.");
    }
    if (frame.kind === "backtick") {
      throw new Error(
        "Malformed SSH/OpenShell exec command: unterminated backtick command substitution.",
      );
    }
    if (frame.kind === "command-substitution") {
      throw new Error("Malformed SSH/OpenShell exec command: unterminated command substitution.");
    }
    if (frame.kind === "arithmetic") {
      throw new Error("Malformed SSH/OpenShell exec command: unterminated arithmetic expansion.");
    }
  }
}

export function buildValidatedExecRemoteCommand(params: {
  command: string;
  workdir?: string;
  env: Record<string, string>;
}): string {
  assertValidExecRemoteCommand(params.command);
  return buildExecRemoteCommand(params);
}

function createExecCommandFrame(kind: ExecCommandFrame["kind"], parenDepth = 0): ExecCommandFrame {
  return { kind, quote: "plain", escaping: false, parenDepth };
}

function readPlaceholderToken(command: string, index: number): string | null {
  const match = /^<[A-Za-z][A-Za-z0-9_-]*>/.exec(command.slice(index));
  if (!match) {
    return null;
  }
  if (command[index - 1] === "=") {
    return match[0];
  }
  if (isLikelyGeneratedWorkflowPlaceholder(command, index)) {
    return match[0];
  }
  const next = command[index + match[0].length];
  if (next === undefined || /[\r\n;&|)]/.test(next)) {
    return match[0];
  }
  if (next === " " || next === "\t") {
    return hasRedirectionTargetAfter(command, index + match[0].length) ? null : match[0];
  }
  return null;
}

function hasRedirectionTargetAfter(command: string, index: number): boolean {
  let cursor = index;
  while (command[cursor] === " " || command[cursor] === "\t") {
    cursor += 1;
  }
  return command[cursor] !== undefined && !/[;&|()<>\r\n]/.test(command[cursor]);
}

function isLikelyGeneratedWorkflowPlaceholder(command: string, index: number): boolean {
  const prefix = command.slice(0, index);
  const segmentStart =
    Math.max(
      prefix.lastIndexOf("\n"),
      prefix.lastIndexOf(";"),
      prefix.lastIndexOf("&"),
      prefix.lastIndexOf("|"),
      prefix.lastIndexOf("("),
      prefix.lastIndexOf("`"),
    ) + 1;
  const currentCommand = prefix.slice(segmentStart).trim();
  return /^workflow(?:\s+[A-Za-z0-9._/-]+)*$/.test(currentCommand);
}

function readHeredoc(
  command: string,
  index: number,
): { pending: HeredocMarker; endIndex: number } | null {
  if (command[index + 1] !== "<" || command[index + 2] === "<") {
    return null;
  }
  let cursor = index + 2;
  const stripLeadingTabs = command[cursor] === "-";
  if (stripLeadingTabs) {
    cursor += 1;
  }
  while (command[cursor] === " " || command[cursor] === "\t") {
    cursor += 1;
  }
  const delimiter = readHeredocDelimiter(command, cursor);
  if (!delimiter) {
    throw new Error("Malformed SSH/OpenShell exec command: missing here-doc delimiter.");
  }
  return {
    pending: { delimiter: delimiter.value, stripLeadingTabs },
    endIndex: delimiter.endIndex,
  };
}

function readHeredocDelimiter(
  command: string,
  index: number,
): { value: string; endIndex: number } | null {
  let cursor = index;
  let delimiter = "";
  let quote: ExecCommandQuoteState = "plain";
  let escaping = false;
  while (cursor < command.length) {
    const char = command[cursor];
    if (escaping) {
      delimiter += char;
      escaping = false;
      cursor += 1;
      continue;
    }
    if (quote === "single") {
      if (char === "'") {
        quote = "plain";
      } else {
        delimiter += char;
      }
      cursor += 1;
      continue;
    }
    if (quote === "double") {
      if (char === '"') {
        quote = "plain";
      } else if (char === "\\") {
        escaping = true;
      } else {
        delimiter += char;
      }
      cursor += 1;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      cursor += 1;
      continue;
    }
    if (char === "'") {
      quote = "single";
      cursor += 1;
      continue;
    }
    if (char === '"') {
      quote = "double";
      cursor += 1;
      continue;
    }
    if (isHeredocDelimiterTerminator(char)) {
      break;
    }
    delimiter += char;
    cursor += 1;
  }
  if (quote !== "plain" || escaping) {
    throw new Error("Malformed SSH/OpenShell exec command: unterminated here-doc delimiter.");
  }
  return delimiter ? { value: delimiter, endIndex: cursor } : null;
}

function isHeredocDelimiterTerminator(char: string | undefined): boolean {
  return (
    char === undefined || /\s/.test(char) || [";", "&", "|", "(", ")", "<", ">"].includes(char)
  );
}

function skipHeredocBodies(
  command: string,
  index: number,
  pendingHeredocs: PendingHeredoc[],
): number {
  let cursor = index;
  for (const pending of pendingHeredocs) {
    let found = false;
    while (cursor <= command.length) {
      const lineEnd = command.indexOf("\n", cursor);
      const endIndex = lineEnd === -1 ? command.length : lineEnd;
      const rawLine = command.slice(cursor, endIndex);
      const normalizedLine = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      const line = pending.stripLeadingTabs ? normalizedLine.replace(/^\t+/, "") : normalizedLine;
      cursor = lineEnd === -1 ? command.length : lineEnd + 1;
      if (line === pending.delimiter) {
        found = true;
        break;
      }
      if (lineEnd === -1) {
        break;
      }
    }
    if (!found) {
      throw new Error(
        `Malformed SSH/OpenShell exec command: unterminated here-doc ${pending.delimiter}.`,
      );
    }
  }
  return cursor;
}

function isShellCommentStart(command: string, index: number): boolean {
  const previous = command[index - 1];
  return previous === undefined || /[\s;&|()]/.test(previous);
}

function skipShellComment(command: string, index: number): number {
  const newlineIndex = command.indexOf("\n", index);
  return newlineIndex === -1 ? command.length : newlineIndex;
}

export function buildExecRemoteCommand(params: {
  command: string;
  workdir?: string;
  env: Record<string, string>;
}): string {
  const body = params.workdir
    ? `cd ${shellEscape(params.workdir)} && ${params.command}`
    : params.command;
  const argv =
    Object.keys(params.env).length > 0
      ? [
          "env",
          ...Object.entries(params.env).map(([key, value]) => `${key}=${value}`),
          "/bin/sh",
          "-c",
          body,
        ]
      : ["/bin/sh", "-c", body];
  return buildRemoteCommand(argv);
}

export function buildSshSandboxArgv(params: {
  session: SshSandboxSession;
  remoteCommand: string;
  tty?: boolean;
}): string[] {
  return [
    params.session.command,
    "-F",
    params.session.configPath,
    ...(params.tty
      ? ["-tt", "-o", "RequestTTY=force", "-o", "SetEnv=TERM=xterm-256color"]
      : ["-T", "-o", "RequestTTY=no"]),
    params.session.host,
    params.remoteCommand,
  ];
}

export function assertNoSecretValuesInArgv(
  argv: readonly string[],
  secretValues: Record<string, string> | undefined,
): void {
  if (!secretValues || Object.keys(secretValues).length === 0) {
    return;
  }
  if (containsSecretValueInArgv(argv, Object.values(secretValues))) {
    throw new Error("Refusing to spawn SSH child with a resolved secret in argv.");
  }
}

export function buildFixedSshHeredocRemoteCommand(params: {
  scriptId: string;
  args?: readonly string[];
}): string {
  if (!(params.scriptId in FIXED_HEREDOC_SCRIPTS)) {
    throw new Error(`Unreviewed SSH heredoc script id: ${params.scriptId}`);
  }
  return buildRemoteCommand([
    "bash",
    "-c",
    FIXED_HEREDOC_REMOTE_WRAPPER,
    "openclaw-fixed-heredoc",
    params.scriptId,
    ...(params.args ?? []),
  ]);
}

function buildFixedSshHeredocPayloadPrefix(scriptId: keyof typeof FIXED_HEREDOC_SCRIPTS): Buffer {
  const script = FIXED_HEREDOC_SCRIPTS[scriptId];
  const scriptBuffer = Buffer.from(script.endsWith("\n") ? script : `${script}\n`, "utf8");
  return Buffer.concat([Buffer.from(`${scriptBuffer.length}\n`, "utf8"), scriptBuffer]);
}

export async function runFixedSshHeredocScript(params: {
  session: SshSandboxSession;
  scriptId: keyof typeof FIXED_HEREDOC_SCRIPTS;
  args?: readonly string[];
  stdin?: Buffer | string;
  secretValues: Record<string, string>;
  signal?: AbortSignal;
}): Promise<SandboxBackendCommandResult> {
  const remoteCommand = buildFixedSshHeredocRemoteCommand({
    scriptId: params.scriptId,
    args: params.args,
  });
  const payload = Buffer.concat([
    buildFixedSshHeredocPayloadPrefix(params.scriptId),
    typeof params.stdin === "string"
      ? Buffer.from(params.stdin, "utf8")
      : (params.stdin ?? Buffer.alloc(0)),
  ]);
  const redactor = createRuntimeSecretRedactor(params.secretValues);
  try {
    const result = await runSshSandboxCommand({
      session: params.session,
      remoteCommand,
      stdin: payload,
      signal: params.signal,
      secretValues: params.secretValues,
    });
    return {
      ...result,
      stdout: Buffer.from(redactor.redact(result.stdout.toString("utf8")), "utf8"),
      stderr: Buffer.from(redactor.redact(result.stderr.toString("utf8")), "utf8"),
    };
  } finally {
    redactor.close();
  }
}

export async function createSshSandboxSessionFromConfigText(params: {
  configText: string;
  host?: string;
  command?: string;
}): Promise<SshSandboxSession> {
  const host = params.host?.trim() || parseSshConfigHost(params.configText);
  if (!host) {
    throw new Error("Failed to parse SSH config output.");
  }
  const configDir = await fs.mkdtemp(path.join(resolveSshTmpRoot(), "openclaw-sandbox-ssh-"));
  const configPath = path.join(configDir, "config");
  await fs.writeFile(configPath, params.configText, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(configPath, 0o600);
  return {
    command: params.command?.trim() || "ssh",
    configPath,
    host,
  };
}

export async function createSshSandboxSessionFromSettings(
  settings: SshSandboxSettings,
): Promise<SshSandboxSession> {
  const parsed = parseSshTarget(settings.target);
  if (!parsed) {
    throw new Error(`Invalid sandbox SSH target: ${settings.target}`);
  }

  const configDir = await fs.mkdtemp(path.join(resolveSshTmpRoot(), "openclaw-sandbox-ssh-"));
  try {
    const materializedIdentity = settings.identityData
      ? await writeResolvedSshKeyTempfile({
          dir: configDir,
          value: settings.identityData,
          category: requireSshIdentityDataCategory(settings.identityDataCategory),
        })
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
    const hostAlias = "openclaw-sandbox";
    const configPath = path.join(configDir, "config");
    const lines = [
      `Host ${hostAlias}`,
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
      lines.push(`  UserKnownHostsFile ${knownHostsFile}`);
    } else if (!settings.strictHostKeyChecking) {
      lines.push("  UserKnownHostsFile /dev/null");
    }
    if (identityFile) {
      lines.push(`  IdentityFile ${identityFile}`);
    }
    if (certificateFile) {
      lines.push(`  CertificateFile ${certificateFile}`);
    }
    if (identityFile || certificateFile) {
      lines.push("  IdentitiesOnly yes");
    }
    await fs.writeFile(configPath, `${lines.join("\n")}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.chmod(configPath, 0o600);
    return {
      command: settings.command.trim() || "ssh",
      configPath,
      host: hostAlias,
    };
  } catch (error) {
    await fs.rm(configDir, { recursive: true, force: true });
    throw error;
  }
}

export async function disposeSshSandboxSession(session: SshSandboxSession): Promise<void> {
  await fs.rm(path.dirname(session.configPath), { recursive: true, force: true });
}

export async function runSshSandboxCommand(
  params: RunSshSandboxCommandParams,
): Promise<SandboxBackendCommandResult> {
  const argv = buildSshSandboxArgv({
    session: params.session,
    remoteCommand: params.remoteCommand,
    tty: params.tty,
  });
  assertNoSecretValuesInArgv(argv, params.secretValues);
  const sshEnv = sanitizeEnvVars(buildOwnedChildEnv()).allowed;
  const redactor =
    params.secretValues && Object.keys(params.secretValues).length > 0
      ? createRuntimeSecretRedactor(params.secretValues)
      : null;
  try {
    return await new Promise<SandboxBackendCommandResult>((resolve, reject) => {
      const child = spawn(argv[0], argv.slice(1), {
        stdio: ["pipe", "pipe", "pipe"],
        env: sshEnv,
        signal: params.signal,
      });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
      child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
      child.on("error", (error) => reject(redactSshError(error, redactor)));
      child.on("close", (code) => {
        const stdout = redactBuffer(Buffer.concat(stdoutChunks), redactor);
        const stderr = redactBuffer(Buffer.concat(stderrChunks), redactor);
        const exitCode = code ?? 0;
        if (exitCode !== 0 && !params.allowFailure) {
          reject(
            Object.assign(new Error(buildSshFailureMessage(stderr.toString("utf8"), exitCode)), {
              code: exitCode,
              stdout,
              stderr,
            }),
          );
          return;
        }
        resolve({ stdout, stderr, code: exitCode });
      });

      if (params.stdin !== undefined) {
        child.stdin.end(params.stdin);
        return;
      }
      child.stdin.end();
    });
  } finally {
    redactor?.close();
  }
}

export async function uploadDirectoryToSshTarget(params: {
  session: SshSandboxSession;
  localDir: string;
  remoteDir: string;
  signal?: AbortSignal;
}): Promise<void> {
  await assertSafeUploadSymlinks(params.localDir);
  const remoteCommand = buildFixedSshHeredocRemoteCommand({
    scriptId: "openclaw-sandbox-upload",
    args: [params.remoteDir],
  });
  const sshArgv = buildSshSandboxArgv({
    session: params.session,
    remoteCommand,
  });
  const sshEnv = sanitizeEnvVars(buildOwnedChildEnv()).allowed;
  await new Promise<void>((resolve, reject) => {
    const tar = spawn("tar", ["-C", params.localDir, "-cf", "-", "."], {
      stdio: ["ignore", "pipe", "pipe"],
      env: buildOwnedChildEnv(),
      signal: params.signal,
    });
    const ssh = spawn(sshArgv[0], sshArgv.slice(1), {
      stdio: ["pipe", "pipe", "pipe"],
      env: sshEnv,
      signal: params.signal,
    });
    const tarStderr: Buffer[] = [];
    const sshStdout: Buffer[] = [];
    const sshStderr: Buffer[] = [];
    let tarClosed = false;
    let sshClosed = false;
    let tarCode = 0;
    let sshCode = 0;

    tar.stderr.on("data", (chunk) => tarStderr.push(Buffer.from(chunk)));
    ssh.stdout.on("data", (chunk) => sshStdout.push(Buffer.from(chunk)));
    ssh.stderr.on("data", (chunk) => sshStderr.push(Buffer.from(chunk)));

    const fail = (error: unknown) => {
      tar.kill("SIGKILL");
      ssh.kill("SIGKILL");
      reject(error);
    };

    tar.on("error", fail);
    ssh.on("error", fail);
    const pipeTarArchive = () => {
      tar.stdout.pipe(ssh.stdin);
    };
    if (!ssh.stdin.write(buildFixedSshHeredocPayloadPrefix("openclaw-sandbox-upload"))) {
      ssh.stdin.once("drain", pipeTarArchive);
    } else {
      pipeTarArchive();
    }

    tar.on("close", (code) => {
      tarClosed = true;
      tarCode = code ?? 0;
      maybeResolve();
    });
    ssh.on("close", (code) => {
      sshClosed = true;
      sshCode = code ?? 0;
      maybeResolve();
    });

    function maybeResolve() {
      if (!tarClosed || !sshClosed) {
        return;
      }
      if (tarCode !== 0) {
        reject(
          new Error(
            Buffer.concat(tarStderr).toString("utf8").trim() || `tar exited with code ${tarCode}`,
          ),
        );
        return;
      }
      if (sshCode !== 0) {
        reject(
          new Error(
            Buffer.concat(sshStderr).toString("utf8").trim() || `ssh exited with code ${sshCode}`,
          ),
        );
        return;
      }
      resolve();
    }
  });
}

async function assertSafeUploadSymlinks(localDir: string): Promise<void> {
  const rootDir = path.resolve(localDir);
  await walkDirectory(rootDir);

  async function walkDirectory(currentDir: string): Promise<void> {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isSymbolicLink()) {
        try {
          await resolveRootPath({
            absolutePath: entryPath,
            rootPath: rootDir,
            boundaryLabel: "SSH sandbox upload tree",
          });
        } catch (error) {
          const relativePath = path.relative(rootDir, entryPath).split(path.sep).join("/");
          throw new Error(
            `SSH sandbox upload refuses symlink escaping the workspace: ${relativePath}`,
            { cause: error },
          );
        }
        continue;
      }
      if (entry.isDirectory()) {
        await walkDirectory(entryPath);
      }
    }
  }
}

function parseSshConfigHost(configText: string): string | null {
  const hostMatch = configText.match(/^\s*Host\s+(\S+)/m);
  return hostMatch?.[1]?.trim() || null;
}

function resolveSshTmpRoot(): string {
  return path.resolve(resolvePreferredOpenClawTmpDir() ?? os.tmpdir());
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
  await fs.writeFile(pathname, normalizeInlineSshMaterial(contents, filename), {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.chmod(pathname, 0o600);
  return pathname;
}

export async function writeResolvedSshKeyTempfile(params: {
  dir: string;
  value: string;
  category: SecretCategory;
}): Promise<string> {
  if (params.category !== "ssh_key") {
    throw new Error("SSH key material requires secret category ssh_key.");
  }
  return await writeSecretMaterial(params.dir, "identity", params.value);
}
