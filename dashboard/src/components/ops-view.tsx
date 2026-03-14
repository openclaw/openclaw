"use client";

import { useAutoRefresh } from "@/hooks/use-auto-refresh";
import { GlassCard } from "@/components/ui/glass-card";
import { StatusDot } from "@/components/ui/status-dot";
import { SkeletonCard } from "@/components/ui/skeleton-card";
import { StaggerGrid, StaggerItem } from "@/components/ui/stagger-grid";
import { Server, GitBranch, Eye, Target } from "lucide-react";

export function OpsView() {
  const { data: systemState, loading: sysLoading } = useAutoRefresh<{
    services: Array<{ name: string; status: "up" | "down" | "degraded"; port?: number; lastCheck: string }>;
  }>("/api/system-state");

  const { data: observations } = useAutoRefresh<{ content: string }>("/api/observations");
  const { data: priorities } = useAutoRefresh<{ content: string }>("/api/priorities");

  return (
    <StaggerGrid columns="grid-cols-1 lg:grid-cols-2">
      {/* Server Health */}
      <StaggerItem>
        {sysLoading ? (
          <SkeletonCard lines={5} />
        ) : (
          <GlassCard>
            <div className="flex items-center gap-2 mb-4">
              <Server className="w-4 h-4 text-primary" />
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Server Health
              </h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-white/[0.06]">
                    <th className="text-left py-2 font-medium text-muted-foreground">Service</th>
                    <th className="text-left py-2 font-medium text-muted-foreground">Status</th>
                    <th className="text-right py-2 font-medium text-muted-foreground">Port</th>
                  </tr>
                </thead>
                <tbody>
                  {(systemState?.services || []).map((svc) => (
                    <tr key={svc.name} className="border-b border-white/[0.03]">
                      <td className="py-2 font-medium">{svc.name}</td>
                      <td className="py-2">
                        <div className="flex items-center gap-1.5">
                          <StatusDot
                            color={svc.status === "up" ? "green" : svc.status === "degraded" ? "yellow" : "red"}
                            pulse
                          />
                          <span className="capitalize">{svc.status}</span>
                        </div>
                      </td>
                      <td className="py-2 text-right font-mono text-muted-foreground">
                        {svc.port || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </GlassCard>
        )}
      </StaggerItem>

      {/* Branch Status */}
      <StaggerItem>
        <GlassCard>
          <div className="flex items-center gap-2 mb-4">
            <GitBranch className="w-4 h-4 text-primary" />
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Branch Status
            </h3>
          </div>
          <p className="text-xs text-muted-foreground">Branch status data loads from state/branch-check.json</p>
        </GlassCard>
      </StaggerItem>

      {/* Observations */}
      <StaggerItem>
        <GlassCard>
          <div className="flex items-center gap-2 mb-4">
            <Eye className="w-4 h-4 text-primary" />
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Observations
            </h3>
          </div>
          <div className="prose prose-invert prose-xs max-w-none">
            <pre className="text-[11px] text-foreground/70 whitespace-pre-wrap font-sans leading-relaxed">
              {observations?.content || "No observations recorded."}
            </pre>
          </div>
        </GlassCard>
      </StaggerItem>

      {/* Priorities */}
      <StaggerItem>
        <GlassCard>
          <div className="flex items-center gap-2 mb-4">
            <Target className="w-4 h-4 text-primary" />
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              System Priorities
            </h3>
          </div>
          <div className="prose prose-invert prose-xs max-w-none">
            <pre className="text-[11px] text-foreground/70 whitespace-pre-wrap font-sans leading-relaxed">
              {priorities?.content || "No priorities set."}
            </pre>
          </div>
        </GlassCard>
      </StaggerItem>
    </StaggerGrid>
  );
}
