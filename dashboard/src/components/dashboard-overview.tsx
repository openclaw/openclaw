"use client";

import { useAutoRefresh } from "@/hooks/use-auto-refresh";
import { GlassCard } from "@/components/ui/glass-card";
import { StatusDot } from "@/components/ui/status-dot";
import { StatCard } from "@/components/ui/stat-card";
import { SkeletonCard } from "@/components/ui/skeleton-card";
import { StaggerGrid, StaggerItem } from "@/components/ui/stagger-grid";
import { formatRelativeTime, formatCurrency } from "@/lib/utils";
import {
  Activity,
  Bot,
  Clock,
  DollarSign,
  FileText,
  Server,
  Zap,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";

interface ServiceStatus {
  name: string;
  status: "up" | "down" | "degraded";
  port?: number;
  lastCheck: string;
  details?: string;
}

export function DashboardOverview() {
  const { data: systemState, loading: sysLoading } = useAutoRefresh<{
    services: ServiceStatus[];
    branchCheck: unknown;
  }>("/api/system-state");

  const { data: agents, loading: agentsLoading } = useAutoRefresh<
    Array<{ id: string; name: string; emoji: string; status: string; role: string }>
  >("/api/agents");

  const { data: cronData, loading: cronLoading } = useAutoRefresh<{
    jobs: unknown[];
    heartbeats: Array<{ name: string; schedule: string; lastStatus: string; agentId: string }>;
  }>("/api/cron-health");

  const { data: revenue, loading: revLoading } = useAutoRefresh<{
    current: number;
    monthlyBurn: number;
    net: number;
    currency: string;
  }>("/api/revenue");

  const { data: content, loading: contentLoading } = useAutoRefresh<{
    counts: { draft: number; review: number; approved: number; published: number };
  }>("/api/content-pipeline");

  return (
    <div className="space-y-4">
      {/* Quick stats row */}
      <StaggerGrid columns="grid-cols-2 sm:grid-cols-4">
        <StaggerItem>
          <StatCard
            label="Total Agents"
            value={agents?.length ?? "—"}
            icon={Bot}
          />
        </StaggerItem>
        <StaggerItem>
          <StatCard
            label="Heartbeats"
            value={cronData?.heartbeats?.length ?? "—"}
            icon={Activity}
          />
        </StaggerItem>
        <StaggerItem>
          <StatCard
            label="Content Items"
            value={content ? Object.values(content.counts).reduce((a, b) => a + b, 0) : "—"}
            icon={FileText}
          />
        </StaggerItem>
        <StaggerItem>
          <StatCard
            label="Monthly Burn"
            value={revenue ? formatCurrency(revenue.monthlyBurn) : "—"}
            icon={DollarSign}
          />
        </StaggerItem>
      </StaggerGrid>

      {/* Main cards grid */}
      <StaggerGrid columns="grid-cols-1 lg:grid-cols-2 xl:grid-cols-3">
        {/* System Health */}
        <StaggerItem>
          {sysLoading ? (
            <SkeletonCard lines={4} />
          ) : (
            <GlassCard>
              <div className="flex items-center gap-2 mb-3">
                <Server className="w-4 h-4 text-primary" />
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  System Health
                </h3>
              </div>
              <div className="space-y-2">
                {(systemState?.services || []).map((svc) => (
                  <div key={svc.name} className="flex items-center justify-between py-1.5 border-b border-white/[0.04] last:border-0">
                    <div className="flex items-center gap-2">
                      <StatusDot color={svc.status === "up" ? "green" : svc.status === "degraded" ? "yellow" : "red"} pulse />
                      <span className="text-xs font-medium">{svc.name}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      {svc.port && (
                        <span className="text-[10px] font-mono text-muted-foreground">:{svc.port}</span>
                      )}
                      <span className="text-[10px] text-muted-foreground">
                        {formatRelativeTime(svc.lastCheck)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </GlassCard>
          )}
        </StaggerItem>

        {/* Agent Status */}
        <StaggerItem>
          {agentsLoading ? (
            <SkeletonCard lines={5} />
          ) : (
            <GlassCard>
              <div className="flex items-center gap-2 mb-3">
                <Bot className="w-4 h-4 text-primary" />
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Agent Squad
                </h3>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                {(agents || []).slice(0, 12).map((agent) => (
                  <div
                    key={agent.id}
                    className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg bg-white/[0.02] hover:bg-white/[0.04] transition-colors"
                  >
                    <span className="text-sm">{agent.emoji}</span>
                    <div className="min-w-0">
                      <p className="text-[11px] font-medium truncate">{agent.name}</p>
                      <p className="text-[9px] text-muted-foreground truncate">{agent.role}</p>
                    </div>
                  </div>
                ))}
              </div>
            </GlassCard>
          )}
        </StaggerItem>

        {/* Cron Health */}
        <StaggerItem>
          {cronLoading ? (
            <SkeletonCard lines={4} />
          ) : (
            <GlassCard>
              <div className="flex items-center gap-2 mb-3">
                <Clock className="w-4 h-4 text-primary" />
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Heartbeat Monitor
                </h3>
              </div>
              <div className="space-y-1.5">
                {(cronData?.heartbeats || []).slice(0, 8).map((hb) => (
                  <div key={hb.agentId} className="flex items-center justify-between py-1 border-b border-white/[0.03] last:border-0">
                    <span className="text-[11px] font-medium">{hb.name}</span>
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] text-muted-foreground font-mono">{hb.schedule}</span>
                      {hb.lastStatus === "success" ? (
                        <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                      ) : (
                        <AlertCircle className="w-3 h-3 text-red-400" />
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </GlassCard>
          )}
        </StaggerItem>

        {/* Revenue */}
        <StaggerItem>
          {revLoading ? (
            <SkeletonCard lines={3} />
          ) : (
            <GlassCard>
              <div className="flex items-center gap-2 mb-3">
                <DollarSign className="w-4 h-4 text-primary" />
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Revenue Tracker
                </h3>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <p className="text-[10px] text-muted-foreground">Revenue</p>
                  <p className="text-lg font-semibold text-emerald-400">
                    {formatCurrency(revenue?.current ?? 0)}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground">Burn</p>
                  <p className="text-lg font-semibold text-red-400">
                    {formatCurrency(revenue?.monthlyBurn ?? 0)}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground">Net</p>
                  <p className={`text-lg font-semibold ${(revenue?.net ?? 0) >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                    {formatCurrency(revenue?.net ?? 0)}
                  </p>
                </div>
              </div>
            </GlassCard>
          )}
        </StaggerItem>

        {/* Content Pipeline */}
        <StaggerItem>
          {contentLoading ? (
            <SkeletonCard lines={3} />
          ) : (
            <GlassCard>
              <div className="flex items-center gap-2 mb-3">
                <FileText className="w-4 h-4 text-primary" />
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Content Pipeline
                </h3>
              </div>
              <div className="flex gap-2">
                {[
                  { label: "Draft", count: content?.counts.draft ?? 0, color: "text-zinc-400" },
                  { label: "Review", count: content?.counts.review ?? 0, color: "text-amber-400" },
                  { label: "Approved", count: content?.counts.approved ?? 0, color: "text-blue-400" },
                  { label: "Published", count: content?.counts.published ?? 0, color: "text-emerald-400" },
                ].map((col) => (
                  <div key={col.label} className="flex-1 text-center p-2 rounded-lg bg-white/[0.02]">
                    <p className={`text-xl font-bold ${col.color}`}>{col.count}</p>
                    <p className="text-[9px] text-muted-foreground mt-0.5">{col.label}</p>
                  </div>
                ))}
              </div>
            </GlassCard>
          )}
        </StaggerItem>

        {/* Quick Actions */}
        <StaggerItem>
          <GlassCard>
            <div className="flex items-center gap-2 mb-3">
              <Zap className="w-4 h-4 text-primary" />
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Quick Actions
              </h3>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {[
                { label: "Trigger Heartbeat", icon: Activity },
                { label: "Run Scrape", icon: Bot },
                { label: "View Logs", icon: FileText },
                { label: "System Status", icon: Server },
              ].map((action) => (
                <button
                  key={action.label}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white/[0.03] border border-white/[0.06] hover:bg-white/[0.06] transition-colors text-left"
                >
                  <action.icon className="w-3.5 h-3.5 text-muted-foreground" />
                  <span className="text-[11px] font-medium">{action.label}</span>
                </button>
              ))}
            </div>
          </GlassCard>
        </StaggerItem>
      </StaggerGrid>
    </div>
  );
}
