/**
 * Agent Status Row — a compact, information-dense row for the dashboard table.
 *
 * Shows health indicator, name, current task, resource usage, and timestamps.
 */

import { motion } from "framer-motion";
import {
  Activity,
  Clock,
  Coins,
  ChevronRight,
  AlertTriangle,
  Pause,
  Zap,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { AgentStatusEntry, AgentHealthStatus } from "@/hooks/queries/useAgentStatus";

// ── Health config ──────────────────────────────────────────────────

const HEALTH_CONFIG: Record<
  AgentHealthStatus,
  { color: string; bgColor: string; icon: typeof Activity; label: string; pulse: boolean }
> = {
  active: {
    color: "text-green-600 dark:text-green-400",
    bgColor: "bg-green-500",
    icon: Zap,
    label: "Active",
    pulse: true,
  },
  stalled: {
    color: "text-yellow-600 dark:text-yellow-400",
    bgColor: "bg-yellow-500",
    icon: AlertTriangle,
    label: "Stalled",
    pulse: true,
  },
  idle: {
    color: "text-gray-500 dark:text-gray-400",
    bgColor: "bg-gray-400",
    icon: Pause,
    label: "Idle",
    pulse: false,
  },
  errored: {
    color: "text-red-600 dark:text-red-400",
    bgColor: "bg-red-500",
    icon: XCircle,
    label: "Error",
    pulse: true,
  },
};

// ── Helpers ────────────────────────────────────────────────────────

function formatRelativeTime(timestampMs: number): string {
  const delta = Date.now() - timestampMs;
  if (delta < 5_000) return "Just now";
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}

function formatTokenCount(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(2)}M`;
}

function formatCost(cost: number): string {
  return `$${cost.toFixed(2)}`;
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
  return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
}

// ── Component ──────────────────────────────────────────────────────

export interface AgentStatusRowProps {
  agent: AgentStatusEntry;
  onDrillDown?: (agent: AgentStatusEntry) => void;
  className?: string;
}

export function AgentStatusRow({ agent, onDrillDown, className }: AgentStatusRowProps) {
  const config = HEALTH_CONFIG[agent.health];

  return (
    <motion.div
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.2 }}
      whileHover={{ backgroundColor: "var(--color-muted)" }}
      className={cn(
        "group flex items-center gap-4 rounded-lg border border-border/50 bg-card p-4 transition-colors cursor-pointer",
        agent.health === "errored" && "border-red-500/30",
        agent.health === "active" && "border-green-500/20",
        className
      )}
      onClick={() => onDrillDown?.(agent)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onDrillDown?.(agent);
        }
      }}
    >
      {/* Health Indicator */}
      <div className="flex-shrink-0">
        <div className="relative">
          <div className={cn("h-3 w-3 rounded-full", config.bgColor)} />
          {config.pulse && (
            <motion.div
              className={cn("absolute inset-0 h-3 w-3 rounded-full", config.bgColor, "opacity-60")}
              animate={{ scale: [1, 1.8, 1], opacity: [0.6, 0, 0.6] }}
              transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
            />
          )}
        </div>
      </div>

      {/* Agent Info */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-sm truncate">{agent.name}</span>
          {agent.label && (
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
              {agent.label}
            </Badge>
          )}
          <span className={cn("text-xs font-medium", config.color)}>
            {config.label}
          </span>
        </div>
        <p className="text-xs text-muted-foreground truncate mt-0.5">
          {agent.currentTask || "No active task"}
        </p>
      </div>

      {/* Tags */}
      {agent.tags && agent.tags.length > 0 && (
        <div className="hidden lg:flex items-center gap-1 flex-shrink-0">
          {agent.tags.slice(0, 2).map((tag) => (
            <Badge key={tag} variant="outline" className="text-[10px] px-1.5 py-0">
              {tag}
            </Badge>
          ))}
          {agent.tags.length > 2 && (
            <span className="text-[10px] text-muted-foreground">+{agent.tags.length - 2}</span>
          )}
        </div>
      )}

      {/* Resource Usage */}
      <div className="hidden sm:flex items-center gap-4 text-xs text-muted-foreground flex-shrink-0">
        <TooltipProvider delayDuration={300}>
          {/* Tokens */}
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-1">
                <Activity className="h-3 w-3" />
                <span>{formatTokenCount(agent.resources.tokensUsed)}</span>
              </div>
            </TooltipTrigger>
            <TooltipContent>
              <p>{agent.resources.tokensUsed.toLocaleString()} tokens</p>
            </TooltipContent>
          </Tooltip>

          {/* Cost */}
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-1">
                <Coins className="h-3 w-3" />
                <span>{formatCost(agent.resources.estimatedCost)}</span>
              </div>
            </TooltipTrigger>
            <TooltipContent>
              <p>Estimated cost: {formatCost(agent.resources.estimatedCost)}</p>
            </TooltipContent>
          </Tooltip>

          {/* Duration */}
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-1">
                <Clock className="h-3 w-3" />
                <span>{formatDuration(agent.resources.durationMs)}</span>
              </div>
            </TooltipTrigger>
            <TooltipContent>
              <p>Session duration: {formatDuration(agent.resources.durationMs)}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      {/* Last Activity */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground flex-shrink-0">
        <span className="hidden md:inline">{formatRelativeTime(agent.lastActivityAt)}</span>
        {agent.pendingApprovals && agent.pendingApprovals > 0 && (
          <Badge variant="warning" className="text-[10px] px-1.5 py-0">
            {agent.pendingApprovals} pending
          </Badge>
        )}
      </div>

      {/* Drill-down arrow */}
      <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
    </motion.div>
  );
}
