import { ShieldCheck, ShieldX, Clock, RefreshCw, Loader2 } from "lucide-react";
import { useEffect, useState, useCallback } from "react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

type ApprovalRequest = {
  id: string;
  toolName: string;
  agentRole: string;
  reason: string;
  timestamp: string;
  status: "pending" | "approved" | "denied";
};

export function ApprovalQueue() {
  const [requests, setRequests] = useState<ApprovalRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actioning, setActioning] = useState<Set<string>>(new Set());

  const fetchApprovals = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/mabos/security/approvals");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: ApprovalRequest[] = await res.json();
      setRequests(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch approvals");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchApprovals();
  }, [fetchApprovals]);

  async function handleAction(id: string, action: "approve" | "deny") {
    setActioning((prev) => new Set(prev).add(id));
    try {
      const res = await fetch(`/mabos/security/approvals/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Update local state
      setRequests((prev) =>
        prev.map((r) =>
          r.id === id ? { ...r, status: action === "approve" ? "approved" : "denied" } : r,
        ),
      );
    } catch {
      // Refetch on failure to show correct state
      await fetchApprovals();
    } finally {
      setActioning((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  if (loading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i} className="bg-[var(--bg-card)] border-[var(--border-mabos)] p-4">
            <div className="flex items-start gap-4">
              <Skeleton className="h-8 w-8 rounded-lg shrink-0" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-60" />
                <Skeleton className="h-3 w-32" />
              </div>
            </div>
          </Card>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <Card className="bg-[var(--bg-card)] border-[var(--border-mabos)] p-6">
        <p className="text-[var(--accent-red)] text-sm">{error}</p>
        <button
          onClick={fetchApprovals}
          className="mt-3 flex items-center gap-2 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
        >
          <RefreshCw className="w-3 h-3" /> Retry
        </button>
      </Card>
    );
  }

  const pending = requests.filter((r) => r.status === "pending");
  const resolved = requests.filter((r) => r.status !== "pending");

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">
          Pending Approvals
          {pending.length > 0 && (
            <Badge variant="destructive" className="ml-2 text-[10px]">
              {pending.length}
            </Badge>
          )}
        </h3>
        <button
          onClick={fetchApprovals}
          className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
        >
          <RefreshCw className="w-3 h-3" /> Refresh
        </button>
      </div>

      {pending.length === 0 && (
        <Card className="bg-[var(--bg-card)] border-[var(--border-mabos)] p-6 text-center">
          <ShieldCheck className="w-8 h-8 mx-auto mb-2 text-[var(--accent-green)]" />
          <p className="text-sm text-[var(--text-secondary)]">No pending approvals</p>
        </Card>
      )}

      {pending.map((req) => {
        const isActioning = actioning.has(req.id);
        return (
          <Card
            key={req.id}
            className="bg-[var(--bg-card)] border-[var(--border-mabos)] hover:border-[var(--border-hover)] transition-colors p-4"
          >
            <div className="flex items-start gap-3">
              <div
                className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0 mt-0.5"
                style={{
                  backgroundColor: "color-mix(in srgb, var(--accent-orange) 15%, transparent)",
                }}
              >
                <Clock className="w-4 h-4" style={{ color: "var(--accent-orange)" }} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold text-[var(--text-primary)]">
                    {req.toolName}
                  </span>
                  <Badge variant="outline" className="text-[10px]">
                    {req.agentRole}
                  </Badge>
                </div>
                <p className="text-xs text-[var(--text-secondary)] mt-1">{req.reason}</p>
                <p className="text-[10px] text-[var(--text-muted)] mt-1">
                  {new Date(req.timestamp).toLocaleString()}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  disabled={isActioning}
                  onClick={() => handleAction(req.id, "approve")}
                  className="flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
                  style={{
                    backgroundColor: "color-mix(in srgb, var(--accent-green) 15%, transparent)",
                    color: "var(--accent-green)",
                  }}
                >
                  {isActioning ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <ShieldCheck className="w-3 h-3" />
                  )}
                  Approve
                </button>
                <button
                  disabled={isActioning}
                  onClick={() => handleAction(req.id, "deny")}
                  className="flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
                  style={{
                    backgroundColor: "color-mix(in srgb, var(--accent-red) 15%, transparent)",
                    color: "var(--accent-red)",
                  }}
                >
                  {isActioning ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <ShieldX className="w-3 h-3" />
                  )}
                  Deny
                </button>
              </div>
            </div>
          </Card>
        );
      })}

      {/* Resolved items */}
      {resolved.length > 0 && (
        <details className="mt-4">
          <summary className="text-xs font-medium text-[var(--text-muted)] cursor-pointer hover:text-[var(--text-secondary)] transition-colors">
            {resolved.length} resolved request{resolved.length !== 1 ? "s" : ""}
          </summary>
          <div className="mt-2 space-y-2">
            {resolved.map((req) => (
              <Card
                key={req.id}
                className="bg-[var(--bg-card)] border-[var(--border-mabos)] p-3 opacity-60"
              >
                <div className="flex items-center gap-3">
                  <span className="text-xs font-medium text-[var(--text-primary)]">
                    {req.toolName}
                  </span>
                  <Badge variant="outline" className="text-[10px]">
                    {req.agentRole}
                  </Badge>
                  <Badge
                    className="text-[10px] ml-auto"
                    style={{
                      backgroundColor:
                        req.status === "approved"
                          ? "color-mix(in srgb, var(--accent-green) 15%, transparent)"
                          : "color-mix(in srgb, var(--accent-red) 15%, transparent)",
                      color:
                        req.status === "approved" ? "var(--accent-green)" : "var(--accent-red)",
                    }}
                  >
                    {req.status}
                  </Badge>
                </div>
              </Card>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
