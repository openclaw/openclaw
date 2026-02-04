/**
 * Agent Detail Panel — drill-down view showing detailed info for a selected agent.
 *
 * Shows session details, full resource breakdown, tags, model info, and
 * provides actions (navigate to session, abort, etc.).
 */

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  X,
  Activity,
  Clock,
  Coins,
  Tag,
  Cpu,
  MessageSquare,
  ExternalLink,
  Zap,
  AlertTriangle,
  Pause,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import type { AgentStatusEntry, AgentHealthStatus } from "@/hooks/queries/useAgentStatus";

// ── Helpers ────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
  const hours = Math.floor(ms / 3_600_000);
  const mins = Math.floor((ms % 3_600_000) / 60_000);
  return `${hours}h ${mins}m`;
}

function formatRelativeTime(timestampMs: number): string {
  const delta = Date.now() - timestampMs;
  if (delta < 5_000) return "Just now";
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}

const HEALTH_BADGE: Record<AgentHealthStatus, { variant: "success" | "warning" | "error" | "outline"; icon: typeof Zap; label: string }> = {
  active: { variant: "success", icon: Zap, label: "Active" },
  stalled: { variant: "warning", icon: AlertTriangle, label: "Stalled" },
  idle: { variant: "outline", icon: Pause, label: "Idle" },
  errored: { variant: "error", icon: XCircle, label: "Errored" },
};

// ── Component ──────────────────────────────────────────────────────

export interface AgentDetailPanelProps {
  agent: AgentStatusEntry | null;
  onClose: () => void;
  onNavigateToSession?: (agent: AgentStatusEntry) => void;
}

export function AgentDetailPanel({ agent, onClose, onNavigateToSession }: AgentDetailPanelProps) {
  // Auto-refresh "last activity" every 5 seconds
  const [, forceUpdate] = React.useReducer((x: number) => x + 1, 0);
  React.useEffect(() => {
    if (!agent) return;
    const timer = setInterval(forceUpdate, 5_000);
    return () => clearInterval(timer);
  }, [agent]);

  return (
    <AnimatePresence mode="wait">
      {agent && (
        <motion.div
          key={agent.id}
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 20 }}
          transition={{ duration: 0.2 }}
          className="space-y-4"
        >
          {/* Header */}
          <div className="flex items-start justify-between">
            <div>
              <h3 className="text-lg font-bold">{agent.name}</h3>
              {agent.label && (
                <Badge variant="secondary" className="mt-1">
                  {agent.label}
                </Badge>
              )}
            </div>
            <Button variant="ghost" size="icon" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>

          {/* Health Badge */}
          {(() => {
            const healthInfo = HEALTH_BADGE[agent.health];
            const HealthIcon = healthInfo.icon;
            return (
              <Badge variant={healthInfo.variant} className="gap-1">
                <HealthIcon className="h-3 w-3" />
                {healthInfo.label}
              </Badge>
            );
          })()}

          <Separator />

          {/* Current Task */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <MessageSquare className="h-4 w-4 text-muted-foreground" />
                Current Task
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm">
                {agent.currentTask || "No active task"}
              </p>
              {agent.pendingApprovals && agent.pendingApprovals > 0 && (
                <Badge variant="warning" className="mt-2">
                  {agent.pendingApprovals} pending approval{agent.pendingApprovals > 1 ? "s" : ""}
                </Badge>
              )}
            </CardContent>
          </Card>

          {/* Resource Usage */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Activity className="h-4 w-4 text-muted-foreground" />
                Resource Usage
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground flex items-center gap-1.5">
                  <Activity className="h-3.5 w-3.5" />
                  Tokens
                </span>
                <span className="font-mono font-medium">
                  {agent.resources.tokensUsed.toLocaleString()}
                </span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground flex items-center gap-1.5">
                  <Coins className="h-3.5 w-3.5" />
                  Cost
                </span>
                <span className="font-mono font-medium">
                  ${agent.resources.estimatedCost.toFixed(2)}
                </span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground flex items-center gap-1.5">
                  <Clock className="h-3.5 w-3.5" />
                  Duration
                </span>
                <span className="font-mono font-medium">
                  {formatDuration(agent.resources.durationMs)}
                </span>
              </div>
            </CardContent>
          </Card>

          {/* Agent Info */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Cpu className="h-4 w-4 text-muted-foreground" />
                Details
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {agent.model && (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Model</span>
                  <span className="font-mono text-xs">{agent.model}</span>
                </div>
              )}
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Sessions</span>
                <span className="font-medium">{agent.sessionCount}</span>
              </div>
              {agent.sessionKey && (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Session Key</span>
                  <span className="font-mono text-xs truncate max-w-[180px]">
                    {agent.sessionKey}
                  </span>
                </div>
              )}
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Last Activity</span>
                <span>{formatRelativeTime(agent.lastActivityAt)}</span>
              </div>
            </CardContent>
          </Card>

          {/* Tags */}
          {agent.tags && agent.tags.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <Tag className="h-4 w-4 text-muted-foreground" />
                  Tags
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-1.5">
                  {agent.tags.map((tag) => (
                    <Badge key={tag} variant="outline" className="text-xs">
                      {tag}
                    </Badge>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Actions */}
          <div className="flex gap-2 pt-2">
            {agent.sessionKey && onNavigateToSession && (
              <Button
                variant="outline"
                size="sm"
                className="flex-1 gap-2"
                onClick={() => onNavigateToSession(agent)}
              >
                <ExternalLink className="h-4 w-4" />
                View Session
              </Button>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
