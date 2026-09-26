/**
 * Browser proxy upload transport.
 *
 * Existing Browser upload paths are Gateway-owned. Proxied requests carry
 * bounded bytes to the node, which stages private copies under its upload root.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { sanitizeUntrustedFileName } from "openclaw/plugin-sdk/security-runtime";
import { asNullableRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf8Prefix } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  assertBrowserProxyFileBytesWithinLimits,
  assertBrowserProxyFileCountWithinLimit,
  BROWSER_PROXY_MAX_FILE_BYTES,
  BROWSER_PROXY_UPLOAD_ENVELOPE,
  type BrowserProxyUploadFile,
  type BrowserProxyUploadV1,
} from "./browser-proxy-envelope.js";
import { DEFAULT_UPLOAD_DIR, resolveExistingUploadPaths } from "./browser/paths.js";

const logger = createSubsystemLogger("browser");
const BROWSER_PROXY_UPLOAD_ROOT_NAME = ".proxy-uploads";
const BROWSER_PROXY_UPLOAD_PREFIX = "upload-";
const BROWSER_PROXY_UPLOAD_MARKER_NAME = ".openclaw-browser-proxy-upload-v1";
const BROWSER_PROXY_UPLOAD_MARKER_CONTENT = "openclaw-browser-proxy-upload-v1\n";
const BROWSER_PROXY_UPLOAD_RETENTION_MS = 24 * 60 * 60 * 1000;
const BROWSER_PROXY_UPLOAD_CLEANUP_RETRY_MS = 60 * 60 * 1000;
// Recovery/cleanup retries are bounded: a persistent staging fault must not pin
// node-host active work (which blocks tryPauseForUpdate) or spam warns. Giving
// up loses no state; recovery re-runs at the next node start, and a later
// upload re-probes an exhausted cleanup once the fault has cleared.
const BROWSER_PROXY_UPLOAD_RECOVERY_MAX_ATTEMPTS = 3;
const BROWSER_PROXY_UPLOAD_MAX_RETAINED_BYTES = 256 * 1024 * 1024;
const BROWSER_PROXY_UPLOAD_MAX_RETAINED_DIRECTORIES = 64;
const BROWSER_PROXY_MAX_ENCODED_FILE_LENGTH = Math.ceil(BROWSER_PROXY_MAX_FILE_BYTES / 3) * 4;
const MAX_STAGED_NAME_BYTES = 180;
const cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
const recoveryPromises = new Map<string, Promise<void>>();
const recoveryRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const stagingLocks = new Map<string, Promise<void>>();
let activeCleanup = 0;
let activeRecovery = 0;
const recoveryAttemptCounts = new Map<string, number>();
const cleanupAttemptCounts = new Map<string, number>();

export function hasBrowserProxyUploadWork(): boolean {
  return (
    activeCleanup > 0 ||
    activeRecovery > 0 ||
    cleanupTimers.size > 0 ||
    recoveryRetryTimers.size > 0 ||
    stagingLocks.size > 0
  );
}

type PreparedBrowserProxyUploadRequest = {
  body: unknown;
  upload?: BrowserProxyUploadV1;
};

type StagedBrowserProxyUploadRequest = {
  body: unknown;
  directory?: string;
};

type StagedUploadLimits = {
  maxRetainedBytes: number;
  maxRetainedDirectories: number;
};

type OwnedStagedUpload = {
  bytes: number;
  directory: string;
  mtimeMs: number;
};

function isFileChooserRequest(method: string, requestPath: string): boolean {
  return (
    method.toUpperCase() === "POST" &&
    `/${requestPath.trim().replace(/^\/+/u, "")}` === "/hooks/file-chooser"
  );
}

/** Identify upload requests before reading files or applying transport-only limits. */
export function isBrowserProxyUploadRequest(params: {
  method: string;
  path: string;
  body?: unknown;
}): boolean {
  if (!isFileChooserRequest(params.method, params.path)) {
    return false;
  }
  const body = asNullableRecord(params.body);
  return Boolean(body && Array.isArray(body.paths) && body.paths.length > 0);
}

function readUploadPaths(body: Record<string, unknown>): string[] | null {
  if (!Array.isArray(body.paths) || body.paths.length === 0) {
    return null;
  }
  if (!body.paths.every((entry): entry is string => typeof entry === "string")) {
    throw new Error("browser proxy upload paths must contain only strings");
  }
  return body.paths;
}

async function readBrowserProxyUploadFiles(
  paths: string[],
  signal?: AbortSignal,
): Promise<BrowserProxyUploadFile[]> {
  assertBrowserProxyFileCountWithinLimit(paths.length, "request");
  const files: BrowserProxyUploadFile[] = [];
  let totalBytes = 0;
  for (const filePath of paths) {
    signal?.throwIfAborted();
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat?.isFile()) {
      throw new Error(`browser proxy upload file not found: ${filePath}`);
    }
    assertBrowserProxyFileBytesWithinLimits(stat.size, totalBytes + stat.size);
    const buffer = await fs.readFile(filePath, signal ? { signal } : undefined);
    assertBrowserProxyFileBytesWithinLimits(buffer.byteLength, totalBytes + buffer.byteLength);
    totalBytes += buffer.byteLength;
    files.push({
      name: path.basename(filePath),
      contentBase64: buffer.toString("base64"),
    });
  }
  return files;
}

/** Build a node-only upload envelope while retaining the original body for host fallback. */
export async function prepareBrowserProxyUploadRequest(params: {
  method: string;
  path: string;
  body: unknown;
  uploadDir?: string;
  inboundMediaDir?: string;
  signal?: AbortSignal;
}): Promise<PreparedBrowserProxyUploadRequest> {
  params.signal?.throwIfAborted();
  if (!isFileChooserRequest(params.method, params.path)) {
    return { body: params.body };
  }
  const body = asNullableRecord(params.body);
  if (!body) {
    return { body: params.body };
  }
  const requestedPaths = readUploadPaths(body);
  if (!requestedPaths) {
    return { body: params.body };
  }
  assertBrowserProxyFileCountWithinLimit(requestedPaths.length, "request");
  const resolved = await resolveExistingUploadPaths({
    requestedPaths,
    ...(params.uploadDir ? { uploadDir: params.uploadDir } : {}),
    ...(params.inboundMediaDir ? { inboundMediaDir: params.inboundMediaDir } : {}),
  });
  if (!resolved.ok) {
    throw new Error(resolved.error);
  }
  const upload: BrowserProxyUploadV1 = {
    envelope: BROWSER_PROXY_UPLOAD_ENVELOPE,
    files: await readBrowserProxyUploadFiles(resolved.paths, params.signal),
  };
  const { paths: _paths, ...bodyWithoutPaths } = body;
  return { body: bodyWithoutPaths, upload };
}

function sanitizeUploadName(name: string): string {
  const safe = sanitizeUntrustedFileName(name, "upload").replace(/[!%]/gu, "_");
  const bounded = truncateUtf8Prefix(safe, MAX_STAGED_NAME_BYTES).replace(/[.\s]+$/u, "");
  // Bounding can expose a Windows device name that was hidden by trailing padding.
  return sanitizeUntrustedFileName(bounded, "upload");
}

function decodedBase64Size(value: string): number {
  if (value.length % 4 !== 0) {
    throw new Error("INVALID_REQUEST: invalid browser proxy upload encoding");
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function decodeUploadFile(file: BrowserProxyUploadFile, totalBytes: number): Buffer {
  if (
    !file ||
    typeof file.name !== "string" ||
    !file.name.trim() ||
    typeof file.contentBase64 !== "string" ||
    file.contentBase64.length > BROWSER_PROXY_MAX_ENCODED_FILE_LENGTH
  ) {
    throw new Error("INVALID_REQUEST: invalid browser proxy upload file");
  }
  const estimatedBytes = decodedBase64Size(file.contentBase64);
  assertBrowserProxyFileBytesWithinLimits(estimatedBytes, totalBytes + estimatedBytes);
  const buffer = Buffer.from(file.contentBase64, "base64");
  if (buffer.toString("base64") !== file.contentBase64) {
    throw new Error("INVALID_REQUEST: invalid browser proxy upload encoding");
  }
  assertBrowserProxyFileBytesWithinLimits(buffer.byteLength, totalBytes + buffer.byteLength);
  return buffer;
}

function clearCleanupTimer(directory: string): void {
  const timer = cleanupTimers.get(directory);
  if (!timer) {
    return;
  }
  clearTimeout(timer);
  cleanupTimers.delete(directory);
}

async function removeStagedUpload(directory: string): Promise<void> {
  const exhausted =
    (cleanupAttemptCounts.get(directory) ?? 0) >= BROWSER_PROXY_UPLOAD_RECOVERY_MAX_ATTEMPTS;
  activeCleanup += 1;
  clearCleanupTimer(directory);
  try {
    await fs.rm(directory, { recursive: true, force: true });
    cleanupAttemptCounts.delete(directory);
  } catch (error) {
    if (exhausted) {
      // Recovery re-probes exhausted cleanup whenever it next runs (node start
      // or a later upload): a cleared fault reclaims the copy here, while a
      // persistent fault stays silent and never re-arms a retry timer.
      return;
    }
    const attempts = (cleanupAttemptCounts.get(directory) ?? 0) + 1;
    cleanupAttemptCounts.set(directory, attempts);
    if (attempts >= BROWSER_PROXY_UPLOAD_RECOVERY_MAX_ATTEMPTS) {
      clearCleanupTimer(directory);
      logger.error(
        `browser proxy upload cleanup gave up after ${attempts} attempts; staged uploads will be re-evaluated at the next node start: ${String(error)}`,
      );
    } else {
      logger.warn(`browser proxy upload cleanup failed; retrying: ${String(error)}`);
      scheduleCleanup(directory, BROWSER_PROXY_UPLOAD_CLEANUP_RETRY_MS);
    }
  } finally {
    activeCleanup -= 1;
  }
}

async function readDirectoryBytes(directory: string, signal?: AbortSignal): Promise<number> {
  signal?.throwIfAborted();
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    // SAFETY: the caught fs.readdir rejection is a Node system error whose
    // string `code` identifies the missing-directory case.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw error;
  }
  let totalBytes = 0;
  for (const entry of entries) {
    signal?.throwIfAborted();
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      totalBytes += await readDirectoryBytes(entryPath, signal);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const stat = await fs.stat(entryPath).catch(() => null);
    totalBytes += stat?.isFile() ? stat.size : 0;
  }
  return totalBytes;
}

async function readOwnedStagedUploads(
  stagingRoot: string,
  signal?: AbortSignal,
): Promise<OwnedStagedUpload[]> {
  signal?.throwIfAborted();
  let entries;
  try {
    entries = await fs.readdir(stagingRoot, { withFileTypes: true });
  } catch (error) {
    // SAFETY: the caught fs.readdir rejection is a Node system error whose
    // string `code` identifies the missing-directory case.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const uploads = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(BROWSER_PROXY_UPLOAD_PREFIX))
      .map(async (entry): Promise<OwnedStagedUpload | null> => {
        signal?.throwIfAborted();
        const directory = path.join(stagingRoot, entry.name);
        const stat = await fs.stat(directory).catch(() => null);
        if (!stat?.isDirectory()) {
          return null;
        }
        if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
          return null;
        }
        const marker = await fs
          .readFile(path.join(directory, BROWSER_PROXY_UPLOAD_MARKER_NAME), "utf8")
          .catch(() => null);
        if (marker !== BROWSER_PROXY_UPLOAD_MARKER_CONTENT) {
          return null;
        }
        return {
          bytes: await readDirectoryBytes(directory, signal),
          directory,
          mtimeMs: stat.mtimeMs,
        };
      }),
  );
  return uploads.filter((upload): upload is OwnedStagedUpload => upload !== null);
}

// Staging proves the root is writable, not that recovery can run its complete
// scan again: a readable root can still hold a marked upload whose numbered
// child directory blocks readdir, which only fails inside the recursive byte
// scan. Only a complete scan re-establishes an exhausted budget; a root-only
// probe would clear it while the original fault persists and re-arm the
// retry loop that keeps node-update admission busy.
async function stagingRecoveryScanCompletes(stagingRoot: string): Promise<boolean> {
  try {
    await readOwnedStagedUploads(stagingRoot);
    return true;
  } catch {
    return false;
  }
}

// Exhausted cleanup attempts strand their directories until a recovery pass
// re-probes removal; staging must notice that independent of recovery attempts.
function hasExhaustedCleanupAttempts(stagingRoot: string): boolean {
  for (const [directory, attempts] of cleanupAttemptCounts) {
    if (
      attempts >= BROWSER_PROXY_UPLOAD_RECOVERY_MAX_ATTEMPTS &&
      directory.startsWith(stagingRoot + path.sep)
    ) {
      return true;
    }
  }
  return false;
}

function scheduleCleanup(directory: string, delayMs: number): void {
  if (cleanupTimers.has(directory)) {
    return;
  }
  const timer = setTimeout(
    () => {
      cleanupTimers.delete(directory);
      void removeStagedUpload(directory);
    },
    Math.max(0, delayMs),
  );
  cleanupTimers.set(directory, timer);
  timer.unref?.();
}

async function recoverStagedUploads(params: {
  uploadDir: string;
  retentionMs: number;
  nowMs: number;
  limits: StagedUploadLimits;
}): Promise<void> {
  const { uploadDir, retentionMs, nowMs, limits } = params;
  const stagingRoot = path.join(uploadDir, BROWSER_PROXY_UPLOAD_ROOT_NAME);
  // Exhausted cleanup attempts mark a directory as pending deletion, not as a
  // retained upload: re-probe its removal regardless of retention age before
  // any retention scheduling, and never let it enter the retained list below.
  const exhaustedDiscards = new Set<string>();
  for (const [directory, attempts] of cleanupAttemptCounts) {
    if (
      attempts >= BROWSER_PROXY_UPLOAD_RECOVERY_MAX_ATTEMPTS &&
      directory.startsWith(stagingRoot + path.sep)
    ) {
      exhaustedDiscards.add(directory);
    }
  }
  const retained: OwnedStagedUpload[] = [];
  const scannedDirectories = new Set<string>();
  for (const upload of await readOwnedStagedUploads(stagingRoot)) {
    scannedDirectories.add(upload.directory);
    if (exhaustedDiscards.has(upload.directory)) {
      // A persistent deletion fault stays silent without re-arming a timer;
      // a repaired one reclaims the discarded copy here, long before its
      // retention expiry would.
      await removeStagedUpload(upload.directory);
      continue;
    }
    if (retentionMs - Math.max(0, nowMs - upload.mtimeMs) <= 0) {
      await removeStagedUpload(upload.directory);
    } else {
      retained.push(upload);
    }
  }

  // Partial recursive removal can unlink the ownership marker before failing
  // on a file inside a read-only child directory, after which the marker-gated
  // scan above can never rediscover the remnant and a repaired fault would
  // leave it stranded forever. Directories recorded here are known to be owned
  // from an earlier verified scan, so re-probe removal for exhausted entries
  // the scan no longer sees; scanned entries were already re-probed above, and
  // unmarked directories never recorded here stay untouched. Non-exhausted
  // entries keep their pending retry timer, which already re-probes the
  // recorded path directly.
  for (const [directory, attempts] of Array.from(cleanupAttemptCounts)) {
    if (attempts < BROWSER_PROXY_UPLOAD_RECOVERY_MAX_ATTEMPTS) {
      continue;
    }
    if (scannedDirectories.has(directory) || !directory.startsWith(stagingRoot + path.sep)) {
      continue;
    }
    await removeStagedUpload(directory);
  }

  // A restarted node has no surviving Browser request that can still own these
  // copies, so oldest-first eviction safely restores the bounded retention budget.
  retained.sort((left, right) => left.mtimeMs - right.mtimeMs);
  let totalBytes = retained.reduce((total, upload) => total + upload.bytes, 0);
  while (retained.length > limits.maxRetainedDirectories || totalBytes > limits.maxRetainedBytes) {
    const oldest = retained.shift();
    if (!oldest) {
      break;
    }
    totalBytes -= oldest.bytes;
    await removeStagedUpload(oldest.directory);
  }
  for (const upload of retained) {
    const remaining = retentionMs - Math.max(0, nowMs - upload.mtimeMs);
    scheduleCleanup(upload.directory, remaining);
  }
}

function clearRecoveryRetry(uploadDir: string): void {
  const timer = recoveryRetryTimers.get(uploadDir);
  if (!timer) {
    return;
  }
  clearTimeout(timer);
  recoveryRetryTimers.delete(uploadDir);
}

function scheduleRecoveryRetry(uploadDir: string, retentionMs: number): void {
  if (recoveryRetryTimers.has(uploadDir)) {
    return;
  }
  const timer = setTimeout(() => {
    recoveryRetryTimers.delete(uploadDir);
    recoveryPromises.delete(uploadDir);
    void ensureBrowserProxyUploadCleanup({ uploadDir, retentionMs });
  }, BROWSER_PROXY_UPLOAD_CLEANUP_RETRY_MS);
  recoveryRetryTimers.set(uploadDir, timer);
  timer.unref?.();
}

async function runRecovery(params: {
  uploadDir: string;
  retentionMs: number;
  nowMs: number;
  limits: StagedUploadLimits;
}): Promise<void> {
  if (
    (recoveryAttemptCounts.get(params.uploadDir) ?? 0) >= BROWSER_PROXY_UPLOAD_RECOVERY_MAX_ATTEMPTS
  ) {
    return;
  }
  activeRecovery += 1;
  try {
    await recoverStagedUploads(params);
    recoveryAttemptCounts.delete(params.uploadDir);
    clearRecoveryRetry(params.uploadDir);
  } catch (error) {
    const attempts = (recoveryAttemptCounts.get(params.uploadDir) ?? 0) + 1;
    recoveryAttemptCounts.set(params.uploadDir, attempts);
    if (attempts >= BROWSER_PROXY_UPLOAD_RECOVERY_MAX_ATTEMPTS) {
      clearRecoveryRetry(params.uploadDir);
      logger.error(
        `browser proxy upload recovery gave up after ${attempts} attempts; staged uploads will be re-evaluated at the next node start: ${String(error)}`,
      );
    } else {
      logger.warn(`browser proxy upload recovery failed; retrying: ${String(error)}`);
      scheduleRecoveryRetry(params.uploadDir, params.retentionMs);
    }
  } finally {
    activeRecovery -= 1;
  }
}

/** Restores cleanup timers for staged uploads left by a previous node process. */
export function ensureBrowserProxyUploadCleanup(options?: {
  uploadDir?: string;
  retentionMs?: number;
  nowMs?: number;
  maxRetainedBytes?: number;
  maxRetainedDirectories?: number;
}): Promise<void> {
  const uploadDir = options?.uploadDir ?? DEFAULT_UPLOAD_DIR;
  const retentionMs = options?.retentionMs ?? BROWSER_PROXY_UPLOAD_RETENTION_MS;
  const nowMs = options?.nowMs ?? Date.now();
  const limits = {
    maxRetainedBytes: options?.maxRetainedBytes ?? BROWSER_PROXY_UPLOAD_MAX_RETAINED_BYTES,
    maxRetainedDirectories:
      options?.maxRetainedDirectories ?? BROWSER_PROXY_UPLOAD_MAX_RETAINED_DIRECTORIES,
  };
  if (
    options?.retentionMs !== undefined ||
    options?.nowMs !== undefined ||
    options?.maxRetainedBytes !== undefined ||
    options?.maxRetainedDirectories !== undefined
  ) {
    return runRecovery({ uploadDir, retentionMs, nowMs, limits });
  }
  const existing = recoveryPromises.get(uploadDir);
  if (existing) {
    return existing;
  }
  const recovery = runRecovery({ uploadDir, retentionMs, nowMs, limits }).finally(() => {
    if (recoveryRetryTimers.has(uploadDir)) {
      recoveryPromises.delete(uploadDir);
    }
  });
  recoveryPromises.set(uploadDir, recovery);
  return recovery;
}

async function waitForStagingLock(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await previous;
    return;
  }
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      try {
        signal.throwIfAborted();
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([previous, aborted]);
  } finally {
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

async function withStagingLock<T>(
  uploadDir: string,
  task: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const previous = stagingLocks.get(uploadDir) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  stagingLocks.set(uploadDir, tail);
  try {
    await waitForStagingLock(previous, signal);
    return await task();
  } finally {
    release();
    if (stagingLocks.get(uploadDir) === tail) {
      stagingLocks.delete(uploadDir);
    }
  }
}

function validateUploadEnvelope(upload: BrowserProxyUploadV1): BrowserProxyUploadFile[] {
  if (
    !upload ||
    upload.envelope !== BROWSER_PROXY_UPLOAD_ENVELOPE ||
    !Array.isArray(upload.files) ||
    upload.files.length === 0
  ) {
    throw new Error("INVALID_REQUEST: invalid browser proxy upload envelope");
  }
  assertBrowserProxyFileCountWithinLimit(upload.files.length, "request");
  return upload.files;
}

/** Stage a validated upload envelope under the node's managed Browser upload root. */
export async function stageBrowserProxyUploadRequest(params: {
  method: string;
  path: string;
  body: unknown;
  upload?: BrowserProxyUploadV1;
  uploadDir?: string;
  maxRetainedBytes?: number;
  maxRetainedDirectories?: number;
  signal?: AbortSignal;
}): Promise<StagedBrowserProxyUploadRequest> {
  params.signal?.throwIfAborted();
  if (params.upload === undefined) {
    return { body: params.body };
  }
  if (!isFileChooserRequest(params.method, params.path)) {
    throw new Error("INVALID_REQUEST: browser proxy upload requires the file chooser route");
  }
  const body = asNullableRecord(params.body);
  if (!body || Object.hasOwn(body, "paths")) {
    throw new Error("INVALID_REQUEST: browser proxy upload body must omit paths");
  }
  const files = validateUploadEnvelope(params.upload);
  const uploadDir = params.uploadDir ?? DEFAULT_UPLOAD_DIR;
  const stagingRoot = path.join(uploadDir, BROWSER_PROXY_UPLOAD_ROOT_NAME);
  await fs.mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  // Recursive mkdir succeeds even while an existing staging root still blocks
  // readdir, so it cannot by itself prove an earlier give-up is safe to retry.
  // Only a complete recovery scan proves the fault cleared: unlatch an
  // exhausted recovery budget and drop the cached recovery pass so exhausted
  // cleanup removals are re-probed before quota admission; otherwise repeated
  // uploads would restart the retry loop and keep pinning node update
  // admission.
  const resumeAfterFault =
    (recoveryAttemptCounts.get(uploadDir) ?? 0) >= BROWSER_PROXY_UPLOAD_RECOVERY_MAX_ATTEMPTS ||
    hasExhaustedCleanupAttempts(stagingRoot);
  if (resumeAfterFault && (await stagingRecoveryScanCompletes(stagingRoot))) {
    recoveryAttemptCounts.delete(uploadDir);
    recoveryPromises.delete(uploadDir);
  }
  params.signal?.throwIfAborted();
  await ensureBrowserProxyUploadCleanup({ uploadDir });
  params.signal?.throwIfAborted();
  const decodedFiles: Array<{ buffer: Buffer; name: string }> = [];
  let fileBytes = 0;
  for (const file of files) {
    const buffer = decodeUploadFile(file, fileBytes);
    fileBytes += buffer.byteLength;
    decodedFiles.push({ buffer, name: file.name });
  }
  const retainedRequestBytes = fileBytes + Buffer.byteLength(BROWSER_PROXY_UPLOAD_MARKER_CONTENT);
  const limits = {
    maxRetainedBytes: params.maxRetainedBytes ?? BROWSER_PROXY_UPLOAD_MAX_RETAINED_BYTES,
    maxRetainedDirectories:
      params.maxRetainedDirectories ?? BROWSER_PROXY_UPLOAD_MAX_RETAINED_DIRECTORIES,
  };
  return await withStagingLock(
    uploadDir,
    async () => {
      params.signal?.throwIfAborted();
      const retained = await readOwnedStagedUploads(stagingRoot, params.signal);
      const retainedBytes = retained.reduce((total, upload) => total + upload.bytes, 0);
      if (
        retained.length >= limits.maxRetainedDirectories ||
        retainedBytes + retainedRequestBytes > limits.maxRetainedBytes
      ) {
        throw new Error("RESOURCE_EXHAUSTED: browser proxy upload staging limit reached");
      }
      const directory = await fs.mkdtemp(path.join(stagingRoot, BROWSER_PROXY_UPLOAD_PREFIX));
      const stagedPaths: string[] = [];
      try {
        await fs.writeFile(
          path.join(directory, BROWSER_PROXY_UPLOAD_MARKER_NAME),
          BROWSER_PROXY_UPLOAD_MARKER_CONTENT,
          { flag: "wx", mode: 0o600, signal: params.signal },
        );
        for (const [index, file] of decodedFiles.entries()) {
          params.signal?.throwIfAborted();
          const fileDirectory = path.join(directory, String(index));
          await fs.mkdir(fileDirectory, { mode: 0o700 });
          params.signal?.throwIfAborted();
          const filePath = path.join(fileDirectory, sanitizeUploadName(file.name));
          await fs.writeFile(filePath, file.buffer, {
            flag: "wx",
            mode: 0o600,
            signal: params.signal,
          });
          stagedPaths.push(filePath);
        }
      } catch (error) {
        await removeStagedUpload(directory);
        throw error;
      }
      scheduleCleanup(directory, BROWSER_PROXY_UPLOAD_RETENTION_MS);
      return {
        body: { ...body, paths: stagedPaths },
        directory,
      };
    },
    params.signal,
  );
}

/** Remove staged copies after a request fails before Browser ownership is established. */
export async function discardStagedBrowserProxyUpload(
  staged: StagedBrowserProxyUploadRequest,
): Promise<void> {
  if (staged.directory) {
    await removeStagedUpload(staged.directory);
  }
}
