// Imessage plugin module implements media staging behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { isInboundPathAllowed } from "openclaw/plugin-sdk/media-runtime";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { loadWebMedia } from "openclaw/plugin-sdk/web-media";
import type { IMessageAttachment } from "./types.js";

type StagedIMessageAttachment = {
  path: string;
  contentType?: string;
};

type StagedIMessageAttachments = {
  attachments: StagedIMessageAttachment[];
  unavailableCount: number;
};

type SaveMediaBufferImpl = typeof saveMediaBuffer;

type StageIMessageAttachmentsDeps = {
  saveMediaBuffer?: SaveMediaBufferImpl;
  convertHeicToJpeg?: (sourcePath: string, maxBytes: number) => Promise<Buffer>;
  logVerbose?: (message: string) => void;
};

function isHeicAttachment(attachmentPath: string, mimeType?: string | null): boolean {
  const normalizedMime = mimeType?.toLowerCase();
  if (normalizedMime === "image/heic" || normalizedMime === "image/heif") {
    return true;
  }
  const ext = path.extname(attachmentPath).toLowerCase();
  return ext === ".heic" || ext === ".heif";
}

function jpegFilenameForAttachment(attachmentPath: string): string {
  const parsed = path.parse(attachmentPath);
  return `${parsed.name || "imessage-attachment"}.jpg`;
}

function attachmentLimitMessage(maxBytes: number): string {
  return `attachment exceeds ${Math.round(maxBytes / (1024 * 1024))}MB limit`;
}

async function readFileWithinLimit(filePath: string, maxBytes: number): Promise<Buffer> {
  const handle = await fs.open(filePath, "r");
  try {
    const readLimit = Math.max(0, Math.floor(maxBytes)) + 1;
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let position = 0;
    while (totalBytes <= maxBytes) {
      const chunkSize = Math.min(64 * 1024, Math.max(1, readLimit - totalBytes));
      const chunk = Buffer.allocUnsafe(chunkSize);
      const { bytesRead } = await handle.read(chunk, 0, chunkSize, position);
      if (bytesRead === 0) {
        break;
      }
      totalBytes += bytesRead;
      if (totalBytes > maxBytes) {
        throw new Error(attachmentLimitMessage(maxBytes));
      }
      chunks.push(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
    return Buffer.concat(chunks, totalBytes);
  } finally {
    await handle.close();
  }
}

async function withHeicSnapshot<T>(
  sourcePath: string,
  buffer: Buffer,
  fn: (snapshotPath: string, snapshotDir: string) => Promise<T>,
): Promise<T> {
  const snapshotDir = await fs.mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "openclaw-imessage-heic-"),
  );
  try {
    const snapshotPath = path.join(snapshotDir, path.basename(sourcePath));
    await fs.writeFile(snapshotPath, buffer, { flag: "wx" });
    return await fn(snapshotPath, snapshotDir);
  } finally {
    await fs.rm(snapshotDir, { recursive: true, force: true });
  }
}

function hasWildcardSegment(root: string): boolean {
  return root.replaceAll("\\", "/").split("/").includes("*");
}

async function canonicalizeAllowedRoots(roots: readonly string[]): Promise<string[]> {
  const canonicalRoots: string[] = [];
  for (const root of roots) {
    canonicalRoots.push(root);
    if (hasWildcardSegment(root)) {
      continue;
    }
    const canonicalRoot = await fs.realpath(root).catch(() => undefined);
    if (canonicalRoot && canonicalRoot !== root) {
      canonicalRoots.push(canonicalRoot);
    }
  }
  return canonicalRoots;
}

async function resolveAllowedCanonicalAttachmentPath(params: {
  attachmentPath: string;
  allowedRoots?: readonly string[];
}): Promise<string> {
  if (!params.allowedRoots) {
    return params.attachmentPath;
  }
  const canonicalPath = await fs.realpath(params.attachmentPath);
  const canonicalRoots = await canonicalizeAllowedRoots(params.allowedRoots);
  if (!isInboundPathAllowed({ filePath: canonicalPath, roots: canonicalRoots })) {
    throw new Error("attachment path resolves outside allowed roots");
  }
  return canonicalPath;
}

async function readAttachmentBuffer(params: {
  attachmentPath: string;
  mimeType?: string | null;
  maxBytes: number;
  allowedRoots?: readonly string[];
  deps: StageIMessageAttachmentsDeps;
}): Promise<{ buffer: Buffer; contentType?: string; originalFilename?: string }> {
  const stat = await fs.lstat(params.attachmentPath);
  if (stat.isSymbolicLink()) {
    throw new Error("attachment path is a symlink");
  }
  if (!stat.isFile()) {
    throw new Error("attachment path is not a file");
  }
  if (stat.size > params.maxBytes) {
    throw new Error(attachmentLimitMessage(params.maxBytes));
  }

  const canonicalPath = await resolveAllowedCanonicalAttachmentPath({
    attachmentPath: params.attachmentPath,
    allowedRoots: params.allowedRoots,
  });
  const canonicalStat = await fs.stat(canonicalPath);
  if (!canonicalStat.isFile()) {
    throw new Error("attachment path is not a file");
  }
  if (canonicalStat.size > params.maxBytes) {
    throw new Error(attachmentLimitMessage(params.maxBytes));
  }

  if (isHeicAttachment(params.attachmentPath, params.mimeType)) {
    try {
      const sourceBuffer = await readFileWithinLimit(canonicalPath, params.maxBytes);
      const convert = params.deps.convertHeicToJpeg;
      const converted = await withHeicSnapshot(
        canonicalPath,
        sourceBuffer,
        async (snapshotPath, snapshotDir) =>
          convert
            ? {
                buffer: await convert(snapshotPath, params.maxBytes),
                fileName: jpegFilenameForAttachment(params.attachmentPath),
              }
            : await loadWebMedia(snapshotPath, {
                maxBytes: params.maxBytes,
                localRoots: [snapshotDir],
              }),
      );
      return {
        buffer: converted.buffer,
        contentType: "image/jpeg",
        originalFilename: converted.fileName ?? jpegFilenameForAttachment(params.attachmentPath),
      };
    } catch (err) {
      params.deps.logVerbose?.(
        `imessage: HEIC attachment conversion failed; staging original instead: ${String(err)}`,
      );
    }
  }

  return {
    buffer: await readFileWithinLimit(canonicalPath, params.maxBytes),
    contentType: params.mimeType ?? undefined,
    originalFilename: path.basename(params.attachmentPath),
  };
}

export async function stageIMessageAttachments(
  attachments: IMessageAttachment[],
  params: {
    maxBytes: number;
    allowedRoots?: readonly string[];
    deps?: StageIMessageAttachmentsDeps;
  },
): Promise<StagedIMessageAttachments> {
  const deps = params.deps ?? {};
  const save = deps.saveMediaBuffer ?? saveMediaBuffer;
  const staged: StagedIMessageAttachment[] = [];
  let unavailableCount = 0;

  for (const attachment of attachments) {
    const attachmentPath = attachment.original_path?.trim();
    if (!attachmentPath || attachment.missing) {
      unavailableCount += 1;
      continue;
    }

    try {
      const media = await readAttachmentBuffer({
        attachmentPath,
        mimeType: attachment.mime_type,
        maxBytes: params.maxBytes,
        allowedRoots: params.allowedRoots,
        deps,
      });
      const saved = await save(
        media.buffer,
        media.contentType,
        "inbound",
        params.maxBytes,
        media.originalFilename,
      );
      staged.push({ path: saved.path, contentType: saved.contentType });
    } catch (err) {
      unavailableCount += 1;
      deps.logVerbose?.(`imessage: failed to stage inbound attachment: ${String(err)}`);
    }
  }

  return { attachments: staged, unavailableCount };
}
