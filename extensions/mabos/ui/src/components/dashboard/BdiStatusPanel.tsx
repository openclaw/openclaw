import { useMutation } from "@tanstack/react-query";
import { Activity, Play } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api";
import type { SystemStatus, AgentListItem } from "@/lib/types";

type BdiStatusPanelProps = {
  status: SystemStatus | undefined;
  agents: AgentListItem[] | undefined;
};

export function BdiStatusPanel({ status, agents }: BdiStatusPanelProps) {
  const triggerCycle = useMutation({
    mutationFn: ({ agentId }: { agentId: string }) => api.triggerBdiCycle("vividwalls", agentId),
  });

  const heartbeat = status?.bdiHeartbeat;
  const isActive = heartbeat === "active";
  const intervalMin = status?.bdiIntervalMinutes ?? 30;

  return (
    <Card className="border-[var(--border-mabos)] bg-[var(--bg-card)] shadow-none">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium text-[var(--text-secondary)] flex items-center gap-2">
            <Activity className="w-4 h-4" />
            BDI Heartbeat
          </CardTitle>
          <div className="flex items-center gap-2">
            <span
              className="inline-block w-2 h-2 rounded-full"
              style={{
                backgroundColor: isActive ? "var(--accent-green)" : "var(--text-muted)",
                boxShadow: isActive ? "0 0 6px var(--accent-green)" : "none",
                animation: isActive ? "pulse 2s infinite" : "none",
              }}
            />
            <Badge
              variant="outline"
              className="text-[10px]"
              style={{
                borderColor: isActive
                  ? "color-mix(in srgb, var(--accent-green) 30%, transparent)"
                  : "var(--border-mabos)",
                color: isActive ? "var(--accent-green)" : "var(--text-muted)",
              }}
            >
              {isActive ? "Active" : "Stopped"}
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <p className="text-xs text-[var(--text-muted)]">Interval</p>
            <p className="text-sm text-[var(--text-primary)]">{intervalMin} min</p>
          </div>
          <div>
            <p className="text-xs text-[var(--text-muted)]">Total Cycles</p>
            <p className="text-sm text-[var(--text-primary)]">{status?.agents?.length ?? "-"}</p>
          </div>
        </div>

        {/* Per-agent trigger buttons */}
        {agents && agents.length > 0 && (
          <div className="space-y-1.5 pt-1">
            <p className="text-xs text-[var(--text-muted)]">Trigger Cycle</p>
            <div className="flex flex-wrap gap-1.5">
              {agents.slice(0, 6).map((agent) => (
                <Button
                  key={agent.id}
                  variant="outline"
                  size="sm"
                  onClick={() => triggerCycle.mutate({ agentId: agent.id })}
                  disabled={triggerCycle.isPending}
                  className="h-7 text-[10px] border-[var(--border-mabos)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] gap-1"
                >
                  <Play className="w-2.5 h-2.5" />
                  {agent.id}
                </Button>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
