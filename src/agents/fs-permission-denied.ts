export type FsPermissionDeniedReason =
  | "workspace_boundary"
  | "path_alias_escape"
  | "readonly_filesystem"
  | "unknown";

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error && typeof error.message === "string") {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return String(error ?? "unknown error");
}

export function classifyFsPermissionDeniedReason(error: unknown): FsPermissionDeniedReason {
  const message = normalizeErrorMessage(error).toLowerCase();
  if (message.includes("symlink") || message.includes("hardlink") || message.includes("alias")) {
    return "path_alias_escape";
  }
  if (
    message.includes("escapes sandbox root") ||
    message.includes("outside workspace root") ||
    message.includes("outside sandbox root")
  ) {
    return "workspace_boundary";
  }
  if (message.includes("read-only")) {
    return "readonly_filesystem";
  }
  return "unknown";
}

export function createFsPermissionDeniedError(params: {
  action: string;
  path?: string;
  cause: unknown;
}): Error {
  const reason = classifyFsPermissionDeniedReason(params.cause);
  const causeMessage = normalizeErrorMessage(params.cause);
  const pathPart = params.path ? ` path=${JSON.stringify(params.path)}` : "";
  const error = new Error(
    `permission_denied reason=${reason} action=${params.action}${pathPart}: ${causeMessage}`,
  );
  (error as Error & { code?: string; reason?: FsPermissionDeniedReason }).code =
    "E_FS_PERMISSION_DENIED";
  (error as Error & { code?: string; reason?: FsPermissionDeniedReason }).reason = reason;
  return error;
}
