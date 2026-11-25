import crypto from "node:crypto";
import { ARCHIVE_LIMIT_ERROR_CODE, ArchiveLimitError } from "openclaw/plugin-sdk/archive";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  asPositiveFiniteNumber,
  parseStrictNonNegativeInteger,
} from "openclaw/plugin-sdk/number-runtime";
import { readPositiveIntegerParam } from "openclaw/plugin-sdk/param-readers";
import type {
  OpenClawPluginNodeInvokePolicy,
  OpenClawPluginNodeInvokePolicyContext,
  OpenClawPluginNodeInvokePolicyResult,
} from "openclaw/plugin-sdk/plugin-entry";
import { getPluginRuntimeGatewayRequestScope } from "openclaw/plugin-sdk/plugin-runtime";
import { asNullableRecord, asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { bindFileTransferAudit } from "./audit-context.js";
import type { FileTransferAuditOp } from "./audit.js";
import {
  BOUNDED_DIRECTORY_PAGE_SIZE,
  BOUNDED_LINUX_PATH_BYTES,
  BOUNDED_UNARY_FILE_BYTES,
  usesBoundedReplies,
} from "./bounded-replies.js";
import { inspectDirFetchArchive } from "./dir-fetch-archive.js";
import {
  DIR_FETCH_DEFAULT_MAX_BYTES,
  DIR_FETCH_HARD_MAX_BYTES,
  DIR_FETCH_MAX_ENTRIES,
} from "./dir-fetch-limits.js";
import { readFileCreateMetadata } from "./file-create-protocol.js";
import {
  FILE_FETCH_DEFAULT_MAX_BYTES,
  FILE_FETCH_HARD_MAX_BYTES,
  readFileFetchBinaryMaxBytes,
} from "./file-fetch-protocol.js";
import { commandKind, requestApproval } from "./node-invoke-policy-approval.js";
import {
  FILE_TRANSFER_NODE_INVOKE_COMMANDS,
  type FileTransferNodeInvokeCommand,
} from "./node-invoke-policy-commands.js";
import {
  policyDeniedResult,
  runPathPreflight,
  validateCanonicalAuthorization,
  validateDirFetchEntries,
} from "./node-invoke-policy-preflight.js";
import { persistLiteralGrant } from "./policy.js";
const DIR_FETCH_ARCHIVE_INSPECTION_TIMEOUT_MS = 30_000;

function readMaxBytes(input: {
  value: unknown;
  defaultValue: number;
  hardMax: number;
  policyMax?: number;
}): number {
  const parsed =
    input.value === undefined
      ? input.defaultValue
      : readPositiveIntegerParam({ maxBytes: input.value }, "maxBytes");
  const requested = parsed ?? input.defaultValue;
  const clamped = Math.max(1, Math.min(requested, input.hardMax));
  return input.policyMax ? Math.min(clamped, input.policyMax) : clamped;
}

function validateFetchMaxBytesParam(
  command: FileTransferNodeInvokeCommand,
  params: Record<string, unknown>,
) {
  if (command !== "file.fetch" && command !== "dir.fetch") {
    return;
  }
  if (params.maxBytes !== undefined) {
    readPositiveIntegerParam(params, "maxBytes");
  }
  if (command === "file.fetch") {
    readFileFetchBinaryMaxBytes(params);
  }
}

function readAuditSizeBytes(
  command: FileTransferNodeInvokeCommand,
  payload: Record<string, unknown> | null,
  verifiedDirFetchBytes?: number,
): number | undefined {
  if (command === "dir.fetch") {
    return verifiedDirFetchBytes;
  }
  if (command === "dir.list") {
    return undefined;
  }
  return typeof payload?.size === "number" ? payload.size : undefined;
}

async function verifyDirFetchArchive(
  payload: Record<string, unknown> | null,
): Promise<
  | { ok: true; entries: string[]; sizeBytes: number; sha256: string }
  | { ok: false; code: string; reason: string }
> {
  const tarBase64 = typeof payload?.tarBase64 === "string" ? payload.tarBase64 : "";
  if (!tarBase64) {
    return {
      ok: false,
      code: "ARCHIVE_ENTRIES_MISSING",
      reason: "dir.fetch archive did not return tarBase64",
    };
  }
  const tarBuffer = Buffer.from(tarBase64, "base64");
  const sizeBytes = tarBuffer.byteLength;
  if (typeof payload?.tarBytes === "number" && payload.tarBytes !== sizeBytes) {
    return {
      ok: false,
      code: "ARCHIVE_SIZE_MISMATCH",
      reason: `dir.fetch archive size mismatch: payload says ${payload.tarBytes} bytes, decoded ${sizeBytes}`,
    };
  }
  const sha256 = crypto.createHash("sha256").update(tarBuffer).digest("hex");
  if (typeof payload?.sha256 === "string" && payload.sha256.toLowerCase() !== sha256) {
    return {
      ok: false,
      code: "ARCHIVE_INTEGRITY_FAILURE",
      reason: `dir.fetch archive sha256 mismatch: payload says ${payload.sha256.toLowerCase()}, decoded ${sha256}`,
    };
  }
  try {
    const entries = await inspectDirFetchArchive(
      tarBuffer,
      DIR_FETCH_ARCHIVE_INSPECTION_TIMEOUT_MS,
    );
    return { ok: true, entries, sizeBytes, sha256 };
  } catch (error) {
    const tooMany =
      error instanceof ArchiveLimitError &&
      error.code === ARCHIVE_LIMIT_ERROR_CODE.ENTRY_COUNT_EXCEEDS_LIMIT;
    return {
      ok: false,
      code: tooMany ? "ARCHIVE_ENTRIES_TOO_MANY" : "ARCHIVE_ENTRIES_UNREADABLE",
      reason: tooMany
        ? `dir.fetch archive contains more than ${DIR_FETCH_MAX_ENTRIES} entries`
        : `dir.fetch archive inspection failed: ${formatErrorMessage(error)}`,
    };
  }
}

function validateBoundedReplyRequest(
  command: FileTransferNodeInvokeCommand,
  platform: string | undefined,
  path: string,
  params: Record<string, unknown>,
): { code: string; message: string } | undefined {
  if (platform !== "linux") {
    return { code: "UNSUPPORTED_NODE", message: "bounded replies require a paired Linux node" };
  }
  if (command === "dir.fetch") {
    return { code: "UNSUPPORTED_COMMAND", message: "use dir.list pages on a bounded-reply node" };
  }
  const { rootPath, pageToken, expectedSha256, transport } = params;
  if (
    Buffer.byteLength(path) > BOUNDED_LINUX_PATH_BYTES ||
    (command === "file.fetch" &&
      rootPath !== undefined &&
      (typeof rootPath !== "string" || Buffer.byteLength(rootPath) > BOUNDED_LINUX_PATH_BYTES))
  ) {
    return {
      code: "INVALID_PARAMS",
      message: "path and rootPath must fit the bounded Linux path limit",
    };
  }
  if (
    command === "dir.list" &&
    pageToken !== undefined &&
    (typeof pageToken !== "string" ||
      pageToken.length > 16 ||
      parseStrictNonNegativeInteger(pageToken) === undefined)
  ) {
    return { code: "INVALID_PARAMS", message: "invalid directory continuation token" };
  }
  if (
    command === "file.write" &&
    expectedSha256 !== undefined &&
    (typeof expectedSha256 !== "string" ||
      expectedSha256.length !== 64 ||
      !/^[a-fA-F0-9]{64}$/u.test(expectedSha256))
  ) {
    return {
      code: "INVALID_PARAMS",
      message: "expectedSha256 must be a 64-character hexadecimal SHA-256 digest",
    };
  }
  if (command === "file.fetch" && transport === "binary") {
    // Only Gateway-admitted in-process callers can own the start/ACK stream.
    const owner = getPluginRuntimeGatewayRequestScope()?.client?.internal;
    if (
      owner?.syntheticClient !== true ||
      owner.pluginRuntimeOwnerId !== "file-transfer" ||
      !owner.nodeInvokeStream
    ) {
      return {
        code: "INVALID_PARAMS",
        message: "binary file.fetch requires a File Transfer duplex service",
      };
    }
  }
  return undefined;
}

// A refusal before the node announces readiness must bypass the normal
// successful payload wrapper so the duplex opener can return its typed error.
function preserveFileStreamRefusal(
  result: OpenClawPluginNodeInvokePolicyResult,
  boundedFileStream: boolean,
): OpenClawPluginNodeInvokePolicyResult {
  const payload = boundedFileStream && result.ok ? asNullableRecord(result.payload) : null;
  if (
    payload?.ok === false &&
    typeof payload.code === "string" &&
    typeof payload.message === "string"
  ) {
    return {
      ok: false,
      code: payload.code,
      message: payload.message,
      details: { fileTransferError: payload },
    };
  }
  return result;
}

async function handleFileTransferInvoke(
  ctx: OpenClawPluginNodeInvokePolicyContext,
): Promise<OpenClawPluginNodeInvokePolicyResult> {
  if (!FILE_TRANSFER_NODE_INVOKE_COMMANDS.includes(ctx.command as FileTransferNodeInvokeCommand)) {
    return { ok: false, code: "UNSUPPORTED_COMMAND", message: "unsupported file-transfer command" };
  }
  const command = ctx.command as FileTransferNodeInvokeCommand;
  const op: FileTransferAuditOp = command;
  const params = asOptionalRecord(ctx.params) ?? {};
  const requestedPath = typeof params.path === "string" ? params.path : "";
  const bounded = usesBoundedReplies(
    ctx.config.plugins?.entries?.["file-transfer"]?.config ?? ctx.pluginConfig,
    ctx.nodeId,
  );
  const boundedFileStream = bounded && command === "file.fetch" && params.transport === "binary";
  const nodeDisplayName = ctx.node?.displayName;
  const startedAt = Date.now();
  const audit = bindFileTransferAudit(
    { op, nodeId: ctx.nodeId, nodeDisplayName, requestedPath },
    startedAt,
  );

  if (!requestedPath) {
    return { ok: false, code: "INVALID_PARAMS", message: `${op} path required` };
  }
  if (bounded) {
    const refusal = validateBoundedReplyRequest(command, ctx.node?.platform, requestedPath, params);
    if (refusal) {
      return policyDeniedResult({ op, ...refusal });
    }
  }
  try {
    validateFetchMaxBytesParam(command, params);
  } catch (error) {
    return {
      ok: false,
      code: "INVALID_PARAMS",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const gate = await requestApproval({
    ctx,
    op,
    kind: commandKind(command),
    path: requestedPath,
    startedAt,
  });
  if (!gate.ok) {
    return { ok: false, code: gate.code, message: gate.message };
  }

  let forwardedParams: Record<string, unknown>;
  try {
    const { maxBytes } = gate;
    // A caller may narrow the configured permission, never expand it.
    const followSymlinks = gate.followSymlinks && params.followSymlinks !== false;
    forwardedParams = {
      ...params,
      followSymlinks,
    };
    delete forwardedParams.preflightOnly;
    delete forwardedParams.expectedCanonicalPath;
    delete forwardedParams.expectedBinding;
    if (command === "file.create") {
      Object.assign(forwardedParams, readFileCreateMetadata(params, maxBytes));
    } else if (command === "file.fetch") {
      const binaryMax = readFileFetchBinaryMaxBytes(params);
      if (bounded) {
        // Forward only the read fields consumed by the node. An ignored caller
        // field must not inflate the serialized invoke on the paired connection.
        forwardedParams = {
          path: requestedPath,
          followSymlinks,
          ...(typeof params.rootPath === "string" ? { rootPath: params.rootPath } : {}),
          ...(binaryMax !== undefined ? { transport: "binary" } : {}),
        };
      }
      forwardedParams.maxBytes = readMaxBytes({
        value: params.maxBytes,
        defaultValue: FILE_FETCH_DEFAULT_MAX_BYTES,
        hardMax: binaryMax ?? (bounded ? BOUNDED_UNARY_FILE_BYTES : FILE_FETCH_HARD_MAX_BYTES),
        policyMax: maxBytes,
      });
    } else if (bounded && command === "dir.list") {
      forwardedParams = {
        path: requestedPath,
        followSymlinks,
        ...(typeof params.pageToken === "string" ? { pageToken: params.pageToken } : {}),
        maxEntries: Math.max(
          1,
          Math.min(
            Math.floor(asPositiveFiniteNumber(params.maxEntries) ?? BOUNDED_DIRECTORY_PAGE_SIZE),
            BOUNDED_DIRECTORY_PAGE_SIZE,
            BOUNDED_LINUX_PATH_BYTES,
          ),
        ),
      };
    } else if (command === "dir.fetch") {
      forwardedParams.maxBytes = readMaxBytes({
        value: params.maxBytes,
        defaultValue: DIR_FETCH_DEFAULT_MAX_BYTES,
        hardMax: DIR_FETCH_HARD_MAX_BYTES,
        policyMax: maxBytes,
      });
    }
  } catch (error) {
    return {
      ok: false,
      code: "INVALID_PARAMS",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  const preflight = await runPathPreflight({
    ctx,
    op,
    kind: commandKind(command),
    authorization: gate,
    params: forwardedParams,
    requestedPath,
    startedAt,
  });
  if (!preflight.ok) {
    return preserveFileStreamRefusal(preflight.result, boundedFileStream);
  }
  // The node must reject target drift before the final filesystem effect.
  forwardedParams.expectedCanonicalPath = preflight.canonicalPath;
  forwardedParams.expectedBinding = preflight.binding;

  const result = await ctx.invokeNode({ params: forwardedParams });
  if (!result.ok) {
    await audit({
      decision: "error",
      errorCode: result.code,
      errorMessage: result.message,
    });
    return {
      ok: false,
      code: result.code,
      message: `${op} failed: ${result.message}`,
      details: result.details,
      unavailable: true,
    };
  }

  const payload = asNullableRecord(result.payload);
  if (payload?.ok === false) {
    await audit({
      canonicalPath: typeof payload.canonicalPath === "string" ? payload.canonicalPath : undefined,
      decision: "error",
      errorCode: typeof payload.code === "string" ? payload.code : undefined,
      errorMessage: typeof payload.message === "string" ? payload.message : undefined,
    });
    return preserveFileStreamRefusal(result, boundedFileStream);
  }

  const canonicalPath = payload && typeof payload.path === "string" ? payload.path : "";
  if (!canonicalPath) {
    return policyDeniedResult({
      op,
      code: "CANONICAL_PATH_MISSING",
      message: "node result did not return a resolved path",
    });
  }
  if (preflight.canonicalPath !== canonicalPath) {
    return policyDeniedResult({
      op,
      code: "CANONICAL_PATH_CHANGED",
      message: "the resolved path changed after preflight; refusing the result",
      details: { path: canonicalPath },
    });
  }
  const canonicalDeny = await validateCanonicalAuthorization({
    ctx,
    op,
    kind: commandKind(command),
    authorization: gate,
    requestedPath,
    canonicalPath,
    startedAt,
  });
  if (canonicalDeny) {
    return canonicalDeny;
  }
  let verifiedDirFetchArchive: { sizeBytes: number; sha256: string } | undefined;
  if (command === "dir.fetch") {
    const archiveEntries = await verifyDirFetchArchive(payload);
    if (!archiveEntries.ok) {
      await audit({
        canonicalPath,
        decision: "error",
        errorCode: archiveEntries.code,
        reason: archiveEntries.reason,
      });
      return policyDeniedResult({
        op,
        code: archiveEntries.code,
        message: `${archiveEntries.reason}; refusing archive transfer`,
        details: { path: canonicalPath, reason: archiveEntries.reason },
      });
    }
    const archiveDeny = await validateDirFetchEntries({
      ctx,
      op,
      authorization: gate,
      requestedPath,
      canonicalPath,
      entries: archiveEntries.entries,
      startedAt,
      phase: "archive",
    });
    if (archiveDeny) {
      return archiveDeny;
    }
    verifiedDirFetchArchive = {
      sizeBytes: archiveEntries.sizeBytes,
      sha256: archiveEntries.sha256,
    };
  }

  let standingApprovalWarning: string | undefined;
  if (gate.persist) {
    try {
      await persistLiteralGrant({
        nodeId: ctx.nodeId,
        command,
        requestedPath,
        canonicalPath,
        pendingReapprovalSelector: gate.pendingReapprovalSelector,
      });
    } catch (error) {
      standingApprovalWarning =
        "The transfer succeeded, but the standing approval was not saved. Run the command again and choose allow-always, or use allow-once.";
      await audit({
        canonicalPath,
        decision: "error",
        errorCode: "APPROVAL_PERSIST_FAILED",
        reason: `standing approval persistence failed: ${String(error)}`,
      });
    }
  }

  await audit({
    canonicalPath,
    decision: "allowed",
    sizeBytes: readAuditSizeBytes(command, payload, verifiedDirFetchArchive?.sizeBytes),
    sha256:
      command === "dir.fetch"
        ? verifiedDirFetchArchive?.sha256
        : typeof payload?.sha256 === "string"
          ? payload.sha256
          : undefined,
  });

  return standingApprovalWarning && payload
    ? { ok: true, payload: { ...payload, standingApprovalWarning } }
    : result;
}

export function createFileTransferNodeInvokePolicy(): OpenClawPluginNodeInvokePolicy {
  return {
    commands: [...FILE_TRANSFER_NODE_INVOKE_COMMANDS],
    handle: handleFileTransferInvoke,
  };
}
