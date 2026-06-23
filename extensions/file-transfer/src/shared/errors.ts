// Shared error code surface across the four file-transfer tools/handlers.
// Every tool returns the same { ok: false, code, message, canonicalPath? }
// shape so the model can reason about errors uniformly.

type FileTransferErrCode =
  // Path-shape errors (caller's fault)
  | "INVALID_PATH"
  | "INVALID_BASE64"
  | "INVALID_PARAMS"
  // Filesystem errors (file/dir layer)
  | "NOT_FOUND"
  | "PERMISSION_DENIED"
  | "IS_DIRECTORY"
  | "IS_FILE"
  | "PARENT_NOT_FOUND"
  | "EXISTS_NO_OVERWRITE"
  | "READ_ERROR"
  | "WRITE_ERROR"
  // Size/limit errors
  | "FILE_TOO_LARGE"
  | "TREE_TOO_LARGE"
  // Safety errors
  | "PATH_TRAVERSAL"
  | "SYMLINK_TARGET_DENIED"
  | "INTEGRITY_FAILURE"
  // Policy errors (gateway-side)
  | "POLICY_DENIED"
  | "NO_POLICY";

type FileTransferErr = {
  ok: false;
  code: FileTransferErrCode;
  message: string;
  canonicalPath?: string;
};

export function err(
  code: FileTransferErrCode,
  message: string,
  canonicalPath?: string,
): FileTransferErr {
  return { ok: false, code, message, ...(canonicalPath ? { canonicalPath } : {}) };
}

// Convert a node-host error payload to a thrown Error for agent-tool consumption.
// The agent-tool surfaces these as failed tool results uniformly.
export function throwFromNodePayload(operation: string, payload: Record<string, unknown>): never {
  const code = typeof payload.code === "string" ? payload.code : "ERROR";
  const message = typeof payload.message === "string" ? payload.message : `${operation} failed`;
  const canonical =
    typeof payload.canonicalPath === "string" ? ` (canonical=${payload.canonicalPath})` : "";
  throw new Error(`${operation} ${code}: ${message}${canonical}`);
}
