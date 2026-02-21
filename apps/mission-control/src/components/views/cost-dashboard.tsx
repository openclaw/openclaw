"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  DollarSign,
  TrendingUp,
  Minus,
  RefreshCw,
  Loader2,
  BarChart3,
  Clock3,
  Database,
  AlertTriangle,
  MessageSquare,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  useGatewayConnectionState,
  useGatewayEvents,
  type GatewayConnectionState,
  type GatewayEvent,
} from "@/lib/hooks/use-gateway-events";

// --- Types ---

interface UsageData {
  usage: Record<string, unknown> | null;
  cost: Record<string, unknown> | null;
  period?: string;
  normalizedPeriod?: string;
  supportsHistoricalBreakdown?: boolean;
  fetchedAt?: string;
}

interface DailyEntry {
  date: string;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead?: number;
  cacheWrite?: number;
}

interface ProviderWindow {
  label: string;
  usedPercent: number;
  resetAt?: number;
}

interface ProviderEntry {
  name: string;
  plan?: string;
  usedPercent: number;
  resetAt?: number;
  windows?: ProviderWindow[];
}

interface Totals {
  totalCost: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  missingCostEntries?: number;
}

interface ChatAnalyticsData {
  messagesPerDay?: Array<{ day: string; count: number }>;
  messagesByChannel?: Array<{ channel: string | null; count: number }>;
  tokensByModel?: Array<{ model: string | null; input: number; output: number; total: number }>;
  degraded?: boolean;
  warning?: string;
}

// --- Helpers ---

function formatTokens(n: number | undefined | null): string {
  if (!n) { return "0"; }
  if (n >= 1_000_000) { return `${(n / 1_000_000).toFixed(1)}M`; }
  if (n >= 1_000) { return `${(n / 1_000).toFixed(1)}K`; }
  return String(n);
}

function formatCost(n: number | undefined | null): string {
  if (!n) { return "$0.00"; }
  return `$${n.toFixed(2)}`;
}

function formatTimestamp(ts?: string): string {
  if (!ts) { return "N/A"; }
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) { return "N/A"; }
  return date.toLocaleString();
}

function formatShortDate(dateStr: string): string {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) { return dateStr; }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatCountdown(resetAt?: number | string): string {
  if (!resetAt) { return ""; }
  const ts = typeof resetAt === "number" ? resetAt : new Date(resetAt).getTime();
  const diff = ts - Date.now();
  if (diff <= 0) { return "now"; }
  const hours = Math.floor(diff / 3_600_000);
  const mins = Math.floor((diff % 3_600_000) / 60_000);
  if (hours > 24) { return `${Math.floor(hours / 24)}d`; }
  if (hours > 0) { return `${hours}h ${mins}m`; }
  return `${mins}m`;
}

function usageBarColor(pct: number): string {
  if (pct > 80) { return "bg-red-500"; }
  if (pct > 60) { return "bg-yellow-500"; }
  return "bg-emerald-500";
}

function extractTotals(cost: Record<string, unknown>): Totals {
  const totals = (cost.totals ?? cost) as Record<string, unknown>;
  return {
    totalCost: (totals.totalCost as number) || (cost.total as number) || (cost.cost as number) || 0,
    totalTokens: (totals.totalTokens as number) || 0,
    inputTokens: (totals.input as number) || (totals.inputTokens as number) || (totals.input_tokens as number) || 0,
    outputTokens: (totals.output as number) || (totals.outputTokens as number) || (totals.output_tokens as number) || 0,
    cacheRead: (totals.cacheRead as number) || (totals.cache_read as number) || 0,
    cacheWrite: (totals.cacheWrite as number) || (totals.cache_write as number) || 0,
    missingCostEntries: (totals.missingCostEntries as number) || 0,
  };
}

function extractDaily(cost: Record<string, unknown>): DailyEntry[] {
  const raw = cost.daily;
  if (!Array.isArray(raw)) { return []; }
  return raw.map((d: Record<string, unknown>) => ({
    date: typeof d.date === "string" ? d.date : JSON.stringify(d.date ?? ""),
    totalCost: (d.totalCost as number) || 0,
    inputTokens: (d.input as number) || (d.inputTokens as number) || (d.input_tokens as number) || 0,
    outputTokens: (d.output as number) || (d.outputTokens as number) || (d.output_tokens as number) || 0,
    cacheRead: (d.cacheRead as number) || (d.cache_read as number) || 0,
    cacheWrite: (d.cacheWrite as number) || (d.cache_write as number) || 0,
  }));
}

function extractProviders(usage: Record<string, unknown>): ProviderEntry[] {
  const raw = usage.providers;
  if (!Array.isArray(raw)) { return []; }
  return raw.map((p: Record<string, unknown>) => {
    const windows = Array.isArray(p.windows)
      ? (p.windows as Array<Record<string, unknown>>).map((w) => ({
        label: typeof w.label === "string" ? w.label : JSON.stringify(w.label ?? ""),
        usedPercent: (w.usedPercent as number) || 0,
        resetAt: (w.resetAt as number) || undefined,
      }))
      : undefined;
    // Use the highest usage window for the summary bar
    const maxWindow = windows?.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a), windows[0]);
    return {
      name: typeof (p.displayName ?? p.name ?? p.provider) === "string"
        ? ((p.displayName ?? p.name ?? p.provider) as string)
        : "unknown",
      plan: p.plan as string | undefined,
      usedPercent: maxWindow?.usedPercent ?? ((p.usedPercent as number) || 0),
      resetAt: maxWindow?.resetAt ?? ((p.resetAt as number) || undefined),
      windows,
    };
  });
}

function normalizeMessagesPerDay(
  raw: ChatAnalyticsData["messagesPerDay"]
): Array<{ day: string; count: number }> {
  if (!Array.isArray(raw)) { return []; }
  return raw
    .map((row) => ({
      day: String(row.day ?? ""),
      count: Number(row.count ?? 0),
    }))
    .filter((row) => row.day.length > 0)
    .toSorted((a, b) => a.day.localeCompare(b.day));
}

function normalizeMessagesByChannel(
  raw: ChatAnalyticsData["messagesByChannel"]
): Array<{ channel: string | null; count: number }> {
  if (!Array.isArray(raw)) { return []; }
  return raw
    .map((row) => ({
      channel: row.channel ?? null,
      count: Number(row.count ?? 0),
    }))
    .filter((row) => row.count > 0)
    .toSorted((a, b) => b.count - a.count);
}

function normalizeTokensByModel(
  raw: ChatAnalyticsData["tokensByModel"]
): Array<{ model: string | null; input: number; output: number; total: number }> {
  if (!Array.isArray(raw)) { return []; }
  return raw
    .map((row) => ({
      model: row.model ?? null,
      input: Number(row.input ?? 0),
      output: Number(row.output ?? 0),
      total: Number(row.total ?? 0),
    }))
    .filter((row) => row.total > 0)
    .toSorted((a, b) => b.total - a.total);
}

// --- Sub-components ---

function StatCard({
  label,
  value,
  subtitle,
  icon: Icon,
  trend,
  accentColor,
}: {
  label: string;
  value: string;
  subtitle?: string;
  icon: React.ComponentType<{ className?: string }>;
  trend?: "up" | "flat";
  accentColor?: string;
}) {
  return (
    <div className="glass-panel rounded-lg p-5 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        <div
          className={`w-8 h-8 rounded flex items-center justify-center ${accentColor || "bg-primary/10"}`}
        >
          <Icon className={`w-4 h-4 ${accentColor ? "text-white" : "text-primary"}`} />
        </div>
      </div>
      <div className="text-2xl font-bold font-mono">{value}</div>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {trend === "up" && <TrendingUp className="w-3.5 h-3.5 text-green-500" />}
        {trend === "flat" && <Minus className="w-3.5 h-3.5" />}
        {subtitle && <span>{subtitle}</span>}
      </div>
    </div>
  );
}

function DailyCostChart({ daily }: { daily: DailyEntry[] }) {
  const maxCost = Math.max(...daily.map((d) => d.totalCost), 0.01);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  return (
    <div className="glass-panel rounded-lg p-5">
      <h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground mb-4">
        Daily Cost
      </h3>
      <div className="flex items-end gap-1 h-36 relative">
        {daily.map((d, i) => {
          const heightPct = Math.max((d.totalCost / maxCost) * 100, 2);
          return (
            <div
              key={d.date}
              className="flex-1 flex flex-col items-center justify-end relative group"
              onMouseEnter={() => setHoveredIdx(i)}
              onMouseLeave={() => setHoveredIdx(null)}
            >
              <div
                className="w-full rounded-t bg-primary/80 hover:bg-primary transition-colors cursor-default min-h-[2px]"
                style={{ height: `${heightPct}%` }}
              />
              {hoveredIdx === i && (
                <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 z-10 bg-popover border border-border rounded px-2.5 py-1.5 text-xs shadow-md whitespace-nowrap pointer-events-none">
                  <div className="font-bold">{formatShortDate(d.date)}</div>
                  <div>Cost: {formatCost(d.totalCost)}</div>
                  <div>Tokens: {formatTokens(d.inputTokens + d.outputTokens)}</div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="flex gap-1 mt-1.5">
        {daily.map((d, i) => (
          <div
            key={d.date}
            className={`flex-1 text-center text-[10px] truncate ${i === 0 || i === daily.length - 1 || daily.length <= 10
              ? "text-muted-foreground"
              : "text-transparent"
              }`}
          >
            {formatShortDate(d.date)}
          </div>
        ))}
      </div>
    </div>
  );
}

function ProviderUsage({ providers }: { providers: ProviderEntry[] }) {
  return (
    <div className="glass-panel rounded-lg p-5">
      <h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground mb-4">
        Provider Usage
      </h3>
      {providers.length > 0 ? (
        <div className="space-y-4">
          {providers.map((p) => (
            <div key={p.name}>
              <div className="flex items-center gap-2 mb-2">
                <span className="font-medium text-sm">{p.name}</span>
                {p.plan && (
                  <span className="text-[10px] bg-muted px-1.5 py-0.5 rounded">
                    {p.plan}
                  </span>
                )}
              </div>
              {p.windows && p.windows.length > 0 ? (
                <div className="space-y-2">
                  {p.windows.map((w) => (
                    <div key={w.label}>
                      <div className="flex items-center justify-between text-xs mb-1">
                        <span className="text-muted-foreground">{w.label} window</span>
                        <div className="flex items-center gap-2 text-muted-foreground">
                          <span className="font-mono">{Math.round(w.usedPercent)}%</span>
                          {w.resetAt && (
                            <span className="text-[10px]">resets {formatCountdown(w.resetAt)}</span>
                          )}
                        </div>
                      </div>
                      <div className="h-2 rounded-full bg-muted overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${usageBarColor(w.usedPercent)}`}
                          style={{ width: `${Math.min(w.usedPercent, 100)}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div>
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="text-muted-foreground">Usage</span>
                    <span className="font-mono text-muted-foreground">{Math.round(p.usedPercent)}%</span>
                  </div>
                  <div className="h-2 rounded-full bg-muted overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${usageBarColor(p.usedPercent)}`}
                      style={{ width: `${Math.min(p.usedPercent, 100)}%` }}
                    />
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="text-sm text-muted-foreground">No provider usage data</div>
      )}
    </div>
  );
}

function TokenBreakdown({ totals }: { totals: Totals }) {
  const { inputTokens, outputTokens, cacheRead, cacheWrite, missingCostEntries } = totals;
  const tokenTotal = inputTokens + outputTokens;
  const cacheTotal = cacheRead + cacheWrite;
  const inputPct = tokenTotal > 0 ? Math.round((inputTokens / tokenTotal) * 100) : 0;
  const outputPct = tokenTotal > 0 ? Math.round((outputTokens / tokenTotal) * 100) : 0;
  const cacheReadPct = cacheTotal > 0 ? Math.round((cacheRead / cacheTotal) * 100) : 0;
  const cacheWritePct = cacheTotal > 0 ? Math.round((cacheWrite / cacheTotal) * 100) : 0;

  return (
    <div className="glass-panel rounded-lg p-5">
      <h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground mb-4">
        Token Breakdown
      </h3>
      {tokenTotal > 0 ? (
        <div className="space-y-3">
          <div>
            <div className="flex items-center justify-between text-xs mb-1.5">
              <span className="font-medium">Input</span>
              <span className="text-muted-foreground font-mono">
                {formatTokens(inputTokens)} ({inputPct}%)
              </span>
            </div>
            <div className="h-2 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full bg-primary rounded-full transition-all"
                style={{ width: `${inputPct}%` }}
              />
            </div>
          </div>
          <div>
            <div className="flex items-center justify-between text-xs mb-1.5">
              <span className="font-medium">Output</span>
              <span className="text-muted-foreground font-mono">
                {formatTokens(outputTokens)} ({outputPct}%)
              </span>
            </div>
            <div className="h-2 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full bg-emerald-500 rounded-full transition-all"
                style={{ width: `${outputPct}%` }}
              />
            </div>
          </div>

          {cacheTotal > 0 && (
            <>
              <div className="border-t border-border/60 pt-3 mt-3">
                <div className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-3">
                  Cache
                </div>
              </div>
              <div>
                <div className="flex items-center justify-between text-xs mb-1.5">
                  <span className="font-medium">Cache Read</span>
                  <span className="text-muted-foreground font-mono">
                    {formatTokens(cacheRead)} ({cacheReadPct}%)
                  </span>
                </div>
                <div className="h-2 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full bg-sky-500 rounded-full transition-all"
                    style={{ width: `${cacheReadPct}%` }}
                  />
                </div>
              </div>
              <div>
                <div className="flex items-center justify-between text-xs mb-1.5">
                  <span className="font-medium">Cache Write</span>
                  <span className="text-muted-foreground font-mono">
                    {formatTokens(cacheWrite)} ({cacheWritePct}%)
                  </span>
                </div>
                <div className="h-2 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full bg-violet-500 rounded-full transition-all"
                    style={{ width: `${cacheWritePct}%` }}
                  />
                </div>
              </div>
            </>
          )}

          {(missingCostEntries ?? 0) > 0 && (
            <div className="flex items-center gap-1.5 text-xs text-yellow-600 pt-2 border-t border-border/60">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              <span>{missingCostEntries} entries missing cost data</span>
            </div>
          )}
        </div>
      ) : (
        <div className="text-sm text-muted-foreground">No token usage data yet</div>
      )}
    </div>
  );
}

function ChatMessagesTrend({ rows }: { rows: Array<{ day: string; count: number }> }) {
  const maxCount = Math.max(...rows.map((row) => row.count), 1);
  return (
    <div className="glass-panel rounded-lg p-5">
      <h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground mb-4">
        Chat Messages / Day
      </h3>
      {rows.length === 0 ? (
        <div className="text-sm text-muted-foreground">No chat analytics data yet</div>
      ) : (
        <>
          <div className="flex items-end gap-1 h-28">
            {rows.map((row) => {
              const heightPct = Math.max((row.count / maxCount) * 100, 2);
              return (
                <div key={row.day} className="flex-1 flex flex-col items-center justify-end">
                  <div
                    className="w-full rounded-t bg-primary/80 min-h-[2px]"
                    style={{ height: `${heightPct}%` }}
                    title={`${row.day}: ${row.count}`}
                  />
                </div>
              );
            })}
          </div>
          <div className="mt-2 text-[10px] text-muted-foreground flex items-center justify-between">
            <span>{formatShortDate(rows[0].day)}</span>
            <span>{formatShortDate(rows[rows.length - 1].day)}</span>
          </div>
        </>
      )}
    </div>
  );
}

function ChatChannelBreakdown({
  rows,
}: {
  rows: Array<{ channel: string | null; count: number }>;
}) {
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  return (
    <div className="glass-panel rounded-lg p-5">
      <h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground mb-4">
        Chat Channels
      </h3>
      {rows.length === 0 || total <= 0 ? (
        <div className="text-sm text-muted-foreground">No channel breakdown yet</div>
      ) : (
        <div className="space-y-2">
          {rows.slice(0, 8).map((row) => {
            const pct = Math.max(1, Math.round((row.count / total) * 100));
            return (
              <div key={`${row.channel ?? "unknown"}-${row.count}`}>
                <div className="flex items-center justify-between text-xs mb-1">
                  <span className="font-medium">{row.channel || "unknown"}</span>
                  <span className="text-muted-foreground font-mono">
                    {row.count} ({pct}%)
                  </span>
                </div>
                <div className="h-2 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full rounded-full bg-emerald-500"
                    style={{ width: `${Math.min(pct, 100)}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ChatModelTokens({
  rows,
}: {
  rows: Array<{ model: string | null; input: number; output: number; total: number }>;
}) {
  return (
    <div className="glass-panel rounded-lg p-5">
      <h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground mb-4">
        Tokens By Model
      </h3>
      {rows.length === 0 ? (
        <div className="text-sm text-muted-foreground">No model token stats yet</div>
      ) : (
        <div className="space-y-2">
          {rows.slice(0, 8).map((row) => (
            <div
              key={`${row.model ?? "unknown"}-${row.total}`}
              className="grid grid-cols-[1fr_auto_auto_auto] gap-2 text-xs items-center"
            >
              <span className="truncate font-medium">{row.model || "unknown"}</span>
              <span className="font-mono text-muted-foreground">
                in {formatTokens(row.input)}
              </span>
              <span className="font-mono text-muted-foreground">
                out {formatTokens(row.output)}
              </span>
              <span className="font-mono">{formatTokens(row.total)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// --- Main Component ---

export function CostDashboard() {
  const [data, setData] = useState<UsageData | null>(null);
  const [chatAnalytics, setChatAnalytics] = useState<ChatAnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [chatAnalyticsLoading, setChatAnalyticsLoading] = useState(true);
  const [period, setPeriod] = useState<"today" | "7d" | "30d">("today");
  const [connectionState, setConnectionState] =
    useState<GatewayConnectionState>("connecting");
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchUsage = useCallback(async () => {
    setLoading(true);
    try {
      const query = new URLSearchParams({ period });
      const res = await fetch(`/api/openclaw/usage?${query.toString()}`);
      const json = (await res.json()) as UsageData;
      setData(json);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [period]);

  const fetchChatAnalytics = useCallback(async () => {
    setChatAnalyticsLoading(true);
    try {
      const now = Date.now();
      const from =
        period === "today"
          ? now - 24 * 60 * 60 * 1000
          : period === "7d"
            ? now - 7 * 24 * 60 * 60 * 1000
            : now - 30 * 24 * 60 * 60 * 1000;
      const res = await fetch("/api/chat/analytics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: "main",
          from,
        }),
      });
      const json = (await res.json()) as ChatAnalyticsData;
      if (!res.ok) {
        setChatAnalytics(null);
        return;
      }
      setChatAnalytics(json);
    } catch {
      setChatAnalytics(null);
    } finally {
      setChatAnalyticsLoading(false);
    }
  }, [period]);

  const fetchAll = useCallback(async () => {
    await Promise.all([fetchUsage(), fetchChatAnalytics()]);
  }, [fetchUsage, fetchChatAnalytics]);

  const scheduleRefresh = useCallback(() => {
    if (refreshTimerRef.current) { return; }
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      fetchAll().catch(() => {
        // Ignore transient usage refresh failures.
      });
    }, 220);
  }, [fetchAll]);

  const handleConnectionState = useCallback((state: GatewayConnectionState) => {
    setConnectionState(state);
  }, []);

  const handleGatewayEvent = useCallback(
    (event: GatewayEvent) => {
      if (event.type !== "gateway_event") { return; }
      const eventName = (event.event || "").toLowerCase();
      if (
        eventName.includes("usage.") ||
        eventName.includes("chat.") ||
        eventName.includes("sessions.") ||
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
    fetchAll().catch(() => {
      // Ignore initial usage load failures.
    });
  }, [fetchAll]);

  useEffect(() => {
    const intervalId = setInterval(() => {
      if (connectionState !== "connected") {
        fetchAll().catch(() => {
          // Ignore fallback usage refresh failures.
        });
      }
    }, 60_000);
    return () => clearInterval(intervalId);
  }, [connectionState, fetchAll]);

  useEffect(() => {
    return () => {
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
      }
    };
  }, []);

  // --- Data extraction ---

  const usage = (data?.usage || {});
  const cost = (data?.cost || {});
  const totals = extractTotals(cost);
  const daily = extractDaily(cost);
  const providers = extractProviders(usage);
  const sessions =
    (usage.sessions as number) || (usage.activeSessions as number) || 0;

  // Compute totalTokens from totals, falling back to usage-level fields
  const totalTokens =
    totals.totalTokens ||
    totals.inputTokens + totals.outputTokens ||
    (usage.totalTokens as number) ||
    (usage.total_tokens as number) ||
    0;

  const showDailyChart = period !== "today" && daily.length > 0;
  const messagesPerDay = normalizeMessagesPerDay(chatAnalytics?.messagesPerDay);
  const messagesByChannel = normalizeMessagesByChannel(chatAnalytics?.messagesByChannel);
  const tokensByModel = normalizeTokensByModel(chatAnalytics?.tokensByModel);
  const hasAnalyticsWarning = Boolean(chatAnalytics?.warning);
  const refreshBusy = loading || chatAnalyticsLoading;

  return (
    <div className="flex-1 overflow-auto p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold">Usage & Costs</h2>
          <p className="text-sm text-muted-foreground">
            Real gateway telemetry only
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex bg-muted rounded overflow-hidden border border-border">
            {(["today", "7d", "30d"] as const).map((p) => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className={`px-3 py-1.5 text-xs font-medium transition-all ${period === p
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
                  }`}
              >
                {p === "today" ? "Today" : p === "7d" ? "7 Days" : "30 Days"}
              </button>
            ))}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={fetchAll}
            disabled={refreshBusy}
            className="gap-1.5"
          >
            {refreshBusy ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5" />
            )}
            Refresh
          </Button>
        </div>
      </div>

      <div className="mb-4 text-xs text-muted-foreground flex items-center gap-2">
        <Clock3 className="w-3.5 h-3.5" />
        <span>As of {formatTimestamp(data?.fetchedAt)}</span>
        <span>&bull;</span>
        <span>Period: {(data?.period || period).toUpperCase()}</span>
      </div>

      {hasAnalyticsWarning && (
        <div className="mb-4 rounded border border-amber-300/50 bg-amber-500/10 px-3 py-2 text-xs text-amber-700">
          {chatAnalytics?.warning}
        </div>
      )}

      {/* Row 1: KPI Stat Cards */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <StatCard
          label="Total Cost"
          value={formatCost(totals.totalCost)}
          subtitle="reported by gateway"
          icon={DollarSign}
          trend={totals.totalCost > 0 ? "up" : "flat"}
          accentColor="bg-green-600"
        />
        <StatCard
          label="Total Tokens"
          value={formatTokens(totalTokens)}
          subtitle={`${formatTokens(totals.inputTokens)} in / ${formatTokens(totals.outputTokens)} out`}
          icon={TrendingUp}
          trend={totalTokens > 0 ? "up" : "flat"}
        />
        <StatCard
          label="Cache Savings"
          value={formatTokens(totals.cacheRead)}
          subtitle="tokens served from cache"
          icon={Database}
          trend={totals.cacheRead > 0 ? "up" : "flat"}
          accentColor="bg-sky-600"
        />
        <StatCard
          label="Active Sessions"
          value={String(sessions)}
          subtitle="running now"
          icon={BarChart3}
          trend="flat"
        />
      </div>

      {/* Row 2: Daily Cost Chart (only for 7d/30d) */}
      {showDailyChart && <div className="mb-6"><DailyCostChart daily={daily} /></div>}

      {/* Row 3: Provider Usage + Token Breakdown */}
      <div className="grid grid-cols-2 gap-4">
        <ProviderUsage providers={providers} />
        <TokenBreakdown totals={totals} />
      </div>

      {/* Row 4: Chat analytics */}
      <div className="mt-6 mb-3 flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground font-bold">
        <MessageSquare className="w-4 h-4" />
        Chat Analytics
      </div>
      <div className="grid grid-cols-3 gap-4">
        <ChatMessagesTrend rows={messagesPerDay} />
        <ChatChannelBreakdown rows={messagesByChannel} />
        <ChatModelTokens rows={tokensByModel} />
      </div>

      {/* Row 5: Raw data toggle */}
      {data && (
        <details className="mt-6">
          <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
            Show raw gateway response
          </summary>
          <pre className="mt-2 bg-muted/50 rounded border border-border p-3 text-xs font-mono overflow-auto max-h-48">
            {JSON.stringify(data, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}
