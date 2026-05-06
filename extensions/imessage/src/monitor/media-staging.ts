import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import type { IMessageAttachment } from "./types.js";

const execFileAsync = promisify(execFile);

export type StagedIMessageAttachment = {
  path: string;
  contentType?: string;
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

async function convertHeicToJpegWithSips(sourcePath: string, maxBytes: number): Promise<Buffer> {
  const tempPath = path.join(os.tmpdir(), `openclaw-imessage-${randomUUID()}.jpg`);
  try {
    await execFileAsync("sips", [
      "-s",
      "format",
      "jpeg",
      "-s",
      "formatOptions",
      "90",
      "-Z",
      "4096",
      sourcePath,
      "--out",
      tempPath,
    ]);
    const stat = await fs.stat(tempPath);
    if (stat.size > maxBytes) {
      throw new Error(`converted media exceeds ${Math.round(maxBytes / (1024 * 1024))}MB limit`);
    }
    return await fs.readFile(tempPath);
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

async function readAttachmentBuffer(params: {
  attachmentPath: string;
  mimeType?: string | null;
  maxBytes: number;
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
    throw new Error(`attachment exceeds ${Math.round(params.maxBytes / (1024 * 1024))}MB limit`);
  }

  if (isHeicAttachment(params.attachmentPath, params.mimeType)) {
    try {
      const convert = params.deps.convertHeicToJpeg ?? convertHeicToJpegWithSips;
      return {
        buffer: await convert(params.attachmentPath, params.maxBytes),
        contentType: "image/jpeg",
        originalFilename: jpegFilenameForAttachment(params.attachmentPath),
      };
    } catch (err) {
      params.deps.logVerbose?.(
        `imessage: HEIC attachment conversion failed; staging original instead: ${String(err)}`,
      );
    }
  }

  return {
    buffer: await fs.readFile(params.attachmentPath),
    contentType: params.mimeType ?? undefined,
    originalFilename: path.basename(params.attachmentPath),
  };
}

export async function stageIMessageAttachments(
  attachments: IMessageAttachment[],
  params: {
    maxBytes: number;
    deps?: StageIMessageAttachmentsDeps;
  },
): Promise<StagedIMessageAttachment[]> {
  const deps = params.deps ?? {};
  const save = deps.saveMediaBuffer ?? saveMediaBuffer;
  const staged: StagedIMessageAttachment[] = [];

  for (const attachment of attachments) {
    const attachmentPath = attachment.original_path?.trim();
    if (!attachmentPath || attachment.missing) {
      continue;
    }

    try {
      const media = await readAttachmentBuffer({
        attachmentPath,
        mimeType: attachment.mime_type,
        maxBytes: params.maxBytes,
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
      deps.logVerbose?.(`imessage: failed to stage inbound attachment: ${String(err)}`);
    }
  }

  return staged;
}
