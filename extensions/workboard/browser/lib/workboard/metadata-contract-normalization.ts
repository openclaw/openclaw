import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  WorkboardAutomation,
  WorkboardDiagnosticAction,
  WorkboardHandoff,
  WorkboardWorkspace,
  WorkboardWorkspaceAccess,
} from "./types.ts";

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
    : [];
}

function normalizeWorkspaceAccess(value: unknown): WorkboardWorkspaceAccess | undefined {
  if (!isRecord(value) || typeof value.unrestricted !== "boolean") {
    return undefined;
  }
  if (value.unrestricted) {
    return { unrestricted: true };
  }
  if (!Array.isArray(value.roots) || typeof value.writable !== "boolean") {
    return undefined;
  }
  return {
    unrestricted: false,
    roots: value.roots.filter((root): root is string => typeof root === "string"),
    writable: value.writable,
  };
}

export function normalizeAutomation(value: unknown): WorkboardAutomation | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const workspace = isRecord(value.workspace)
    ? {
        kind:
          value.workspace.kind === "scratch" ||
          value.workspace.kind === "dir" ||
          value.workspace.kind === "worktree"
            ? value.workspace.kind
            : undefined,
        ...(typeof value.workspace.path === "string" ? { path: value.workspace.path } : {}),
        ...(typeof value.workspace.branch === "string" ? { branch: value.workspace.branch } : {}),
        ...(typeof value.workspace.sourcePath === "string"
          ? { sourcePath: value.workspace.sourcePath }
          : {}),
        ...(typeof value.workspace.sourceBranch === "string"
          ? { sourceBranch: value.workspace.sourceBranch }
          : {}),
      }
    : undefined;
  const workspaceAccess = normalizeWorkspaceAccess(value.workspaceAccess);
  const skills = normalizeStringArray(value.skills);
  const createdCardIds = normalizeStringArray(value.createdCardIds);
  const handoff: WorkboardHandoff | undefined =
    isRecord(value.handoff) &&
    typeof value.handoff.summary === "string" &&
    typeof value.handoff.updatedAt === "number"
      ? {
          summary: value.handoff.summary,
          updatedAt: value.handoff.updatedAt,
          ...(typeof value.handoff.needsUser === "string"
            ? { needsUser: value.handoff.needsUser }
            : {}),
          ...(typeof value.handoff.previewUrl === "string"
            ? { previewUrl: value.handoff.previewUrl }
            : {}),
          ...(typeof value.handoff.verifiedAt === "number"
            ? { verifiedAt: value.handoff.verifiedAt }
            : {}),
          ...(value.handoff.approval === "not-required" ||
          value.handoff.approval === "pending" ||
          value.handoff.approval === "approved"
            ? { approval: value.handoff.approval }
            : {}),
          ...(value.handoff.uat === "not-required" ||
          value.handoff.uat === "pending" ||
          value.handoff.uat === "approved"
            ? { uat: value.handoff.uat }
            : {}),
          ...(value.handoff.deliveryStatus === "not-requested" ||
          value.handoff.deliveryStatus === "pending" ||
          value.handoff.deliveryStatus === "delivered" ||
          value.handoff.deliveryStatus === "failed" ||
          value.handoff.deliveryStatus === "empty"
            ? { deliveryStatus: value.handoff.deliveryStatus }
            : {}),
          ...(typeof value.handoff.deliveryReceipt === "string"
            ? { deliveryReceipt: value.handoff.deliveryReceipt }
            : {}),
        }
      : undefined;
  const automation: WorkboardAutomation = {
    ...(typeof value.tenant === "string" ? { tenant: value.tenant } : {}),
    ...(typeof value.boardId === "string" ? { boardId: value.boardId } : {}),
    ...(typeof value.createdByCardId === "string"
      ? { createdByCardId: value.createdByCardId }
      : {}),
    ...(typeof value.idempotencyKey === "string" ? { idempotencyKey: value.idempotencyKey } : {}),
    ...(skills.length ? { skills } : {}),
    ...(workspace?.kind ? { workspace: workspace as WorkboardWorkspace } : {}),
    ...(workspaceAccess ? { workspaceAccess } : {}),
    ...(typeof value.maxRuntimeSeconds === "number"
      ? { maxRuntimeSeconds: value.maxRuntimeSeconds }
      : {}),
    ...(typeof value.maxRetries === "number" ? { maxRetries: value.maxRetries } : {}),
    ...(typeof value.scheduledAt === "number" ? { scheduledAt: value.scheduledAt } : {}),
    ...(typeof value.summary === "string" ? { summary: value.summary } : {}),
    ...(createdCardIds.length ? { createdCardIds } : {}),
    ...(typeof value.dispatchCount === "number" ? { dispatchCount: value.dispatchCount } : {}),
    ...(typeof value.lastDispatchAt === "number" ? { lastDispatchAt: value.lastDispatchAt } : {}),
    ...(handoff ? { handoff } : {}),
  };
  return Object.keys(automation).length ? automation : undefined;
}

export function normalizeDiagnosticAction(value: unknown): WorkboardDiagnosticAction | null {
  if (
    !isRecord(value) ||
    (value.kind !== "claim" &&
      value.kind !== "unblock" &&
      value.kind !== "promote" &&
      value.kind !== "reclaim" &&
      value.kind !== "reassign" &&
      value.kind !== "add_proof" &&
      value.kind !== "open_session") ||
    typeof value.label !== "string"
  ) {
    return null;
  }
  return { kind: value.kind, label: value.label };
}
