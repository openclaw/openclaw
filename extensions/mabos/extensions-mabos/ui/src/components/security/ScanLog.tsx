import { ScanSearch, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

type ScanEvent = {
  id: string;
  timestamp: string;
  toolName: string;
  patternDetected: string;
  threatLevel: "critical" | "high" | "medium" | "low" | "info";
  status: "blocked" | "allowed";
};

const threatColors: Record<string, string> = {
  critical: "var(--accent-red)",
  high: "var(--accent-orange)",
  medium: "var(--accent-blue)",
  low: "var(--accent-green)",
  info: "var(--accent-purple)",
};

export function ScanLog() {
  const [events, setEvents] = useState<ScanEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function fetchLog() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/mabos/security/scan-log");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: ScanEvent[] = await res.json();
      setEvents(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch scan log");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchLog();
  }, []);

  if (loading) {
    return (
      <Card className="bg-[var(--bg-card)] border-[var(--border-mabos)] p-4">
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-40 flex-1" />
              <Skeleton className="h-5 w-16 rounded-full" />
              <Skeleton className="h-5 w-16 rounded-full" />
            </div>
          ))}
        </div>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="bg-[var(--bg-card)] border-[var(--border-mabos)] p-6">
        <p className="text-[var(--accent-red)] text-sm">{error}</p>
        <button
          onClick={fetchLog}
          className="mt-3 flex items-center gap-2 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
        >
          <RefreshCw className="w-3 h-3" /> Retry
        </button>
      </Card>
    );
  }

  if (events.length === 0) {
    return (
      <Card className="bg-[var(--bg-card)] border-[var(--border-mabos)] p-6 text-center">
        <ScanSearch className="w-8 h-8 mx-auto mb-2 text-[var(--text-muted)]" />
        <p className="text-sm text-[var(--text-secondary)]">No scan events recorded</p>
      </Card>
    );
  }

  return (
    <Card className="bg-[var(--bg-card)] border-[var(--border-mabos)] overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-mabos)]">
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">Injection Scan Log</h3>
        <button
          onClick={fetchLog}
          className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
        >
          <RefreshCw className="w-3 h-3" /> Refresh
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-[var(--border-mabos)]">
              <th className="text-left px-4 py-2 font-medium text-[var(--text-muted)] uppercase tracking-wider">
                Timestamp
              </th>
              <th className="text-left px-4 py-2 font-medium text-[var(--text-muted)] uppercase tracking-wider">
                Tool
              </th>
              <th className="text-left px-4 py-2 font-medium text-[var(--text-muted)] uppercase tracking-wider">
                Pattern Detected
              </th>
              <th className="text-left px-4 py-2 font-medium text-[var(--text-muted)] uppercase tracking-wider">
                Threat
              </th>
              <th className="text-left px-4 py-2 font-medium text-[var(--text-muted)] uppercase tracking-wider">
                Status
              </th>
            </tr>
          </thead>
          <tbody>
            {events.map((evt) => {
              const color = threatColors[evt.threatLevel] ?? "var(--text-muted)";
              const isBlocked = evt.status === "blocked";
              return (
                <tr
                  key={evt.id}
                  className="border-b border-[var(--border-mabos)] last:border-b-0 hover:bg-[var(--bg-secondary)] transition-colors"
                >
                  <td className="px-4 py-2.5 text-[var(--text-secondary)] whitespace-nowrap font-mono">
                    {new Date(evt.timestamp).toLocaleString()}
                  </td>
                  <td className="px-4 py-2.5 text-[var(--text-primary)] font-medium whitespace-nowrap">
                    {evt.toolName}
                  </td>
                  <td className="px-4 py-2.5 text-[var(--text-secondary)] max-w-[300px] truncate">
                    {evt.patternDetected}
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    <span
                      className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold capitalize"
                      style={{
                        backgroundColor: `color-mix(in srgb, ${color} 15%, transparent)`,
                        color,
                      }}
                    >
                      {evt.threatLevel}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    <span
                      className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold capitalize"
                      style={{
                        backgroundColor: isBlocked
                          ? "color-mix(in srgb, var(--accent-red) 15%, transparent)"
                          : "color-mix(in srgb, var(--accent-green) 15%, transparent)",
                        color: isBlocked ? "var(--accent-red)" : "var(--accent-green)",
                      }}
                    >
                      {evt.status}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
