import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import {
  AVATAR_MAX_BYTES,
  isAvatarDataUrl,
  isAvatarHttpUrl,
  isPathWithinRoot,
  isSupportedLocalAvatarExtension,
} from "../shared/avatar-policy.js";
import { resolveUserPath } from "../utils.js";
import { resolveAgentWorkspaceDir } from "./agent-scope.js";
import { loadAgentIdentityFromWorkspace } from "./identity-file.js";
import { resolveAgentIdentity } from "./identity.js";

export type AgentAvatarResolution =
  | { kind: "none"; reason: string }
  | { kind: "local"; filePath: string }
  | { kind: "remote"; url: string }
  | { kind: "data"; url: string };

function normalizeAvatarValue(value: string | undefined | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function resolveAvatarSource(cfg: OpenClawConfig, agentId: string): string | null {
  const fromConfig = normalizeAvatarValue(resolveAgentIdentity(cfg, agentId)?.avatar);
  if (fromConfig) {
    return fromConfig;
  }
  const workspace = resolveAgentWorkspaceDir(cfg, agentId);
  const fromIdentity = normalizeAvatarValue(loadAgentIdentityFromWorkspace(workspace)?.avatar);
  return fromIdentity;
}

function resolveExistingPath(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function resolveLocalAvatarPath(params: {
  raw: string;
  workspaceDir: string;
}): { ok: true; filePath: string } | { ok: false; reason: string } {
  const workspaceRoot = resolveExistingPath(params.workspaceDir);
  const raw = params.raw;
  const resolved =
    raw.startsWith("~") || path.isAbsolute(raw)
      ? resolveUserPath(raw)
      : path.resolve(workspaceRoot, raw);
  const realPath = resolveExistingPath(resolved);
  if (!isPathWithinRoot(workspaceRoot, realPath)) {
    return { ok: false, reason: "outside_workspace" };
  }
  if (!isSupportedLocalAvatarExtension(realPath)) {
    return { ok: false, reason: "unsupported_extension" };
  }
  try {
    const stat = fs.statSync(realPath);
    if (!stat.isFile()) {
      return { ok: false, reason: "missing" };
    }
    if (stat.size > AVATAR_MAX_BYTES) {
      return { ok: false, reason: "too_large" };
    }
  } catch {
    return { ok: false, reason: "missing" };
  }
  return { ok: true, filePath: realPath };
}

export function resolveAgentAvatar(cfg: OpenClawConfig, agentId: string): AgentAvatarResolution {
  // Special case: "user" refers to the user avatar override from ui.userAvatar
  if (agentId === "user") {
    const userAvatar = normalizeAvatarValue(cfg.ui?.userAvatar);
    if (!userAvatar) {
      return { kind: "none", reason: "missing" };
    }
    if (isAvatarHttpUrl(userAvatar)) {
      return { kind: "remote", url: userAvatar };
    }
    if (isAvatarDataUrl(userAvatar)) {
      return { kind: "data", url: userAvatar };
    }
    // Treat relative user avatar paths as relative to the default workspace's avatars dir.
    // This mirrors how agent avatars are stored (in their workspace/avatars/).
    const defaultWorkspace = cfg.agents?.defaults?.workspace || process.cwd();
    const workspaceDir = resolveExistingPath(defaultWorkspace);
    const resolved =
      userAvatar.startsWith("~") || path.isAbsolute(userAvatar)
        ? resolveUserPath(userAvatar)
        : path.resolve(workspaceDir, "avatars", userAvatar);
    const realPath = resolveExistingPath(resolved);
    if (!isPathWithinRoot(workspaceDir, realPath)) {
      return { kind: "none", reason: "outside_workspace" };
    }
    if (!isSupportedLocalAvatarExtension(realPath)) {
      return { kind: "none", reason: "unsupported_extension" };
    }
    try {
      const stat = fs.statSync(realPath);
      if (!stat.isFile()) {
        return { kind: "none", reason: "missing" };
      }
      if (stat.size > AVATAR_MAX_BYTES) {
        return { kind: "none", reason: "too_large" };
      }
    } catch {
      return { kind: "none", reason: "missing" };
    }
    return { kind: "local", filePath: realPath };
  }

  const source = resolveAvatarSource(cfg, agentId);
  if (!source) {
    return { kind: "none", reason: "missing" };
  }
  if (isAvatarHttpUrl(source)) {
    return { kind: "remote", url: source };
  }
  if (isAvatarDataUrl(source)) {
    return { kind: "data", url: source };
  }
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  const resolved = resolveLocalAvatarPath({ raw: source, workspaceDir });
  if (!resolved.ok) {
    return { kind: "none", reason: resolved.reason };
  }
  return { kind: "local", filePath: resolved.filePath };
}
