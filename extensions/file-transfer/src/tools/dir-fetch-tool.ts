import fs from "node:fs/promises";
import path from "node:path";
import { sha256File } from "@openclaw/fs-safe/durability";
import { walkDirectory } from "@openclaw/fs-safe/walk";
import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  ARCHIVE_LIMIT_ERROR_CODE,
  ArchiveLimitError,
  extractArchive,
} from "openclaw/plugin-sdk/archive";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import { textResult } from "openclaw/plugin-sdk/tool-results";
import { DIR_FETCH_ARCHIVE_POLICY } from "../shared/dir-fetch-archive.js";
import {
  DIR_FETCH_DEFAULT_MAX_BYTES,
  DIR_FETCH_HARD_MAX_BYTES,
} from "../shared/dir-fetch-limits.js";
import { IMAGE_MIME_INLINE_SET, mimeFromExtension } from "../shared/mime.js";
import { readClampedInt } from "../shared/params.js";
import { DIR_FETCH_TOOL_DESCRIPTOR, FILE_TRANSFER_SUBDIR } from "./descriptors.js";
import { renderDirectoryText } from "./directory-text.js";
import { decodeFetchPayload } from "./fetch-payload.js";
import { invokeNodeToolPayload, readRequiredNodePath } from "./node-tool-invoke.js";

// Cap how many local file paths we surface in details.media.mediaUrls.
// Larger trees still land on disk but we don't spam the channel adapter
// with hundreds of attachments.
const MEDIA_URL_CAP = 25;

// Hard timeout for gateway-side archive extraction.
const TAR_UNPACK_TIMEOUT_MS = 60_000;

type UnpackedFileEntry = {
  relPath: string;
  size: number;
  mimeType: string;
  sha256: string;
  localPath: string;
};

export function createDirFetchTool(): AnyAgentTool {
  return {
    ...DIR_FETCH_TOOL_DESCRIPTOR,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const { node, requestedPath: dirPath } = readRequiredNodePath(params);

      const maxBytes = readClampedInt({
        input: params,
        key: "maxBytes",
        defaultValue: DIR_FETCH_DEFAULT_MAX_BYTES,
        hardMax: DIR_FETCH_HARD_MAX_BYTES,
      });

      const { audit, payload } = await invokeNodeToolPayload({
        node,
        params,
        command: "dir.fetch",
        commandParams: {
          path: dirPath,
          maxBytes,
        },
        requestedPath: dirPath,
      });

      const {
        canonicalPath,
        size: tarBytes,
        sha256,
        buffer: tarBuffer,
      } = decodeFetchPayload("dir.fetch", payload);

      // Keep the tarball and extracted paths under the same managed tool namespace.
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
      await fs.mkdir(rootDir, { recursive: true, mode: 0o700 });
      try {
        await extractArchive({
          archivePath: savedTar.path,
          destDir: rootDir,
          kind: "tar",
          tarGzip: true,
          timeoutMs: TAR_UNPACK_TIMEOUT_MS,
          entryModes: "clamp",
          ...DIR_FETCH_ARCHIVE_POLICY,
        });
      } catch (error) {
        await Promise.all([
          fs.rm(rootDir, { recursive: true, force: true }).catch(() => undefined),
          fs.rm(savedTar.path, { force: true }).catch(() => undefined),
        ]);
        const reason = error instanceof Error ? error.message : String(error);
        const tooLarge =
          error instanceof ArchiveLimitError &&
          error.code !== ARCHIVE_LIMIT_ERROR_CODE.ENTRY_COUNT_EXCEEDS_LIMIT;
        await audit({
          canonicalPath,
          decision: "error",
          errorCode: tooLarge ? "TREE_TOO_LARGE" : "UNSAFE_ARCHIVE",
          errorMessage: reason,
          sizeBytes: tarBytes,
          sha256,
        });
        const code = tooLarge ? "UNCOMPRESSED_TOO_LARGE" : "UNSAFE_ARCHIVE";
        throw new Error(`dir.fetch ${code}: ${reason}`, { cause: error });
      }

      const walked = await walkDirectory(rootDir, {
        symlinks: "skip",
        include: ({ kind }) => kind === "file",
      });
      if (walked.failedDirs.length > 0) {
        throw walked.failedDirs[0]!.error;
      }
      const files: UnpackedFileEntry[] = [];
      for (const { relativePath: relPath, path: absPath } of walked.entries) {
        const { size } = await fs.stat(absPath);
        const mimeType = mimeFromExtension(relPath);
        const fileSha256 = (await sha256File(absPath)).digest;
        files.push({ relPath, size, mimeType, sha256: fileSha256, localPath: absPath });
      }
      const fileCount = files.length;

      const imageFiles = files.filter((f) => IMAGE_MIME_INLINE_SET.has(f.mimeType));
      const nonImageFiles = files.filter((f) => !IMAGE_MIME_INLINE_SET.has(f.mimeType));
      const allOrdered = [...imageFiles, ...nonImageFiles];
      const mediaUrls = allOrdered.slice(0, MEDIA_URL_CAP).map((f) => f.localPath);

      await audit({
        canonicalPath,
        decision: "allowed",
        sizeBytes: tarBytes,
        sha256,
      });

      const header = JSON.stringify({ rootDir, fileCount: files.length }).slice(0, -1);
      const text = renderDirectoryText({
        // Sort only the text projection; manifest and attachment order are unchanged.
        entries: files.toSorted((a, b) =>
          a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0,
        ),
        project: ({ relPath, size }) => ({ relPath, size }),
        render: (visible) => {
          const manifest = `${header},"displayedCount":${visible.length},"files":[${visible.join(",")}]}`;
          const omitted = files.length - visible.length;
          // A stable footer lets each complete record consume more bytes, including the last one.
          const note = `${omitted} saved files omitted from this text (byte limit or reserved path markers). All remain under rootDir; inspect them with available local file or directory capabilities.`;
          return { manifest, text: `Fetched ${files.length} files.\n${manifest}\n${note}` };
        },
        fallback: `Fetched ${files.length} files. Saved paths omitted: rootDir cannot be represented safely within the 8192-byte text limit. No usable local path is shown.`,
      });
      return textResult(text, {
        path: canonicalPath,
        rootDir,
        fileCount,
        tarBytes,
        sha256,
        files,
        media: {
          mediaUrls,
        },
      });
    },
  };
}
