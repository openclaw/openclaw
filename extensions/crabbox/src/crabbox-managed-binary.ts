import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { extractArchive } from "openclaw/plugin-sdk/archive";
import { extractErrorCode, toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { buildTimeoutAbortSignal } from "openclaw/plugin-sdk/extension-shared";
import { withFileLock } from "openclaw/plugin-sdk/file-lock";
import { runCommandWithTimeout, type SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import type { CrabboxCommandRunner } from "./crabbox-worker-command.js";

export const CRABBOX_MIN_VERSION = "0.55.0";
const RELEASE_URL = `https://github.com/openclaw/crabbox/releases/download/v${CRABBOX_MIN_VERSION}`;
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const VERSION_TIMEOUT_MS = 5_000;
const DOWNLOAD_IDLE_TIMEOUT_MS = 30_000;
const DOWNLOAD_TOTAL_TIMEOUT_MS = 10 * 60_000;

type CrabboxVersionProbe =
  | { status: "supported"; version: string }
  | { status: "outdated"; version: string }
  | { status: "indeterminate"; reason: string };

export async function probeCrabboxVersion(
  binary: string,
  runCommand: CrabboxCommandRunner = runCommandWithTimeout,
  signal?: AbortSignal,
): Promise<CrabboxVersionProbe> {
  signal?.throwIfAborted();
  let result: SpawnResult;
  try {
    result = await runCommand([binary, "--version"], {
      killProcessTree: true,
      maxOutputBytes: 64 * 1024,
      timeoutMs: VERSION_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
    });
  } catch {
    signal?.throwIfAborted();
    return { status: "indeterminate", reason: "version command could not start" };
  }
  signal?.throwIfAborted();
  if (result.termination !== "exit" || result.code !== 0 || result.outputLimitExceeded) {
    return {
      status: "indeterminate",
      reason: result.outputLimitExceeded
        ? "version output exceeded 64 KiB"
        : result.termination === "timeout"
          ? `version command timed out after ${VERSION_TIMEOUT_MS} ms`
          : `version command failed (${result.termination}, code ${result.code ?? "unknown"})`,
    };
  }
  const match =
    /(?:^|\s)v?((\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?:\s|$)/u.exec(
      `${result.stdout}\n${result.stderr}`,
    );
  if (!match) {
    return { status: "indeterminate", reason: "version output was not recognized" };
  }
  const current = [Number(match[2]), Number(match[3]), Number(match[4])];
  if (current.some((part) => !Number.isSafeInteger(part))) {
    return { status: "indeterminate", reason: "version output was not recognized" };
  }
  const minimum = CRABBOX_MIN_VERSION.split(".").map(Number);
  const difference = current.findIndex((part, index) => part !== minimum[index]);
  const supported = difference === -1 ? !match[5] : current[difference]! > minimum[difference]!;
  return { status: supported ? "supported" : "outdated", version: match[1]! };
}

function releaseTarget() {
  const platform = process.platform === "win32" ? "windows" : process.platform;
  const arch = process.arch === "x64" ? "amd64" : process.arch;
  if (!["darwin", "linux", "windows"].includes(platform) || !["amd64", "arm64"].includes(arch)) {
    throw new Error(`Crabbox has no managed release for ${process.platform}/${process.arch}`);
  }
  const extension = platform === "windows" ? "zip" : "tar.gz";
  return {
    directory: `${platform}-${arch}`,
    executable: platform === "windows" ? "crabbox.exe" : "crabbox",
    asset: `crabbox_${CRABBOX_MIN_VERSION}_${platform}_${arch}.${extension}`,
    tar: extension === "tar.gz",
  };
}

export function resolveManagedCrabboxBinaryPath(env: NodeJS.ProcessEnv = process.env): string {
  const target = releaseTarget();
  return path.join(
    resolveStateDir(env),
    "tools",
    "crabbox",
    CRABBOX_MIN_VERSION,
    target.directory,
    target.executable,
  );
}

async function downloadReleaseFile(name: string, maxBytes: number, signal: AbortSignal) {
  const deadline = buildTimeoutAbortSignal({
    timeoutMs: DOWNLOAD_TOTAL_TIMEOUT_MS,
    signal,
    operation: "crabbox-release-download",
  });
  const { response, release, refreshTimeout } = await fetchWithSsrFGuard({
    url: `${RELEASE_URL}/${name}`,
    requireHttps: true,
    timeoutMs: DOWNLOAD_IDLE_TIMEOUT_MS,
    signal: deadline.signal,
    policy: { hostnameAllowlist: ["github.com", "release-assets.githubusercontent.com"] },
    auditContext: "crabbox-managed-release",
  }).catch((error: unknown) => {
    deadline.cleanup();
    throw error;
  });
  try {
    if (!response.ok) {
      throw new Error(`Crabbox release download failed for ${name} (HTTP ${response.status})`);
    }
    if (Number(response.headers.get("content-length")) > maxBytes) {
      throw new Error(`Crabbox release file ${name} exceeds ${maxBytes} bytes`);
    }
    if (!response.body) {
      throw new Error(`Crabbox release file ${name} has no response body`);
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        deadline.signal?.throwIfAborted();
        const { done, value } = await reader.read();
        deadline.signal?.throwIfAborted();
        if (done) {
          return Buffer.concat(chunks, size);
        }
        if (value.byteLength === 0) {
          continue;
        }
        size += value.byteLength;
        if (size > maxBytes) {
          throw new Error(`Crabbox release file ${name} exceeds ${maxBytes} bytes`);
        }
        // Healthy release transfers can take minutes; retain a separate cap on total time.
        refreshTimeout?.();
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  } finally {
    deadline.cleanup();
    await response.body?.cancel().catch(() => undefined);
    await release();
  }
}

async function probeInstallation(
  binary: string,
  runCommand: CrabboxCommandRunner,
  signal: AbortSignal,
) {
  const stat = await fs.lstat(binary).catch(() => undefined);
  return (
    stat?.isFile() && (await probeCrabboxVersion(binary, runCommand, signal)).status === "supported"
  );
}

async function inspectInstallationDirectory(destination: string) {
  let stat;
  try {
    stat = await fs.lstat(destination);
  } catch (error) {
    if (extractErrorCode(error) === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Managed Crabbox destination must be a regular directory: ${destination}`);
  }
  return stat;
}

async function publishInstallation(params: {
  binary: string;
  payload: string;
  runCommand: CrabboxCommandRunner;
  signal: AbortSignal;
}): Promise<void> {
  const { binary, payload, runCommand, signal } = params;
  const destination = path.dirname(binary);
  await withFileLock(
    `${destination}.publication`,
    {
      retries: { retries: 100, factor: 1, minTimeout: 100, maxTimeout: 100 },
      stale: 120_000,
      staleRecovery: "remove-if-definitely-stale",
    },
    async () => {
      signal.throwIfAborted();
      const existing = await inspectInstallationDirectory(destination);
      if (existing && (await probeInstallation(binary, runCommand, signal))) {
        return;
      }
      signal.throwIfAborted();
      let recovery: string | undefined;
      if (existing) {
        recovery = `${destination}.recovery-${randomUUID()}`;
        // Preserve damaged installations, including files we did not create, outside staging cleanup.
        await fs.rename(destination, recovery);
      }
      try {
        signal.throwIfAborted();
        // Publish the whole distribution so Darwin companion executables stay beside the CLI.
        await fs.rename(payload, destination);
      } catch (error) {
        // Cooperating installers hold the same lock. Retain ambiguous externally changed state.
        if (recovery) {
          try {
            if (!(await inspectInstallationDirectory(destination))) {
              await fs.rename(recovery, destination);
              recovery = undefined;
            }
          } catch (restoreError) {
            throw new AggregateError(
              [error, restoreError],
              `Crabbox publication failed; previous installation is preserved at ${recovery}`,
              { cause: restoreError },
            );
          }
        }
        if (
          !signal.aborted &&
          (await inspectInstallationDirectory(destination)) &&
          (await probeInstallation(binary, runCommand, signal))
        ) {
          return;
        }
        if (recovery) {
          throw new Error(
            `Crabbox publication failed; previous installation is preserved at ${recovery}`,
            { cause: error },
          );
        }
        throw error;
      }
    },
  );
}

async function installManagedBinary(
  binary: string,
  runCommand: CrabboxCommandRunner,
  signal: AbortSignal,
): Promise<string> {
  const destination = path.dirname(binary);
  await inspectInstallationDirectory(destination);
  if (await probeInstallation(binary, runCommand, signal)) {
    return binary;
  }
  const parent = path.dirname(destination);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const staging = await fs.mkdtemp(path.join(parent, ".install-"));
  try {
    const target = releaseTarget();
    const checksums = (await downloadReleaseFile("checksums.txt", 64 * 1024, signal)).toString(
      "utf8",
    );
    const hashes = checksums.split(/\r?\n/u).flatMap((line) => {
      const match = /^([a-fA-F0-9]{64})\s+\*?(\S+)\s*$/u.exec(line);
      return match?.[2] === target.asset ? [match[1]!.toLowerCase()] : [];
    });
    if (hashes.length !== 1) {
      throw new Error(
        `Crabbox release checksums must contain exactly one entry for ${target.asset}`,
      );
    }
    const archive = await downloadReleaseFile(target.asset, MAX_ARCHIVE_BYTES, signal);
    if (createHash("sha256").update(archive).digest("hex") !== hashes[0]) {
      throw new Error(`Crabbox release checksum mismatch for ${target.asset}`);
    }
    signal.throwIfAborted();
    const archivePath = path.join(staging, target.asset);
    const payload = path.join(staging, "distribution");
    await fs.writeFile(archivePath, archive, { flag: "wx", mode: 0o600 });
    await fs.mkdir(payload, { mode: 0o700 });
    await extractArchive({
      archivePath,
      destDir: payload,
      kind: target.tar ? "tar" : "zip",
      tarGzip: target.tar,
      // Join bounded extraction before cancellation cleanup can remove its destination.
      timeoutMs: 0,
      limits: {
        maxArchiveBytes: MAX_ARCHIVE_BYTES,
        maxEntries: 128,
        maxExtractedBytes: 512 * 1024 * 1024,
        maxEntryBytes: 256 * 1024 * 1024,
      },
      entryFilter: (entry) =>
        entry.kind === "file" || entry.kind === "directory" ? "extract" : "skip",
      onFiltered: "reject-archive",
    });
    const stagedBinary = path.join(payload, target.executable);
    if (!(await probeInstallation(stagedBinary, runCommand, signal))) {
      throw new Error(`Downloaded Crabbox executable does not satisfy ${CRABBOX_MIN_VERSION}`);
    }
    await publishInstallation({ binary, payload, runCommand, signal });
    return binary;
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

type Acquisition = { promise: Promise<string>; controller: AbortController; waiters: number };
const acquisitions = new Map<string, Acquisition>();

export async function ensureManagedCrabboxBinary(
  params: {
    binary?: string;
    runCommand?: CrabboxCommandRunner;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
  } = {},
): Promise<string> {
  const { signal } = params;
  const runCommand = params.runCommand ?? runCommandWithTimeout;
  const candidate = params.binary ?? "crabbox";
  const binary = resolveManagedCrabboxBinaryPath(params.env);
  if (path.resolve(candidate) === binary) {
    await inspectInstallationDirectory(path.dirname(binary));
  }
  if ((await probeCrabboxVersion(candidate, runCommand, signal)).status === "supported") {
    return candidate;
  }
  let acquisition = acquisitions.get(binary);
  if (acquisition?.controller.signal.aborted) {
    await acquisition.promise.catch(() => undefined);
    signal?.throwIfAborted();
    acquisition = acquisitions.get(binary);
  }
  if (!acquisition) {
    const controller = new AbortController();
    acquisition = {
      controller,
      waiters: 0,
      promise: installManagedBinary(binary, runCommand, controller.signal),
    };
    acquisitions.set(binary, acquisition);
    const owned = acquisition;
    void acquisition.promise
      .finally(() => {
        if (acquisitions.get(binary) === owned) {
          acquisitions.delete(binary);
        }
      })
      .catch(() => undefined);
  }
  const shared = acquisition;
  shared.waiters += 1;
  let waiting = true;
  const leave = () => {
    if (waiting) {
      waiting = false;
      shared.waiters -= 1;
      if (shared.waiters === 0) {
        shared.controller.abort();
      }
    }
  };
  let abandon: () => void = () => {};
  const abandoned = new Promise<never>((_resolve, reject) => {
    abandon = () => {
      leave();
      // Other callers retain custody; only the last waiter must join cancellation cleanup.
      if (shared.waiters > 0) {
        reject(toErrorObject(signal?.reason, "Crabbox acquisition aborted"));
      }
    };
  });
  signal?.addEventListener("abort", abandon, { once: true });
  if (signal?.aborted) {
    abandon();
  }
  try {
    const resolved = await Promise.race([shared.promise, abandoned]);
    signal?.throwIfAborted();
    return resolved;
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  } finally {
    signal?.removeEventListener("abort", abandon);
    leave();
  }
}
