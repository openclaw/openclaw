import { Shield, ShieldAlert, ShieldCheck, ShieldX, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

type ThreatBreakdown = {
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
};

type SecurityStatus = {
  totalScans: number;
  blockedCount: number;
  allowedCount: number;
  threatBreakdown: ThreatBreakdown;
  lastScanAt: string | null;
};

const threatLevelColors: Record<string, string> = {
  critical: "var(--accent-red)",
  high: "var(--accent-orange)",
  medium: "var(--accent-blue)",
  low: "var(--accent-green)",
  info: "var(--accent-purple)",
};

export function SecurityDashboard() {
  const [status, setStatus] = useState<SecurityStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function fetchStatus() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/mabos/security/status");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: SecurityStatus = await res.json();
      setStatus(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch security status");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchStatus();
  }, []);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i} className="bg-[var(--bg-card)] border-[var(--border-mabos)] py-4">
              <CardContent className="flex items-center gap-4">
                <Skeleton className="h-10 w-10 rounded-lg" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="h-6 w-12" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <Card className="bg-[var(--bg-card)] border-[var(--border-mabos)] p-6">
        <p className="text-[var(--accent-red)] text-sm">{error}</p>
        <button
          onClick={fetchStatus}
          className="mt-3 flex items-center gap-2 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
        >
          <RefreshCw className="w-3 h-3" /> Retry
        </button>
      </Card>
    );
  }

  if (!status) return null;

  const statCards = [
    {
      key: "total-scans",
      label: "Total Scans",
      value: status.totalScans.toLocaleString(),
      subtitle: status.lastScanAt
        ? `Last: ${new Date(status.lastScanAt).toLocaleString()}`
        : "No scans yet",
      icon: Shield,
      color: "var(--accent-blue)",
    },
    {
      key: "blocked",
      label: "Blocked",
      value: status.blockedCount.toLocaleString(),
      subtitle: `${status.totalScans > 0 ? Math.round((status.blockedCount / status.totalScans) * 100) : 0}% block rate`,
      icon: ShieldX,
      color: "var(--accent-red)",
    },
    {
      key: "allowed",
      label: "Allowed",
      value: status.allowedCount.toLocaleString(),
      subtitle: "Passed all checks",
      icon: ShieldCheck,
      color: "var(--accent-green)",
    },
    {
      key: "threats",
      label: "Active Threats",
      value: (status.threatBreakdown.critical + status.threatBreakdown.high).toLocaleString(),
      subtitle: "Critical + High",
      icon: ShieldAlert,
      color: "var(--accent-orange)",
    },
  ];

  const breakdownEntries = Object.entries(status.threatBreakdown) as [string, number][];
  const maxCount = Math.max(...breakdownEntries.map(([, v]) => v), 1);

  return (
    <div className="space-y-6">
      {/* Stats row */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {statCards.map((card) => {
          const Icon = card.icon;
          return (
            <Card
              key={card.key}
              className="bg-[var(--bg-card)] border-[var(--border-mabos)] hover:border-[var(--border-hover)] transition-colors py-4"
            >
              <CardContent className="flex items-center gap-4">
                <div
                  className="flex items-center justify-center w-10 h-10 rounded-lg"
                  style={{ backgroundColor: `color-mix(in srgb, ${card.color} 15%, transparent)` }}
                >
                  <Icon className="w-5 h-5" style={{ color: card.color }} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider">
                    {card.label}
                  </p>
                  <p className="text-2xl font-bold text-[var(--text-primary)] mt-0.5">
                    {card.value}
                  </p>
                  <p className="text-xs text-[var(--text-secondary)] mt-0.5 truncate">
                    {card.subtitle}
                  </p>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Threat breakdown */}
      <Card className="bg-[var(--bg-card)] border-[var(--border-mabos)] p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">Threat Breakdown</h3>
          <button
            onClick={fetchStatus}
            className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
          >
            <RefreshCw className="w-3 h-3" /> Refresh
          </button>
        </div>
        <div className="space-y-3">
          {breakdownEntries.map(([level, count]) => {
            const color = threatLevelColors[level] ?? "var(--text-muted)";
            const pct = maxCount > 0 ? (count / maxCount) * 100 : 0;
            return (
              <div key={level} className="flex items-center gap-3">
                <span className="text-xs font-medium w-16 capitalize" style={{ color }}>
                  {level}
                </span>
                <div className="flex-1 h-2 rounded-full bg-[var(--bg-secondary)]">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{ width: `${pct}%`, backgroundColor: color }}
                  />
                </div>
                <span className="text-xs text-[var(--text-secondary)] w-8 text-right font-mono">
                  {count}
                </span>
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}
