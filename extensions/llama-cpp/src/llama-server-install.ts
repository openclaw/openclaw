import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs, { createWriteStream, type BigIntStats, type Stats } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { sha256File as hashFile } from "@openclaw/fs-safe/durability";
import {
  ARCHIVE_LIMIT_ERROR_CODE,
  ArchiveLimitError,
  extractArchive,
  type ArchiveExtractLimits,
} from "openclaw/plugin-sdk/archive";
import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { racePromiseWithAbortSignal } from "openclaw/plugin-sdk/time-runtime";
import { resolveLlamaCppDataDir } from "./defaults.js";
import {
  LLAMA_SERVER_BUILD,
  LLAMA_SERVER_COMMIT,
  LLAMA_SERVER_RELEASE,
  resolveManagedLlamaServerPaths,
  selectLlamaServerAsset,
  type LlamaServerArchive,
  type LlamaServerAsset,
  type LlamaServerDependency,
} from "./llama-server-assets.js";

const MEBIBYTE = 1024 * 1024;
const LLAMA_ARCHIVE_LIMITS = {
  maxArchiveBytes: 256 * MEBIBYTE,
  maxEntries: 1_000,
  maxExtractedBytes: 512 * MEBIBYTE,
  maxEntryBytes: 256 * MEBIBYTE,
  maxMetaEntryBytes: MEBIBYTE,
} satisfies ArchiveExtractLimits;
const MAX_ALIAS_BYTES = 512 * MEBIBYTE;
const CAB_HEADER_SIZE = 12;
const EXPAND_TIMEOUT_MS = 60_000;

async function assertRegularFile(
  filePath: string,
  label: string,
  source = "llama-server archive",
): Promise<Stats> {
  const stat = await fsp.lstat(filePath).catch(() => undefined);
  if (!stat?.isFile() || stat.nlink > 1) {
    throw new Error(`${source} does not contain regular ${label}`);
  }
  return stat;
}

async function extractVerifiedArchive(
  archivePath: string,
  destDir: string,
  asset: LlamaServerArchive,
  requiredFiles: readonly string[],
): Promise<string> {
  const isTar = asset.archive === "tar.gz";
  const limits = { ...LLAMA_ARCHIVE_LIMITS, ...asset.limits };
  const aliasCount = asset.regularFileAliases.reduce(
    (count, [, aliases]) => count + aliases.length,
    0,
  );
  if (aliasCount > limits.maxEntries) {
    throw new ArchiveLimitError(ARCHIVE_LIMIT_ERROR_CODE.ENTRY_COUNT_EXCEEDS_LIMIT);
  }
  await extractArchive({
    archivePath,
    destDir,
    kind: isTar ? "tar" : "zip",
    // The installer owns destination cleanup, so keep extraction joined instead of racing
    // fs-safe's internal transaction against a caller-side timeout.
    timeoutMs: 0,
    limits: {
      ...limits,
      maxEntries: limits.maxEntries - aliasCount,
    },
    tarGzip: isTar,
    entryFilter: (entry) => (entry.kind === "symlink" ? "skip" : "extract"),
    onFiltered: "skip-entry",
  });
  const rootDir = path.join(destDir, asset.archiveRoot);
  // Paths come from the private pinned asset manifest, not archive entries.
  for (const file of requiredFiles) {
    await assertRegularFile(path.join(rootDir, file), `file ${file}`);
  }
  let copiedBytes = 0;
  for (const [source, aliases] of asset.regularFileAliases) {
    const sourcePath = path.join(rootDir, source);
    const sourceStat = await assertRegularFile(sourcePath, `alias source ${source}`);
    for (const alias of aliases) {
      copiedBytes += sourceStat.size;
      if (copiedBytes > MAX_ALIAS_BYTES) {
        throw new ArchiveLimitError(ARCHIVE_LIMIT_ERROR_CODE.EXTRACTED_SIZE_EXCEEDS_LIMIT);
      }
      const aliasPath = path.join(rootDir, alias);
      await fsp.copyFile(sourcePath, aliasPath, fs.constants.COPYFILE_EXCL);
      await fsp.chmod(aliasPath, sourceStat.mode & 0o777);
    }
  }
  return rootDir;
}

async function runExpand(command: string, args: string[], signal?: AbortSignal): Promise<void> {
  await runServerCommand(command, args, signal, EXPAND_TIMEOUT_MS, (error, stderr) => {
    const detail = stderr.trim();
    return new Error(`Failed to extract the Visual C++ runtime${detail ? `: ${detail}` : ""}`, {
      cause: error,
    });
  });
}

const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
const PROBE_TIMEOUT_MS = 15_000;
// Version checks initialize backends and can trigger macOS security assessment.
// Publication or a previous successful launch does not guarantee a warm runtime.
const VERSION_TIMEOUT_MS = 120_000;

export type LlamaDownloadProgress = (status: {
  downloadedSize: number;
  totalSize: number;
  bytesPerSecond: number;
}) => void;

const installationPromises = new Map<string, Promise<string>>();

function compareVersion(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (delta !== 0) {
      return delta;
    }
  }
  return 0;
}

/** The verified build cannot run on this host; rerunning setup cannot change that. */
export class UnsupportedLlamaServerHostError extends Error {
  override name = "UnsupportedLlamaServerHostError";
}

function assertSupportedLinuxRuntime(asset: LlamaServerAsset): void {
  if (asset.platform !== "linux") {
    return;
  }
  const header = asOptionalRecord(asOptionalRecord(process.report?.getReport())?.header);
  const glibc = typeof header?.glibcVersionRuntime === "string" ? header.glibcVersionRuntime : "";
  if (!glibc) {
    throw new UnsupportedLlamaServerHostError(
      "The verified Ubuntu llama-server build requires glibc and cannot run on musl/Alpine. Install llama-server manually for this host and configure its absolute path.",
    );
  }
  const minimum = asset.arch === "arm64" ? "2.38" : "2.34";
  if (compareVersion(glibc, minimum) < 0) {
    throw new UnsupportedLlamaServerHostError(
      `The verified llama-server build requires glibc ${minimum}+ on Linux ${asset.arch}; this host has ${glibc}. Install a compatible llama-server manually and configure its absolute path.`,
    );
  }
}

// The verified macOS archives link Accelerate's ILP64 LAPACK interface, added in macOS 13.3.
const MACOS_MINIMUM = "13.3";

async function assertSupportedMacosRuntime(
  asset: LlamaServerAsset,
  signal?: AbortSignal,
  cause?: unknown,
): Promise<void> {
  if (asset.platform !== "darwin") {
    return;
  }
  const version = await runServerCommand("/usr/bin/sw_vers", ["-productVersion"], signal).catch(
    () => {
      signal?.throwIfAborted();
      // An unreadable version leaves the post-extraction launch check as the guard.
      return "";
    },
  );
  if (!/^\d+\.\d+(?:\.\d+)?$/u.test(version) || compareVersion(version, MACOS_MINIMUM) >= 0) {
    return;
  }
  throw new UnsupportedLlamaServerHostError(
    `The verified llama-server ${LLAMA_SERVER_RELEASE} build requires macOS ${MACOS_MINIMUM}+; this Mac runs macOS ${version}. Build llama-server for this Mac and set models.providers.llama-cpp.localService.command to its absolute path, or use a remote model or embedding provider.`,
    cause === undefined ? undefined : { cause },
  );
}

function assetUrl(asset: Pick<LlamaServerArchive, "name" | "url">): string {
  return (
    asset.url ??
    `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_SERVER_RELEASE}/${asset.name}`
  );
}

const verifiedFiles = new Map<string, { identity: string; sha256: string }>();
const VERIFIED_FILE_LIMIT = 16;

function fileIdentity(stat: BigIntStats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

function rememberVerifiedFile(filePath: string, stat: BigIntStats, sha256: string): void {
  verifiedFiles.delete(filePath);
  verifiedFiles.set(filePath, { identity: fileIdentity(stat), sha256 });
  pruneMapToMaxSize(verifiedFiles, VERIFIED_FILE_LIMIT);
}

export async function sha256File(filePath: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  try {
    const identity = fileIdentity(await fsp.stat(filePath, { bigint: true }));
    const verified = verifiedFiles.get(filePath);
    if (verified?.identity === identity) {
      return verified.sha256;
    }
    verifiedFiles.delete(filePath);
    const handle = await fsp.open(filePath, "r");
    try {
      const before = fileIdentity(await handle.stat({ bigint: true }));
      const { digest: sha256 } = await hashFile(handle, { signal });
      const after = await handle.stat({ bigint: true });
      if (
        before !== fileIdentity(after) ||
        before !== fileIdentity(await fsp.stat(filePath, { bigint: true }))
      ) {
        throw new Error(`File changed during integrity verification: ${filePath}. Retry setup.`);
      }
      rememberVerifiedFile(filePath, after, sha256);
      return sha256;
    } finally {
      await handle.close();
    }
  } catch (error) {
    verifiedFiles.delete(filePath);
    throw error;
  }
}

function readResponseSha256(response: Response): string | undefined {
  for (const name of ["x-checksum-sha256", "x-linked-etag"]) {
    const value = response.headers.get(name)?.replace(/^W\//u, "").replaceAll('"', "").trim();
    if (value && /^[a-f\d]{64}$/iu.test(value)) {
      return value.toLowerCase();
    }
  }
  const encoded = response.headers.get("digest")?.match(/(?:^|,)\s*sha-256=([^,\s]+)/iu)?.[1];
  return encoded ? Buffer.from(encoded, "base64").toString("hex") : undefined;
}

export async function downloadVerifiedFile(params: {
  url: string;
  destination: string;
  expectedSha256?: string;
  expectedSize?: number;
  requireServerDigest?: boolean;
  signal?: AbortSignal;
  onProgress?: LlamaDownloadProgress;
}): Promise<void> {
  const partialPath = `${params.destination}.partial-${randomUUID()}`;
  await fsp.mkdir(path.dirname(params.destination), { recursive: true });
  // Setup/doctor closure must not cold-load the SSRF barrel (DNS, proxy state,
  // logging); defer it to actual download time per the closure guard contract.
  const { fetchWithSsrFGuard, ssrfPolicyFromHttpBaseUrlAllowedOrigin } =
    await import("openclaw/plugin-sdk/ssrf-runtime");
  try {
    const { response, release } = await fetchWithSsrFGuard({
      url: params.url,
      signal: params.signal,
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
      policy: ssrfPolicyFromHttpBaseUrlAllowedOrigin(params.url),
      requireHttps: true,
      auditContext: "llama-cpp-download",
    });
    try {
      if (!response.ok || !response.body) {
        throw new Error(`download failed: HTTP ${response.status} ${response.statusText}`);
      }
      const expectedSha256 = params.expectedSha256 ?? readResponseSha256(response);
      if (!expectedSha256 && params.requireServerDigest) {
        throw new Error(
          "the download server did not provide a SHA-256 digest; download the GGUF manually and configure its local path",
        );
      }
      const contentLength = Number(response.headers.get("content-length"));
      const totalSize =
        params.expectedSize ??
        (Number.isFinite(contentLength) && contentLength > 0 ? contentLength : 0);
      const handle = await fsp.open(partialPath, "wx", 0o600);
      const hash = createHash("sha256");
      let downloadedSize = 0;
      let previousSize = 0;
      let previousAt = Date.now();
      let rollingBytesPerSecond = 0;
      try {
        // Unlock on every exit; the guard owns aborting an unfinished download.
        for await (const value of response.body.values({ preventCancel: true })) {
          const chunk = Buffer.from(value);
          await handle.writeFile(chunk);
          hash.update(chunk);
          downloadedSize += chunk.byteLength;
          const now = Date.now();
          if (now > previousAt) {
            const currentRate = ((downloadedSize - previousSize) * 1000) / (now - previousAt);
            rollingBytesPerSecond =
              rollingBytesPerSecond === 0
                ? currentRate
                : rollingBytesPerSecond * 0.75 + currentRate * 0.25;
            previousSize = downloadedSize;
            previousAt = now;
          }
          params.onProgress?.({ downloadedSize, totalSize, bytesPerSecond: rollingBytesPerSecond });
        }
        if (params.expectedSize && downloadedSize !== params.expectedSize) {
          throw new Error(
            `download size mismatch: expected ${params.expectedSize}, got ${downloadedSize}`,
          );
        }
        const actualSha256 = hash.digest("hex");
        if (expectedSha256 && actualSha256 !== expectedSha256.toLowerCase()) {
          throw new Error(
            `download SHA-256 mismatch: expected ${expectedSha256}, got ${actualSha256}`,
          );
        }
        const completed = await handle.stat({ bigint: true });
        params.signal?.throwIfAborted();
        await fsp.rename(partialPath, params.destination);
        const published = await handle.stat({ bigint: true });
        // Rename can change ctime. Retain the verified open file's publication identity so
        // setup and cold chat preparation do not rescan a multi-GB download in this process.
        if (completed.size === published.size && completed.mtimeNs === published.mtimeNs) {
          rememberVerifiedFile(params.destination, published, actualSha256);
        }
      } finally {
        await handle.close();
      }
    } finally {
      await release();
    }
  } finally {
    await fsp.rm(partialPath, { force: true }).catch(() => undefined);
  }
}

async function runServerCommand(
  command: string,
  args: string[],
  signal?: AbortSignal,
  timeoutMs = PROBE_TIMEOUT_MS,
  formatError?: (error: Error, stderr: string) => Error,
): Promise<string> {
  return await new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: timeoutMs, signal, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            formatError ? formatError(error, stderr) : new Error(error.message, { cause: error }),
          );
        } else {
          resolve(`${stdout}${stderr}`.trim());
        }
      },
    );
  });
}

function formatRuntimeDependencyError(error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  if (process.platform === "linux") {
    return new Error(
      `The verified llama-server build could not start. Install the OpenMP runtime (for example libgomp1 on Debian/Ubuntu or libgomp on Fedora), then rerun llama.cpp setup. Detail: ${detail}`,
      { cause: error },
    );
  }
  if (process.platform === "win32") {
    return new Error(
      `The verified llama-server build could not start with its app-local Visual C++ runtime. Rerun llama.cpp setup to reinstall it, or configure a compatible llama-server manually. Detail: ${detail}`,
      { cause: error },
    );
  }
  return new Error(`The verified llama-server build could not start: ${detail}`, { cause: error });
}

async function queryServerVersion(command: string, signal?: AbortSignal): Promise<string> {
  try {
    return await runServerCommand(command, ["--version"], signal, VERSION_TIMEOUT_MS);
  } catch (error) {
    signal?.throwIfAborted();
    throw formatRuntimeDependencyError(error);
  }
}

function validateServerVersionOutput(command: string, version: string): void {
  const versionLine = version.split(/\r?\n/u, 1)[0]?.trim() ?? "";
  const match = versionLine.match(/^version: .+ \(build (\d+), commit ([a-f\d]{9})\)$/u);
  const build = match?.[1] ? Number(match[1]) : undefined;
  const commit = match?.[2];
  if (build !== LLAMA_SERVER_BUILD || commit !== LLAMA_SERVER_COMMIT.slice(0, 9)) {
    throw new Error(
      `Unexpected llama-server build at ${command}: expected ${LLAMA_SERVER_RELEASE} (${LLAMA_SERVER_COMMIT.slice(0, 9)}), got ${version || "no version output"}`,
    );
  }
}

async function validateCudaServer(
  command: string,
  asset: LlamaServerAsset,
  signal?: AbortSignal,
): Promise<void> {
  if (asset.backend === "cuda") {
    // --version succeeds even if a dynamically loaded CUDA backend fails. Device
    // enumeration must prove CUDA is usable before this installation is published.
    const devices = await runServerCommand(command, ["--list-devices"], signal);
    if (!/^\s*CUDA\d+: .+\(\d+ MiB, \d+ MiB free\)$/mu.test(devices)) {
      throw new Error(
        "The verified llama-server could not initialize an NVIDIA CUDA device. Update the NVIDIA driver and rerun setup, or configure a compatible llama-server manually. CPU fallback was not activated.",
      );
    }
  }
}

async function validateInstalledServer(
  command: string,
  asset: LlamaServerAsset,
  signal?: AbortSignal,
): Promise<void> {
  validateServerVersionOutput(command, await queryServerVersion(command, signal));
  await validateCudaServer(command, asset, signal);
}

type LlamaServerInstallOptions = {
  asset?: LlamaServerAsset;
  signal?: AbortSignal;
  onProgress?: LlamaDownloadProgress;
};

async function stageLlamaServerDependency(params: {
  dependency: LlamaServerDependency;
  index: number;
  extractDir: string;
  extractedRoot: string;
  options: LlamaServerInstallOptions;
}): Promise<void> {
  const { dependency, extractDir, extractedRoot, index, options } = params;
  options.signal?.throwIfAborted();
  const dependencyArchive = path.join(extractDir, dependency.name);
  await downloadVerifiedFile({
    url: assetUrl(dependency),
    destination: dependencyArchive,
    expectedSha256: dependency.sha256,
    expectedSize: dependency.archive === "vc-redist" ? dependency.size : undefined,
    signal: options.signal,
    onProgress: options.onProgress,
  });
  const dependencyExtractDir = path.join(extractDir, `dependency-${index}`);
  await fsp.mkdir(dependencyExtractDir);
  let dependencyRoot: string;
  if (dependency.archive === "vc-redist") {
    const { nestedCabinet, files } = dependency;
    const systemRoot = process.env.SystemRoot;
    if (!systemRoot || !path.win32.isAbsolute(systemRoot)) {
      throw new Error("SystemRoot is unavailable; cannot extract the Visual C++ runtime");
    }
    const expandCommand = path.win32.join(systemRoot, "System32", "expand.exe");
    const containerPath = path.join(dependencyExtractDir, "bundle.cab");
    const nestedDir = path.join(dependencyExtractDir, "nested");
    const filesDir = path.join(dependencyExtractDir, "files");
    await Promise.all([
      fsp.mkdir(nestedDir, { recursive: true }),
      fsp.mkdir(filesDir, { recursive: true }),
    ]);
    const source = await fsp.open(dependencyArchive, "r");
    try {
      const stat = await source.stat();
      if (!stat.isFile() || stat.size !== dependency.size) {
        throw new Error(
          `Visual C++ runtime bundle size mismatch: expected ${dependency.size}, got ${stat.size}`,
        );
      }
      if (
        dependency.containerOffset < 0 ||
        dependency.containerSize < CAB_HEADER_SIZE ||
        dependency.containerOffset + dependency.containerSize > stat.size
      ) {
        throw new Error("invalid Visual C++ runtime container bounds");
      }
      const header = Buffer.alloc(CAB_HEADER_SIZE);
      const headerRead = await source.read(header, 0, header.length, dependency.containerOffset);
      if (
        headerRead.bytesRead !== header.length ||
        header.subarray(0, 4).toString("ascii") !== "MSCF" ||
        header.readUInt32LE(8) !== dependency.containerSize
      ) {
        throw new Error("Visual C++ runtime bundle does not contain the pinned cabinet");
      }

      await pipeline(
        source.createReadStream({
          start: dependency.containerOffset,
          end: dependency.containerOffset + dependency.containerSize - 1,
          autoClose: false,
        }),
        createWriteStream(containerPath, { flags: "wx", mode: 0o600 }),
        { signal: options.signal },
      );
    } finally {
      await source.close();
    }
    await runExpand(
      expandCommand,
      [`-F:${nestedCabinet}`, containerPath, nestedDir],
      options.signal,
    );
    const nestedPath = path.join(nestedDir, nestedCabinet);
    await assertRegularFile(nestedPath, `file ${nestedCabinet}`, "Visual C++ runtime");
    for (const file of files) {
      options.signal?.throwIfAborted();
      await runExpand(expandCommand, [`-F:${file.source}`, nestedPath, filesDir], options.signal);
      const sourcePath = path.join(filesDir, file.source);
      await assertRegularFile(sourcePath, `file ${file.source}`, "Visual C++ runtime");
      await fsp.copyFile(
        sourcePath,
        path.join(dependencyExtractDir, file.target),
        fs.constants.COPYFILE_EXCL,
      );
    }
    dependencyRoot = dependencyExtractDir;
  } else {
    dependencyRoot = await extractVerifiedArchive(
      dependencyArchive,
      dependencyExtractDir,
      dependency,
      dependency.files,
    );
  }
  const files =
    dependency.archive === "vc-redist"
      ? dependency.files.map((file) => file.target)
      : dependency.files;
  for (const file of files) {
    await fsp.copyFile(
      path.join(dependencyRoot, file),
      path.join(extractedRoot, file),
      fs.constants.COPYFILE_EXCL,
    );
  }
}

function formatVcRuntimeFallbackError(startupError: unknown, fallbackError: unknown): Error {
  const startupDetail = startupError instanceof Error ? startupError.message : String(startupError);
  const fallbackDetail =
    fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
  return new Error(
    `The extracted llama-server could not start with the installed Windows runtime, and its app-local Visual C++ runtime fallback did not restore it. Initial startup detail: ${startupDetail} Fallback detail: ${fallbackDetail}`,
    { cause: fallbackError },
  );
}

async function installLlamaServer(
  asset: LlamaServerAsset,
  options: LlamaServerInstallOptions,
): Promise<string> {
  options.signal?.throwIfAborted();
  assertSupportedLinuxRuntime(asset);
  const { installDir, command } = resolveManagedLlamaServerPaths(asset);
  if (
    await fsp
      .stat(command)
      .then((stat) => stat.isFile())
      .catch(() => false)
  ) {
    // A build that validates is reused on any macOS, including one built for an older release.
    try {
      await validateInstalledServer(command, asset, options.signal);
    } catch (error) {
      await assertSupportedMacosRuntime(asset, options.signal, error);
      throw error;
    }
    return command;
  }
  await assertSupportedMacosRuntime(asset, options.signal);
  const dataDir = resolveLlamaCppDataDir();
  const archivePath = path.join(dataDir, `.download-${randomUUID()}-${asset.name}`);
  const extractDir = path.join(dataDir, `.extract-${randomUUID()}`);
  await fsp.mkdir(dataDir, { recursive: true });
  try {
    await downloadVerifiedFile({
      url: assetUrl(asset),
      destination: archivePath,
      expectedSha256: asset.sha256,
      signal: options.signal,
      onProgress: options.onProgress,
    });
    const serverExtractDir = path.join(extractDir, "server");
    await fsp.mkdir(serverExtractDir, { recursive: true });
    const extractedCommand = path.join(
      await extractVerifiedArchive(archivePath, serverExtractDir, asset, [asset.executable]),
      asset.executable,
    );
    const extractedRoot = path.dirname(extractedCommand);
    const dependencies = asset.dependencies ?? [];
    const windowsRuntimeDependencies: Array<{
      dependency: LlamaServerDependency;
      index: number;
    }> = [];
    for (const [index, dependency] of dependencies.entries()) {
      if (dependency.archive === "vc-redist") {
        windowsRuntimeDependencies.push({ dependency, index });
      } else {
        await stageLlamaServerDependency({
          dependency,
          index,
          extractDir,
          extractedRoot,
          options,
        });
      }
    }
    options.signal?.throwIfAborted();
    await fsp.chmod(extractedCommand, 0o755);
    if (windowsRuntimeDependencies.length > 0) {
      let version: string;
      try {
        version = await queryServerVersion(extractedCommand, options.signal);
      } catch (startupError) {
        options.signal?.throwIfAborted();
        try {
          for (const { dependency, index } of windowsRuntimeDependencies) {
            await stageLlamaServerDependency({
              dependency,
              index,
              extractDir,
              extractedRoot,
              options,
            });
          }
        } catch (stagingError) {
          options.signal?.throwIfAborted();
          throw formatVcRuntimeFallbackError(startupError, stagingError);
        }
        try {
          version = await queryServerVersion(extractedCommand, options.signal);
        } catch (retryError) {
          options.signal?.throwIfAborted();
          throw formatVcRuntimeFallbackError(startupError, retryError);
        }
      }
      validateServerVersionOutput(extractedCommand, version);
      await validateCudaServer(extractedCommand, asset, options.signal);
    } else {
      await validateInstalledServer(extractedCommand, asset, options.signal);
    }
    await fsp.mkdir(path.dirname(installDir), { recursive: true });
    options.signal?.throwIfAborted();
    await fsp.rm(installDir, { recursive: true, force: true });
    await fsp.rename(extractedRoot, installDir);
    return command;
  } finally {
    await Promise.all([
      fsp.rm(archivePath, { force: true }),
      fsp.rm(extractDir, { recursive: true, force: true }),
    ]);
  }
}

export async function ensureLlamaServerInstalled(options: LlamaServerInstallOptions = {}): Promise<{
  command: string;
}> {
  options.signal?.throwIfAborted();
  const asset = options.asset ?? selectLlamaServerAsset();
  const key = resolveManagedLlamaServerPaths(asset).command;
  const previous = installationPromises.get(key);
  // Each caller owns its cancellation. Serialize attempts so a cancelled setup
  // cannot poison another caller or race its archive cleanup/publication.
  const pending = Promise.resolve(previous)
    .catch(() => undefined)
    .then(() => installLlamaServer(asset, options))
    .finally(() => {
      if (installationPromises.get(key) === pending) {
        installationPromises.delete(key);
      }
    });
  installationPromises.set(key, pending);
  const command = await racePromiseWithAbortSignal(
    pending,
    previous ? options.signal : undefined,
    (signal) => toErrorObject(signal.reason, "Installation cancelled"),
  );
  return { command };
}
