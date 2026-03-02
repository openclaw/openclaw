import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { isWindowsDrivePath } from "../infra/archive-path.js";
import {
  createTarEntrySafetyChecker,
  extractArchive as extractArchiveSafe,
} from "../infra/archive.js";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import { isWithinDir } from "../infra/path-safety.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { ensureDir, resolveUserPath } from "../utils.js";
import { formatInstallFailureMessage } from "./skills-install-output.js";
import type { SkillInstallResult } from "./skills-install.js";
import type { SkillEntry, SkillInstallSpec } from "./skills.js";
import { hasBinary } from "./skills.js";
import { resolveSkillToolsRootDir } from "./skills/tools-dir.js";

function isNodeReadableStream(value: unknown): value is NodeJS.ReadableStream {
  return Boolean(value && typeof (value as NodeJS.ReadableStream).pipe === "function");
}

function resolveDownloadTargetDir(entry: SkillEntry, spec: SkillInstallSpec): string {
  const safeRoot = resolveSkillToolsRootDir(entry);
  const raw = spec.targetDir?.trim();
  if (!raw) {
    return safeRoot;
  }

  // Treat non-absolute paths as relative to the per-skill tools root.
  const resolved =
    raw.startsWith("~") || path.isAbsolute(raw) || isWindowsDrivePath(raw)
      ? resolveUserPath(raw)
      : path.resolve(safeRoot, raw);

  if (!isWithinDir(safeRoot, resolved)) {
    throw new Error(
      `Refusing to install outside the skill tools directory. targetDir="${raw}" resolves to "${resolved}". Allowed root: "${safeRoot}".`,
    );
  }
  return resolved;
}

function resolveArchiveType(spec: SkillInstallSpec, filename: string): string | undefined {
  const explicit = spec.archive?.trim().toLowerCase();
  if (explicit) {
    return explicit;
  }
  const lower = filename.toLowerCase();
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) {
    return "tar.gz";
  }
  if (lower.endsWith(".tar.bz2") || lower.endsWith(".tbz2")) {
    return "tar.bz2";
  }
  if (lower.endsWith(".zip")) {
    return "zip";
  }
  return undefined;
}

const TAR_VERBOSE_MONTHS = new Set([
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
]);
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function mapTarVerboseTypeChar(typeChar: string): string {
  switch (typeChar) {
    case "l":
      return "SymbolicLink";
    case "h":
      return "Link";
    case "b":
      return "BlockDevice";
    case "c":
      return "CharacterDevice";
    case "p":
      return "FIFO";
    case "s":
      return "Socket";
    case "d":
      return "Directory";
    default:
      return "File";
  }
}

function parseTarVerboseSize(line: string): number {
  const tokens = line.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 6) {
    throw new Error(`unable to parse tar verbose metadata: ${line}`);
  }

  let dateIndex = tokens.findIndex((token) => TAR_VERBOSE_MONTHS.has(token));
  if (dateIndex > 0) {
    const size = Number.parseInt(tokens[dateIndex - 1] ?? "", 10);
    if (!Number.isFinite(size) || size < 0) {
      throw new Error(`unable to parse tar entry size: ${line}`);
    }
    return size;
  }

  dateIndex = tokens.findIndex((token) => ISO_DATE_PATTERN.test(token));
  if (dateIndex > 0) {
    const size = Number.parseInt(tokens[dateIndex - 1] ?? "", 10);
    if (!Number.isFinite(size) || size < 0) {
      throw new Error(`unable to parse tar entry size: ${line}`);
    }
    return size;
  }

  throw new Error(`unable to parse tar verbose metadata: ${line}`);
}

function parseTarVerboseMetadata(stdout: string): Array<{ type: string; size: number }> {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.map((line) => {
    const typeChar = line[0] ?? "";
    if (!typeChar) {
      throw new Error("unable to parse tar entry type");
    }
    return {
      type: mapTarVerboseTypeChar(typeChar),
      size: parseTarVerboseSize(line),
    };
  });
}

async function hashFileSha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = fs.createReadStream(filePath);
  return await new Promise<string>((resolve, reject) => {
    stream.on("data", (chunk) => {
      hash.update(chunk as Buffer);
    });
    stream.on("error", reject);
    stream.on("end", () => {
      resolve(hash.digest("hex"));
    });
  });
}

async function downloadFile(
  url: string,
  destPath: string,
  timeoutMs: number,
): Promise<{ bytes: number }> {
  const { response, release } = await fetchWithSsrFGuard({
    url,
    timeoutMs: Math.max(1_000, timeoutMs),
  });
  try {
    if (!response.ok || !response.body) {
      throw new Error(`Download failed (${response.status} ${response.statusText})`);
    }
    await ensureDir(path.dirname(destPath));
    const file = fs.createWriteStream(destPath);
    const body = response.body as unknown;
    const readable = isNodeReadableStream(body)
      ? body
      : Readable.fromWeb(body as NodeReadableStream);
    await pipeline(readable, file);
    const stat = await fs.promises.stat(destPath);
    return { bytes: stat.size };
  } finally {
    await release();
  }
}

async function extractArchive(params: {
  archivePath: string;
  archiveType: string;
  targetDir: string;
  stripComponents?: number;
  timeoutMs: number;
}): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const { archivePath, archiveType, targetDir, stripComponents, timeoutMs } = params;
  const strip =
    typeof stripComponents === "number" && Number.isFinite(stripComponents)
      ? Math.max(0, Math.floor(stripComponents))
      : 0;

  try {
    if (archiveType === "zip") {
      await extractArchiveSafe({
        archivePath,
        destDir: targetDir,
        timeoutMs,
        kind: "zip",
        stripComponents: strip,
      });
      return { stdout: "", stderr: "", code: 0 };
    }

    if (archiveType === "tar.gz") {
      await extractArchiveSafe({
        archivePath,
        destDir: targetDir,
        timeoutMs,
        kind: "tar",
        stripComponents: strip,
        tarGzip: true,
      });
      return { stdout: "", stderr: "", code: 0 };
    }

    if (archiveType === "tar.bz2") {
      if (!hasBinary("tar")) {
        return { stdout: "", stderr: "tar not found on PATH", code: null };
      }

      const preflightHash = await hashFileSha256(archivePath);

      // Preflight list to prevent zip-slip style traversal before extraction.
      const listResult = await runCommandWithTimeout(["tar", "tf", archivePath], { timeoutMs });
      if (listResult.code !== 0) {
        return {
          stdout: listResult.stdout,
          stderr: listResult.stderr || "tar list failed",
          code: listResult.code,
        };
      }
      const entries = listResult.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

      const verboseResult = await runCommandWithTimeout(["tar", "tvf", archivePath], { timeoutMs });
      if (verboseResult.code !== 0) {
        return {
          stdout: verboseResult.stdout,
          stderr: verboseResult.stderr || "tar verbose list failed",
          code: verboseResult.code,
        };
      }
      const metadata = parseTarVerboseMetadata(verboseResult.stdout);
      if (metadata.length !== entries.length) {
        return {
          stdout: verboseResult.stdout,
          stderr: `tar verbose/list entry count mismatch (${metadata.length} vs ${entries.length})`,
          code: 1,
        };
      }
      const checkTarEntrySafety = createTarEntrySafetyChecker({
        rootDir: targetDir,
        stripComponents: strip,
        escapeLabel: "targetDir",
      });
      for (let i = 0; i < entries.length; i += 1) {
        const entryPath = entries[i];
        const entryMeta = metadata[i];
        if (!entryPath || !entryMeta) {
          return {
            stdout: verboseResult.stdout,
            stderr: "tar metadata parse failure",
            code: 1,
          };
        }
        checkTarEntrySafety({
          path: entryPath,
          type: entryMeta.type,
          size: entryMeta.size,
        });
      }

      const postPreflightHash = await hashFileSha256(archivePath);
      if (postPreflightHash !== preflightHash) {
        return {
          stdout: "",
          stderr: "tar archive changed during safety preflight; refusing to extract",
          code: 1,
        };
      }

      const argv = ["tar", "xf", archivePath, "-C", targetDir];
      if (strip > 0) {
        argv.push("--strip-components", String(strip));
      }
      return await runCommandWithTimeout(argv, { timeoutMs });
    }

    return { stdout: "", stderr: `unsupported archive type: ${archiveType}`, code: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { stdout: "", stderr: message, code: 1 };
  }
}

export async function installDownloadSpec(params: {
  entry: SkillEntry;
  spec: SkillInstallSpec;
  timeoutMs: number;
}): Promise<SkillInstallResult> {
  const { entry, spec, timeoutMs } = params;
  const url = spec.url?.trim();
  if (!url) {
    return {
      ok: false,
      message: "missing download url",
      stdout: "",
      stderr: "",
      code: null,
    };
  }

  let filename = "";
  try {
    const parsed = new URL(url);
    filename = path.basename(parsed.pathname);
  } catch {
    filename = path.basename(url);
  }
  if (!filename) {
    filename = "download";
  }

  let targetDir = "";
  try {
    targetDir = resolveDownloadTargetDir(entry, spec);
    await ensureDir(targetDir);
    const stat = await fs.promises.lstat(targetDir);
    if (stat.isSymbolicLink()) {
      throw new Error(`targetDir is a symlink: ${targetDir}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`targetDir is not a directory: ${targetDir}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message, stdout: "", stderr: message, code: null };
  }

  const archivePath = path.join(targetDir, filename);
  let downloaded = 0;
  try {
    const result = await downloadFile(url, archivePath, timeoutMs);
    downloaded = result.bytes;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message, stdout: "", stderr: message, code: null };
  }

  const archiveType = resolveArchiveType(spec, filename);
  const shouldExtract = spec.extract ?? Boolean(archiveType);
  if (!shouldExtract) {
    return {
      ok: true,
      message: `Downloaded to ${archivePath}`,
      stdout: `downloaded=${downloaded}`,
      stderr: "",
      code: 0,
    };
  }

  if (!archiveType) {
    return {
      ok: false,
      message: "extract requested but archive type could not be detected",
      stdout: "",
      stderr: "",
      code: null,
    };
  }

  const extractResult = await extractArchive({
    archivePath,
    archiveType,
    targetDir,
    stripComponents: spec.stripComponents,
    timeoutMs,
  });
  const success = extractResult.code === 0;
  return {
    ok: success,
    message: success
      ? `Downloaded and extracted to ${targetDir}`
      : formatInstallFailureMessage(extractResult),
    stdout: extractResult.stdout.trim(),
    stderr: extractResult.stderr.trim(),
    code: extractResult.code,
  };
}
