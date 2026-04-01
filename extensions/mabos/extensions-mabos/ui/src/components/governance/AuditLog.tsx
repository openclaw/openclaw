import { FileText, Search, RefreshCw } from "lucide-react";
import { useEffect, useState, useMemo } from "react";

type AuditEntry = {
  id: string;
  timestamp: string;
  actor: string;
  action: string;
  resource: string;
  outcome: "success" | "denied" | "error";
  detail?: string;
};

const outcomeStyles: Record<string, { color: string; bg: string }> = {
  success: {
    color: "var(--accent-green)",
    bg: "color-mix(in srgb, var(--accent-green) 15%, transparent)",
  },
  denied: {
    color: "var(--accent-red)",
    bg: "color-mix(in srgb, var(--accent-red) 15%, transparent)",
  },
  error: {
    color: "var(--accent-orange)",
    bg: "color-mix(in srgb, var(--accent-orange) 15%, transparent)",
  },
};

const OUTCOME_OPTIONS = ["all", "success", "denied", "error"] as const;

export function AuditLog() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [outcomeFilter, setOutcomeFilter] = useState<string>("all");

  const fetchAudit = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/mabos/governance/audit?limit=50");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setEntries(Array.isArray(json) ? json : (json.entries ?? []));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load audit log");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAudit();
  }, []);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return entries.filter((e) => {
      if (outcomeFilter !== "all" && e.outcome !== outcomeFilter) return false;
      if (q) {
        return (
          e.actor.toLowerCase().includes(q) ||
          e.action.toLowerCase().includes(q) ||
          e.resource.toLowerCase().includes(q) ||
          (e.detail?.toLowerCase().includes(q) ?? false)
        );
      }
      return true;
    });
  }, [entries, search, outcomeFilter]);

  return (
    <div
      className="rounded-lg border p-5 space-y-4"
      style={{
        backgroundColor: "var(--bg-card)",
        borderColor: "var(--border-mabos)",
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div
            className="flex items-center justify-center w-8 h-8 rounded-lg"
            style={{ backgroundColor: "color-mix(in srgb, var(--accent-purple) 15%, transparent)" }}
          >
            <FileText className="w-4 h-4" style={{ color: "var(--accent-purple)" }} />
          </div>
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">Audit Log</h3>
        </div>
        <button
          type="button"
          onClick={fetchAudit}
          disabled={loading}
          className="p-1.5 rounded-md hover:bg-[var(--bg-tertiary)] transition-colors disabled:opacity-50"
          title="Refresh"
        >
          <RefreshCw
            className={`w-4 h-4 text-[var(--text-muted)] ${loading ? "animate-spin" : ""}`}
          />
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-2.5 w-3.5 h-3.5 text-[var(--text-muted)]" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search actor, action, resource..."
            className="w-full pl-8 pr-3 py-2 text-xs rounded-md border bg-[var(--bg-secondary)] border-[var(--border-mabos)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-blue)]"
          />
        </div>
        <select
          value={outcomeFilter}
          onChange={(e) => setOutcomeFilter(e.target.value)}
          className="px-3 py-2 text-xs rounded-md border bg-[var(--bg-secondary)] border-[var(--border-mabos)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-blue)]"
        >
          {OUTCOME_OPTIONS.map((opt) => (
            <option key={opt} value={opt}>
              {opt === "all" ? "All Outcomes" : opt.charAt(0).toUpperCase() + opt.slice(1)}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <p className="text-xs text-[var(--accent-red)] bg-[var(--bg-tertiary)] rounded-md px-3 py-2">
          {error}
        </p>
      )}

      {/* Loading */}
      {loading && (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div
              key={i}
              className="h-8 rounded-md animate-pulse"
              style={{ backgroundColor: "var(--bg-tertiary)" }}
            />
          ))}
        </div>
      )}

      {/* Table */}
      {!loading && filtered.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b text-left" style={{ borderColor: "var(--border-mabos)" }}>
                <th className="pb-2 pr-4 font-medium text-[var(--text-muted)]">Timestamp</th>
                <th className="pb-2 pr-4 font-medium text-[var(--text-muted)]">Actor</th>
                <th className="pb-2 pr-4 font-medium text-[var(--text-muted)]">Action</th>
                <th className="pb-2 pr-4 font-medium text-[var(--text-muted)]">Resource</th>
                <th className="pb-2 font-medium text-[var(--text-muted)]">Outcome</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((entry) => {
                const style = outcomeStyles[entry.outcome] ?? outcomeStyles.error;
                return (
                  <tr
                    key={entry.id}
                    className="border-b last:border-b-0"
                    style={{ borderColor: "var(--border-mabos)" }}
                  >
                    <td className="py-2 pr-4 text-[var(--text-secondary)] whitespace-nowrap">
                      {new Date(entry.timestamp).toLocaleString()}
                    </td>
                    <td className="py-2 pr-4 text-[var(--text-primary)] font-medium">
                      {entry.actor}
                    </td>
                    <td className="py-2 pr-4 text-[var(--text-secondary)]">{entry.action}</td>
                    <td className="py-2 pr-4 text-[var(--text-secondary)] font-mono">
                      {entry.resource}
                    </td>
                    <td className="py-2">
                      <span
                        className="inline-block px-2 py-0.5 rounded-full text-xs font-medium"
                        style={{ color: style.color, backgroundColor: style.bg }}
                      >
                        {entry.outcome}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Empty state */}
      {!loading && filtered.length === 0 && !error && (
        <p className="text-sm text-center text-[var(--text-muted)] py-6">
          {entries.length === 0 ? "No audit entries" : "No entries match filters"}
        </p>
      )}
    </div>
  );
}
