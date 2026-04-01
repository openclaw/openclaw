import { TrendingUp, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

type CostEvent = {
  id: string;
  timestamp: string;
  amount: number;
  model: string;
  agentId: string;
  agentName?: string;
};

export function CostTimeline() {
  const [events, setEvents] = useState<CostEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchCosts = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/mabos/governance/costs?limit=100");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setEvents(Array.isArray(json) ? json : (json.events ?? []));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load cost data");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCosts();
  }, []);

  // Compute SVG mini chart data
  const chartHeight = 120;
  const chartWidth = 600;
  const maxAmount = events.length > 0 ? Math.max(...events.map((e) => e.amount), 0.01) : 1;

  const points = events.map((e, i) => {
    const x = events.length > 1 ? (i / (events.length - 1)) * chartWidth : chartWidth / 2;
    const y = chartHeight - (e.amount / maxAmount) * (chartHeight - 10) - 5;
    return { x, y, event: e };
  });

  const linePath = points.length > 1 ? `M ${points.map((p) => `${p.x},${p.y}`).join(" L ")}` : "";

  const areaPath =
    points.length > 1
      ? `${linePath} L ${points[points.length - 1].x},${chartHeight} L ${points[0].x},${chartHeight} Z`
      : "";

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
            style={{ backgroundColor: "color-mix(in srgb, var(--accent-blue) 15%, transparent)" }}
          >
            <TrendingUp className="w-4 h-4" style={{ color: "var(--accent-blue)" }} />
          </div>
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">Cost Timeline</h3>
        </div>
        <button
          type="button"
          onClick={fetchCosts}
          disabled={loading}
          className="p-1.5 rounded-md hover:bg-[var(--bg-tertiary)] transition-colors disabled:opacity-50"
          title="Refresh"
        >
          <RefreshCw
            className={`w-4 h-4 text-[var(--text-muted)] ${loading ? "animate-spin" : ""}`}
          />
        </button>
      </div>

      {error && (
        <p className="text-xs text-[var(--accent-red)] bg-[var(--bg-tertiary)] rounded-md px-3 py-2">
          {error}
        </p>
      )}

      {/* SVG mini chart */}
      {!loading && events.length > 1 && (
        <div className="w-full overflow-x-auto">
          <svg
            viewBox={`0 0 ${chartWidth} ${chartHeight}`}
            className="w-full"
            style={{ maxHeight: chartHeight }}
            preserveAspectRatio="none"
          >
            {/* Area fill */}
            <path d={areaPath} fill="var(--accent-blue)" opacity={0.1} />
            {/* Line */}
            <path
              d={linePath}
              fill="none"
              stroke="var(--accent-blue)"
              strokeWidth={2}
              strokeLinejoin="round"
            />
            {/* Dots */}
            {points.map((p, i) => (
              <circle key={i} cx={p.x} cy={p.y} r={3} fill="var(--accent-blue)" opacity={0.7}>
                <title>
                  {new Date(p.event.timestamp).toLocaleString()} — ${p.event.amount.toFixed(4)}
                </title>
              </circle>
            ))}
          </svg>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div
          className="h-[120px] rounded-md animate-pulse"
          style={{ backgroundColor: "var(--bg-tertiary)" }}
        />
      )}

      {/* Empty state */}
      {!loading && events.length === 0 && !error && (
        <p className="text-sm text-center text-[var(--text-muted)] py-6">No cost events recorded</p>
      )}

      {/* Table fallback / detail */}
      {!loading && events.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b text-left" style={{ borderColor: "var(--border-mabos)" }}>
                <th className="pb-2 pr-4 font-medium text-[var(--text-muted)]">Date</th>
                <th className="pb-2 pr-4 font-medium text-[var(--text-muted)]">Amount</th>
                <th className="pb-2 pr-4 font-medium text-[var(--text-muted)]">Model</th>
                <th className="pb-2 font-medium text-[var(--text-muted)]">Agent</th>
              </tr>
            </thead>
            <tbody>
              {events.slice(0, 20).map((e) => (
                <tr
                  key={e.id}
                  className="border-b last:border-b-0"
                  style={{ borderColor: "var(--border-mabos)" }}
                >
                  <td className="py-2 pr-4 text-[var(--text-secondary)]">
                    {new Date(e.timestamp).toLocaleString()}
                  </td>
                  <td className="py-2 pr-4 font-mono text-[var(--text-primary)]">
                    ${e.amount.toFixed(4)}
                  </td>
                  <td className="py-2 pr-4 text-[var(--text-secondary)]">{e.model}</td>
                  <td className="py-2 text-[var(--text-secondary)]">{e.agentName ?? e.agentId}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {events.length > 20 && (
            <p className="text-xs text-[var(--text-muted)] mt-2 text-center">
              Showing 20 of {events.length} events
            </p>
          )}
        </div>
      )}
    </div>
  );
}
