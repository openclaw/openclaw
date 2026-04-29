import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  callGatewayTool,
  listNodes,
  resolveNodeIdFromList,
  type AnyAgentTool,
  type NodeListNode,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import { Type } from "typebox";
import { appendFileTransferAudit } from "../shared/audit.js";
import { throwFromNodePayload } from "../shared/errors.js";
import { gatekeep } from "../shared/gatekeep.js";
import { IMAGE_MIME_INLINE_SET, mimeFromExtension } from "../shared/mime.js";
import {
  humanSize,
  readBoolean,
  readClampedInt,
  readGatewayCallOptions,
  readTrimmedString,
} from "../shared/params.js";
import { evaluateFilePolicy } from "../shared/policy.js";

const DIR_FETCH_DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DIR_FETCH_HARD_MAX_BYTES = 16 * 1024 * 1024;
const FILE_TRANSFER_SUBDIR = "file-transfer";

// Cap how many local file paths we surface in details.media.mediaUrls.
// Larger trees still land on disk but we don't spam the channel adapter
// with hundreds of attachments.
const MEDIA_URL_CAP = 25;

// Hard timeout for the gateway-side `tar -xzf` unpack process.
const TAR_UNPACK_TIMEOUT_MS = 60_000;

const DirFetchToolSchema = Type.Object({
  node: Type.String({
    description: "Node id, name, or IP. Resolves the same way as the nodes tool.",
  }),
  path: Type.String({
    description: "Absolute path to the directory on the node to fetch. Canonicalized server-side.",
  }),
  maxBytes: Type.Optional(
    Type.Number({
      description:
        "Max gzipped tarball bytes to fetch. Default 8 MB, hard ceiling 16 MB (single round-trip).",
    }),
  ),
  includeDotfiles: Type.Optional(
    Type.Boolean({
      description: "Reserved for v2; currently always includes dotfiles (v1 quirk in BSD tar).",
    }),
  ),
  gatewayUrl: Type.Optional(Type.String()),
  gatewayToken: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Number()),
});

async function computeFileSha256(filePath: string): Promise<string> {
  const buf = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

type UnpackedFileEntry = {
  relPath: string;
  size: number;
  mimeType: string;
  sha256: string;
  localPath: string;
};

/**
 * Unpack a gzipped tarball into a target directory via `tar -xzf -`. The
 * `-P` flag is intentionally omitted so absolute paths in the archive are
 * stripped to relative ones and `..` traversal is rejected by tar itself.
 * A hard wall-clock timeout caps the unpack at TAR_UNPACK_TIMEOUT_MS to
 * avoid hangs on hostile/large archives.
 */
async function unpackTar(tarBuffer: Buffer, destDir: string): Promise<void> {
  await fs.mkdir(destDir, { recursive: true, mode: 0o700 });
  return new Promise((resolve, reject) => {
    const tarBin = process.platform !== "win32" ? "/usr/bin/tar" : "tar";
    const child = spawn(
      tarBin,
      [
        "-xzf",
        "-",
        "-C",
        destDir,
        // Refuse archives whose paths escape destDir.
        "--no-overwrite-dir",
      ],
      { stdio: ["pipe", "ignore", "pipe"] },
    );
    let stderrOut = "";
    const watchdog = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      reject(new Error(`tar unpack timed out after ${TAR_UNPACK_TIMEOUT_MS}ms`));
    }, TAR_UNPACK_TIMEOUT_MS);
    child.stderr.on("data", (chunk: Buffer) => {
      stderrOut += chunk.toString();
    });
    child.on("close", (code) => {
      clearTimeout(watchdog);
      if (code !== 0) {
        reject(new Error(`tar unpack exited ${code}: ${stderrOut.slice(0, 300)}`));
        return;
      }
      resolve();
    });
    child.on("error", (e) => {
      clearTimeout(watchdog);
      reject(e);
    });
    child.stdin.end(tarBuffer);
  });
}

/**
 * Walk a directory recursively, collecting file entries (skips directories).
 * Skips symlinks — we don't want to follow links the archive might have
 * carried in. Files only.
 */
async function walkDir(
  dir: string,
  rootDir: string,
): Promise<{ relPath: string; absPath: string }[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const results: { relPath: string; absPath: string }[] = [];
  for (const entry of entries) {
    const absPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await walkDir(absPath, rootDir);
      results.push(...nested);
    } else if (entry.isFile()) {
      const relPath = path.relative(rootDir, absPath);
      results.push({ relPath, absPath });
    }
    // Symlinks are intentionally ignored: don't follow them out of destDir.
  }
  return results;
}

export function createDirFetchTool(): AnyAgentTool {
  return {
    label: "Directory Fetch",
    name: "dir_fetch",
    description:
      "Retrieve a directory tree from a paired node as a gzipped tarball, unpack it on the gateway, and return a manifest of saved paths. Use to pull source trees, asset folders, or log directories in a single round-trip. The unpacked files live on the GATEWAY (not your local machine); pass localPath into other tools or use file_fetch on individual entries to ship them elsewhere. Rejects trees larger than 16 MB compressed. Requires operator opt-in: gateway.nodes.allowCommands must include 'dir.fetch' AND gateway.nodes.fileTransfer.<node>.allowReadPaths must match the directory path.",
    parameters: DirFetchToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const node = readTrimmedString(params, "node");
      const dirPath = readTrimmedString(params, "path");
      if (!node) {
        throw new Error("node required");
      }
      if (!dirPath) {
        throw new Error("path required");
      }

      const maxBytes = readClampedInt({
        input: params,
        key: "maxBytes",
        defaultValue: DIR_FETCH_DEFAULT_MAX_BYTES,
        hardMin: 1,
        hardMax: DIR_FETCH_HARD_MAX_BYTES,
      });
      const includeDotfiles = readBoolean(params, "includeDotfiles", false);

      const gatewayOpts = readGatewayCallOptions(params);
      const nodes: NodeListNode[] = await listNodes(gatewayOpts);
      const nodeId = resolveNodeIdFromList(nodes, node, false);
      const nodeMeta = nodes.find((n) => n.nodeId === nodeId);
      const nodeDisplayName = nodeMeta?.displayName ?? node;
      const startedAt = Date.now();

      const gate = await gatekeep({
        op: "dir.fetch",
        nodeId,
        nodeDisplayName,
        kind: "read",
        path: dirPath,
        toolCallId: _toolCallId,
        gatewayOpts,
        startedAt,
        promptVerb: "Fetch directory tree",
      });
      if (!gate.ok) {
        throw new Error(gate.throwMessage);
      }
      const effectiveMaxBytes = gate.maxBytes ? Math.min(maxBytes, gate.maxBytes) : maxBytes;

      const raw = await callGatewayTool<{ payload: unknown }>("node.invoke", gatewayOpts, {
        nodeId,
        command: "dir.fetch",
        params: {
          path: dirPath,
          maxBytes: effectiveMaxBytes,
          includeDotfiles,
        },
        idempotencyKey: crypto.randomUUID(),
      });

      const payload =
        raw?.payload && typeof raw.payload === "object" && !Array.isArray(raw.payload)
          ? (raw.payload as Record<string, unknown>)
          : null;
      if (!payload) {
        await appendFileTransferAudit({
          op: "dir.fetch",
          nodeId,
          nodeDisplayName,
          requestedPath: dirPath,
          decision: "error",
          errorMessage: "invalid payload",
          durationMs: Date.now() - startedAt,
        });
        throw new Error("invalid dir.fetch payload");
      }
      if (payload.ok === false) {
        await appendFileTransferAudit({
          op: "dir.fetch",
          nodeId,
          nodeDisplayName,
          requestedPath: dirPath,
          canonicalPath:
            typeof payload.canonicalPath === "string" ? payload.canonicalPath : undefined,
          decision: "error",
          errorCode: typeof payload.code === "string" ? payload.code : undefined,
          errorMessage: typeof payload.message === "string" ? payload.message : undefined,
          durationMs: Date.now() - startedAt,
        });
        throwFromNodePayload("dir.fetch", payload);
      }

      const canonicalPath = typeof payload.path === "string" ? payload.path : "";
      const tarBase64 = typeof payload.tarBase64 === "string" ? payload.tarBase64 : "";
      const tarBytes = typeof payload.tarBytes === "number" ? payload.tarBytes : -1;
      const sha256 = typeof payload.sha256 === "string" ? payload.sha256 : "";
      const fileCount = typeof payload.fileCount === "number" ? payload.fileCount : 0;

      if (!canonicalPath || !tarBase64 || tarBytes < 0 || !sha256) {
        throw new Error("invalid dir.fetch payload (missing fields)");
      }

      // Post-flight policy on canonicalized path.
      if (canonicalPath !== dirPath) {
        const postflight = evaluateFilePolicy({
          nodeId,
          nodeDisplayName,
          kind: "read",
          path: canonicalPath,
        });
        if (!postflight.ok) {
          await appendFileTransferAudit({
            op: "dir.fetch",
            nodeId,
            nodeDisplayName,
            requestedPath: dirPath,
            canonicalPath,
            decision: "denied:symlink_escape",
            errorCode: postflight.code,
            reason: postflight.reason,
            durationMs: Date.now() - startedAt,
          });
          throw new Error(
            `dir.fetch SYMLINK_TARGET_DENIED: requested path resolved to ${canonicalPath} which is not allowed by policy`,
          );
        }
      }

      const tarBuffer = Buffer.from(tarBase64, "base64");
      if (tarBuffer.byteLength !== tarBytes) {
        throw new Error(
          `dir.fetch size mismatch: payload says ${tarBytes} bytes, decoded ${tarBuffer.byteLength}`,
        );
      }
      const localSha256 = crypto.createHash("sha256").update(tarBuffer).digest("hex");
      if (localSha256 !== sha256) {
        throw new Error("dir.fetch sha256 mismatch (integrity failure)");
      }

      // Save tarball under the file-transfer subdir (no 2-min TTL).
      const savedTar = await saveMediaBuffer(
        tarBuffer,
        "application/gzip",
        FILE_TRANSFER_SUBDIR,
        DIR_FETCH_HARD_MAX_BYTES,
      );

      const tarDir = path.dirname(savedTar.path);
      const tarBaseName = path.basename(savedTar.path, path.extname(savedTar.path));
      const unpackId = `dir-fetch-${tarBaseName}`;
      const rootDir = path.join(tarDir, unpackId);

      await unpackTar(tarBuffer, rootDir);

      const walked = await walkDir(rootDir, rootDir);
      const files: UnpackedFileEntry[] = [];
      for (const { relPath, absPath } of walked) {
        let size = 0;
        try {
          const st = await fs.stat(absPath);
          size = st.size;
        } catch {
          continue;
        }
        const mimeType = mimeFromExtension(relPath);
        const fileSha256 = await computeFileSha256(absPath);
        files.push({ relPath, size, mimeType, sha256: fileSha256, localPath: absPath });
      }

      const imageFiles = files.filter((f) => IMAGE_MIME_INLINE_SET.has(f.mimeType));
      const nonImageFiles = files.filter((f) => !IMAGE_MIME_INLINE_SET.has(f.mimeType));
      const allOrdered = [...imageFiles, ...nonImageFiles];
      const droppedFromMedia = Math.max(0, allOrdered.length - MEDIA_URL_CAP);
      const mediaUrls = allOrdered.slice(0, MEDIA_URL_CAP).map((f) => f.localPath);

      const shortHash = sha256.slice(0, 12);
      const mediaNote = droppedFromMedia
        ? ` (channel attaches first ${MEDIA_URL_CAP}; ${droppedFromMedia} more in details.files)`
        : "";
      const summaryText = `Fetched ${fileCount} files from ${canonicalPath} (${humanSize(tarBytes)} compressed, sha256:${shortHash}) — saved on the gateway under ${rootDir}/${mediaNote}`;

      await appendFileTransferAudit({
        op: "dir.fetch",
        nodeId,
        nodeDisplayName,
        requestedPath: dirPath,
        canonicalPath,
        decision: "allowed",
        sizeBytes: tarBytes,
        sha256,
        durationMs: Date.now() - startedAt,
      });

      return {
        content: [{ type: "text" as const, text: summaryText }],
        details: {
          path: canonicalPath,
          rootDir,
          fileCount,
          tarBytes,
          sha256,
          files,
          media: {
            mediaUrls,
          },
        },
      };
    },
  };
}
