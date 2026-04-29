import type {
  OpenClawPluginNodeInvokePolicy,
  OpenClawPluginNodeInvokePolicyContext,
  OpenClawPluginNodeInvokePolicyResult,
} from "openclaw/plugin-sdk/plugin-entry";
import { appendFileTransferAudit, type FileTransferAuditOp } from "./audit.js";
import { evaluateFilePolicy, persistAllowAlways, type FilePolicyKind } from "./policy.js";

const FILE_FETCH_DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const FILE_FETCH_HARD_MAX_BYTES = 16 * 1024 * 1024;
const DIR_FETCH_DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DIR_FETCH_HARD_MAX_BYTES = 16 * 1024 * 1024;

type FileTransferCommand = "file.fetch" | "dir.list" | "dir.fetch" | "file.write";

const COMMANDS: FileTransferCommand[] = ["file.fetch", "dir.list", "dir.fetch", "file.write"];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readPath(params: Record<string, unknown>): string {
  return typeof params.path === "string" ? params.path.trim() : "";
}

function readMaxBytes(input: {
  value: unknown;
  defaultValue: number;
  hardMax: number;
  policyMax?: number;
}): number {
  const requested =
    typeof input.value === "number" && Number.isFinite(input.value)
      ? Math.floor(input.value)
      : input.defaultValue;
  const clamped = Math.max(1, Math.min(requested, input.hardMax));
  return input.policyMax ? Math.min(clamped, input.policyMax) : clamped;
}

function commandKind(command: FileTransferCommand): FilePolicyKind {
  return command === "file.write" ? "write" : "read";
}

function promptVerb(command: FileTransferCommand): string {
  switch (command) {
    case "dir.fetch":
      return "Fetch directory";
    case "dir.list":
      return "List directory";
    case "file.write":
      return "Write file";
    case "file.fetch":
      return "Read file";
  }
}

async function requestApproval(input: {
  ctx: OpenClawPluginNodeInvokePolicyContext;
  op: FileTransferAuditOp;
  kind: FilePolicyKind;
  path: string;
  startedAt: number;
}): Promise<
  | { ok: true; followSymlinks: boolean; maxBytes?: number }
  | { ok: false; message: string; code: string }
> {
  const nodeDisplayName = input.ctx.node?.displayName;
  const decision = evaluateFilePolicy({
    nodeId: input.ctx.nodeId,
    nodeDisplayName,
    kind: input.kind,
    path: input.path,
    pluginConfig: input.ctx.pluginConfig,
  });

  if (decision.ok && decision.reason === "matched-allow") {
    return {
      ok: true,
      followSymlinks: decision.followSymlinks,
      maxBytes: decision.maxBytes,
    };
  }

  const shouldAsk =
    (decision.ok && decision.reason === "ask-always") || (!decision.ok && decision.askable);
  if (!shouldAsk) {
    await appendFileTransferAudit({
      op: input.op,
      nodeId: input.ctx.nodeId,
      nodeDisplayName,
      requestedPath: input.path,
      decision:
        !decision.ok && decision.code === "NO_POLICY" ? "denied:no_policy" : "denied:policy",
      errorCode: decision.ok ? undefined : decision.code,
      reason: decision.ok ? decision.reason : decision.reason,
      durationMs: Date.now() - input.startedAt,
    });
    return {
      ok: false,
      code: decision.ok ? "POLICY_DENIED" : decision.code,
      message: `${input.op} ${decision.ok ? "POLICY_DENIED" : decision.code}: ${decision.reason}`,
    };
  }

  const approvals = input.ctx.approvals;
  if (!approvals) {
    await appendFileTransferAudit({
      op: input.op,
      nodeId: input.ctx.nodeId,
      nodeDisplayName,
      requestedPath: input.path,
      decision: "denied:approval",
      reason: "plugin approvals unavailable",
      durationMs: Date.now() - input.startedAt,
    });
    return {
      ok: false,
      code: "APPROVAL_UNAVAILABLE",
      message: `${input.op} APPROVAL_UNAVAILABLE: plugin approvals unavailable`,
    };
  }

  const verb = promptVerb(input.op);
  const subject = nodeDisplayName ?? input.ctx.nodeId;
  const approval = await approvals.request({
    title: `${verb}: ${input.path}`,
    description: `Allow ${verb.toLowerCase()} on ${subject}\nPath: ${input.path}\nKind: ${input.kind}\n\n"allow-always" appends this exact path to allow${input.kind === "read" ? "Read" : "Write"}Paths.`,
    severity: input.kind === "write" ? "warning" : "info",
    toolName: input.op,
  });

  if (approval.decision === "deny" || approval.decision === null || !approval.decision) {
    await appendFileTransferAudit({
      op: input.op,
      nodeId: input.ctx.nodeId,
      nodeDisplayName,
      requestedPath: input.path,
      decision: "denied:approval",
      reason: approval.decision === "deny" ? "operator denied" : "no operator available",
      durationMs: Date.now() - input.startedAt,
    });
    return {
      ok: false,
      code: approval.decision === "deny" ? "APPROVAL_DENIED" : "APPROVAL_UNAVAILABLE",
      message:
        approval.decision === "deny"
          ? `${input.op} APPROVAL_DENIED: operator denied the prompt`
          : `${input.op} APPROVAL_UNAVAILABLE: no operator client connected to approve the request`,
    };
  }

  if (approval.decision === "allow-always") {
    try {
      await persistAllowAlways({
        nodeId: input.ctx.nodeId,
        nodeDisplayName,
        kind: input.kind,
        path: input.path,
      });
    } catch (error) {
      await appendFileTransferAudit({
        op: input.op,
        nodeId: input.ctx.nodeId,
        nodeDisplayName,
        requestedPath: input.path,
        decision: "allowed:always",
        reason: `persist failed: ${String(error)}`,
        durationMs: Date.now() - input.startedAt,
      });
      return {
        ok: true,
        followSymlinks: decision.ok ? decision.followSymlinks : false,
        maxBytes: decision.ok ? decision.maxBytes : undefined,
      };
    }
  }

  await appendFileTransferAudit({
    op: input.op,
    nodeId: input.ctx.nodeId,
    nodeDisplayName,
    requestedPath: input.path,
    decision: approval.decision === "allow-always" ? "allowed:always" : "allowed:once",
    durationMs: Date.now() - input.startedAt,
  });
  return {
    ok: true,
    followSymlinks: decision.ok ? decision.followSymlinks : false,
    maxBytes: decision.ok ? decision.maxBytes : undefined,
  };
}

function prepareParams(input: {
  command: FileTransferCommand;
  params: Record<string, unknown>;
  followSymlinks: boolean;
  maxBytes?: number;
}): Record<string, unknown> {
  const next: Record<string, unknown> = {
    ...input.params,
    followSymlinks: input.followSymlinks,
  };
  if (input.command === "file.fetch") {
    next.maxBytes = readMaxBytes({
      value: input.params.maxBytes,
      defaultValue: FILE_FETCH_DEFAULT_MAX_BYTES,
      hardMax: FILE_FETCH_HARD_MAX_BYTES,
      policyMax: input.maxBytes,
    });
  } else if (input.command === "dir.fetch") {
    next.maxBytes = readMaxBytes({
      value: input.params.maxBytes,
      defaultValue: DIR_FETCH_DEFAULT_MAX_BYTES,
      hardMax: DIR_FETCH_HARD_MAX_BYTES,
      policyMax: input.maxBytes,
    });
  }
  return next;
}

async function handleFileTransferInvoke(
  ctx: OpenClawPluginNodeInvokePolicyContext,
): Promise<OpenClawPluginNodeInvokePolicyResult> {
  if (!COMMANDS.includes(ctx.command as FileTransferCommand)) {
    return { ok: false, code: "UNSUPPORTED_COMMAND", message: "unsupported file-transfer command" };
  }
  const command = ctx.command as FileTransferCommand;
  const op: FileTransferAuditOp = command;
  const params = asRecord(ctx.params);
  const requestedPath = readPath(params);
  const nodeDisplayName = ctx.node?.displayName;
  const startedAt = Date.now();

  if (!requestedPath) {
    return { ok: false, code: "INVALID_PARAMS", message: `${op} path required` };
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

  const forwardedParams = prepareParams({
    command,
    params,
    followSymlinks: gate.followSymlinks,
    maxBytes: gate.maxBytes,
  });
  const result = await ctx.invokeNode({ params: forwardedParams });
  if (!result.ok) {
    await appendFileTransferAudit({
      op,
      nodeId: ctx.nodeId,
      nodeDisplayName,
      requestedPath,
      decision: "error",
      errorCode: result.code,
      errorMessage: result.message,
      durationMs: Date.now() - startedAt,
    });
    return {
      ok: false,
      code: result.code,
      message: `${op} failed: ${result.message}`,
      details: result.details,
      unavailable: true,
    };
  }

  const payload =
    result.payload && typeof result.payload === "object" && !Array.isArray(result.payload)
      ? (result.payload as Record<string, unknown>)
      : null;
  if (payload?.ok === false) {
    await appendFileTransferAudit({
      op,
      nodeId: ctx.nodeId,
      nodeDisplayName,
      requestedPath,
      canonicalPath: typeof payload.canonicalPath === "string" ? payload.canonicalPath : undefined,
      decision: "error",
      errorCode: typeof payload.code === "string" ? payload.code : undefined,
      errorMessage: typeof payload.message === "string" ? payload.message : undefined,
      durationMs: Date.now() - startedAt,
    });
    return result;
  }

  const canonicalPath =
    payload && typeof payload.path === "string" && payload.path ? payload.path : requestedPath;
  if (canonicalPath !== requestedPath) {
    const postflight = evaluateFilePolicy({
      nodeId: ctx.nodeId,
      nodeDisplayName,
      kind: commandKind(command),
      path: canonicalPath,
      pluginConfig: ctx.pluginConfig,
    });
    if (!postflight.ok) {
      await appendFileTransferAudit({
        op,
        nodeId: ctx.nodeId,
        nodeDisplayName,
        requestedPath,
        canonicalPath,
        decision: "denied:symlink_escape",
        errorCode: postflight.code,
        reason: postflight.reason,
        durationMs: Date.now() - startedAt,
      });
      return {
        ok: false,
        code: "SYMLINK_TARGET_DENIED",
        message: `${op} SYMLINK_TARGET_DENIED: requested path resolved to ${canonicalPath} which is not allowed by policy`,
      };
    }
  }

  await appendFileTransferAudit({
    op,
    nodeId: ctx.nodeId,
    nodeDisplayName,
    requestedPath,
    canonicalPath,
    decision: "allowed",
    sizeBytes: typeof payload?.size === "number" ? payload.size : undefined,
    sha256: typeof payload?.sha256 === "string" ? payload.sha256 : undefined,
    durationMs: Date.now() - startedAt,
  });

  return result;
}

export function createFileTransferNodeInvokePolicy(): OpenClawPluginNodeInvokePolicy {
  return {
    commands: COMMANDS,
    handle: handleFileTransferInvoke,
  };
}
