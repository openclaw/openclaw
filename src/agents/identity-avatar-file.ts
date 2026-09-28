// Internal local-avatar resolution and pinned file reads.
import fs from "node:fs";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openRootFileSync, readFileDescriptorBoundedSync } from "../infra/boundary-file-read.js";
import { resolveRealpathOrAbsolute } from "../infra/boundary-path.js";
import { isRenderableAvatarImageDataUrl } from "../shared/avatar-limits.js";
import {
  AVATAR_MAX_BYTES,
  hasAvatarUriScheme,
  isAvatarDataUrl,
  isAvatarHttpUrl,
  isPathWithinRoot,
  isSupportedLocalAvatarExtension,
  isWindowsAbsolutePath,
  resolveAvatarMime,
} from "../shared/avatar-policy.js";
import { resolveUserPath } from "../utils.js";
import { resolveAgentWorkspaceDir } from "./agent-scope.js";

export type LocalAgentAvatarFailureReason =
  | "missing"
  | "outside_workspace"
  | "too_large"
  | "unreadable"
  | "unsupported_extension";

type OpenedLocalAgentAvatarFile = {
  path: string;
  fd: number;
  stat: {
    ctimeMs: number;
    dev: number;
    ino: number;
    mtimeMs: number;
    size: number;
  };
};

type LocalAgentAvatarPath = {
  filePath: string;
  workspaceRoot: string;
};

/** Resolve one local avatar source while retaining its canonical workspace root. */
export function resolveLocalAgentAvatarPath(params: {
  raw: string;
  workspaceDir: string;
}):
  | { ok: true; value: LocalAgentAvatarPath }
  | { ok: false; reason: LocalAgentAvatarFailureReason } {
  const workspaceRoot = resolveRealpathOrAbsolute(params.workspaceDir);
  const resolved =
    params.raw.startsWith("~") || path.isAbsolute(params.raw)
      ? resolveUserPath(params.raw)
      : path.resolve(workspaceRoot, params.raw);
  const filePath = resolveRealpathOrAbsolute(resolved);
  if (!isPathWithinRoot(workspaceRoot, filePath)) {
    return { ok: false, reason: "outside_workspace" };
  }
  if (!isSupportedLocalAvatarExtension(filePath)) {
    return { ok: false, reason: "unsupported_extension" };
  }
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return { ok: false, reason: "missing" };
    }
    if (stat.size > AVATAR_MAX_BYTES) {
      return { ok: false, reason: "too_large" };
    }
  } catch {
    return { ok: false, reason: "missing" };
  }
  return { ok: true, value: { filePath, workspaceRoot } };
}

function openResolvedLocalAgentAvatarFile(
  resolved: LocalAgentAvatarPath,
): OpenedLocalAgentAvatarFile | null {
  try {
    const opened = openRootFileSync({
      absolutePath: resolved.filePath,
      rootPath: resolved.workspaceRoot,
      rootRealPath: resolved.workspaceRoot,
      boundaryLabel: "agent workspace",
      maxBytes: AVATAR_MAX_BYTES,
      rejectHardlinks: true,
      skipLexicalRootCheck: true,
    });
    if (!opened.ok) {
      return null;
    }
    if (!isSupportedLocalAvatarExtension(opened.path)) {
      fs.closeSync(opened.fd);
      return null;
    }
    return {
      path: opened.path,
      fd: opened.fd,
      stat: {
        ctimeMs: opened.stat.ctimeMs,
        dev: opened.stat.dev,
        ino: opened.stat.ino,
        mtimeMs: opened.stat.mtimeMs,
        size: opened.stat.size,
      },
    };
  } catch {
    return null;
  }
}

export type PreparedLocalAgentAvatarFile = Omit<OpenedLocalAgentAvatarFile, "fd"> & {
  body?: Buffer;
};

export type LocalAgentAvatarResult =
  | { ok: true; file: PreparedLocalAgentAvatarFile }
  | { ok: false; reason: LocalAgentAvatarFailureReason };

export type LocalAgentAvatarRead = {
  workspaceDir: string;
  source: string;
  readBody: boolean;
  knownRevision?: string;
};

export type LocalAgentAvatarSnapshot =
  | {
      ok: true;
      file: Omit<PreparedLocalAgentAvatarFile, "body"> & { body?: Uint8Array<ArrayBuffer> };
    }
  | Extract<LocalAgentAvatarResult, { ok: false }>
  | { kind: "unchanged" };

export function localAgentAvatarRevision(
  file: Pick<PreparedLocalAgentAvatarFile, "path" | "stat">,
): string {
  const { ctimeMs, dev, ino, mtimeMs, size } = file.stat;
  return JSON.stringify([file.path, ctimeMs, dev, ino, mtimeMs, size]);
}

/** Worker-side admission keeps the descriptor pinned until the optional read completes. */
export function readLocalAgentAvatarSnapshot(
  params: LocalAgentAvatarRead,
): LocalAgentAvatarSnapshot {
  const resolved = resolveLocalAgentAvatarPath({
    raw: params.source,
    workspaceDir: params.workspaceDir,
  });
  if (!resolved.ok) {
    return resolved;
  }
  const opened = openResolvedLocalAgentAvatarFile(resolved.value);
  if (!opened) {
    return { ok: false, reason: "unreadable" };
  }
  try {
    const file = { path: opened.path, stat: opened.stat };
    if (params.knownRevision === localAgentAvatarRevision(file)) {
      return { kind: "unchanged" };
    }
    return {
      ok: true,
      file: {
        ...file,
        body: params.readBody
          ? Uint8Array.from(readFileDescriptorBoundedSync(opened.fd, AVATAR_MAX_BYTES))
          : undefined,
      },
    };
  } catch {
    return { ok: false, reason: "unreadable" };
  } finally {
    fs.closeSync(opened.fd);
  }
}

export async function prepareLocalAgentAvatarFile(params: {
  cfg: OpenClawConfig;
  agentId: string;
  source: string;
  readBody: boolean;
}): Promise<LocalAgentAvatarResult> {
  try {
    const { prepareLocalAgentAvatar } = await import("./identity-avatar-file-runtime.js");
    return await prepareLocalAgentAvatar({
      workspaceDir: resolveAgentWorkspaceDir(params.cfg, params.agentId),
      source: params.source,
      readBody: params.readBody,
    });
  } catch {
    return { ok: false, reason: "unreadable" };
  }
}

/** Resolve one configured avatar source for agent-list projections. */
export async function resolveAgentAvatarUrlFromSource(
  cfg: OpenClawConfig,
  agentId: string,
  source: string | null | undefined,
): Promise<string | undefined> {
  const normalized = normalizeOptionalString(source);
  if (!normalized) {
    return undefined;
  }
  if (isAvatarHttpUrl(normalized) || isRenderableAvatarImageDataUrl(normalized)) {
    return normalized;
  }
  if (
    isAvatarDataUrl(normalized) ||
    (hasAvatarUriScheme(normalized) && !isWindowsAbsolutePath(normalized))
  ) {
    return undefined;
  }
  const prepared = await prepareLocalAgentAvatarFile({
    cfg,
    agentId,
    source: normalized,
    readBody: true,
  });
  return prepared.ok && prepared.file.body
    ? `data:${resolveAvatarMime(prepared.file.path)};base64,${prepared.file.body.toString("base64")}`
    : undefined;
}
