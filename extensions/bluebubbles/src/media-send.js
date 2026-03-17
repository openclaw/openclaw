import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveChannelMediaMaxBytes } from "openclaw/plugin-sdk/bluebubbles";
import { resolveBlueBubblesAccount } from "./accounts.js";
import { sendBlueBubblesAttachment } from "./attachments.js";
import { resolveBlueBubblesMessageId } from "./monitor.js";
import { getBlueBubblesRuntime } from "./runtime.js";
import { sendMessageBlueBubbles } from "./send.js";
const HTTP_URL_RE = /^https?:\/\//i;
const MB = 1024 * 1024;
function assertMediaWithinLimit(sizeBytes, maxBytes) {
  if (typeof maxBytes !== "number" || maxBytes <= 0) {
    return;
  }
  if (sizeBytes <= maxBytes) {
    return;
  }
  const maxLabel = (maxBytes / MB).toFixed(0);
  const sizeLabel = (sizeBytes / MB).toFixed(2);
  throw new Error(`Media exceeds ${maxLabel}MB limit (got ${sizeLabel}MB)`);
}
function resolveLocalMediaPath(source) {
  if (!source.startsWith("file://")) {
    return source;
  }
  try {
    return fileURLToPath(source);
  } catch {
    throw new Error(`Invalid file:// URL: ${source}`);
  }
}
function expandHomePath(input) {
  if (input === "~") {
    return os.homedir();
  }
  if (input.startsWith("~/") || input.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}
function resolveConfiguredPath(input) {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Empty mediaLocalRoots entry is not allowed");
  }
  if (trimmed.startsWith("file://")) {
    let parsed;
    try {
      parsed = fileURLToPath(trimmed);
    } catch {
      throw new Error(`Invalid file:// URL in mediaLocalRoots: ${input}`);
    }
    if (!path.isAbsolute(parsed)) {
      throw new Error(`mediaLocalRoots entries must be absolute paths: ${input}`);
    }
    return parsed;
  }
  const resolved = expandHomePath(trimmed);
  if (!path.isAbsolute(resolved)) {
    throw new Error(`mediaLocalRoots entries must be absolute paths: ${input}`);
  }
  return resolved;
}
function isPathInsideRoot(candidate, root) {
  const normalizedCandidate = path.normalize(candidate);
  const normalizedRoot = path.normalize(root);
  const rootWithSep = normalizedRoot.endsWith(path.sep) ? normalizedRoot : normalizedRoot + path.sep;
  if (process.platform === "win32") {
    const candidateLower = normalizedCandidate.toLowerCase();
    const rootLower = normalizedRoot.toLowerCase();
    const rootWithSepLower = rootWithSep.toLowerCase();
    return candidateLower === rootLower || candidateLower.startsWith(rootWithSepLower);
  }
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(rootWithSep);
}
function resolveMediaLocalRoots(params) {
  const account = resolveBlueBubblesAccount({
    cfg: params.cfg,
    accountId: params.accountId
  });
  return (account.config.mediaLocalRoots ?? []).map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}
async function assertLocalMediaPathAllowed(params) {
  if (params.localRoots.length === 0) {
    throw new Error(
      `Local BlueBubbles media paths are disabled by default. Set channels.bluebubbles.mediaLocalRoots${params.accountId ? ` or channels.bluebubbles.accounts.${params.accountId}.mediaLocalRoots` : ""} to explicitly allow local file directories.`
    );
  }
  const resolvedLocalPath = path.resolve(params.localPath);
  const supportsNoFollow = process.platform !== "win32" && "O_NOFOLLOW" in fsConstants;
  const openFlags = fsConstants.O_RDONLY | (supportsNoFollow ? fsConstants.O_NOFOLLOW : 0);
  for (const rootEntry of params.localRoots) {
    const resolvedRootInput = resolveConfiguredPath(rootEntry);
    const relativeToRoot = path.relative(resolvedRootInput, resolvedLocalPath);
    if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot) || relativeToRoot === "") {
      continue;
    }
    let rootReal;
    try {
      rootReal = await fs.realpath(resolvedRootInput);
    } catch {
      rootReal = path.resolve(resolvedRootInput);
    }
    const candidatePath = path.resolve(rootReal, relativeToRoot);
    if (!isPathInsideRoot(candidatePath, rootReal)) {
      continue;
    }
    let handle = null;
    try {
      handle = await fs.open(candidatePath, openFlags);
      const realPath = await fs.realpath(candidatePath);
      if (!isPathInsideRoot(realPath, rootReal)) {
        continue;
      }
      const stat = await handle.stat();
      if (!stat.isFile()) {
        continue;
      }
      const realStat = await fs.stat(realPath);
      if (stat.ino !== realStat.ino || stat.dev !== realStat.dev) {
        continue;
      }
      const data = await handle.readFile();
      return { data, realPath, sizeBytes: stat.size };
    } catch {
      continue;
    } finally {
      if (handle) {
        await handle.close().catch(() => {
        });
      }
    }
  }
  throw new Error(
    `Local media path is not under any configured mediaLocalRoots entry: ${params.localPath}`
  );
}
function resolveFilenameFromSource(source) {
  if (!source) {
    return void 0;
  }
  if (source.startsWith("file://")) {
    try {
      return path.basename(fileURLToPath(source)) || void 0;
    } catch {
      return void 0;
    }
  }
  if (HTTP_URL_RE.test(source)) {
    try {
      return path.basename(new URL(source).pathname) || void 0;
    } catch {
      return void 0;
    }
  }
  const base = path.basename(source);
  return base || void 0;
}
async function sendBlueBubblesMedia(params) {
  const {
    cfg,
    to,
    mediaUrl,
    mediaPath,
    mediaBuffer,
    contentType,
    filename,
    caption,
    replyToId,
    accountId,
    asVoice
  } = params;
  const core = getBlueBubblesRuntime();
  const maxBytes = resolveChannelMediaMaxBytes({
    cfg,
    resolveChannelLimitMb: ({ cfg: cfg2, accountId: accountId2 }) => cfg2.channels?.bluebubbles?.accounts?.[accountId2]?.mediaMaxMb ?? cfg2.channels?.bluebubbles?.mediaMaxMb,
    accountId
  });
  const mediaLocalRoots = resolveMediaLocalRoots({ cfg, accountId });
  let buffer;
  let resolvedContentType = contentType ?? void 0;
  let resolvedFilename = filename ?? void 0;
  if (mediaBuffer) {
    assertMediaWithinLimit(mediaBuffer.byteLength, maxBytes);
    buffer = mediaBuffer;
    if (!resolvedContentType) {
      const hint = mediaPath ?? mediaUrl;
      const detected = await core.media.detectMime({
        buffer: Buffer.isBuffer(mediaBuffer) ? mediaBuffer : Buffer.from(mediaBuffer),
        filePath: hint
      });
      resolvedContentType = detected ?? void 0;
    }
    if (!resolvedFilename) {
      resolvedFilename = resolveFilenameFromSource(mediaPath ?? mediaUrl);
    }
  } else {
    const source = mediaPath ?? mediaUrl;
    if (!source) {
      throw new Error("BlueBubbles media delivery requires mediaUrl, mediaPath, or mediaBuffer.");
    }
    if (HTTP_URL_RE.test(source)) {
      const fetched = await core.channel.media.fetchRemoteMedia({
        url: source,
        maxBytes: typeof maxBytes === "number" && maxBytes > 0 ? maxBytes : void 0
      });
      buffer = fetched.buffer;
      resolvedContentType = resolvedContentType ?? fetched.contentType ?? void 0;
      resolvedFilename = resolvedFilename ?? fetched.fileName;
    } else {
      const localPath = expandHomePath(resolveLocalMediaPath(source));
      const localFile = await assertLocalMediaPathAllowed({
        localPath,
        localRoots: mediaLocalRoots,
        accountId
      });
      if (typeof maxBytes === "number" && maxBytes > 0) {
        assertMediaWithinLimit(localFile.sizeBytes, maxBytes);
      }
      const data = localFile.data;
      assertMediaWithinLimit(data.byteLength, maxBytes);
      buffer = new Uint8Array(data);
      if (!resolvedContentType) {
        const detected = await core.media.detectMime({
          buffer: data,
          filePath: localFile.realPath
        });
        resolvedContentType = detected ?? void 0;
      }
      if (!resolvedFilename) {
        resolvedFilename = resolveFilenameFromSource(localFile.realPath);
      }
    }
  }
  const replyToMessageGuid = replyToId?.trim() ? resolveBlueBubblesMessageId(replyToId.trim(), { requireKnownShortId: true }) : void 0;
  const attachmentResult = await sendBlueBubblesAttachment({
    to,
    buffer,
    filename: resolvedFilename ?? "attachment",
    contentType: resolvedContentType ?? void 0,
    replyToMessageGuid,
    asVoice,
    opts: {
      cfg,
      accountId
    }
  });
  const trimmedCaption = caption?.trim();
  if (trimmedCaption) {
    await sendMessageBlueBubbles(to, trimmedCaption, {
      cfg,
      accountId,
      replyToMessageGuid
    });
  }
  return attachmentResult;
}
export {
  sendBlueBubblesMedia
};
