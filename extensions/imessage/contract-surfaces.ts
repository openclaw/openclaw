import path from "node:path";
import type { OpenClawConfig } from "./runtime-api.js";
import { resolveIMessageAccount } from "./src/accounts.js";

const DEFAULT_IMESSAGE_ATTACHMENT_ROOTS = ["/Users/*/Library/Messages/Attachments"] as const;
const WILDCARD_SEGMENT = "*";
const WINDOWS_DRIVE_ABS_RE = /^[A-Za-z]:\//;
const WINDOWS_DRIVE_ROOT_RE = /^[A-Za-z]:$/;

function normalizePosixAbsolutePath(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("\0")) {
    return undefined;
  }
  const normalized = path.posix.normalize(trimmed.replaceAll("\\", "/"));
  const isAbsolute = normalized.startsWith("/") || WINDOWS_DRIVE_ABS_RE.test(normalized);
  if (!isAbsolute || normalized === "/") {
    return undefined;
  }
  const withoutTrailingSlash = normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
  if (WINDOWS_DRIVE_ROOT_RE.test(withoutTrailingSlash)) {
    return undefined;
  }
  return withoutTrailingSlash;
}

function splitPathSegments(value: string): string[] {
  return value.split("/").filter(Boolean);
}

function isValidInboundPathRootPattern(value: string): boolean {
  const normalized = normalizePosixAbsolutePath(value);
  if (!normalized) {
    return false;
  }
  const segments = splitPathSegments(normalized);
  if (segments.length === 0) {
    return false;
  }
  return segments.every((segment) => segment === WILDCARD_SEGMENT || !segment.includes("*"));
}

function normalizeInboundPathRoots(roots?: readonly string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const root of roots ?? []) {
    if (typeof root !== "string") {
      continue;
    }
    if (!isValidInboundPathRootPattern(root)) {
      continue;
    }
    const candidate = normalizePosixAbsolutePath(root);
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    normalized.push(candidate);
  }
  return normalized;
}

function mergeInboundPathRoots(...rootsLists: Array<readonly string[] | undefined>): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const roots of rootsLists) {
    const normalized = normalizeInboundPathRoots(roots);
    for (const root of normalized) {
      if (seen.has(root)) {
        continue;
      }
      seen.add(root);
      merged.push(root);
    }
  }
  return merged;
}

export function resolveInboundAttachmentRoots(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string[] {
  const account = resolveIMessageAccount(params);
  return mergeInboundPathRoots(
    account.config.attachmentRoots,
    params.cfg.channels?.imessage?.attachmentRoots,
    DEFAULT_IMESSAGE_ATTACHMENT_ROOTS,
  );
}

export function resolveRemoteInboundAttachmentRoots(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string[] {
  const account = resolveIMessageAccount(params);
  return mergeInboundPathRoots(
    account.config.remoteAttachmentRoots,
    params.cfg.channels?.imessage?.remoteAttachmentRoots,
    account.config.attachmentRoots,
    params.cfg.channels?.imessage?.attachmentRoots,
    DEFAULT_IMESSAGE_ATTACHMENT_ROOTS,
  );
}
