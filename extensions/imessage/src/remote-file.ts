// Stages gateway-local outbound files into a private directory on the Messages Mac.
import { randomUUID } from "node:crypto";
import path from "node:path";
import { normalizeScpRemoteHost } from "openclaw/plugin-sdk/host-runtime";
import { type CommandOptions, runCommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";

const SSH_OPTIONS = [
  "-o",
  "BatchMode=yes",
  "-o",
  "StrictHostKeyChecking=yes",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "ClearAllForwardings=yes",
  "-o",
  "ForwardAgent=no",
  "-o",
  "ForwardX11=no",
] as const;
const CLEANUP_TIMEOUT_MS = 10_000;
const log = createSubsystemLogger("channels/imessage");
const MAX_STAGING_NAME_BYTES = 200;
// Letters, digits and combining marks from any script, plus pictographs. ASCII shell
// metacharacters stay out because they are neither letters nor pictographs.
const STAGING_NAME_DISALLOWED = /[^\p{L}\p{N}\p{M}\p{Extended_Pictographic}._-]+/gu;

function cleanStagingSegment(value: string): string {
  return value
    .replace(/[\\/]+/gu, "-")
    .replace(STAGING_NAME_DISALLOWED, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/^[.-]+/u, "")
    .replace(/[.-]+$/u, "");
}

/**
 * Keep the attachment's display name for the remote copy. scp receives this as one
 * argued path, so only separators, control characters and shell metacharacters are
 * unsafe; collapsing non-ASCII names to hyphens delivered ".doc" to the recipient.
 */
function buildRemoteStagingFileName(basename: string): string {
  const extension = cleanStagingSegment(path.extname(basename).slice(0, 16));
  const stem = cleanStagingSegment(path.basename(basename, path.extname(basename))) || "attachment";
  const suffix = extension === "" ? "" : `.${extension}`;
  const name = `${stem}${suffix}`;
  if (Buffer.byteLength(name, "utf8") <= MAX_STAGING_NAME_BYTES) {
    return name;
  }
  // Cut on code points, not UTF-16 units, so a surrogate pair or emoji is never split.
  const budget = Math.max(1, MAX_STAGING_NAME_BYTES - Buffer.byteLength(suffix, "utf8"));
  let head = "";
  let used = 0;
  for (const character of stem) {
    const size = Buffer.byteLength(character, "utf8");
    if (used + size > budget) {
      break;
    }
    head += character;
    used += size;
  }
  return `${head}${suffix}`;
}

async function runChecked(label: string, argv: string[], options: CommandOptions): Promise<void> {
  const result = await runCommandWithTimeout(argv, {
    killProcessTree: true,
    maxOutputBytes: { stdout: 4 * 1024, stderr: 64 * 1024 },
    outputCapture: { stdout: "head", stderr: "tail" },
    ...options,
  });
  if (result.code !== 0 || result.termination !== "exit") {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(
      `${label} failed (${result.termination}${result.code === null ? "" : `, code ${result.code}`})${detail ? `: ${detail}` : ""}`,
    );
  }
}

export async function withIMessageRemoteFile<T>(params: {
  remoteHost: string;
  localPath: string;
  timeoutMs?: number;
  assertDirectAdapterHandoff?: () => void;
  use: (remotePath: string) => Promise<T>;
}): Promise<T> {
  const remoteHost = normalizeScpRemoteHost(params.remoteHost);
  if (!remoteHost) {
    throw new Error("invalid iMessage remoteHost for SSH/SCP staging");
  }
  const token = randomUUID().replaceAll("-", "");
  const remoteDir = `/tmp/openclaw-imessage-${token}`;
  const remotePath = `${remoteDir}/${buildRemoteStagingFileName(path.basename(params.localPath))}`;
  const createScript = `set -eu
umask 077
directory=${remoteDir}
trap 'rm -rf -- "$directory"' EXIT HUP INT TERM
mkdir -m 700 -- "$directory"
trap - EXIT HUP INT TERM
`;
  const cleanupScript = `set -eu
rm -rf -- ${remoteDir}
`;

  params.assertDirectAdapterHandoff?.();
  try {
    await runChecked(
      "iMessage remote temporary directory allocation",
      ["ssh", ...SSH_OPTIONS, "-T", "--", remoteHost, "sh -s"],
      { input: createScript, timeoutMs: params.timeoutMs },
    );
    params.assertDirectAdapterHandoff?.();
    await runChecked(
      "iMessage remote file upload",
      ["scp", ...SSH_OPTIONS, "--", params.localPath, `${remoteHost}:${remotePath}`],
      { timeoutMs: params.timeoutMs },
    );
    params.assertDirectAdapterHandoff?.();
    return await params.use(remotePath);
  } finally {
    try {
      // Cleanup gets its own bounded attempt after allocation, upload, or handoff failure.
      await runChecked(
        "iMessage remote file cleanup",
        ["ssh", ...SSH_OPTIONS, "-T", "--", remoteHost, "sh -s"],
        { input: cleanupScript, timeoutMs: CLEANUP_TIMEOUT_MS },
      );
    } catch (cleanupError) {
      const detail = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      log.warn(`remote attachment cleanup failed: ${detail}`);
    }
  }
}
