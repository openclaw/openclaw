import fs from "node:fs/promises";
import path from "node:path";
import type { ChannelInboundMediaInput } from "openclaw/plugin-sdk/channel-inbound";
import { readFileHandleBounded } from "openclaw/plugin-sdk/file-access-runtime";
import { isInboundPathAllowed, kindFromMime, runFfmpeg } from "openclaw/plugin-sdk/media-runtime";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import {
  FsSafeError,
  openLocalFileSafely,
  writeExternalFileWithinRoot,
} from "openclaw/plugin-sdk/security-runtime";
import { resolvePreferredOpenClawTmpDir, withTempWorkspace } from "openclaw/plugin-sdk/temp-path";
import { loadWebMedia } from "openclaw/plugin-sdk/web-media";
import type { IMessageAttachment } from "./types.js";

type StagedIMessageAttachments = {
  attachments: ChannelInboundMediaInput[];
  unavailableCount: number;
};

type StageIMessageAttachmentsDeps = {
  logVerbose?: (message: string) => void;
};

function createTypeOnlyIMessageAttachment(
  attachment: IMessageAttachment,
): ChannelInboundMediaInput {
  const contentType = attachment.mime_type?.trim() || undefined;
  return { contentType, kind: kindFromMime(contentType) ?? "unknown" };
}

function isHeicAttachment(attachmentPath: string, mimeType?: string | null): boolean {
  const normalizedMime = mimeType?.toLowerCase();
  if (normalizedMime === "image/heic" || normalizedMime === "image/heif") {
    return true;
  }
  const ext = path.extname(attachmentPath).toLowerCase();
  return ext === ".heic" || ext === ".heif";
}

function isCafAttachment(
  buffer: Buffer,
  attachmentPath: string,
  mimeType?: string | null,
): boolean {
  const mime = mimeType?.split(";", 1)[0]?.trim().toLowerCase();
  return (
    buffer.toString("ascii", 0, 4) === "caff" ||
    path.extname(attachmentPath).toLowerCase() === ".caf" ||
    mime === "audio/x-caf" ||
    mime === "audio/caf"
  );
}

async function readAttachmentBuffer(params: {
  attachmentPath: string;
  mimeType?: string | null;
  maxBytes: number;
  allowedRoots?: readonly string[];
  deps: StageIMessageAttachmentsDeps;
}): Promise<{ buffer: Buffer; contentType?: string; originalFilename?: string }> {
  await using opened = await openLocalFileSafely({
    filePath: params.attachmentPath,
  });
  if (opened.stat.size > params.maxBytes) {
    throw new Error(`attachment exceeds ${Math.round(params.maxBytes / (1024 * 1024))}MB limit`);
  }
  if (params.allowedRoots) {
    const canonicalRoots: string[] = [];
    for (const root of params.allowedRoots) {
      canonicalRoots.push(root);
      if (root.replaceAll("\\", "/").split("/").includes("*")) {
        continue;
      }
      const canonicalRoot = await fs.realpath(root).catch(() => undefined);
      if (canonicalRoot && canonicalRoot !== root) {
        canonicalRoots.push(canonicalRoot);
      }
    }
    if (!isInboundPathAllowed({ filePath: opened.realPath, roots: canonicalRoots })) {
      throw new Error("attachment path resolves outside allowed roots");
    }
  }
  // The inode can grow after the pinned open; keep the allocation bounded as well as the stat.
  const buffer = await readFileHandleBounded(opened.handle, params.maxBytes).catch(
    (error: unknown) => {
      if (error instanceof FsSafeError && error.code === "too-large") {
        throw new Error(
          `attachment exceeds ${Math.round(params.maxBytes / (1024 * 1024))}MB limit`,
        );
      }
      throw error;
    },
  );

  // Native voice notes use CAF, which common transcription providers reject.
  // Convert the pinned bytes, never reopen the original attachment pathname.
  if (isCafAttachment(buffer, params.attachmentPath, params.mimeType)) {
    const converted = await withTempWorkspace(
      { rootDir: resolvePreferredOpenClawTmpDir(), prefix: "openclaw-imessage-caf-" },
      async (workspace) => {
        const inputPath = await workspace.write("input.caf", buffer);
        await writeExternalFileWithinRoot({
          rootDir: workspace.dir,
          path: "output.wav",
          write: async (outputPath) => {
            await runFfmpeg(
              [
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "caf",
                "-i",
                inputPath,
                "-vn",
                "-sn",
                "-dn",
                "-ac",
                "1",
                "-ar",
                "16000",
                "-c:a",
                "pcm_s16le",
                "-f",
                "wav",
                // ffmpeg can succeed after reaching its size cap. Exceed the
                // staging limit so a truncated voice note is rejected below.
                "-fs",
                String(params.maxBytes + 1),
                outputPath,
              ],
              { timeoutMs: 30_000 },
            );
          },
        });
        const wav = await workspace.read("output.wav");
        if (wav.length > params.maxBytes) {
          throw new Error("converted iMessage audio exceeds the attachment limit");
        }
        return wav;
      },
    );
    return {
      buffer: converted,
      contentType: "audio/wav",
      originalFilename: `${path.parse(params.attachmentPath).name || "imessage-attachment"}.wav`,
    };
  }

  if (isHeicAttachment(params.attachmentPath, params.mimeType)) {
    try {
      const converted = await withTempWorkspace(
        { rootDir: resolvePreferredOpenClawTmpDir(), prefix: "openclaw-imessage-heic-" },
        async (workspace) => {
          const pinnedPath = await workspace.write("attachment.heic", buffer);
          return await loadWebMedia(pinnedPath, {
            maxBytes: params.maxBytes,
            localRoots: [workspace.dir],
          });
        },
      );
      return {
        buffer: converted.buffer,
        contentType: "image/jpeg",
        originalFilename: `${path.parse(params.attachmentPath).name || "imessage-attachment"}.jpg`,
      };
    } catch (err) {
      params.deps.logVerbose?.(
        `imessage: HEIC attachment conversion failed; staging original instead: ${String(err)}`,
      );
    }
  }

  return {
    buffer,
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
  const staged: ChannelInboundMediaInput[] = [];
  let unavailableCount = 0;

  for (const attachment of attachments) {
    const attachmentPath = attachment.original_path?.trim();
    if (!attachmentPath || attachment.missing) {
      unavailableCount += 1;
      staged.push(createTypeOnlyIMessageAttachment(attachment));
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
      const saved = await saveMediaBuffer(
        media.buffer,
        media.contentType,
        "inbound",
        params.maxBytes,
        media.originalFilename,
      );
      const contentType = saved.contentType ?? media.contentType;
      staged.push({
        path: saved.path,
        contentType,
        kind: kindFromMime(contentType) ?? "unknown",
      });
    } catch (err) {
      unavailableCount += 1;
      staged.push(createTypeOnlyIMessageAttachment(attachment));
      deps.logVerbose?.(`imessage: failed to stage inbound attachment: ${String(err)}`);
    }
  }

  return { attachments: staged, unavailableCount };
}
