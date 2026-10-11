import { homedir } from "node:os";
import path from "node:path";
import { trySafeFileURLToPath } from "@openclaw/fs-safe/advanced";
import { asOptionalRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { isKnownCoreToolId } from "../agents/tool-catalog.js";
import { isMutatingToolCall } from "../agents/tool-mutation.js";
import { isPathInside } from "../infra/path-guards.js";
import { readTrimmedStringAlias } from "../utils/string-readers.js";

const SAFE_SEARCH_TOOL_IDS = new Set(["search", "web_search", "memory_search"]);
const TRUSTED_SAFE_TOOL_ALIASES = new Set(["search"]);
const EXEC_CAPABLE_TOOL_IDS = new Set([
  "exec",
  "spawn",
  "shell",
  "bash",
  "process",
  "code_execution",
  "nodes",
]);
const CONTROL_PLANE_TOOL_IDS = new Set([
  "cron",
  "gateway",
  "sessions_spawn",
  "sessions_send",
  "session_status",
]);

type AcpApprovalClass =
  | "readonly_scoped"
  | "readonly_search"
  | "mutating"
  | "exec_capable"
  | "control_plane"
  | "interactive"
  | "other"
  | "unknown";

type AcpApprovalClassification = {
  toolName?: string;
  approvalClass: AcpApprovalClass;
  autoApprove: boolean;
};

type AcpApprovalToolCall = {
  title?: string | null;
  _meta?: unknown;
  rawInput?: unknown;
  locations?: unknown;
};

function readFirstStringValue(
  source: Record<string, unknown> | undefined,
  keys: string[],
): string | undefined {
  return source ? readTrimmedStringAlias(source, keys) : undefined;
}

function normalizeToolPolicyName(value: string): string | undefined {
  const normalized = normalizeLowercaseStringOrEmpty(value);
  if (!normalized || normalized.length > 128) {
    return undefined;
  }
  return /^[a-z0-9._-]+$/.test(normalized) ? normalized : undefined;
}

function parseToolNameFromTitle(title: string | undefined | null): string | undefined {
  if (!title) {
    return undefined;
  }
  const head = normalizeOptionalString(title.split(":", 1)[0]);
  return head ? normalizeToolPolicyName(head) : undefined;
}

function resolveToolNameForPermission(
  toolCall: AcpApprovalToolCall | undefined,
): string | undefined {
  const fromMeta = readFirstStringValue(asRecord(toolCall?.["_meta"]), [
    "toolName",
    "tool_name",
    "name",
  ]);
  const fromRawInput = readFirstStringValue(asRecord(toolCall?.rawInput), [
    "tool",
    "toolName",
    "tool_name",
    "name",
  ]);
  const metaName = fromMeta ? normalizeToolPolicyName(fromMeta) : undefined;
  const rawInputName = fromRawInput ? normalizeToolPolicyName(fromRawInput) : undefined;
  const titleName = parseToolNameFromTitle(toolCall?.title);
  if ((fromMeta && !metaName) || (fromRawInput && !rawInputName)) {
    return undefined;
  }
  if (new Set([metaName, titleName, rawInputName].filter(Boolean)).size > 1) {
    return undefined;
  }
  return metaName ?? titleName ?? rawInputName;
}

function extractPathFromToolTitle(
  toolTitle: string | undefined,
  toolName: string | undefined,
): string | undefined {
  if (!toolTitle) {
    return undefined;
  }
  const separator = toolTitle.indexOf(":");
  if (separator < 0) {
    return undefined;
  }
  const tail = toolTitle.slice(separator + 1).trim();
  if (!tail) {
    return undefined;
  }
  const keyedMatch =
    toolName === "read"
      ? tail.match(/(?:^|,\s*)(?:path|file_path|filePath)\s*:\s*([^,]+)/)
      : tail.match(/^(?:path|file_path|filePath)\s*:\s*([^,]+)/);
  if (keyedMatch?.[1]) {
    return keyedMatch[1].trim();
  }
  return toolName === "read" ? tail : undefined;
}

const TOOL_PATH_KEYS = ["path", "file_path", "filePath"];

function readDeclaredLocationPaths(locations: unknown): string[] {
  if (!Array.isArray(locations)) {
    return [];
  }
  return locations
    .map((location) => readFirstStringValue(asRecord(location), TOOL_PATH_KEYS))
    .filter((value): value is string => value !== undefined);
}

function resolveToolPathCandidates(
  toolCall: AcpApprovalToolCall | undefined,
  toolName: string,
): string[] {
  // Read locations are a deny signal only. They must not become a grant path,
  // or a locations-only request would auto-approve.
  const locationPaths = toolName === "read" ? [] : readDeclaredLocationPaths(toolCall?.locations);
  return [
    readFirstStringValue(asRecord(toolCall?.rawInput), TOOL_PATH_KEYS),
    extractPathFromToolTitle(toolCall?.title ?? undefined, toolName),
    ...locationPaths,
  ].filter((value): value is string => value !== undefined);
}

function resolveAbsoluteScopedPath(value: string, cwd: string): string | undefined {
  let candidate = value.trim();
  if (!candidate) {
    return undefined;
  }
  // Parse every file-scheme spelling first; alternate URL forms otherwise look cwd-relative.
  if (/^file:/i.test(candidate)) {
    candidate = trySafeFileURLToPath(candidate) ?? "";
    if (!candidate) {
      return undefined;
    }
  }
  if (candidate === "~") {
    candidate = homedir();
  } else if (candidate.startsWith("~/")) {
    candidate = path.join(homedir(), candidate.slice(2));
  }
  return path.isAbsolute(candidate) ? path.normalize(candidate) : path.resolve(cwd, candidate);
}

function isToolPathScopedToCwd(rawPath: string, cwd: string): boolean {
  const absolutePath = resolveAbsoluteScopedPath(rawPath, cwd);
  if (!absolutePath) {
    return false;
  }
  return isPathInside(path.resolve(cwd), absolutePath);
}

/** Resolves the ACP approval class for one tool call, failing closed on spoofed tool identity. */
export function classifyAcpToolApproval(params: {
  toolCall?: AcpApprovalToolCall;
  cwd: string;
}): AcpApprovalClassification {
  const toolName = resolveToolNameForPermission(params.toolCall);
  if (!toolName) {
    return { toolName: undefined, approvalClass: "unknown", autoApprove: false };
  }

  const isTrustedToolId = isKnownCoreToolId(toolName) || TRUSTED_SAFE_TOOL_ALIASES.has(toolName);
  if (isTrustedToolId && (toolName === "read" || SAFE_SEARCH_TOOL_IDS.has(toolName))) {
    const rawPaths = resolveToolPathCandidates(params.toolCall, toolName);
    // Locations alone never grant a read, but a declared location outside cwd
    // still denies, the same way search treats them.
    const scopedPaths =
      toolName === "read"
        ? [...rawPaths, ...readDeclaredLocationPaths(params.toolCall?.locations)]
        : rawPaths;
    const autoApprove =
      (toolName !== "read" || rawPaths.length > 0) &&
      scopedPaths.every((rawPath) => isToolPathScopedToCwd(rawPath, params.cwd));
    return {
      toolName,
      approvalClass: autoApprove
        ? toolName === "read"
          ? "readonly_scoped"
          : "readonly_search"
        : "other",
      autoApprove,
    };
  }
  if (EXEC_CAPABLE_TOOL_IDS.has(toolName)) {
    return { toolName, approvalClass: "exec_capable", autoApprove: false };
  }
  if (CONTROL_PLANE_TOOL_IDS.has(toolName)) {
    return { toolName, approvalClass: "control_plane", autoApprove: false };
  }
  if (isMutatingToolCall(toolName, params.toolCall?.rawInput)) {
    return { toolName, approvalClass: "mutating", autoApprove: false };
  }
  return { toolName, approvalClass: "other", autoApprove: false };
}
