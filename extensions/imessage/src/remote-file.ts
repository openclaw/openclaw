// Stages gateway-local outbound files into a private directory on the Messages Mac.
import { randomUUID } from "node:crypto";
import path from "node:path";
import { normalizeScpRemoteHost } from "openclaw/plugin-sdk/host-runtime";
import { type CommandOptions, runCommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { sanitizeTempFileName } from "openclaw/plugin-sdk/temp-path";

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
  signal?: AbortSignal;
  assertDirectAdapterHandoff?: () => void;
  use: (remotePath: string) => Promise<T>;
}): Promise<T> {
  const remoteHost = normalizeScpRemoteHost(params.remoteHost);
  if (!remoteHost) {
    throw new Error("invalid iMessage remoteHost for SSH/SCP staging");
  }
  const token = randomUUID().replaceAll("-", "");
  const remoteDir = `/tmp/openclaw-imessage-${token}`;
  const remotePath = `${remoteDir}/${sanitizeTempFileName(path.basename(params.localPath))}`;
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
      { input: createScript, timeoutMs: params.timeoutMs, signal: params.signal },
    );
    params.assertDirectAdapterHandoff?.();
    await runChecked(
      "iMessage remote file upload",
      ["scp", ...SSH_OPTIONS, "--", params.localPath, `${remoteHost}:${remotePath}`],
      { timeoutMs: params.timeoutMs, signal: params.signal },
    );
    params.assertDirectAdapterHandoff?.();
    return await params.use(remotePath);
  } finally {
    try {
      // An aborted caller may still own a remote file, so cleanup gets its own
      // bounded attempt without reusing the already-aborted signal.
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
