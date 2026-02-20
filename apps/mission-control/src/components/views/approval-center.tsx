"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  AlertTriangle,
  Search,
  Server,
  Shield,
  ShieldCheck,
  ShieldX,
  Clock,
  CheckCircle2,
  XCircle,
  RefreshCw,
  Loader2,
  Bot,
  ListTodo,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  useGatewayConnectionState,
  useGatewayEvents,
  type GatewayConnectionState,
  type GatewayEvent,
} from "@/lib/hooks/use-gateway-events";
import {
  approvalCreatedMs,
  approvalDecisionLabel,
  approvalResolvedMs,
  assessApprovalRisk,
  buildAllowlistPatternSuggestions,
  isApprovalApproved,
  isApprovalRejected,
  isApprovalResolved,
  isPathLikeAllowlistPattern,
  looksLikeApprovalsConfigSnapshot,
  matchesAllowlistPattern,
  normalizeApprovalRecords,
  previewAllowlistPattern,
  suggestAllowlistPattern,
  type ApprovalRecord,
  type ApprovalRiskAssessment,
  type ApprovalRiskLevel,
  type AllowlistPatternScope,
} from "@/lib/approvals";
import { cn } from "@/lib/utils";

type RiskFilter = "all" | "critical" | "high" | "medium" | "low";
type SortMode = "newest" | "oldest" | "risk" | "expiry";

interface ApprovalRow {
  approval: ApprovalRecord;
  risk: ApprovalRiskAssessment;
}

interface ConfirmDialogState {
  approval: ApprovalRecord;
  risk: ApprovalRiskAssessment;
  decision: "approve" | "reject" | "allow-pattern";
  pattern?: string;
  approveCurrent?: boolean;
}

interface PatternHistoryImpact {
  considered: number;
  matched: number;
  missingPath: number;
}

const RISK_CLASSES: Record<
  ApprovalRiskLevel,
  { badge: string; panel: string; icon: typeof Shield }
> = {
  LOW: {
    badge: "text-green-500 bg-green-500/10 border-green-500/20",
    panel: "border-l-green-500/50",
    icon: ShieldCheck,
  },
  MEDIUM: {
    badge: "text-yellow-500 bg-yellow-500/10 border-yellow-500/20",
    panel: "border-l-yellow-500/50",
    icon: AlertTriangle,
  },
  HIGH: {
    badge: "text-orange-500 bg-orange-500/10 border-orange-500/20",
    panel: "border-l-orange-500/50",
    icon: ShieldX,
  },
  CRITICAL: {
    badge: "text-red-500 bg-red-500/10 border-red-500/20",
    panel: "border-l-red-500/50",
    icon: ShieldX,
  },
};

const PATTERN_SCOPE_CLASSES: Record<AllowlistPatternScope, string> = {
  invalid: "text-red-400 bg-red-500/10 border-red-500/30",
  exact: "text-green-500 bg-green-500/10 border-green-500/30",
  narrow: "text-emerald-500 bg-emerald-500/10 border-emerald-500/30",
  broad: "text-yellow-500 bg-yellow-500/10 border-yellow-500/30",
  "very-broad": "text-orange-500 bg-orange-500/10 border-orange-500/30",
};

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  return "Unexpected error while processing approvals.";
}

function formatRelativeTime(ms?: number): string {
  if (!ms || !Number.isFinite(ms)) return "-";
  const delta = Date.now() - ms;
  const seconds = Math.max(0, Math.floor(delta / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatAbsoluteTime(ms?: number): string {
  if (!ms || !Number.isFinite(ms)) return "-";
  return new Date(ms).toLocaleString();
}

function formatExpiry(expiresAtMs?: number): string {
  if (!expiresAtMs || !Number.isFinite(expiresAtMs)) return "No expiry";
  const remaining = expiresAtMs - Date.now();
  if (remaining <= 0) return "Expired";
  const sec = Math.floor(remaining / 1000);
  if (sec < 60) return `Expires in ${sec}s`;
  const mins = Math.floor(sec / 60);
  if (mins < 60) return `Expires in ${mins}m`;
  const hours = Math.floor(mins / 60);
  return `Expires in ${hours}h`;
}

function parseResolvedEvent(payload: unknown): {
  id: string;
  decision?: string;
  resolvedBy?: string;
  ts?: number;
} | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  if (!id) return null;
  const decision = typeof record.decision === "string" ? record.decision.trim() : undefined;
  const resolvedBy = typeof record.resolvedBy === "string" ? record.resolvedBy.trim() : undefined;

  let ts: number | undefined;
  if (typeof record.ts === "number" && Number.isFinite(record.ts)) ts = record.ts;
  if (typeof record.ts === "string") {
    const parsed = Number(record.ts);
    if (Number.isFinite(parsed)) ts = parsed;
  }
  return { id, decision, resolvedBy, ts };
}

function splitByState(records: ApprovalRecord[]): {
  pending: ApprovalRecord[];
  resolved: ApprovalRecord[];
} {
  const pending: ApprovalRecord[] = [];
  const resolved: ApprovalRecord[] = [];
  for (const record of records) {
    if (isApprovalResolved(record)) resolved.push(record);
    else pending.push(record);
  }
  return { pending, resolved };
}

function trimCommand(command: string, max = 180): string {
  if (command.length <= max) return command;
  return `${command.slice(0, max - 1)}…`;
}

function approvalListKey(approval: ApprovalRecord, index: number): string {
  return `${approval.id}:${approvalCreatedMs(approval)}:${index}`;
}

function queueSortValue(approval: ApprovalRecord): number {
  return approvalCreatedMs(approval) || 0;
}

function sortHistory(records: ApprovalRecord[]): ApprovalRecord[] {
  return [...records].sort((a, b) => approvalResolvedMs(b) - approvalResolvedMs(a));
}

function upsertHistory(existing: ApprovalRecord[], incoming: ApprovalRecord): ApprovalRecord[] {
  const idx = existing.findIndex((entry) => entry.id === incoming.id);
  if (idx === -1) {
    return sortHistory([incoming, ...existing]).slice(0, 100);
  }
  const next = [...existing];
  next[idx] = { ...next[idx], ...incoming };
  return sortHistory(next).slice(0, 100);
}

function connectionBadge(state: GatewayConnectionState): {
  label: string;
  className: string;
} {
  if (state === "connected") {
    return {
      label: "Live",
      className: "text-green-500 bg-green-500/10 border-green-500/20",
    };
  }
  if (state === "connecting") {
    return {
      label: "Reconnecting",
      className: "text-yellow-500 bg-yellow-500/10 border-yellow-500/20",
    };
  }
  return {
    label: "Offline fallback",
    className: "text-red-500 bg-red-500/10 border-red-500/20",
  };
}

export function ApprovalCenter() {
  const [approvals, setApprovals] = useState<ApprovalRecord[]>([]);
  const [history, setHistory] = useState<ApprovalRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionInfo, setActionInfo] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [riskFilter, setRiskFilter] = useState<RiskFilter>("all");
  const [sortMode, setSortMode] = useState<SortMode>("newest");
  const [selectedApprovalId, setSelectedApprovalId] = useState<string | null>(null);
  const [reviewConfirmed, setReviewConfirmed] = useState(false);
  const [stepUpText, setStepUpText] = useState("");
  const [allowPattern, setAllowPattern] = useState("");
  const [allowPatternApproveCurrent, setAllowPatternApproveCurrent] = useState(true);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null);
  const [connectionState, setConnectionState] =
    useState<GatewayConnectionState>("connecting");
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const approvalsRef = useRef<ApprovalRecord[]>([]);

  useEffect(() => {
    approvalsRef.current = approvals;
  }, [approvals]);

  const fetchApprovals = useCallback(async (options?: { silent?: boolean }) => {
    const silent = options?.silent ?? false;
    if (!silent) setLoading(true);
    if (silent) setRefreshing(true);

    try {
      const res = await fetch("/api/openclaw/approvals", { cache: "no-store" });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;

      if (!res.ok) {
        const message =
          typeof data.error === "string"
            ? data.error
            : `Failed to fetch approvals (${res.status})`;
        throw new Error(message);
      }

      const payload = data.approvals;
      const parsedApprovals = normalizeApprovalRecords(payload);
      const parsedHistory = normalizeApprovalRecords(data.history);

      if (looksLikeApprovalsConfigSnapshot(payload) && parsedApprovals.length === 0) {
        setError(
          "Gateway returned approval policy settings. Live approval queue is being maintained from real-time events."
        );
        setLastUpdatedAt(Date.now());
        return;
      }

      const combined = [...parsedApprovals, ...parsedHistory];
      const { pending, resolved } = splitByState(combined);

      setApprovals([...pending].sort((a, b) => queueSortValue(b) - queueSortValue(a)));
      setHistory(sortHistory(resolved));
      setError(null);
      setLastUpdatedAt(Date.now());
    } catch (fetchError) {
      setError(normalizeErrorMessage(fetchError));
    } finally {
      if (!silent) setLoading(false);
      if (silent) setRefreshing(false);
    }
  }, []);

  const scheduleRefresh = useCallback(() => {
    if (refreshTimerRef.current) return;
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      fetchApprovals({ silent: true }).catch(() => {
        // Ignore transient refresh failures.
      });
    }, 180);
  }, [fetchApprovals]);

  const handleConnectionState = useCallback((state: GatewayConnectionState) => {
    setConnectionState(state);
  }, []);

  const handleGatewayEvent = useCallback(
    (event: GatewayEvent) => {
      if (event.type !== "gateway_event") return;
      const eventName = (event.event || "").toLowerCase();

      if (eventName === "exec.approval.requested") {
        const parsed = normalizeApprovalRecords(event.payload);
        if (parsed.length > 0) {
          const incoming = parsed[0];
          setApprovals((prev) => {
            const idx = prev.findIndex((item) => item.id === incoming.id);
            if (idx === -1) {
              return [incoming, ...prev].sort(
                (a, b) => queueSortValue(b) - queueSortValue(a)
              );
            }
            const next = [...prev];
            next[idx] = { ...next[idx], ...incoming };
            return next.sort((a, b) => queueSortValue(b) - queueSortValue(a));
          });
          setError(null);
          setLastUpdatedAt(Date.now());
        } else {
          scheduleRefresh();
        }
        return;
      }

      if (eventName === "exec.approval.resolved") {
        const resolved = parseResolvedEvent(event.payload);
        if (resolved) {
          const existing = approvalsRef.current.find((item) => item.id === resolved.id);
          setApprovals((prev) => prev.filter((item) => item.id !== resolved.id));
          setHistory((prev) =>
            upsertHistory(prev, {
              ...(existing ?? {
                id: resolved.id,
                command: "Unknown command",
              }),
              decision: resolved.decision ?? existing?.decision ?? "resolved",
              status: "resolved",
              resolvedBy: resolved.resolvedBy ?? existing?.resolvedBy,
              resolvedAtMs: resolved.ts ?? Date.now(),
            })
          );
          setLastUpdatedAt(Date.now());
        } else {
          scheduleRefresh();
        }
        return;
      }

      if (
        eventName.includes("exec.approval") ||
        eventName.includes("approval") ||
        eventName.includes("status")
      ) {
        scheduleRefresh();
      }
    },
    [scheduleRefresh]
  );

  useGatewayConnectionState(handleConnectionState);
  useGatewayEvents(handleGatewayEvent);

  useEffect(() => {
    fetchApprovals().catch(() => {
      // Ignore initial load errors.
    });
  }, [fetchApprovals]);

  useEffect(() => {
    const intervalId = setInterval(() => {
      if (connectionState !== "connected") {
        fetchApprovals({ silent: true }).catch(() => {
          // Ignore fallback refresh errors.
        });
      }
    }, 15_000);
    return () => clearInterval(intervalId);
  }, [connectionState, fetchApprovals]);

  useEffect(() => {
    return () => {
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setReviewConfirmed(false);
    setStepUpText("");
    setActionInfo(null);
    const selected = selectedApprovalId
      ? approvalsRef.current.find((item) => item.id === selectedApprovalId)
      : null;
    setAllowPattern(selected ? suggestAllowlistPattern(selected) ?? "" : "");
    setAllowPatternApproveCurrent(true);
  }, [selectedApprovalId]);

  const resolveApproval = useCallback(
    async (approval: ApprovalRecord, decision: "approve" | "reject"): Promise<boolean> => {
      setActionLoading(approval.id);
      setActionError(null);
      setActionInfo(null);

      try {
        const res = await fetch("/api/openclaw/approvals", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: approval.id, decision }),
        });
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;

        if (!res.ok || data.ok === false) {
          const message =
            typeof data.error === "string"
              ? data.error
              : `Failed to ${decision} approval ${approval.id}`;
          throw new Error(message);
        }

        setApprovals((prev) => prev.filter((item) => item.id !== approval.id));
        setHistory((prev) =>
          upsertHistory(prev, {
            ...approval,
            decision,
            status: "resolved",
            resolvedAtMs: Date.now(),
          })
        );
        setLastUpdatedAt(Date.now());
        await fetchApprovals({ silent: true });
        return true;
      } catch (resolveError) {
        setActionError(normalizeErrorMessage(resolveError));
        return false;
      } finally {
        setActionLoading(null);
      }
    },
    [fetchApprovals]
  );

  const allowPatternForApproval = useCallback(
    async (
      approval: ApprovalRecord,
      pattern: string,
      approveCurrent: boolean
    ): Promise<boolean> => {
      const trimmedPattern = pattern.trim();
      if (!trimmedPattern) {
        setActionError("Allowlist pattern is required.");
        return false;
      }
      if (!isPathLikeAllowlistPattern(trimmedPattern)) {
        setActionError("Pattern must include a path separator or ~.");
        return false;
      }

      setActionLoading(approval.id);
      setActionError(null);
      setActionInfo(null);

      try {
        const res = await fetch("/api/openclaw/approvals", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "allow-pattern",
            pattern: trimmedPattern,
            agentId: approval.agentId || "main",
            approvalId: approval.id,
            approveCurrent,
          }),
        });
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;

        if (!res.ok || data.ok === false) {
          const message =
            typeof data.error === "string"
              ? data.error
              : `Failed to allow pattern for approval ${approval.id}`;
          throw new Error(message);
        }

        const alreadyExists = data.alreadyExists === true;
        const approvedCurrent = data.approvedCurrent === true;
        setActionInfo(
          alreadyExists
            ? approvedCurrent
              ? `Pattern already allowlisted and request approved for agent ${approval.agentId || "main"}: ${trimmedPattern}`
              : `Pattern already allowlisted for agent ${approval.agentId || "main"}: ${trimmedPattern}`
            : approvedCurrent
              ? `Pattern saved and request approved for agent ${approval.agentId || "main"}: ${trimmedPattern}`
              : `Pattern saved for agent ${approval.agentId || "main"}: ${trimmedPattern}`
        );
        setLastUpdatedAt(Date.now());
        await fetchApprovals({ silent: true });
        return true;
      } catch (allowError) {
        setActionError(normalizeErrorMessage(allowError));
        return false;
      } finally {
        setActionLoading(null);
      }
    },
    [fetchApprovals]
  );

  const rows = useMemo<ApprovalRow[]>(
    () => approvals.map((approval) => ({ approval, risk: assessApprovalRisk(approval.command) })),
    [approvals]
  );

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();

    const next = rows.filter((row) => {
      if (riskFilter !== "all" && row.risk.level.toLowerCase() !== riskFilter) {
        return false;
      }
      if (!q) return true;

      const searchable = [
        row.approval.id,
        row.approval.command,
        row.approval.agentId,
        row.approval.sessionKey,
        row.approval.cwd,
        row.approval.host,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return searchable.includes(q);
    });

    next.sort((a, b) => {
      if (sortMode === "oldest") {
        return queueSortValue(a.approval) - queueSortValue(b.approval);
      }
      if (sortMode === "risk") {
        if (b.risk.score !== a.risk.score) return b.risk.score - a.risk.score;
        return queueSortValue(b.approval) - queueSortValue(a.approval);
      }
      if (sortMode === "expiry") {
        const aExpiry = a.approval.expiresAtMs ?? Number.POSITIVE_INFINITY;
        const bExpiry = b.approval.expiresAtMs ?? Number.POSITIVE_INFINITY;
        if (aExpiry !== bExpiry) return aExpiry - bExpiry;
        return queueSortValue(b.approval) - queueSortValue(a.approval);
      }
      return queueSortValue(b.approval) - queueSortValue(a.approval);
    });

    return next;
  }, [rows, riskFilter, search, sortMode]);

  useEffect(() => {
    if (filteredRows.length === 0) {
      setSelectedApprovalId(null);
      return;
    }
    const selectedStillExists = filteredRows.some(
      (row) => row.approval.id === selectedApprovalId
    );
    if (!selectedStillExists) {
      setSelectedApprovalId(filteredRows[0].approval.id);
    }
  }, [filteredRows, selectedApprovalId]);

  const selectedRow = useMemo(
    () =>
      selectedApprovalId
        ? filteredRows.find((row) => row.approval.id === selectedApprovalId) ?? null
        : null,
    [filteredRows, selectedApprovalId]
  );

  const allowPatternPreview = useMemo(
    () =>
      selectedRow
        ? previewAllowlistPattern({
          pattern: allowPattern,
          targetPath: selectedRow.approval.resolvedPath,
          cwd: selectedRow.approval.cwd,
        })
        : null,
    [allowPattern, selectedRow]
  );

  const allowPatternSuggestions = useMemo(
    () => (selectedRow ? buildAllowlistPatternSuggestions(selectedRow.approval) : []),
    [selectedRow]
  );

  const allowPatternHistoryImpact = useMemo<PatternHistoryImpact | null>(() => {
    if (!selectedRow || !allowPatternPreview?.isValid) return null;

    const selectedAgent = selectedRow.approval.agentId || "main";
    const recent = sortHistory(history)
      .filter((entry) => (entry.agentId || "main") === selectedAgent)
      .slice(0, 40);

    let considered = 0;
    let matched = 0;
    let missingPath = 0;

    for (const entry of recent) {
      const targetPath = entry.resolvedPath?.trim();
      if (!targetPath) {
        missingPath += 1;
        continue;
      }
      considered += 1;
      const result = matchesAllowlistPattern({
        pattern: allowPatternPreview.normalizedPattern,
        targetPath,
        cwd: entry.cwd,
      });
      if (result) matched += 1;
    }

    return { considered, matched, missingPath };
  }, [allowPatternPreview, history, selectedRow]);

  const highRiskCount = useMemo(
    () => rows.filter((row) => row.risk.level === "HIGH" || row.risk.level === "CRITICAL").length,
    [rows]
  );

  const expiringSoonCount = useMemo(
    () =>
      rows.filter((row) => {
        if (!row.approval.expiresAtMs) return false;
        return row.approval.expiresAtMs - Date.now() <= 60_000;
      }).length,
    [rows]
  );

  const historyRows = useMemo(
    () =>
      sortHistory(history).map((approval) => ({
        approval,
        risk: assessApprovalRisk(approval.command),
      })),
    [history]
  );

  const connection = connectionBadge(connectionState);
  const pendingCount = approvals.length;

  const selectedRequiresStepUp = selectedRow?.risk.requiresStepUp ?? false;
  const selectedApprovalIdRequired = selectedRow?.approval.id ?? "";

  const selectedApproveEnabled =
    !!selectedRow &&
    reviewConfirmed &&
    (!selectedRequiresStepUp || stepUpText.trim() === selectedApprovalIdRequired) &&
    actionLoading !== selectedApprovalIdRequired;
  const selectedAllowPatternEnabled =
    !!selectedRow &&
    allowPatternPreview?.isValid === true &&
    reviewConfirmed &&
    (!selectedRequiresStepUp || stepUpText.trim() === selectedApprovalIdRequired) &&
    actionLoading !== selectedApprovalIdRequired;

  const openDecisionDialog = useCallback(
    (decision: ConfirmDialogState["decision"]) => {
      if (!selectedRow) return;
      if (decision === "allow-pattern") {
        const trimmed = allowPattern.trim();
        if (!trimmed) {
          setActionError("Provide an allowlist pattern first.");
          return;
        }
        if (!allowPatternPreview?.isValid || !isPathLikeAllowlistPattern(trimmed)) {
          setActionError("Allowlist pattern must include a path separator or ~.");
          return;
        }
      }
      setConfirmDialog({
        approval: selectedRow.approval,
        risk: selectedRow.risk,
        decision,
        pattern:
          decision === "allow-pattern"
            ? allowPatternPreview?.normalizedPattern ?? allowPattern.trim()
            : undefined,
        approveCurrent:
          decision === "allow-pattern" ? allowPatternApproveCurrent : undefined,
      });
    },
    [allowPattern, allowPatternApproveCurrent, allowPatternPreview, selectedRow]
  );

  const confirmPatternPreview = useMemo(() => {
    if (!confirmDialog || confirmDialog.decision !== "allow-pattern") return null;
    return previewAllowlistPattern({
      pattern: confirmDialog.pattern ?? "",
      targetPath: confirmDialog.approval.resolvedPath,
      cwd: confirmDialog.approval.cwd,
    });
  }, [confirmDialog]);

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      <div className="p-6 border-b border-border bg-card/30">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded bg-primary/10 flex items-center justify-center">
                <Shield className="w-5 h-5 text-primary" />
              </div>
              <div>
                <h2 className="text-xl font-bold">Execution Approvals</h2>
                <p className="text-sm text-muted-foreground">
                  Review command intent, execution context, and consequences before allowing agent execution.
                </p>
                <button
                  onClick={() => { window.location.hash = "board"; }}
                  className="mt-2 text-sm text-primary hover:text-primary/80 hover:underline flex items-center gap-1.5 transition-colors"
                >
                  <ListTodo className="h-4 w-4" />
                  View Tasks Board
                </button>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge className={cn("gap-1.5 px-3 py-1", connection.className)}>
                <Server className="w-3.5 h-3.5" />
                {connection.label}
              </Badge>
              <Badge variant="outline" className="gap-1.5 px-3 py-1">
                <Clock className="w-3.5 h-3.5" />
                {pendingCount} pending
              </Badge>
              <Button
                variant="outline"
                size="sm"
                onClick={() => fetchApprovals({ silent: true })}
                className="gap-1.5"
                disabled={refreshing}
              >
                <RefreshCw className={cn("w-3.5 h-3.5", refreshing && "animate-spin")} />
                Refresh
              </Button>
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <div className="glass-panel rounded-lg p-3 border border-border">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">
                High-risk queue
              </div>
              <div className="text-lg font-semibold">{highRiskCount}</div>
              <div className="text-xs text-muted-foreground">
                Requests rated high or critical.
              </div>
            </div>
            <div className="glass-panel rounded-lg p-3 border border-border">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">
                Expiring soon
              </div>
              <div className="text-lg font-semibold">{expiringSoonCount}</div>
              <div className="text-xs text-muted-foreground">
                Requests that may expire within 60 seconds.
              </div>
            </div>
            <div className="glass-panel rounded-lg p-3 border border-border">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">
                Last sync
              </div>
              <div className="text-sm font-semibold">
                {lastUpdatedAt ? formatRelativeTime(lastUpdatedAt) : "Not synced yet"}
              </div>
              <div className="text-xs text-muted-foreground">
                {lastUpdatedAt
                  ? formatAbsoluteTime(lastUpdatedAt)
                  : "Waiting for first response"}
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-2 md:flex-row">
            <div className="relative flex-1">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search by command, ID, agent, host, session, or path"
                maxLength={200}
                className="w-full h-9 rounded-md border border-border bg-background/50 pl-9 pr-3 text-sm outline-none focus:border-primary/40"
              />
            </div>
            <select
              value={riskFilter}
              onChange={(event) => setRiskFilter(event.target.value as RiskFilter)}
              className="h-9 rounded-md border border-border bg-background/50 px-3 text-sm outline-none focus:border-primary/40"
              aria-label="Filter by risk"
            >
              <option value="all">All risk levels</option>
              <option value="critical">Critical only</option>
              <option value="high">High only</option>
              <option value="medium">Medium only</option>
              <option value="low">Low only</option>
            </select>
            <select
              value={sortMode}
              onChange={(event) => setSortMode(event.target.value as SortMode)}
              className="h-9 rounded-md border border-border bg-background/50 px-3 text-sm outline-none focus:border-primary/40"
              aria-label="Sort approvals"
            >
              <option value="newest">Sort: Newest first</option>
              <option value="oldest">Sort: Oldest first</option>
              <option value="risk">Sort: Highest risk first</option>
              <option value="expiry">Sort: Expiry first</option>
            </select>
          </div>
        </div>
      </div>

      {(error || actionError || actionInfo) && (
        <div className="px-6 pt-4">
          {error && (
            <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-4 py-3 text-sm text-yellow-500 mb-2">
              {error}
            </div>
          )}
          {actionError && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
              {actionError}
            </div>
          )}
          {actionInfo && (
            <div className="rounded-lg border border-green-500/30 bg-green-500/10 px-4 py-3 text-sm text-green-500">
              {actionInfo}
            </div>
          )}
        </div>
      )}

      {loading && pendingCount === 0 && historyRows.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="w-6 h-6 animate-spin text-primary" />
        </div>
      ) : (
        <div className="flex-1 overflow-hidden grid grid-cols-1 xl:grid-cols-[420px_minmax(0,1fr)]">
          <div className="border-r border-border/70 min-h-0 flex flex-col">
            <div className="px-4 py-3 border-b border-border/70">
              <div className="text-sm font-semibold">Pending Queue</div>
              <div className="text-xs text-muted-foreground">
                {filteredRows.length} shown of {pendingCount} total
              </div>
            </div>
            <ScrollArea className="flex-1">
              <div className="p-4 space-y-3">
                {filteredRows.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-border p-6 text-center">
                    <ShieldCheck className="w-10 h-10 mx-auto mb-2 text-green-500/60" />
                    <p className="font-medium mb-1">No matching approvals</p>
                    <p className="text-xs text-muted-foreground">
                      Try adjusting search or risk filters, or wait for new requests.
                    </p>
                  </div>
                ) : (
                  filteredRows.map((row, index) => {
                    const style = RISK_CLASSES[row.risk.level];
                    const RiskIcon = style.icon;
                    const isSelected = selectedApprovalId === row.approval.id;
                    return (
                      <button
                        key={approvalListKey(row.approval, index)}
                        type="button"
                        onClick={() => setSelectedApprovalId(row.approval.id)}
                        className={cn(
                          "w-full text-left glass-panel rounded-lg p-4 border-l-4 transition-all",
                          style.panel,
                          isSelected
                            ? "ring-1 ring-primary/50 bg-primary/5"
                            : "hover:bg-accent/40"
                        )}
                      >
                        <div className="flex items-center justify-between gap-2 mb-2">
                          <Badge variant="outline" className={cn("text-[10px]", style.badge)}>
                            <RiskIcon className="w-3 h-3 mr-1" />
                            {row.risk.level}
                          </Badge>
                          <span className="text-[11px] text-muted-foreground">
                            {formatExpiry(row.approval.expiresAtMs)}
                          </span>
                        </div>
                        <pre className="font-mono text-xs rounded border border-border bg-muted/40 px-2 py-2 overflow-hidden whitespace-pre-wrap break-words">
                          {trimCommand(row.approval.command, 140)}
                        </pre>
                        <div className="mt-2 space-y-1 text-[11px] text-muted-foreground">
                          <div className="flex items-center gap-1.5">
                            <Bot className="w-3.5 h-3.5" />
                            Agent: {row.approval.agentId || "main"}
                          </div>
                          <div className="flex items-center gap-1.5">
                            <Clock className="w-3.5 h-3.5" />
                            Requested {formatRelativeTime(approvalCreatedMs(row.approval))}
                          </div>
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </ScrollArea>
          </div>

          <div className="min-h-0 flex flex-col">
            <ScrollArea className="flex-1">
              <div className="p-6 space-y-6">
                {selectedRow ? (
                  <>
                    <div
                      className={cn(
                        "glass-panel rounded-xl p-5 border border-border border-l-4",
                        RISK_CLASSES[selectedRow.risk.level].panel
                      )}
                    >
                      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                        <div>
                          <h3 className="text-lg font-semibold">Approval Review</h3>
                          <p className="text-sm text-muted-foreground mt-1">
                            Approval ID <span className="font-mono">{selectedRow.approval.id}</span>
                          </p>
                          <p className="text-sm text-muted-foreground">
                            Approving allows this command to execute for this approval request.
                          </p>
                        </div>
                        <Badge
                          variant="outline"
                          className={cn("text-xs", RISK_CLASSES[selectedRow.risk.level].badge)}
                        >
                          Risk Score {selectedRow.risk.score} / 100
                        </Badge>
                      </div>

                      <div className="mt-4">
                        <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1.5">
                          Command to execute
                        </div>
                        <pre className="rounded border border-border bg-muted/40 px-4 py-3 text-sm font-mono overflow-x-auto whitespace-pre-wrap break-words">
                          {selectedRow.approval.command}
                        </pre>
                      </div>

                      <div className="mt-4 grid gap-3 md:grid-cols-2 text-sm">
                        <div className="rounded-md border border-border bg-background/40 px-3 py-2">
                          <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">
                            Command profile
                          </div>
                          <div>
                            Primary executable: <span className="font-mono">{selectedRow.risk.primaryCommand}</span>
                          </div>
                          <div>Steps detected: {selectedRow.risk.stepCount}</div>
                        </div>
                        <div className="rounded-md border border-border bg-background/40 px-3 py-2">
                          <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">
                            Request timing
                          </div>
                          <div>Requested: {formatAbsoluteTime(approvalCreatedMs(selectedRow.approval))}</div>
                          <div>{formatExpiry(selectedRow.approval.expiresAtMs)}</div>
                        </div>
                      </div>
                    </div>

                    <div className="glass-panel rounded-xl p-5 border border-border">
                      <h4 className="text-base font-semibold mb-2">Consequence Assessment</h4>
                      <p className="text-sm text-muted-foreground mb-3">{selectedRow.risk.summary}</p>
                      <ul className="space-y-2">
                        {selectedRow.risk.consequences.map((item, index) => (
                          <li key={`${item}:${index}`} className="text-sm text-foreground flex gap-2">
                            <AlertTriangle className="w-4 h-4 mt-0.5 text-yellow-500 shrink-0" />
                            <span>{item}</span>
                          </li>
                        ))}
                      </ul>
                    </div>

                    <div className="glass-panel rounded-xl p-5 border border-border">
                      <h4 className="text-base font-semibold mb-3">Execution Context</h4>
                      <div className="grid gap-3 md:grid-cols-2 text-sm">
                        <div className="rounded-md border border-border bg-background/40 px-3 py-2">
                          <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">
                            Agent
                          </div>
                          <div>{selectedRow.approval.agentId || "main"}</div>
                        </div>
                        <div className="rounded-md border border-border bg-background/40 px-3 py-2">
                          <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">
                            Session key
                          </div>
                          <div className="font-mono break-all">
                            {selectedRow.approval.sessionKey || "-"}
                          </div>
                        </div>
                        <div className="rounded-md border border-border bg-background/40 px-3 py-2">
                          <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">
                            Host
                          </div>
                          <div>{selectedRow.approval.host || "-"}</div>
                        </div>
                        <div className="rounded-md border border-border bg-background/40 px-3 py-2">
                          <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">
                            Working directory
                          </div>
                          <div className="font-mono break-all">{selectedRow.approval.cwd || "-"}</div>
                        </div>
                        <div className="rounded-md border border-border bg-background/40 px-3 py-2">
                          <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">
                            Resolved path
                          </div>
                          <div className="font-mono break-all">
                            {selectedRow.approval.resolvedPath || "-"}
                          </div>
                        </div>
                        <div className="rounded-md border border-border bg-background/40 px-3 py-2">
                          <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">
                            Security / ask mode
                          </div>
                          <div>
                            {selectedRow.approval.security || "-"} / {selectedRow.approval.ask || "-"}
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="glass-panel rounded-xl p-5 border border-border">
                      <h4 className="text-base font-semibold mb-2">Decision Guardrail</h4>
                      <p className="text-sm text-muted-foreground mb-3">
                        Confirm that the command matches your intent. If approved, the agent can execute it with the context shown above.
                      </p>
                      <label className="flex items-start gap-2 text-sm mb-3">
                        <input
                          type="checkbox"
                          className="mt-1"
                          checked={reviewConfirmed}
                          onChange={(event) => setReviewConfirmed(event.target.checked)}
                        />
                        <span>
                          I reviewed command text, working directory, and consequence analysis.
                        </span>
                      </label>

                      {selectedRequiresStepUp && (
                        <div className="rounded-md border border-orange-500/30 bg-orange-500/10 px-3 py-3 mb-3">
                          <div className="text-sm font-medium text-orange-500 mb-1">
                            Additional confirmation required for {selectedRow.risk.level.toLowerCase()} risk.
                          </div>
                          <p className="text-xs text-muted-foreground mb-2">
                            Type the approval ID to unlock the approve action:{" "}
                            <span className="font-mono">{selectedApprovalIdRequired}</span>
                          </p>
                          <input
                            value={stepUpText}
                            onChange={(event) => setStepUpText(event.target.value)}
                            className="w-full h-9 rounded border border-border bg-background/70 px-3 text-sm outline-none focus:border-primary/40"
                            placeholder="Type approval ID exactly"
                            maxLength={200}
                          />
                        </div>
                      )}

                      <div className="rounded-md border border-border bg-background/40 px-3 py-3 mb-3">
                        <div className="text-sm font-medium mb-1">
                          Always allow this executable pattern
                        </div>
                        <p className="text-xs text-muted-foreground mb-2">
                          Adds a persistent allowlist rule for this agent. Supports
                          glob patterns like <span className="font-mono">/usr/bin/*</span>{" "}
                          and <span className="font-mono">**/node</span>.
                        </p>
                        {allowPatternSuggestions.length > 0 && (
                          <div className="flex flex-wrap gap-2 mb-2">
                            {allowPatternSuggestions.map((suggestion) => (
                              <button
                                key={suggestion.value}
                                type="button"
                                className="rounded border border-border bg-background/70 px-2 py-1 text-[11px] hover:bg-accent/40"
                                onClick={() => setAllowPattern(suggestion.value)}
                                title={suggestion.description}
                              >
                                {suggestion.label}
                              </button>
                            ))}
                          </div>
                        )}
                        <input
                          value={allowPattern}
                          onChange={(event) => setAllowPattern(event.target.value)}
                          className="w-full h-9 rounded border border-border bg-background/70 px-3 text-sm outline-none focus:border-primary/40 mb-2"
                          placeholder="Example: /usr/local/bin/node"
                          maxLength={500}
                        />
                        {allowPatternPreview && allowPattern.trim().length > 0 && (
                          <div className="rounded border border-border bg-background/60 px-3 py-2 mb-2">
                            <div className="flex flex-wrap items-center gap-2 mb-1.5">
                              <Badge
                                variant="outline"
                                className={cn(
                                  "text-[10px] px-2 py-0.5",
                                  PATTERN_SCOPE_CLASSES[allowPatternPreview.scope]
                                )}
                              >
                                {allowPatternPreview.scopeLabel}
                              </Badge>
                              <span className="text-[11px] text-muted-foreground">
                                Wildcards: {allowPatternPreview.wildcardCount}
                              </span>
                              {allowPatternPreview.matchesTarget !== null && (
                                <span
                                  className={cn(
                                    "text-[11px]",
                                    allowPatternPreview.matchesTarget
                                      ? "text-green-500"
                                      : "text-yellow-500"
                                  )}
                                >
                                  {allowPatternPreview.matchesTarget
                                    ? "Matches current executable"
                                    : "Does not match current executable"}
                                </span>
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground mb-1">
                              {allowPatternPreview.scopeDescription}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {allowPatternPreview.matchSummary}
                            </p>
                            {allowPatternHistoryImpact && (
                              <p className="text-xs text-muted-foreground mt-1">
                                Would have matched {allowPatternHistoryImpact.matched} of{" "}
                                {allowPatternHistoryImpact.considered} recent resolved requests for
                                this agent with known executable paths.
                                {allowPatternHistoryImpact.missingPath > 0 && (
                                  <>
                                    {" "}
                                    {allowPatternHistoryImpact.missingPath} more had no path data.
                                  </>
                                )}
                              </p>
                            )}
                          </div>
                        )}
                        <label className="flex items-start gap-2 text-xs text-muted-foreground">
                          <input
                            type="checkbox"
                            className="mt-0.5"
                            checked={allowPatternApproveCurrent}
                            onChange={(event) =>
                              setAllowPatternApproveCurrent(event.target.checked)
                            }
                          />
                          <span>Approve current request after saving this pattern.</span>
                        </label>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          variant="outline"
                          onClick={() => openDecisionDialog("reject")}
                          disabled={actionLoading === selectedApprovalIdRequired}
                          className="gap-1.5 text-red-400 border-red-400/20 hover:bg-red-400/10"
                        >
                          <XCircle className="w-4 h-4" />
                          Reject command
                        </Button>
                        <Button
                          onClick={() => openDecisionDialog("approve")}
                          disabled={!selectedApproveEnabled}
                          className="gap-1.5 bg-green-600 hover:bg-green-700 text-white"
                        >
                          <CheckCircle2 className="w-4 h-4" />
                          Approve and execute
                        </Button>
                        <Button
                          variant="outline"
                          onClick={() => openDecisionDialog("allow-pattern")}
                          disabled={!selectedAllowPatternEnabled}
                          className="gap-1.5"
                        >
                          <ShieldCheck className="w-4 h-4" />
                          Always allow pattern
                        </Button>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="glass-panel rounded-xl p-8 border border-border text-center">
                    <ShieldCheck className="w-12 h-12 mx-auto mb-3 text-green-500/70" />
                    <h3 className="text-lg font-semibold mb-1">Queue clear</h3>
                    <p className="text-sm text-muted-foreground">
                      No pending approvals match current filters.
                    </p>
                  </div>
                )}

                {historyRows.length > 0 && (
                  <div className="glass-panel rounded-xl p-5 border border-border">
                    <h4 className="text-base font-semibold mb-3">Decision History</h4>
                    <div className="space-y-2">
                      {historyRows.slice(0, 30).map((row, index) => {
                        const decisionLabel = approvalDecisionLabel(row.approval);
                        const approved =
                          isApprovalApproved(row.approval.decision) ||
                          isApprovalApproved(row.approval.status);
                        const rejected =
                          isApprovalRejected(row.approval.decision) ||
                          isApprovalRejected(row.approval.status);
                        return (
                          <div
                            key={`${row.approval.id}-${approvalResolvedMs(row.approval)}-${index}`}
                            className="rounded-md border border-border bg-background/40 px-3 py-2"
                          >
                            <div className="flex items-center gap-2 mb-1">
                              {approved ? (
                                <CheckCircle2 className="w-4 h-4 text-green-500" />
                              ) : rejected ? (
                                <XCircle className="w-4 h-4 text-red-400" />
                              ) : (
                                <Clock className="w-4 h-4 text-muted-foreground" />
                              )}
                              <span className="text-sm font-medium">{decisionLabel}</span>
                              <Badge
                                variant="outline"
                                className={cn("ml-auto text-[10px]", RISK_CLASSES[row.risk.level].badge)}
                              >
                                {row.risk.level}
                              </Badge>
                            </div>
                            <div className="font-mono text-xs break-words mb-1">
                              {trimCommand(row.approval.command, 200)}
                            </div>
                            <div className="text-[11px] text-muted-foreground flex flex-wrap gap-3">
                              <span>Agent: {row.approval.agentId || "main"}</span>
                              <span>At: {formatAbsoluteTime(approvalResolvedMs(row.approval))}</span>
                              {row.approval.resolvedBy && (
                                <span>By: {row.approval.resolvedBy}</span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            </ScrollArea>
          </div>
        </div>
      )}

      <Dialog
        open={!!confirmDialog}
        onOpenChange={(open) => {
          if (!open) setConfirmDialog(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirmDialog?.decision === "approve"
                ? "Approve this execution request?"
                : confirmDialog?.decision === "allow-pattern"
                  ? "Always allow this pattern?"
                  : "Reject this execution request?"}
            </DialogTitle>
            <DialogDescription>
              {confirmDialog?.decision === "approve"
                ? "Approval allows the command below to run for this request ID."
                : confirmDialog?.decision === "allow-pattern"
                  ? "This writes a persistent allowlist rule and can optionally approve this pending request."
                  : "Rejection blocks the command and returns a denial to the agent."}
            </DialogDescription>
          </DialogHeader>

          {confirmDialog && (
            <div className="space-y-3">
              <div className="rounded border border-border bg-muted/40 px-3 py-2 text-xs">
                <div>
                  Request ID: <span className="font-mono">{confirmDialog.approval.id}</span>
                </div>
                <div>
                  Risk:{" "}
                  <span className="font-medium">
                    {confirmDialog.risk.level} ({confirmDialog.risk.score}/100)
                  </span>
                </div>
              </div>
              <pre className="bg-muted/50 rounded border border-border px-4 py-3 text-sm font-mono overflow-x-auto whitespace-pre-wrap break-words">
                {confirmDialog.approval.command}
              </pre>
              <div className="rounded border border-border bg-background/40 px-3 py-2">
                <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
                  Primary consequence
                </div>
                <div className="text-sm">
                  {confirmDialog.risk.consequences[0] ||
                    "This command executes on the configured host and may change state."}
                </div>
              </div>
              {confirmDialog.decision === "allow-pattern" && (
                <div className="rounded border border-border bg-background/40 px-3 py-2 text-sm">
                  <div>
                    Pattern:{" "}
                    <span className="font-mono">{confirmDialog.pattern || "-"}</span>
                  </div>
                  {confirmPatternPreview && (
                    <div className="text-xs text-muted-foreground mt-1">
                      Scope: {confirmPatternPreview.scopeLabel}.{" "}
                      {confirmPatternPreview.matchSummary}
                    </div>
                  )}
                  <div>
                    Approve current request:{" "}
                    {confirmDialog.approveCurrent === false ? "No" : "Yes"}
                  </div>
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDialog(null)}>
              Cancel
            </Button>
            <Button
              onClick={async () => {
                if (!confirmDialog) return;
                const ok =
                  confirmDialog.decision === "allow-pattern"
                    ? await allowPatternForApproval(
                      confirmDialog.approval,
                      confirmDialog.pattern || "",
                      confirmDialog.approveCurrent !== false
                    )
                    : await resolveApproval(
                      confirmDialog.approval,
                      confirmDialog.decision
                    );
                if (ok) setConfirmDialog(null);
              }}
              disabled={actionLoading === confirmDialog?.approval.id}
              className={
                confirmDialog?.decision === "approve"
                  ? "bg-green-600 hover:bg-green-700"
                  : confirmDialog?.decision === "allow-pattern"
                    ? "bg-primary hover:bg-primary/90"
                    : "bg-red-500 hover:bg-red-600"
              }
            >
              {actionLoading === confirmDialog?.approval.id ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : confirmDialog?.decision === "approve" ? (
                "Approve execution"
              ) : confirmDialog?.decision === "allow-pattern" ? (
                "Save allowlist pattern"
              ) : (
                "Reject execution"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
