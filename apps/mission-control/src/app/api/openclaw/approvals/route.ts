import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getOpenClawClient, type OpenClawClient } from "@/lib/openclaw-client";
import { withApiGuard, ApiGuardPresets } from "@/lib/api-guard";
import { handleApiError, UserError } from "@/lib/errors";
import {
  approvalsAllowPatternSchema,
  approvalsResolveSchema,
  parseOrThrow,
} from "@/lib/schemas";
import {
  approvalCreatedMs,
  approvalResolvedMs,
  isApprovalResolved,
  isPathLikeAllowlistPattern,
  looksLikeApprovalsConfigSnapshot,
  normalizeApprovalRecords,
  type ApprovalRecord,
} from "@/lib/approvals";

const eventPendingApprovals = new Map<string, ApprovalRecord>();
let eventHistory: ApprovalRecord[] = [];
let listenersAttached = false;
let listenersSetupPromise: Promise<void> | null = null;

type ResolveDecision = "approve" | "reject";
type ResolveGatewayDecision = "approve" | "reject" | "allow-once" | "deny";

interface ExecAllowlistEntry {
  id?: string;
  pattern: string;
  lastUsedAt?: number;
}

interface ExecApprovalsAgent {
  allowlist?: ExecAllowlistEntry[];
  [key: string]: unknown;
}

interface ExecApprovalsFile {
  version?: number;
  agents?: Record<string, ExecApprovalsAgent>;
  [key: string]: unknown;
}

interface ExecApprovalsSnapshotPayload {
  hash: string;
  file: ExecApprovalsFile;
}

function sortPending(records: ApprovalRecord[]): ApprovalRecord[] {
  return [...records].toSorted((a, b) => approvalCreatedMs(b) - approvalCreatedMs(a));
}

function sortResolved(records: ApprovalRecord[]): ApprovalRecord[] {
  return [...records].toSorted((a, b) => approvalResolvedMs(b) - approvalResolvedMs(a));
}

function splitByState(records: ApprovalRecord[]): {
  pending: ApprovalRecord[];
  resolved: ApprovalRecord[];
} {
  const pending: ApprovalRecord[] = [];
  const resolved: ApprovalRecord[] = [];
  for (const record of records) {
    if (isApprovalResolved(record)) {resolved.push(record);}
    else {pending.push(record);}
  }
  return { pending, resolved };
}

function parseResolvedEvent(payload: unknown): {
  id: string;
  decision?: string;
  resolvedBy?: string;
  ts?: number;
} | null {
  if (!payload || typeof payload !== "object") {return null;}
  const record = payload as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  if (!id) {return null;}
  const decision = typeof record.decision === "string" ? record.decision.trim() : undefined;
  const resolvedBy = typeof record.resolvedBy === "string" ? record.resolvedBy.trim() : undefined;

  let ts: number | undefined;
  if (typeof record.ts === "number" && Number.isFinite(record.ts)) {ts = record.ts;}
  if (typeof record.ts === "string") {
    const parsed = Number(record.ts);
    if (Number.isFinite(parsed)) {ts = parsed;}
  }

  return { id, decision, resolvedBy, ts };
}

function pruneExpiredPending(): void {
  const now = Date.now();
  for (const [id, approval] of eventPendingApprovals.entries()) {
    if (approval.expiresAtMs && approval.expiresAtMs <= now) {
      eventPendingApprovals.delete(id);
    }
  }
}

function pushHistory(entry: ApprovalRecord): void {
  const idx = eventHistory.findIndex((item) => item.id === entry.id);
  if (idx === -1) {
    eventHistory = sortResolved([entry, ...eventHistory]).slice(0, 100);
    return;
  }
  const next = [...eventHistory];
  next[idx] = { ...next[idx], ...entry };
  eventHistory = sortResolved(next).slice(0, 100);
}

function snapshotFromEvents(): {
  pending: ApprovalRecord[];
  history: ApprovalRecord[];
} {
  pruneExpiredPending();
  return {
    pending: sortPending([...eventPendingApprovals.values()]),
    history: sortResolved(eventHistory),
  };
}

async function ensureApprovalListeners(client: OpenClawClient): Promise<void> {
  if (listenersAttached) {return;}
  if (listenersSetupPromise) {
    await listenersSetupPromise;
    return;
  }

  listenersSetupPromise = (async () => {
    await client.connect();

    client.onEvent("exec.approval.requested", (payload) => {
      const parsed = normalizeApprovalRecords(payload);
      if (parsed.length === 0) {return;}

      for (const entry of parsed) {
        eventPendingApprovals.set(entry.id, entry);
        eventHistory = eventHistory.filter((item) => item.id !== entry.id);
      }
    });

    client.onEvent("exec.approval.resolved", (payload) => {
      const resolved = parseResolvedEvent(payload);
      if (!resolved) {return;}

      const pending = eventPendingApprovals.get(resolved.id);
      eventPendingApprovals.delete(resolved.id);

      pushHistory({
        ...(pending ?? {
          id: resolved.id,
          command: "Unknown command",
        }),
        decision: resolved.decision ?? pending?.decision ?? "resolved",
        status: "resolved",
        resolvedBy: resolved.resolvedBy ?? pending?.resolvedBy,
        resolvedAtMs: resolved.ts ?? Date.now(),
      });
    });

    listenersAttached = true;
  })();

  try {
    await listenersSetupPromise;
  } finally {
    listenersSetupPromise = null;
  }
}

function isInvalidDecisionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /invalid decision/i.test(message);
}

function isBaseHashConflictError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /base hash/i.test(message) || /changed since last load/i.test(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractApprovalsSnapshot(payload: unknown): ExecApprovalsSnapshotPayload | null {
  if (!isRecord(payload)) {return null;}
  const hash = typeof payload.hash === "string" ? payload.hash.trim() : "";
  const file = isRecord(payload.file) ? (payload.file as ExecApprovalsFile) : null;
  if (!hash || !file) {return null;}
  return { hash, file };
}

async function loadApprovalsSnapshot(client: OpenClawClient): Promise<ExecApprovalsSnapshotPayload> {
  const payload = await client.getExecApprovals();
  const snapshot = extractApprovalsSnapshot(payload);
  if (!snapshot) {
    throw new UserError(
      "Gateway did not return an editable approvals policy snapshot.",
      502
    );
  }
  return snapshot;
}

function withAllowlistPattern(params: {
  file: ExecApprovalsFile;
  agentId: string;
  pattern: string;
}): { file: ExecApprovalsFile; alreadyExists: boolean } {
  const trimmedPattern = params.pattern.trim();
  if (!trimmedPattern) {
    throw new UserError("Pattern is required.", 400);
  }
  if (!isPathLikeAllowlistPattern(trimmedPattern)) {
    throw new UserError("Pattern must include a path separator or ~.", 400);
  }

  const nextFile: ExecApprovalsFile = {
    ...params.file,
    agents: { ...params.file.agents },
  };
  const existingAgent = nextFile.agents?.[params.agentId] ?? {};
  const existingAllowlist = Array.isArray(existingAgent.allowlist)
    ? [...existingAgent.allowlist]
    : [];

  if (
    existingAllowlist.some(
      (entry) => typeof entry.pattern === "string" && entry.pattern === trimmedPattern
    )
  ) {
    return { file: nextFile, alreadyExists: true };
  }

  existingAllowlist.push({
    id: randomUUID(),
    pattern: trimmedPattern,
    lastUsedAt: Date.now(),
  });

  nextFile.agents![params.agentId] = {
    ...existingAgent,
    allowlist: existingAllowlist,
  };

  return { file: nextFile, alreadyExists: false };
}

async function resolveApprovalWithFallback(params: {
  client: OpenClawClient;
  id: string;
  decision: ResolveDecision;
}): Promise<{ result: unknown; gatewayDecision: ResolveGatewayDecision }> {
  const { client, id, decision } = params;
  let gatewayDecision: ResolveGatewayDecision = decision;
  let result: unknown;

  try {
    result = await client.resolveExecApproval({ id, decision });
  } catch (error) {
    if (!isInvalidDecisionError(error)) {throw error;}
    gatewayDecision = decision === "approve" ? "allow-once" : "deny";
    result = await client.resolveExecApproval({ id, decision: gatewayDecision });
  }

  return { result, gatewayDecision };
}

function recordResolvedInCache(params: {
  id: string;
  decision: string;
  resolvedBy?: string;
  resolvedAtMs?: number;
}) {
  const { id, decision, resolvedBy, resolvedAtMs } = params;
  const pending = eventPendingApprovals.get(id);
  eventPendingApprovals.delete(id);
  pushHistory({
    ...(pending ?? {
      id,
      command: "Unknown command",
    }),
    decision,
    status: "resolved",
    resolvedBy: resolvedBy ?? pending?.resolvedBy,
    resolvedAtMs: resolvedAtMs ?? Date.now(),
  });
}

export const GET = withApiGuard(async () => {
  try {
    const client = getOpenClawClient();
    await client.connect();
    await ensureApprovalListeners(client);

    const approvalsPayload = await client.getExecApprovals();
    const normalized = normalizeApprovalRecords(approvalsPayload);

    const hasRpcApprovalData = normalized.length > 0;
    const useEventCache =
      looksLikeApprovalsConfigSnapshot(approvalsPayload) ||
      (!hasRpcApprovalData && (eventPendingApprovals.size > 0 || eventHistory.length > 0));

    if (useEventCache) {
      const cached = snapshotFromEvents();
      return NextResponse.json({
        approvals: cached.pending,
        history: cached.history,
        source: "event-cache",
      });
    }

    const { pending, resolved } = splitByState(normalized);
    return NextResponse.json({
      approvals: sortPending(pending),
      history: sortResolved(resolved).slice(0, 100),
      source: "rpc",
    });
  } catch (error) {
    return handleApiError(error, "Failed to fetch approvals");
  }
}, ApiGuardPresets.read);

export const POST = withApiGuard(async (request: NextRequest) => {
  try {
    const body = await request.json();

    const client = getOpenClawClient();
    await client.connect();
    await ensureApprovalListeners(client);

    if (isRecord(body) && body.action === "allow-pattern") {
      const { pattern, approvalId, approveCurrent, agentId } = parseOrThrow(
        approvalsAllowPatternSchema,
        body
      );
      const pending = approvalId ? eventPendingApprovals.get(approvalId) : undefined;
      const targetAgentId =
        agentId?.trim() || pending?.agentId?.trim() || "main";
      let alreadyExists = false;

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const snapshot = await loadApprovalsSnapshot(client);
        const patch = withAllowlistPattern({
          file: snapshot.file,
          agentId: targetAgentId,
          pattern,
        });
        alreadyExists = patch.alreadyExists;
        if (alreadyExists) {break;}

        try {
          await client.setExecApprovals({
            file: patch.file,
            baseHash: snapshot.hash,
          });
          break;
        } catch (error) {
          if (attempt === 0 && isBaseHashConflictError(error)) {
            continue;
          }
          throw error;
        }
      }

      let approvalResult: unknown = null;
      let gatewayDecision: ResolveGatewayDecision | null = null;
      if ((approveCurrent ?? true) && approvalId) {
        const resolved = await resolveApprovalWithFallback({
          client,
          id: approvalId,
          decision: "approve",
        });
        gatewayDecision = resolved.gatewayDecision;
        approvalResult = resolved.result;
        recordResolvedInCache({
          id: approvalId,
          decision: resolved.gatewayDecision,
        });
      }

      return NextResponse.json({
        ok: true,
        action: "allow-pattern",
        pattern: pattern.trim(),
        agentId: targetAgentId,
        alreadyExists,
        approvedCurrent: Boolean((approveCurrent ?? true) && approvalId),
        gatewayDecision,
        approvalResult,
      });
    }

    const { id, decision } = parseOrThrow(approvalsResolveSchema, body);
    const resolved = await resolveApprovalWithFallback({
      client,
      id,
      decision,
    });
    recordResolvedInCache({
      id,
      decision: resolved.gatewayDecision,
    });

    return NextResponse.json({
      ok: true,
      result: resolved.result,
      gatewayDecision: resolved.gatewayDecision,
    });
  } catch (error) {
    return handleApiError(error, "Failed to resolve approval");
  }
}, ApiGuardPresets.write);
