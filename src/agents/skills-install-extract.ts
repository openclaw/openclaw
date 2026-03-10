import { createHash } from "node:crypto";
import fs from "node:fs";
import {
  createTarEntrySafetyChecker,
  extractArchive as extractArchiveSafe,
  mergeExtractedTreeIntoDestination,
  prepareArchiveDestinationDir,
  withStagedArchiveDestination,
} from "../infra/archive.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { parseTarVerboseMetadata } from "./skills-install-tar-verbose.js";
import { hasBinary } from "./skills.js";

export type ArchiveExtractResult = { stdout: string; stderr: string; code: number | null };

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

export async function extractArchive(params: {
  archivePath: string;
  archiveType: string;
  targetDir: string;
  stripComponents?: number;
  timeoutMs: number;
}): Promise<ArchiveExtractResult> {
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

      const destinationRealDir = await prepareArchiveDestinationDir(targetDir);
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
        rootDir: destinationRealDir,
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

      return await withStagedArchiveDestination({
        destinationRealDir,
        run: async (stagingDir) => {
          const argv = ["tar", "xf", archivePath, "-C", stagingDir];
          if (strip > 0) {
            argv.push("--strip-components", String(strip));
          }
          const extractResult = await runCommandWithTimeout(argv, { timeoutMs });
          if (extractResult.code !== 0) {
            return extractResult;
          }
          await mergeExtractedTreeIntoDestination({
            sourceDir: stagingDir,
            destinationDir: destinationRealDir,
            destinationRealDir,
          });
          return extractResult;
        },
      });
    }

    return { stdout: "", stderr: `unsupported archive type: ${archiveType}`, code: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { stdout: "", stderr: message, code: 1 };
  }
}
