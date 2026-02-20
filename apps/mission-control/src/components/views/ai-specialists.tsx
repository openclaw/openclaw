"use client";

import { createElement, useState, useEffect, useCallback, useMemo } from "react";
import * as LucideIcons from "lucide-react";
import {
  Bot,
  Search,
  X,
  ChevronRight,
  ChevronDown,
  MessageSquare,
  Sparkles,
  CheckCircle2,
  Clock,
  AlertTriangle,
  Loader2,
  Copy,
  Check,
  Zap,
  Users,
  ArrowRight,
  RefreshCw,
  GraduationCap,
  Building2,
  Wrench,
  Star,
  GitCompare,
  LayoutGrid,
  LayoutList,
  Send,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  getSpecializedAgents,
  getSpecializedAgent,
  suggestAgentForTask,
  getAgentsByCategory,
  getAgentTeams,
  type SpecializedAgent,
  type AgentTeam,
} from "@/lib/agent-registry";
import { TeamTemplatesSection } from "./team-templates";
import { timeAgo } from "@/lib/shared";

// --- Types ---

interface AgentStatus {
  agentId: string;
  status: "available" | "busy" | "offline";
  currentTask?: string;
  taskCount: number;
  qualityScore: number;
  confidence: number;
  trend: "improving" | "steady" | "needs_attention";
  approvalRate: number;
  reworkRate: number;
  avgFeedbackRating: number | null;
  feedbackCount: number;
  improvementFocus: string;
  strengths: string[];
}

interface RecentTask {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
}

interface Task {
  id: string;
  title: string;
  description: string;
  priority: string;
  status: string;
  assigned_agent_id: string | null;
  created_at?: string;
  updated_at?: string;
}

interface AISpecialistsProps {
  tasks?: Task[];
  workspaceId?: string;
  onAssignTask?: (taskId: string, agentId: string) => void;
  onStartChat?: (agentId: string) => void;
  onNavigateToTask?: (taskId: string) => void;
  onCreateAndAssignTask?: (data: {
    title: string;
    description: string;
    agentId: string;
  }) => Promise<boolean> | boolean;
}

interface SpecialistsApiResponse {
  specialists?: Array<{
    id: string;
    status: "idle" | "busy";
    activeTaskCount: number;
    intelligence?: {
      qualityScore: number;
      confidence: number;
      trend: "improving" | "steady" | "needs_attention";
      approvalRate: number;
      reworkRate: number;
      avgCycleMinutes: number;
      avgFeedbackRating: number | null;
      feedbackCount: number;
      tasksAssigned: number;
      tasksDone: number;
      tasksInReview: number;
      activeTasks: number;
      strengths: string[];
      improvementFocus: string;
      generatedAt: string;
    };
  }>;
  error?: string;
}

interface SpecialistRecommendation {
  agentId: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  score: number;
  confidence: number;
  reasons: string[];
  intelligence: {
    qualityScore: number;
    trend: "improving" | "steady" | "needs_attention";
  };
  available: boolean;
}

interface RecommendationApiResponse {
  recommendations?: SpecialistRecommendation[];
}

type SuggestionChannel = "learning_hub" | "workspace" | "openclaw";

interface SpecialistSuggestion {
  id: string;
  channel: SuggestionChannel;
  title: string;
  summary: string;
  rationale: string;
  actions: string[];
  priority: "high" | "medium" | "low";
  confidence: number;
  specialistId: string;
  specialistName: string;
  specialistIcon: string;
  specialistColor: string;
  workspaceId: string | null;
  generatedAt: string;
}

interface SuggestionApiResponse {
  workspaceId?: string | null;
  suggestions?: Record<SuggestionChannel, SpecialistSuggestion[]>;
  generatedAt?: string;
  error?: string;
}

const CHANNEL_META: Record<
  SuggestionChannel,
  {
    label: string;
    subtitle: string;
    icon: LucideIcons.LucideIcon;
  }
> = {
  learning_hub: {
    label: "Learning Hub",
    subtitle: "Specialist learning recommendations",
    icon: GraduationCap,
  },
  workspace: {
    label: "Workspace",
    subtitle: "Execution and ownership recommendations",
    icon: Building2,
  },
  openclaw: {
    label: "OpenClaw",
    subtitle: "Platform-level improvement recommendations",
    icon: Wrench,
  },
};

// --- Icon Helper ---

function getIconComponent(iconName: string): LucideIcons.LucideIcon {
  const icons = LucideIcons as unknown as Record<string, LucideIcons.LucideIcon>;
  const Icon = icons[iconName];
  return Icon || Bot; // Fallback
}

function AgentIcon({
  iconName,
  className,
}: {
  iconName: string;
  className?: string;
}) {
  return createElement(getIconComponent(iconName), {
    className,
    "aria-hidden": true,
  });
}

function toRecentTaskStatus(status: string): RecentTask["status"] {
  if (status === "done") return "completed";
  if (status === "in_progress" || status === "assigned") return "in_progress";
  if (status === "inbox" || status === "review") return "pending";
  return "failed";
}

function getRecentTasksForAgent(tasks: Task[], agentId: string): RecentTask[] {
  return tasks
    .filter((task) => task.assigned_agent_id === agentId)
    .sort((a, b) => {
      const aTs = new Date(a.updated_at || a.created_at || 0).getTime();
      const bTs = new Date(b.updated_at || b.created_at || 0).getTime();
      return bTs - aTs;
    })
    .slice(0, 8)
    .map((task) => {
      const startedAt = task.created_at || task.updated_at || new Date().toISOString();
      const updatedAt = task.updated_at || startedAt;
      return {
        id: task.id,
        title: task.title,
        status: toRecentTaskStatus(task.status),
        startedAt,
        updatedAt,
        completedAt: task.status === "done" ? updatedAt : undefined,
      };
    });
}

function useAgentStatuses(
  agents: SpecializedAgent[],
  tasks: Task[],
  workspaceId?: string
) {
  const completedTaskCountByAgent = useMemo(() => {
    const counts = new Map<string, number>();
    for (const task of tasks) {
      if (!task.assigned_agent_id || task.status !== "done") continue;
      counts.set(
        task.assigned_agent_id,
        (counts.get(task.assigned_agent_id) ?? 0) + 1
      );
    }
    return counts;
  }, [tasks]);

  const [statuses, setStatuses] = useState<Record<string, AgentStatus>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string | null>(null);

  const buildFallbackStatuses = useCallback(() => {
    const next: Record<string, AgentStatus> = {};
    for (const agent of agents) {
      const hasActiveTask = tasks.some(
        (task) =>
          task.assigned_agent_id === agent.id &&
          (task.status === "in_progress" || task.status === "assigned")
      );
      next[agent.id] = {
        agentId: agent.id,
        status: hasActiveTask ? "busy" : "offline",
        taskCount: completedTaskCountByAgent.get(agent.id) ?? 0,
        currentTask: hasActiveTask ? "Working on active tasks" : undefined,
        qualityScore: 50,
        confidence: 0.2,
        trend: "steady",
        approvalRate: 0,
        reworkRate: 0,
        avgFeedbackRating: null,
        feedbackCount: 0,
        improvementFocus: "Build track record with completed and reviewed tasks.",
        strengths: agent.capabilities.slice(0, 3),
      };
    }
    return next;
  }, [agents, completedTaskCountByAgent, tasks]);

  const refresh = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (workspaceId) {
        params.set("workspace_id", workspaceId);
      }
      const url = params.toString()
        ? `/api/agents/specialists?${params.toString()}`
        : "/api/agents/specialists";
      const res = await fetch(url);
      const data = (await res.json()) as SpecialistsApiResponse;
      if (!res.ok) {
        throw new Error(data.error || `Failed to fetch specialists (${res.status})`);
      }

      const statusById = new Map(
        (data.specialists || []).map((specialist) => [specialist.id, specialist])
      );

      const next: Record<string, AgentStatus> = {};
      for (const agent of agents) {
        const specialist = statusById.get(agent.id);
        next[agent.id] = {
          agentId: agent.id,
          status: specialist
            ? specialist.status === "busy"
              ? "busy"
              : "available"
            : "offline",
          taskCount: completedTaskCountByAgent.get(agent.id) ?? 0,
          currentTask:
            specialist && specialist.activeTaskCount > 0
              ? `${specialist.activeTaskCount} active task${specialist.activeTaskCount > 1 ? "s" : ""
              }`
              : undefined,
          qualityScore: specialist?.intelligence?.qualityScore ?? 50,
          confidence: specialist?.intelligence?.confidence ?? 0.2,
          trend: specialist?.intelligence?.trend ?? "steady",
          approvalRate: specialist?.intelligence?.approvalRate ?? 0,
          reworkRate: specialist?.intelligence?.reworkRate ?? 0,
          avgFeedbackRating: specialist?.intelligence?.avgFeedbackRating ?? null,
          feedbackCount: specialist?.intelligence?.feedbackCount ?? 0,
          improvementFocus:
            specialist?.intelligence?.improvementFocus ??
            "Build track record with completed and reviewed tasks.",
          strengths: specialist?.intelligence?.strengths ?? agent.capabilities.slice(0, 3),
        };
      }

      setStatuses(next);
      setError(null);
      setLastRefreshedAt(new Date().toISOString());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch specialists");
      setStatuses((prev) => {
        if (Object.keys(prev).length > 0) return prev;
        return buildFallbackStatuses();
      });
    } finally {
      setLoading(false);
    }
  }, [agents, buildFallbackStatuses, completedTaskCountByAgent, workspaceId]);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => {
      void refresh();
    }, 15000);
    return () => clearInterval(interval);
  }, [refresh]);

  return { statuses, loading, error, refresh, lastRefreshedAt };
}

// --- Status Badge Component ---

function StatusBadge({ status }: { status: "available" | "busy" | "offline" }) {
  const config = {
    available: {
      color: "bg-green-500",
      pulse: true,
      label: "Available",
    },
    busy: {
      color: "bg-amber-500",
      pulse: false,
      label: "Busy",
    },
    offline: {
      color: "bg-slate-500",
      pulse: false,
      label: "Offline",
    },
  };

  const { color, pulse, label } = config[status];

  return (
    <div className="flex items-center gap-1.5" role="status" aria-label={`Agent status: ${label}`}>
      <span className={`relative flex h-2 w-2`}>
        {pulse && (
          <span
            className={`animate-ping absolute inline-flex h-full w-full rounded-full ${color} opacity-75`}
          />
        )}
        <span className={`relative inline-flex rounded-full h-2 w-2 ${color}`} />
      </span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

// --- Quality Score Ring Component ---

interface QualityScoreRingProps {
  score: number;        // 0-100
  size?: number;        // default 32
  strokeWidth?: number; // default 3
  className?: string;
}

function QualityScoreRing({
  score,
  size = 32,
  strokeWidth = 3,
  className,
}: QualityScoreRingProps) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (Math.min(Math.max(score, 0), 100) / 100) * circumference;

  // Color based on score threshold
  const strokeColor =
    score >= 80
      ? "oklch(0.72 0.19 142)"  // green
      : score >= 60
        ? "oklch(0.78 0.18 85)"   // yellow
        : "oklch(0.65 0.24 27)";  // red

  const fontSize = Math.max(8, size * 0.3);

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={className}
      role="img"
      aria-label={`Quality score: ${score}`}
    >
      {/* Background track */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        className="text-muted/30"
      />
      {/* Colored arc */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={strokeColor}
        strokeWidth={strokeWidth}
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        className="transition-all duration-500 ease-out"
      />
      {/* Score number centered */}
      <text
        x={size / 2}
        y={size / 2}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={fontSize}
        fontWeight="600"
        fill="currentColor"
        className="text-foreground"
      >
        {score}
      </text>
    </svg>
  );
}

// --- Trend Sparkline Component ---

interface TrendSparklineProps {
  trend: "improving" | "steady" | "needs_attention";
  className?: string;
}

function TrendSparkline({ trend, className }: TrendSparklineProps) {
  const width = 48;
  const height = 16;
  const padding = 2;

  const dataPoints: Record<TrendSparklineProps["trend"], number[]> = {
    improving: [4, 6, 5, 8, 12],
    steady: [6, 7, 6, 7, 6],
    needs_attention: [10, 8, 9, 6, 4],
  };

  const colorMap: Record<TrendSparklineProps["trend"], string> = {
    improving: "oklch(0.72 0.19 142)",     // green
    steady: "oklch(0.78 0.18 85)",         // yellow
    needs_attention: "oklch(0.65 0.24 27)", // red
  };

  const points = dataPoints[trend];
  const color = colorMap[trend];

  const maxVal = Math.max(...points);
  const minVal = Math.min(...points);
  const range = maxVal - minVal || 1;

  // Map data points to SVG coordinates
  const coords = points.map((val, i) => {
    const x = padding + (i / (points.length - 1)) * (width - padding * 2);
    const y = padding + (1 - (val - minVal) / range) * (height - padding * 2);
    return { x, y };
  });

  const polylinePoints = coords.map((c) => `${c.x},${c.y}`).join(" ");

  // Build the filled polygon path (line + close along bottom)
  const fillPoints = [
    ...coords.map((c) => `${c.x},${c.y}`),
    `${coords[coords.length - 1].x},${height}`,
    `${coords[0].x},${height}`,
  ].join(" ");

  const gradientId = `sparkline-gradient-${trend}`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      role="img"
      aria-label={`Trend: ${trend.replace("_", " ")}`}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.1" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {/* Subtle fill below the line */}
      <polygon
        points={fillPoints}
        fill={`url(#${gradientId})`}
      />
      {/* Sparkline */}
      <polyline
        points={polylinePoints}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// --- Agent Card Component (Rebuilt) ---

interface AgentCardProps {
  agent: SpecializedAgent;
  status: AgentStatus;
  isSelected: boolean;
  isFavorite: boolean;
  isComparing: boolean;
  showCheckbox: boolean;
  onSelect: () => void;
  onAssignTask: () => void;
  onToggleFavorite: () => void;
  onToggleCompare: () => void;
}

function AgentCard({
  agent,
  status,
  isSelected,
  isFavorite,
  isComparing,
  showCheckbox,
  onSelect,
  onAssignTask,
  onToggleFavorite,
  onToggleCompare,
}: AgentCardProps) {
  return (
    <article
      role="button"
      tabIndex={0}
      aria-pressed={isSelected}
      aria-label={`${agent.name} agent. ${agent.description}. Status: ${status.status}`}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={`
        group relative bg-card border rounded-xl p-5 cursor-pointer
        transition-all duration-200 ease-out
        hover:border-primary/50 hover:shadow-[0_0_20px_oklch(0.58_0.2_260/0.15)]
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2
        ${isSelected ? "border-primary shadow-[0_0_25px_oklch(0.58_0.2_260/0.2)]" : "border-border"}
        ${isComparing ? "ring-2 ring-primary" : ""}
      `}
    >
      {/* Glassmorphism effect */}
      <div className="absolute inset-0 rounded-xl bg-gradient-to-br from-primary/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />

      <div className="relative">
        {/* Favorite star button (top-right corner) */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleFavorite();
          }}
          className="absolute top-0 right-0 p-1 rounded-md hover:bg-muted/50 transition-colors z-10"
          aria-label={isFavorite ? `Remove ${agent.name} from favorites` : `Add ${agent.name} to favorites`}
        >
          <Star
            className={`w-4 h-4 transition-colors ${isFavorite
                ? "fill-yellow-400 text-yellow-400"
                : "text-muted-foreground hover:text-yellow-400"
              }`}
          />
        </button>

        {/* Header row: icon + status badge */}
        <div className="flex items-start justify-between mb-3 pr-6">
          <div
            className={`w-12 h-12 rounded-xl bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center ${agent.color}`}
          >
            <AgentIcon iconName={agent.icon} className="w-6 h-6" />
          </div>
          <StatusBadge status={status.status} />
        </div>

        {/* Name & Description */}
        <h3 className="font-semibold text-lg mb-1">{agent.name}</h3>
        <p className="text-sm text-muted-foreground line-clamp-2 mb-4">
          {agent.description}
        </p>

        {/* Capability Tags */}
        <div className="flex flex-wrap gap-1.5 mb-4" role="list" aria-label="Capabilities">
          {agent.capabilities.slice(0, 4).map((cap) => (
            <Badge
              key={cap}
              variant="outline"
              className="text-xs px-2 py-0.5 bg-primary/5 border-primary/20"
              role="listitem"
            >
              {cap}
            </Badge>
          ))}
          {agent.capabilities.length > 4 && (
            <Badge variant="outline" className="text-xs px-2 py-0.5">
              +{agent.capabilities.length - 4}
            </Badge>
          )}
        </div>

        {/* Bottom row: QualityScoreRing + TrendSparkline + trend label + task count */}
        <div className="flex items-center justify-between mb-3">
          <QualityScoreRing score={status.qualityScore} size={32} strokeWidth={3} />
          <div className="flex items-center gap-1.5">
            <TrendSparkline trend={status.trend} />
            <span className="text-[11px] text-muted-foreground capitalize">
              {status.trend.replace("_", " ")}
            </span>
          </div>
          <span className="text-xs text-muted-foreground">
            {status.taskCount} tasks
          </span>
        </div>

        {/* Footer: Assign Task button */}
        <div className="flex items-center justify-end">
          <Button
            size="sm"
            variant="outline"
            onClick={(e) => {
              e.stopPropagation();
              onAssignTask();
            }}
            className="h-8 text-xs hover:bg-primary hover:text-primary-foreground transition-colors"
            aria-label={`Assign task to ${agent.name}`}
          >
            <Zap className="w-3 h-3 mr-1" aria-hidden="true" />
            Assign Task
          </Button>
        </div>

        {/* Checkbox (conditionally shown in bottom-left for comparison mode) */}
        {showCheckbox && (
          <div className="absolute bottom-0 left-0">
            <input
              type="checkbox"
              checked={isComparing}
              onChange={(e) => {
                e.stopPropagation();
                onToggleCompare();
              }}
              onClick={(e) => e.stopPropagation()}
              className="w-4 h-4 rounded border-border accent-primary cursor-pointer"
              aria-label={`Compare ${agent.name}`}
            />
          </div>
        )}
      </div>
    </article>
  );
}

// --- Agent List Row Component ---

interface AgentListRowProps {
  agent: SpecializedAgent;
  status: AgentStatus;
  isFavorite: boolean;
  isComparing: boolean;
  onSelect: () => void;
  onAssignTask: () => void;
  onToggleFavorite: () => void;
  onToggleCompare: () => void;
}

function AgentListRow({
  agent,
  status,
  isFavorite,
  isComparing,
  onSelect,
  onAssignTask,
  onToggleFavorite,
  onToggleCompare,
}: AgentListRowProps) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className="flex items-center gap-3 px-4 py-3 border-b border-border hover:bg-muted/30 transition-colors cursor-pointer"
      aria-label={`${agent.name} agent. Status: ${status.status}`}
    >
      {/* Checkbox */}
      <input
        type="checkbox"
        checked={isComparing}
        onChange={(e) => {
          e.stopPropagation();
          onToggleCompare();
        }}
        onClick={(e) => e.stopPropagation()}
        className="w-4 h-4 rounded border-border accent-primary cursor-pointer shrink-0"
        aria-label={`Compare ${agent.name}`}
      />

      {/* Agent icon (24x24) */}
      <div
        className={`w-6 h-6 rounded-md bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center shrink-0 ${agent.color}`}
      >
        <AgentIcon iconName={agent.icon} className="w-3.5 h-3.5" />
      </div>

      {/* Name (flex-1) */}
      <span className="flex-1 text-sm font-medium truncate min-w-0">
        {agent.name}
      </span>

      {/* Quality Score Ring */}
      <QualityScoreRing score={status.qualityScore} size={24} strokeWidth={2.5} className="shrink-0" />

      {/* Status Badge */}
      <div className="shrink-0">
        <StatusBadge status={status.status} />
      </div>

      {/* Capabilities count badge */}
      <Badge variant="outline" className="text-[10px] px-2 py-0 h-5 shrink-0">
        {agent.capabilities.length} cap{agent.capabilities.length !== 1 ? "s" : ""}
      </Badge>

      {/* Trend text */}
      <span className="text-[11px] text-muted-foreground capitalize shrink-0 w-20 text-center">
        {status.trend.replace("_", " ")}
      </span>

      {/* Favorite star */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onToggleFavorite();
        }}
        className="p-1 rounded-md hover:bg-muted/50 transition-colors shrink-0"
        aria-label={isFavorite ? `Remove ${agent.name} from favorites` : `Add ${agent.name} to favorites`}
      >
        <Star
          className={`w-4 h-4 transition-colors ${isFavorite
              ? "fill-yellow-400 text-yellow-400"
              : "text-muted-foreground hover:text-yellow-400"
            }`}
        />
      </button>

      {/* Assign button */}
      <Button
        size="sm"
        variant="outline"
        onClick={(e) => {
          e.stopPropagation();
          onAssignTask();
        }}
        className="h-7 text-xs px-2.5 hover:bg-primary hover:text-primary-foreground transition-colors shrink-0"
        aria-label={`Assign task to ${agent.name}`}
      >
        <Zap className="w-3 h-3 mr-1" aria-hidden="true" />
        Assign
      </Button>
    </div>
  );
}

// --- Star Rating Helper (inline) ---

function StarRating({ rating, max = 5 }: { rating: number; max?: number }) {
  return (
    <div className="flex items-center gap-0.5" role="img" aria-label={`${rating.toFixed(1)} out of ${max} stars`}>
      {Array.from({ length: max }, (_, i) => {
        const fill = Math.min(Math.max(rating - i, 0), 1);
        const gradientId = `star-fill-${i}-${Math.round(fill * 100)}`;
        return (
          <svg
            key={i}
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <defs>
              <linearGradient id={gradientId}>
                <stop offset={`${fill * 100}%`} stopColor="oklch(0.80 0.18 85)" />
                <stop offset={`${fill * 100}%`} stopColor="currentColor" stopOpacity="0.15" />
              </linearGradient>
            </defs>
            <path
              d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"
              fill={`url(#${gradientId})`}
              stroke="oklch(0.80 0.18 85)"
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
          </svg>
        );
      })}
    </div>
  );
}

// --- Metric Quality Bar Helper (inline) ---

function MetricBar({ value, max, variant }: { value: number; max: number; variant: "green" | "amber" | "red" | "blue" }) {
  const pct = Math.min(Math.max((value / max) * 100, 0), 100);
  const colorMap = {
    green: "bg-green-500/70",
    amber: "bg-amber-500/70",
    red: "bg-red-500/70",
    blue: "bg-primary/70",
  };
  return (
    <div className="mt-1.5 h-1 w-full rounded-full bg-muted/40 overflow-hidden">
      <div
        className={`h-full rounded-full transition-all duration-500 ease-out ${colorMap[variant]}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

// --- Agent Detail Panel ---

interface AgentDetailPanelProps {
  agent: SpecializedAgent;
  status: AgentStatus;
  recentTasks: RecentTask[];
  isFavorite: boolean;
  isComparing: boolean;
  onClose: () => void;
  onStartChat: () => void;
  onAssignTask: () => void;
  onNavigateToTask?: (taskId: string) => void;
  onToggleFavorite: () => void;
  onToggleCompare: () => void;
}

function AgentDetailPanel({
  agent,
  status,
  recentTasks,
  isFavorite,
  isComparing,
  onClose,
  onStartChat,
  onAssignTask,
  onNavigateToTask,
  onToggleFavorite,
  onToggleCompare,
}: AgentDetailPanelProps) {
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const copyPrompt = useCallback(() => {
    navigator.clipboard.writeText(agent.systemPrompt);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [agent.systemPrompt]);

  // Get preview (first 150 chars)
  const promptPreview = useMemo(() => {
    return agent.systemPrompt.slice(0, 150) + "...";
  }, [agent.systemPrompt]);

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/50 z-40 animate-in fade-in duration-200"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Panel */}
      <div
        className="fixed inset-y-0 right-0 w-full max-w-lg bg-card border-l border-border shadow-2xl z-50 flex flex-col min-h-0 animate-in slide-in-from-right duration-300"
        role="complementary"
        aria-label={`${agent.name} details panel`}
      >
        {/* Header */}
        <div className="flex items-start justify-between p-6 border-b border-border shrink-0">
          <div className="flex items-center gap-4">
            <div
              className={`w-14 h-14 rounded-xl bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center ${agent.color}`}
            >
              <AgentIcon iconName={agent.icon} className="w-7 h-7" />
            </div>
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-3">
                <h2 className="text-xl font-bold">{agent.name}</h2>
                <QualityScoreRing score={status.qualityScore} size={48} strokeWidth={4} />
              </div>
              <div className="flex items-center gap-2">
                <StatusBadge status={status.status} />
                <TrendSparkline trend={status.trend} />
                <span className="text-[11px] text-muted-foreground capitalize">
                  {status.trend.replace("_", " ")}
                </span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={onToggleFavorite}
              className="p-2 rounded-md hover:bg-muted/50 transition-colors"
              aria-label={isFavorite ? `Remove ${agent.name} from favorites` : `Add ${agent.name} to favorites`}
            >
              <Star
                className={`w-5 h-5 transition-colors ${isFavorite
                    ? "fill-yellow-400 text-yellow-400"
                    : "text-muted-foreground hover:text-yellow-400"
                  }`}
              />
            </button>
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              aria-label="Close panel"
              className="hover:bg-destructive/10 hover:text-destructive"
            >
              <X className="w-5 h-5" />
            </Button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="p-6 space-y-6">
            {/* About */}
            <section aria-labelledby="detail-description-heading">
              <h3 id="detail-description-heading" className="text-sm font-medium text-muted-foreground uppercase tracking-wide mb-2">
                About
              </h3>
              <p className="text-sm">{agent.description}</p>
            </section>

            {/* Capabilities */}
            <section aria-labelledby="detail-capabilities-heading">
              <h3 id="detail-capabilities-heading" className="text-sm font-medium text-muted-foreground uppercase tracking-wide mb-3">
                Capabilities
              </h3>
              <div className="flex flex-wrap gap-2" role="list">
                {agent.capabilities.map((cap) => (
                  <Badge
                    key={cap}
                    variant="secondary"
                    className="bg-primary/10 text-primary border-primary/20"
                    role="listitem"
                  >
                    {cap}
                  </Badge>
                ))}
              </div>
            </section>

            {/* Quality Signals */}
            <section aria-labelledby="detail-quality-heading">
              <h3
                id="detail-quality-heading"
                className="text-sm font-medium text-muted-foreground uppercase tracking-wide mb-3"
              >
                Quality Signals
              </h3>
              <div className="grid grid-cols-2 gap-2">
                {/* Quality Score */}
                <div className="rounded-lg border border-border p-3 bg-muted/20">
                  <div className="text-[11px] text-muted-foreground">Quality Score</div>
                  <div className="text-lg font-semibold">{status.qualityScore}/100</div>
                  <MetricBar
                    value={status.qualityScore}
                    max={100}
                    variant={status.qualityScore >= 80 ? "green" : status.qualityScore >= 60 ? "amber" : "red"}
                  />
                </div>
                {/* Approval Rate */}
                <div className="rounded-lg border border-border p-3 bg-muted/20">
                  <div className="text-[11px] text-muted-foreground">Approval Rate</div>
                  <div className="text-lg font-semibold">
                    {Math.round(status.approvalRate * 100)}%
                  </div>
                  <MetricBar
                    value={status.approvalRate}
                    max={1}
                    variant={status.approvalRate >= 0.8 ? "green" : status.approvalRate >= 0.6 ? "amber" : "red"}
                  />
                </div>
                {/* Rework Rate */}
                <div className="rounded-lg border border-border p-3 bg-muted/20">
                  <div className="text-[11px] text-muted-foreground">Rework Rate</div>
                  <div className="text-lg font-semibold">
                    {Math.round(status.reworkRate * 100)}%
                  </div>
                  <MetricBar
                    value={status.reworkRate}
                    max={1}
                    variant={status.reworkRate <= 0.1 ? "green" : status.reworkRate <= 0.25 ? "amber" : "red"}
                  />
                </div>
                {/* Feedback */}
                <div className="rounded-lg border border-border p-3 bg-muted/20">
                  <div className="text-[11px] text-muted-foreground">Feedback</div>
                  <div className="text-lg font-semibold">
                    {status.avgFeedbackRating !== null
                      ? `${status.avgFeedbackRating}/5`
                      : "N/A"}
                  </div>
                  <MetricBar
                    value={status.avgFeedbackRating ?? 0}
                    max={5}
                    variant="blue"
                  />
                  <div className="text-[10px] text-muted-foreground mt-1">
                    Feedback Count: {status.feedbackCount} rating{status.feedbackCount !== 1 ? "s" : ""}
                  </div>
                </div>
              </div>
              <p className="mt-3 text-sm text-muted-foreground">
                <span className="font-medium text-foreground">Improvement focus:</span>{" "}
                {status.improvementFocus}
              </p>
              {status.strengths.length > 0 && (
                <ul className="mt-3 space-y-1 text-sm text-muted-foreground">
                  {status.strengths.map((strength) => (
                    <li key={strength} className="flex items-start gap-2">
                      <span className="mt-1 h-1.5 w-1.5 rounded-full bg-primary shrink-0" />
                      <span>{strength}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* Feedback Summary */}
            <section aria-labelledby="detail-feedback-summary-heading">
              <h3
                id="detail-feedback-summary-heading"
                className="text-sm font-medium text-muted-foreground uppercase tracking-wide mb-3"
              >
                Feedback Summary
              </h3>
              {status.avgFeedbackRating !== null && status.feedbackCount > 0 ? (
                <div className="rounded-lg border border-border p-4 bg-muted/20 space-y-2">
                  <StarRating rating={status.avgFeedbackRating} />
                  <p className="text-sm text-muted-foreground">
                    Based on {status.feedbackCount} rating{status.feedbackCount !== 1 ? "s" : ""}
                  </p>
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-border p-4 text-center">
                  <p className="text-sm text-muted-foreground">
                    No feedback yet — complete tasks to build track record
                  </p>
                </div>
              )}
            </section>

            {/* System Prompt */}
            <section aria-labelledby="detail-prompt-heading">
              <button
                onClick={() => setPromptExpanded(!promptExpanded)}
                className="flex items-center justify-between w-full text-left"
                aria-expanded={promptExpanded}
                aria-controls="detail-system-prompt-content"
              >
                <h3 id="detail-prompt-heading" className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
                  System Prompt
                </h3>
                {promptExpanded ? (
                  <ChevronDown className="w-4 h-4 text-muted-foreground" />
                ) : (
                  <ChevronRight className="w-4 h-4 text-muted-foreground" />
                )}
              </button>
              <div
                id="detail-system-prompt-content"
                className={`mt-3 overflow-hidden transition-all duration-200 ${promptExpanded ? "max-h-[500px]" : "max-h-20"
                  }`}
              >
                <div className="relative">
                  <pre className="text-xs bg-muted/50 border border-border rounded-lg p-4 whitespace-pre-wrap font-mono overflow-auto max-h-80">
                    {promptExpanded ? agent.systemPrompt : promptPreview}
                  </pre>
                  {promptExpanded && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={copyPrompt}
                      className="absolute top-2 right-2 h-7 px-2"
                      aria-label={copied ? "Copied!" : "Copy system prompt"}
                    >
                      {copied ? (
                        <Check className="w-3 h-3 text-green-500" />
                      ) : (
                        <Copy className="w-3 h-3" />
                      )}
                    </Button>
                  )}
                </div>
              </div>
            </section>

            {/* Suggested Tasks */}
            <section aria-labelledby="detail-suggested-heading">
              <h3 id="detail-suggested-heading" className="text-sm font-medium text-muted-foreground uppercase tracking-wide mb-3">
                Suggested Tasks
              </h3>
              <ul className="space-y-2" role="list">
                {agent.suggestedTasks.map((task, i) => (
                  <li
                    key={i}
                    className="flex items-center gap-2 text-sm p-2 rounded-lg bg-muted/30 hover:bg-muted/50 transition-colors cursor-pointer"
                    onClick={onAssignTask}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onAssignTask();
                      }
                    }}
                  >
                    <Sparkles className="w-3 h-3 text-primary shrink-0" aria-hidden="true" />
                    <span>{task}</span>
                  </li>
                ))}
              </ul>
            </section>

            {/* Recent Tasks */}
            <section aria-labelledby="detail-recent-heading">
              <h3 id="detail-recent-heading" className="text-sm font-medium text-muted-foreground uppercase tracking-wide mb-3">
                Recent Tasks
              </h3>
              {recentTasks.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
                  No recent tasks assigned to this specialist yet.
                </div>
              ) : (
                <ul className="space-y-2" role="list">
                  {recentTasks.map((task) => (
                    <li key={task.id}>
                      <button
                        className="w-full flex items-center justify-between p-3 rounded-lg border border-border bg-card/50 hover:bg-muted/30 transition-colors"
                        onClick={() => onNavigateToTask?.(task.id)}
                        disabled={!onNavigateToTask}
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          {task.status === "completed" && (
                            <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0" aria-label="Completed" />
                          )}
                          {task.status === "in_progress" && (
                            <Loader2 className="w-4 h-4 text-primary animate-spin shrink-0" aria-label="In progress" />
                          )}
                          {task.status === "pending" && (
                            <Clock className="w-4 h-4 text-muted-foreground shrink-0" aria-label="Pending" />
                          )}
                          {task.status === "failed" && (
                            <AlertTriangle className="w-4 h-4 text-destructive shrink-0" aria-label="Failed" />
                          )}
                          <span className="text-sm truncate">{task.title}</span>
                        </div>
                        <span className="text-xs text-muted-foreground shrink-0">
                          {timeAgo(task.updatedAt)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="p-6 border-t border-border bg-card/80 backdrop-blur-sm shrink-0">
          <div className="grid grid-cols-4 gap-2">
            <Button
              variant="outline"
              className="flex-1"
              onClick={onAssignTask}
              aria-label={`Assign task to ${agent.name}`}
            >
              <Zap className="w-4 h-4 mr-2" aria-hidden="true" />
              Assign
            </Button>
            <Button
              className="flex-1"
              onClick={onStartChat}
              aria-label={`Start chat with ${agent.name}`}
            >
              <MessageSquare className="w-4 h-4 mr-2" aria-hidden="true" />
              Chat
            </Button>
            <Button
              variant={isComparing ? "secondary" : "outline"}
              className={`flex-1 ${isComparing ? "ring-2 ring-primary" : ""}`}
              onClick={onToggleCompare}
              aria-label={isComparing ? `Stop comparing ${agent.name}` : `Compare ${agent.name}`}
              aria-pressed={isComparing}
            >
              <GitCompare className="w-4 h-4 mr-2" aria-hidden="true" />
              {isComparing ? "Comparing" : "Compare"}
            </Button>
            <Button
              variant={isFavorite ? "secondary" : "outline"}
              className="flex-1"
              onClick={onToggleFavorite}
              aria-label={isFavorite ? `Remove ${agent.name} from favorites` : `Add ${agent.name} to favorites`}
              aria-pressed={isFavorite}
            >
              <Star
                className={`w-4 h-4 mr-2 ${isFavorite ? "fill-yellow-400 text-yellow-400" : ""}`}
                aria-hidden="true"
              />
              {isFavorite ? "Saved" : "Favorite"}
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}

// --- Quick Assign Dialog ---

function QuickAssignDialog({
  open,
  onOpenChange,
  tasks,
  agents,
  agentStatuses,
  workspaceId,
  onAssign,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tasks: Task[];
  agents: SpecializedAgent[];
  agentStatuses: AgentStatus[];
  workspaceId?: string;
  onAssign: (taskIds: string[], agentId: string) => void;
}) {
  const [selectedTasks, setSelectedTasks] = useState<Set<string>>(new Set());
  const [selectedAgent, setSelectedAgent] = useState<string>("");

  const unassignedTasks = useMemo(
    () => tasks.filter((t) => !t.assigned_agent_id && t.status !== "done"),
    [tasks]
  );

  const handleAssign = () => {
    if (selectedTasks.size > 0 && selectedAgent) {
      onAssign(Array.from(selectedTasks), selectedAgent);
      setSelectedTasks(new Set());
      setSelectedAgent("");
      onOpenChange(false);
    }
  };

  const toggleTask = (taskId: string) => {
    setSelectedTasks((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) {
        next.delete(taskId);
      } else {
        next.add(taskId);
      }
      return next;
    });
  };

  const selectAll = () => {
    if (unassignedTasks.length > 0 && selectedTasks.size === unassignedTasks.length) {
      setSelectedTasks(new Set());
    } else {
      setSelectedTasks(new Set(unassignedTasks.map((t) => t.id)));
    }
  };

  const allSelected =
    unassignedTasks.length > 0 && selectedTasks.size === unassignedTasks.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="w-5 h-5 text-primary" />
            Bulk Assign Tasks
          </DialogTitle>
          <DialogDescription>
            Select multiple tasks and assign them to a specialist agent.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 space-y-4">
          {/* Task Selection */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-sm font-medium">Select Tasks ({selectedTasks.size} selected)</h4>
              <Button variant="ghost" size="sm" onClick={selectAll}>
                {allSelected ? "Deselect All" : "Select All"}
              </Button>
            </div>
            <ScrollArea className="h-48 border border-border rounded-lg">
              <div className="p-2 space-y-1">
                {unassignedTasks.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-4">
                    No unassigned tasks available
                  </p>
                ) : (
                  unassignedTasks.map((task) => (
                    <label
                      key={task.id}
                      className={`flex items-center gap-3 p-2 rounded-lg cursor-pointer transition-colors ${selectedTasks.has(task.id)
                          ? "bg-primary/10 border border-primary/30"
                          : "hover:bg-muted/50"
                        }`}
                    >
                      <input
                        type="checkbox"
                        checked={selectedTasks.has(task.id)}
                        onChange={() => toggleTask(task.id)}
                        className="rounded border-border"
                        aria-label={`Select task: ${task.title}`}
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{task.title}</p>
                        <p className="text-xs text-muted-foreground truncate">
                          {task.description}
                        </p>
                      </div>
                      <Badge variant="outline" className="text-xs shrink-0">
                        {task.priority}
                      </Badge>
                    </label>
                  ))
                )}
              </div>
            </ScrollArea>
          </div>

          {/* Agent Selection */}
          <div>
            <h4 className="text-sm font-medium mb-2">Assign to Agent</h4>
            <Select value={selectedAgent} onValueChange={setSelectedAgent}>
              <SelectTrigger aria-label="Select agent">
                <SelectValue placeholder="Choose a specialist..." />
              </SelectTrigger>
              <SelectContent>
                {agents.map((agent) => {
                  const status = agentStatuses.find((s) => s.agentId === agent.id);
                  return (
                    <SelectItem key={agent.id} value={agent.id}>
                      <div className="flex items-center gap-2">
                        <AgentIcon iconName={agent.icon} className={`w-4 h-4 ${agent.color}`} />
                        <span>{agent.name}</span>
                        {typeof status?.qualityScore === "number" && (
                          <Badge variant="secondary" className="text-[10px] ml-1">
                            Q{status.qualityScore}
                          </Badge>
                        )}
                        {status?.status === "busy" && (
                          <Badge variant="outline" className="text-xs ml-2">
                            Busy
                          </Badge>
                        )}
                      </div>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>

          {/* Smart Suggestion */}
          {selectedTasks.size === 1 && (
            <SmartSuggestion
              task={unassignedTasks.find((t) => selectedTasks.has(t.id))!}
              workspaceId={workspaceId}
              onSelectAgent={setSelectedAgent}
            />
          )}
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-3 pt-4 border-t border-border">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleAssign}
            disabled={selectedTasks.size === 0 || !selectedAgent}
          >
            <ArrowRight className="w-4 h-4 mr-2" />
            Assign {selectedTasks.size} Task{selectedTasks.size !== 1 ? "s" : ""}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// --- Smart Suggestion Component ---

function SmartSuggestion({
  task,
  workspaceId,
  onSelectAgent,
}: {
  task: Task;
  workspaceId?: string;
  onSelectAgent: (agentId: string) => void;
}) {
  const [recommendation, setRecommendation] =
    useState<SpecialistRecommendation | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const fallback = suggestAgentForTask(`${task.title} ${task.description}`);

    const run = async () => {
      setLoading(true);
      try {
        const res = await fetch("/api/agents/specialists/recommend", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: task.title,
            description: task.description,
            limit: 1,
            workspace_id: workspaceId,
          }),
        });
        const data = (await res.json()) as RecommendationApiResponse;
        if (!cancelled && res.ok && data.recommendations && data.recommendations[0]) {
          setRecommendation(data.recommendations[0]);
          return;
        }
      } catch {
        // best effort; fallback below
      } finally {
        if (!cancelled) setLoading(false);
      }

      if (!cancelled) {
        if (fallback) {
          setRecommendation({
            agentId: fallback.id,
            name: fallback.name,
            description: fallback.description,
            icon: fallback.icon,
            color: fallback.color,
            score: 0.5,
            confidence: 0.5,
            reasons: ["Matched specialist capability profile"],
            intelligence: {
              qualityScore: 50,
              trend: "steady",
            },
            available: true,
          });
        } else {
          setRecommendation(null);
        }
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [task.description, task.id, task.title, workspaceId]);

  if (loading) {
    return (
      <div className="p-3 rounded-lg bg-primary/5 border border-primary/20">
        <div className="flex items-center gap-2 text-sm text-primary">
          <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
          Finding best specialist recommendation...
        </div>
      </div>
    );
  }

  if (!recommendation) return null;

  return (
    <div
      className="p-3 rounded-lg bg-primary/5 border border-primary/20"
      role="region"
      aria-label="Agent suggestion"
    >
      <div className="flex items-center gap-2 mb-2">
        <Sparkles className="w-4 h-4 text-primary" aria-hidden="true" />
        <span className="text-sm font-medium text-primary">Recommended Specialist</span>
      </div>
      <button
        onClick={() => onSelectAgent(recommendation.agentId)}
        className="flex items-center gap-3 w-full p-2 rounded-lg bg-card/50 hover:bg-card transition-colors text-left"
      >
        <div className={`w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center ${recommendation.color}`}>
          <AgentIcon iconName={recommendation.icon} className="w-4 h-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{recommendation.name}</p>
          <p className="text-xs text-muted-foreground truncate">
            {recommendation.reasons[0] || "Matched specialist profile"}
          </p>
          <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
            <span>Confidence {Math.round(recommendation.confidence * 100)}%</span>
            <span>·</span>
            <span>Quality {recommendation.intelligence.qualityScore}</span>
            <span>·</span>
            <span className="capitalize">{recommendation.intelligence.trend.replace("_", " ")}</span>
          </div>
        </div>
        <ChevronRight className="w-4 h-4 ml-auto text-muted-foreground" aria-hidden="true" />
      </button>
    </div>
  );
}

// --- Single Task Assign Dialog ---

function AssignTaskDialog({
  open,
  onOpenChange,
  agent,
  onAssign,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agent: SpecializedAgent | null;
  onAssign: (title: string, description: string) => Promise<boolean>;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (title.trim()) {
      setSubmitting(true);
      setSubmitError(null);
      const ok = await onAssign(title.trim(), description.trim());
      setSubmitting(false);
      if (ok) {
        setTitle("");
        setDescription("");
        onOpenChange(false);
      } else {
        setSubmitError("Failed to create and assign task. Please try again.");
      }
    }
  };

  if (!agent) return null;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          setSubmitError(null);
          setSubmitting(false);
        }
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <div className={`w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center ${agent.color}`}>
              <AgentIcon iconName={agent.icon} className="w-5 h-5" />
            </div>
            Assign Task to {agent.name}
          </DialogTitle>
          <DialogDescription>
            Create a new task and assign it directly to this specialist.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div>
            <label htmlFor="task-title" className="text-sm font-medium mb-2 block">
              Task Title
            </label>
            <input
              id="task-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What needs to be done?"
              maxLength={200}
              className="w-full px-3 py-2 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div>
            <label htmlFor="task-description" className="text-sm font-medium mb-2 block">
              Description
            </label>
            <textarea
              id="task-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Provide details, context, and requirements..."
              maxLength={2000}
              className="w-full px-3 py-2 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring min-h-[100px] resize-y"
            />
          </div>

          {/* Suggested from agent */}
          <div>
            <p className="text-xs text-muted-foreground mb-2">Quick suggestions:</p>
            <div className="flex flex-wrap gap-2">
              {agent.suggestedTasks.slice(0, 3).map((suggestion, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setTitle(suggestion)}
                  className="text-xs px-2 py-1 rounded-full bg-muted hover:bg-muted/80 transition-colors"
                >
                  {suggestion.length > 30 ? suggestion.slice(0, 30) + "..." : suggestion}
                </button>
              ))}
            </div>
          </div>
          {submitError && (
            <p className="text-sm text-destructive">{submitError}</p>
          )}
        </div>

        <div className="flex justify-end gap-3">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={() => void handleSubmit()} disabled={!title.trim() || submitting}>
            <Zap className="w-4 h-4 mr-2" />
            {submitting ? "Creating..." : "Create & Assign"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// --- StatsRibbon Component ---

interface StatsRibbonProps {
  totalAgents: number;
  available: number;
  busy: number;
  totalTasksCompleted: number;
  avgQuality: number;
  topPerformer: { name: string; score: number } | null;
}

function StatsRibbon({
  totalAgents,
  available,
  busy,
  totalTasksCompleted,
  avgQuality,
  topPerformer,
}: StatsRibbonProps) {
  const cards: Array<{
    label: string;
    value: string | number;
    sublabel?: string;
    colorClass: string;
  }> = [
      {
        label: "Total",
        value: totalAgents,
        sublabel: "agents",
        colorClass: "text-foreground",
      },
      {
        label: "Available",
        value: available,
        sublabel: "agents",
        colorClass: "text-green-500",
      },
      {
        label: "Busy",
        value: busy,
        sublabel: "agents",
        colorClass: "text-amber-500",
      },
      {
        label: "Tasks Done",
        value: totalTasksCompleted,
        colorClass: "text-primary",
      },
      {
        label: "Avg Quality",
        value: `${avgQuality}/100`,
        colorClass: "text-violet-500",
      },
      {
        label: "Top Performer",
        value: topPerformer?.name ?? "N/A",
        sublabel: topPerformer ? `Score ${topPerformer.score}` : undefined,
        colorClass: "text-primary",
      },
    ];

  return (
    <div
      className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3"
      role="region"
      aria-label="Specialist statistics"
    >
      {cards.map((card) => (
        <div key={card.label} className="glass-panel rounded-xl p-4">
          <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
            {card.label}
          </div>
          <div className={`text-2xl font-bold ${card.colorClass} truncate`}>
            {card.value}
          </div>
          {card.sublabel && (
            <div className="text-xs text-muted-foreground mt-0.5">
              {card.sublabel}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// --- ComparisonView Component ---

interface ComparisonViewProps {
  agents: SpecializedAgent[];
  statuses: AgentStatus[];
  onRemoveAgent: (agentId: string) => void;
  onClearAll: () => void;
  onAssignTask: (agentId: string) => void;
  onStartChat: (agentId: string) => void;
}

type ComparisonMetricKey =
  | "status"
  | "qualityScore"
  | "approvalRate"
  | "reworkRate"
  | "feedbackRating"
  | "tasksCompleted"
  | "trend"
  | "capabilities";

interface ComparisonRowDef {
  key: ComparisonMetricKey;
  label: string;
  getValue: (agent: SpecializedAgent, status: AgentStatus) => string | number;
  getNumeric: (agent: SpecializedAgent, status: AgentStatus) => number;
  bestIsHighest: boolean;
}

const COMPARISON_ROWS: ComparisonRowDef[] = [
  {
    key: "status",
    label: "Status",
    getValue: (_a, s) => s.status.charAt(0).toUpperCase() + s.status.slice(1),
    getNumeric: (_a, s) =>
      s.status === "available" ? 1 : s.status === "busy" ? 0 : -1,
    bestIsHighest: true,
  },
  {
    key: "qualityScore",
    label: "Quality Score",
    getValue: (_a, s) => s.qualityScore,
    getNumeric: (_a, s) => s.qualityScore,
    bestIsHighest: true,
  },
  {
    key: "approvalRate",
    label: "Approval Rate",
    getValue: (_a, s) => `${Math.round(s.approvalRate * 100)}%`,
    getNumeric: (_a, s) => s.approvalRate,
    bestIsHighest: true,
  },
  {
    key: "reworkRate",
    label: "Rework Rate",
    getValue: (_a, s) => `${Math.round(s.reworkRate * 100)}%`,
    getNumeric: (_a, s) => s.reworkRate,
    bestIsHighest: false,
  },
  {
    key: "feedbackRating",
    label: "Feedback Rating",
    getValue: (_a, s) =>
      s.avgFeedbackRating !== null ? `${s.avgFeedbackRating}/5` : "N/A",
    getNumeric: (_a, s) => s.avgFeedbackRating ?? 0,
    bestIsHighest: true,
  },
  {
    key: "tasksCompleted",
    label: "Tasks Completed",
    getValue: (_a, s) => s.taskCount,
    getNumeric: (_a, s) => s.taskCount,
    bestIsHighest: true,
  },
  {
    key: "trend",
    label: "Trend",
    getValue: (_a, s) =>
      s.trend === "improving"
        ? "Improving"
        : s.trend === "steady"
          ? "Steady"
          : "Needs Attention",
    getNumeric: (_a, s) =>
      s.trend === "improving" ? 2 : s.trend === "steady" ? 1 : 0,
    bestIsHighest: true,
  },
  {
    key: "capabilities",
    label: "Capabilities",
    getValue: (a) => a.capabilities.length,
    getNumeric: (a) => a.capabilities.length,
    bestIsHighest: true,
  },
];

function ComparisonView({
  agents,
  statuses,
  onRemoveAgent,
  onClearAll,
  onAssignTask,
  onStartChat,
}: ComparisonViewProps) {
  const getBestWorstIndices = (row: ComparisonRowDef) => {
    const values = agents.map((agent, i) => row.getNumeric(agent, statuses[i]));
    const sorted = [...values].sort((a, b) =>
      row.bestIsHighest ? b - a : a - b,
    );
    const bestVal = sorted[0];
    const worstVal = sorted[sorted.length - 1];
    const allSame = bestVal === worstVal;
    return {
      bestIdx: allSame ? -1 : values.indexOf(bestVal),
      worstIdx: allSame ? -1 : values.lastIndexOf(worstVal),
    };
  };

  return (
    <div
      className="glass-panel rounded-xl overflow-hidden"
      role="region"
      aria-label="Agent comparison"
    >
      {/* Header with clear button */}
      <div className="flex items-center justify-between px-5 py-3 bg-muted/30 border-b border-border">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Comparison
        </h3>
        <Button variant="ghost" size="sm" onClick={onClearAll}>
          <X className="w-3.5 h-3.5 mr-1" aria-hidden="true" />
          Clear Comparison
        </Button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="bg-muted/30">
              <th className="text-left px-4 py-3 border-b border-border w-40 text-xs uppercase tracking-wide text-muted-foreground">
                Metric
              </th>
              {agents.map((agent) => (
                <th
                  key={agent.id}
                  className="px-4 py-3 border-b border-border border-l border-l-border text-center min-w-[160px]"
                >
                  <div className="flex flex-col items-center gap-2">
                    <div
                      className={`w-10 h-10 rounded-lg bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center ${agent.color}`}
                    >
                      <AgentIcon iconName={agent.icon} className="w-5 h-5" />
                    </div>
                    <span className="font-semibold text-sm">{agent.name}</span>
                    <button
                      onClick={() => onRemoveAgent(agent.id)}
                      className="text-xs text-muted-foreground hover:text-destructive transition-colors"
                      aria-label={`Remove ${agent.name} from comparison`}
                    >
                      <X className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                  </div>
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            {COMPARISON_ROWS.map((row) => {
              const { bestIdx, worstIdx } = getBestWorstIndices(row);
              return (
                <tr key={row.key} className="table-row-hover">
                  <td className="px-4 py-2.5 border-b border-border text-xs font-medium text-muted-foreground">
                    {row.label}
                  </td>
                  {agents.map((agent, i) => {
                    const displayValue = row.getValue(agent, statuses[i]);
                    const isBest = i === bestIdx;
                    const isWorst = i === worstIdx;
                    return (
                      <td
                        key={agent.id}
                        className={`px-4 py-2.5 border-b border-border border-l border-l-border text-center ${isBest
                            ? "text-green-500 font-semibold"
                            : isWorst
                              ? "text-muted-foreground"
                              : ""
                          }`}
                      >
                        {isBest && (
                          <Star
                            className="w-3 h-3 inline-block mr-1 -mt-0.5"
                            aria-label="Best"
                          />
                        )}
                        {displayValue}
                      </td>
                    );
                  })}
                </tr>
              );
            })}

            {/* Actions row */}
            <tr>
              <td className="px-4 py-3 text-xs font-medium text-muted-foreground">
                Actions
              </td>
              {agents.map((agent) => (
                <td
                  key={agent.id}
                  className="px-4 py-3 border-l border-l-border text-center"
                >
                  <div className="flex flex-col items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-full max-w-[140px] h-8 text-xs hover:bg-primary hover:text-primary-foreground transition-colors"
                      onClick={() => onAssignTask(agent.id)}
                      aria-label={`Assign task to ${agent.name}`}
                    >
                      <Zap className="w-3 h-3 mr-1" aria-hidden="true" />
                      Assign
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="w-full max-w-[140px] h-8 text-xs"
                      onClick={() => onStartChat(agent.id)}
                      aria-label={`Start chat with ${agent.name}`}
                    >
                      <MessageSquare
                        className="w-3 h-3 mr-1"
                        aria-hidden="true"
                      />
                      Chat
                    </Button>
                  </div>
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

// --- BulkDispatchBar Component ---

interface BulkDispatchBarProps {
  selectedCount: number;
  onDispatch: () => void;
  onClear: () => void;
}

function BulkDispatchBar({
  selectedCount,
  onDispatch,
  onClear,
}: BulkDispatchBarProps) {
  if (selectedCount < 2) return null;

  return (
    <div
      className="fixed bottom-0 left-0 right-0 z-50 border-t border-border bg-card/95 backdrop-blur-lg px-6 py-3 slide-in-bottom"
      role="region"
      aria-label="Bulk dispatch actions"
    >
      <div className="flex items-center justify-between max-w-7xl mx-auto">
        <div className="flex items-center gap-2 text-sm">
          <CheckCircle2
            className="w-4 h-4 text-primary"
            aria-hidden="true"
          />
          <span className="font-medium">
            {selectedCount} specialist{selectedCount !== 1 ? "s" : ""} selected
          </span>
        </div>
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={onClear}
            aria-label="Clear selection"
          >
            Clear
          </Button>
          <Button
            size="sm"
            onClick={onDispatch}
            className="btn-glow glow-shadow"
            aria-label={`Dispatch to ${selectedCount} specialists`}
          >
            Dispatch to {selectedCount}
            <ChevronRight
              className="w-4 h-4 ml-1"
              aria-hidden="true"
            />
          </Button>
        </div>
      </div>
    </div>
  );
}

// --- FilterBar Component ---

interface FilterBarProps {
  searchQuery: string;
  onSearchChange: (query: string) => void;
  categories: Array<{ name: string; count: number }>;
  categoryFilter: string | null;
  onCategoryChange: (category: string | null) => void;
  statusFilter: "all" | "available" | "busy";
  onStatusChange: (status: "all" | "available" | "busy") => void;
  qualityMin: number;
  onQualityChange: (min: number) => void;
  sortBy: "name" | "quality" | "tasks" | "trend";
  onSortChange: (sort: "name" | "quality" | "tasks" | "trend") => void;
  viewMode: "grid" | "list" | "comparison";
  onViewModeChange: (mode: "grid" | "list" | "comparison") => void;
}

function FilterBar({
  searchQuery,
  onSearchChange,
  categories,
  categoryFilter,
  onCategoryChange,
  statusFilter,
  onStatusChange,
  qualityMin,
  onQualityChange,
  sortBy,
  onSortChange,
  viewMode,
  onViewModeChange,
}: FilterBarProps) {
  return (
    <div className="space-y-3">
      {/* Row 1: Search + View Mode Toggle */}
      <div className="flex gap-3">
        <div className="flex-1 relative">
          <Search
            className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground"
            aria-hidden="true"
          />
          <input
            type="text"
            placeholder="Search agents by name, description, or capability..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            maxLength={200}
            className="w-full pl-10 pr-4 py-2 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            aria-label="Search agents"
          />
          {searchQuery && (
            <button
              onClick={() => onSearchChange("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label="Clear search"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
        <div className="flex items-center border border-border rounded-lg overflow-hidden" role="radiogroup" aria-label="View mode">
          {([
            { mode: "grid" as const, icon: LayoutGrid, label: "Grid" },
            { mode: "list" as const, icon: LayoutList, label: "List" },
            { mode: "comparison" as const, icon: GitCompare, label: "Compare" },
          ]).map(({ mode, icon: Icon, label }) => (
            <button
              key={mode}
              role="radio"
              aria-checked={viewMode === mode}
              onClick={() => onViewModeChange(mode)}
              className={`px-3 py-2 text-xs flex items-center gap-1.5 transition-colors ${viewMode === mode
                  ? "bg-primary text-primary-foreground"
                  : "hover:bg-muted/50 text-muted-foreground"
                }`}
              aria-label={`${label} view`}
            >
              <Icon className="w-3.5 h-3.5" aria-hidden="true" />
              <span className="hidden sm:inline">{label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Row 2: Category Chips */}
      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by category">
        <button
          onClick={() => onCategoryChange(null)}
          className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${!categoryFilter
              ? "bg-primary text-primary-foreground"
              : "bg-muted/50 text-muted-foreground hover:bg-muted"
            }`}
        >
          All ({categories.reduce((sum, c) => sum + c.count, 0)})
        </button>
        {categories.map(({ name, count }) => (
          <button
            key={name}
            onClick={() => onCategoryChange(categoryFilter === name ? null : name)}
            className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${categoryFilter === name
                ? "bg-primary text-primary-foreground"
                : "bg-muted/50 text-muted-foreground hover:bg-muted"
              }`}
          >
            {name} ({count})
          </button>
        ))}
      </div>

      {/* Row 3: Status + Quality + Sort dropdowns */}
      <div className="flex gap-3 flex-wrap">
        <Select
          value={statusFilter}
          onValueChange={(v) => onStatusChange(v as "all" | "available" | "busy")}
        >
          <SelectTrigger className="w-36" aria-label="Filter by status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="available">Available</SelectItem>
            <SelectItem value="busy">Busy</SelectItem>
          </SelectContent>
        </Select>

        <Select
          value={String(qualityMin)}
          onValueChange={(v) => onQualityChange(Number(v))}
        >
          <SelectTrigger className="w-36" aria-label="Filter by quality">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="0">Any Quality</SelectItem>
            <SelectItem value="70">Quality 70+</SelectItem>
            <SelectItem value="85">Quality 85+</SelectItem>
          </SelectContent>
        </Select>

        <Select
          value={sortBy}
          onValueChange={(v) => onSortChange(v as "name" | "quality" | "tasks" | "trend")}
        >
          <SelectTrigger className="w-40" aria-label="Sort by">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="quality">Sort: Quality</SelectItem>
            <SelectItem value="name">Sort: Name</SelectItem>
            <SelectItem value="tasks">Sort: Tasks</SelectItem>
            <SelectItem value="trend">Sort: Trend</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

// --- Main Component ---

export function AISpecialists({
  tasks = [],
  workspaceId,
  onAssignTask,
  onStartChat,
  onNavigateToTask,
  onCreateAndAssignTask,
}: AISpecialistsProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedAgent, setSelectedAgent] = useState<SpecializedAgent | null>(null);
  const [quickAssignOpen, setQuickAssignOpen] = useState(false);
  const [assignDialogOpen, setAssignDialogOpen] = useState(false);
  const [telegramDialogOpen, setTelegramDialogOpen] = useState(false);
  const [assignTarget, setAssignTarget] = useState<SpecializedAgent | null>(null);

  // New state for command center features
  const [viewMode, setViewMode] = useState<"grid" | "list" | "comparison">(() => {
    if (typeof window === "undefined") return "grid";
    return (localStorage.getItem("oc-specialists-view") as "grid" | "list" | "comparison") || "grid";
  });
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<"all" | "available" | "busy">("all");
  const [qualityMin, setQualityMin] = useState(0);
  const [sortBy, setSortBy] = useState<"name" | "quality" | "tasks" | "trend">("quality");
  const [compareList, setCompareList] = useState<string[]>([]);
  const [isSpawningTeam, setIsSpawningTeam] = useState<string | null>(null);

  const teams = useMemo(() => getAgentTeams(), []);

  const handleSpawnTeam = useCallback(async (team: AgentTeam) => {
    if (!onCreateAndAssignTask) return;

    setIsSpawningTeam(team.id);
    try {
      // Create a task for each agent in the team
      for (const agentId of team.agentIds) {
        const agent = getSpecializedAgent(agentId);
        if (!agent) continue;

        await onCreateAndAssignTask({
          title: `Initialize ${agent.name} for ${team.name}`,
          description: `Strategic setup and initial briefing for ${agent.name} as part of the ${team.name}. Reference the "Multi-Agent Specialized Team (Solo Founder Setup)" lesson for coordination protocols.`,
          agentId: agent.id
        });
      }
    } finally {
      setIsSpawningTeam(null);
    }
  }, [onCreateAndAssignTask]);
  const [favorites, setFavorites] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set();
    try {
      const saved = localStorage.getItem("oc-specialists-favorites");
      return saved ? new Set(JSON.parse(saved) as string[]) : new Set();
    } catch {
      return new Set();
    }
  });
  const [advisoryCollapsed, setAdvisoryCollapsed] = useState(false);

  const allAgents = useMemo(() => getSpecializedAgents(), []);
  const {
    statuses: agentStatusesById,
    loading: statusesLoading,
    error: statusesError,
    refresh: refreshStatuses,
    lastRefreshedAt,
  } = useAgentStatuses(allAgents, tasks, workspaceId);
  const agentsByCategory = useMemo(() => getAgentsByCategory(), []);
  const [suggestions, setSuggestions] = useState<
    Record<SuggestionChannel, SpecialistSuggestion[]>
  >({
    learning_hub: [],
    workspace: [],
    openclaw: [],
  });
  const [suggestionsLoading, setSuggestionsLoading] = useState(true);
  const [suggestionsError, setSuggestionsError] = useState<string | null>(null);
  const [suggestionsRefreshedAt, setSuggestionsRefreshedAt] = useState<string | null>(
    null
  );

  const refreshSuggestions = useCallback(async () => {
    setSuggestionsLoading(true);
    try {
      const params = new URLSearchParams();
      if (workspaceId) {
        params.set("workspace_id", workspaceId);
      }
      const url = params.toString()
        ? `/api/agents/specialists/suggestions?${params.toString()}`
        : "/api/agents/specialists/suggestions";
      const res = await fetch(url);
      const data = (await res.json()) as SuggestionApiResponse;
      if (!res.ok) {
        throw new Error(
          data.error || `Failed to fetch specialist suggestions (${res.status})`
        );
      }
      setSuggestions({
        learning_hub: data.suggestions?.learning_hub ?? [],
        workspace: data.suggestions?.workspace ?? [],
        openclaw: data.suggestions?.openclaw ?? [],
      });
      setSuggestionsError(null);
      setSuggestionsRefreshedAt(data.generatedAt ?? new Date().toISOString());
    } catch (error) {
      setSuggestionsError(
        error instanceof Error
          ? error.message
          : "Failed to load specialist recommendations"
      );
    } finally {
      setSuggestionsLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void refreshSuggestions();
    const interval = setInterval(() => {
      void refreshSuggestions();
    }, 20000);
    return () => clearInterval(interval);
  }, [refreshSuggestions]);

  // Persist viewMode and favorites to localStorage
  useEffect(() => {
    localStorage.setItem("oc-specialists-view", viewMode);
  }, [viewMode]);

  useEffect(() => {
    localStorage.setItem("oc-specialists-favorites", JSON.stringify([...favorites]));
  }, [favorites]);

  const getAgentStatus = useCallback(
    (agentId: string): AgentStatus => {
      return (
        agentStatusesById[agentId] || {
          agentId,
          status: "offline",
          taskCount: 0,
          qualityScore: 50,
          confidence: 0.2,
          trend: "steady",
          approvalRate: 0,
          reworkRate: 0,
          avgFeedbackRating: null,
          feedbackCount: 0,
          improvementFocus: "Build track record with completed and reviewed tasks.",
          strengths: [],
        }
      );
    },
    [agentStatusesById]
  );

  const agentStatuses = useMemo(
    () => allAgents.map((agent) => getAgentStatus(agent.id)),
    [allAgents, getAgentStatus]
  );

  // Filter + sort agents (combines search, category, status, quality, sort)
  const filteredAgents = useMemo(() => {
    const result = allAgents.filter((agent) => {
      // Search
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        if (
          !agent.name.toLowerCase().includes(q) &&
          !agent.description.toLowerCase().includes(q) &&
          !agent.capabilities.some((c) => c.toLowerCase().includes(q))
        )
          return false;
      }
      // Category
      if (categoryFilter) {
        const catAgents = agentsByCategory[categoryFilter];
        if (!catAgents?.some((a) => a.id === agent.id)) return false;
      }
      // Status
      if (statusFilter !== "all") {
        const s = getAgentStatus(agent.id);
        if (statusFilter === "available" && s.status !== "available") return false;
        if (statusFilter === "busy" && s.status !== "busy") return false;
      }
      // Quality threshold
      if (qualityMin > 0) {
        const s = getAgentStatus(agent.id);
        if (s.qualityScore < qualityMin) return false;
      }
      return true;
    });

    // Sort
    result.sort((a, b) => {
      switch (sortBy) {
        case "name":
          return a.name.localeCompare(b.name);
        case "quality":
          return getAgentStatus(b.id).qualityScore - getAgentStatus(a.id).qualityScore;
        case "tasks":
          return getAgentStatus(b.id).taskCount - getAgentStatus(a.id).taskCount;
        case "trend": {
          const order = { improving: 2, steady: 1, needs_attention: 0 } as const;
          return order[getAgentStatus(b.id).trend] - order[getAgentStatus(a.id).trend];
        }
        default:
          return 0;
      }
    });

    return result;
  }, [allAgents, searchQuery, categoryFilter, agentsByCategory, statusFilter, qualityMin, sortBy, getAgentStatus]);

  // Stats (with topPerformer for StatsRibbon)
  const stats = useMemo(() => {
    const available = agentStatuses.filter((s) => s.status === "available").length;
    const busy = agentStatuses.filter((s) => s.status === "busy").length;
    const totalTasks = agentStatuses.reduce((sum, s) => sum + s.taskCount, 0);
    const avgQuality =
      agentStatuses.length > 0
        ? Math.round(
          agentStatuses.reduce((sum, s) => sum + s.qualityScore, 0) /
          agentStatuses.length
        )
        : 0;
    let topPerformer: { name: string; score: number } | null = null;
    for (const agent of allAgents) {
      const s = getAgentStatus(agent.id);
      if (!topPerformer || s.qualityScore > topPerformer.score) {
        topPerformer = { name: agent.name, score: s.qualityScore };
      }
    }
    return { available, busy, totalTasks, avgQuality, topPerformer };
  }, [agentStatuses, allAgents, getAgentStatus]);

  const selectedAgentRecentTasks = useMemo(() => {
    if (!selectedAgent) return [];
    return getRecentTasksForAgent(tasks, selectedAgent.id);
  }, [selectedAgent, tasks]);

  const handleAssignTask = (agentId: string) => {
    const agent = getSpecializedAgent(agentId);
    if (agent) {
      setAssignTarget(agent);
      setAssignDialogOpen(true);
    }
  };

  const handleStartChat = (agentId: string) => {
    if (onStartChat) {
      onStartChat(agentId);
    }
  };

  const handleBulkAssign = (taskIds: string[], agentId: string) => {
    taskIds.forEach((taskId) => {
      if (onAssignTask) {
        onAssignTask(taskId, agentId);
      }
    });
  };

  const handleCreateAndAssign = async (title: string, description: string) => {
    if (!assignTarget || !onCreateAndAssignTask) return false;
    return Promise.resolve(
      onCreateAndAssignTask({
        title,
        description,
        agentId: assignTarget.id,
      })
    );
  };

  const toggleFavorite = useCallback((agentId: string) => {
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  }, []);

  const toggleCompare = useCallback((agentId: string) => {
    setCompareList((prev) => {
      if (prev.includes(agentId)) return prev.filter((id) => id !== agentId);
      if (prev.length >= 3) return prev;
      return [...prev, agentId];
    });
  }, []);

  const compareAgents = useMemo(
    () => compareList.map((id) => getSpecializedAgent(id)).filter(Boolean) as SpecializedAgent[],
    [compareList]
  );

  const categoryList = useMemo(
    () => Object.entries(agentsByCategory).map(([name, agents]) => ({ name, count: agents.length })),
    [agentsByCategory]
  );

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <header className="p-6 border-b border-border bg-card/50 backdrop-blur-sm space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-3">
              <Bot className="w-7 h-7 text-primary" aria-hidden="true" />
              AI Specialists
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Enterprise specialist network with live quality intelligence
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => setTelegramDialogOpen(true)} className="text-sky-500 border-sky-500/30 hover:bg-sky-500/10">
              <Send className="w-4 h-4 mr-2" aria-hidden="true" />
              Telegram Setup
            </Button>
            <Button variant="outline" onClick={() => setQuickAssignOpen(true)}>
              <Users className="w-4 h-4 mr-2" aria-hidden="true" />
              Bulk Assign
            </Button>
          </div>
        </div>

        {/* Stats Ribbon (6 KPIs) */}
        <StatsRibbon
          totalAgents={allAgents.length}
          available={stats.available}
          busy={stats.busy}
          totalTasksCompleted={stats.totalTasks}
          avgQuality={stats.avgQuality}
          topPerformer={stats.topPerformer}
        />

        {/* Live Status Bar */}
        <div className="flex items-center justify-between rounded-lg border border-border bg-card px-3 py-2 text-xs">
          <div className="flex items-center gap-2">
            <span
              className={`h-2 w-2 rounded-full ${statusesError
                  ? "bg-destructive"
                  : statusesLoading
                    ? "bg-amber-500 animate-pulse"
                    : "bg-green-500"
                }`}
              aria-hidden="true"
            />
            <span className={statusesError ? "text-destructive" : "text-muted-foreground"}>
              {statusesError
                ? `Live status unavailable: ${statusesError}`
                : statusesLoading
                  ? "Loading specialist status..."
                  : `Live status synced ${lastRefreshedAt ? timeAgo(lastRefreshedAt) : "just now"}`}
            </span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              void refreshStatuses();
              void refreshSuggestions();
            }}
          >
            <RefreshCw className="w-3.5 h-3.5 mr-1" />
            Refresh
          </Button>
        </div>

        {/* Advisory Panel (collapsible) */}
        <div className="rounded-lg border border-border bg-card/60">
          <button
            className="w-full flex items-center justify-between p-3 text-left"
            onClick={() => setAdvisoryCollapsed(!advisoryCollapsed)}
            aria-expanded={!advisoryCollapsed}
          >
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              Specialist Advisory
            </div>
            <div className="flex items-center gap-2">
              <span
                className={`text-[11px] ${suggestionsError ? "text-destructive" : "text-muted-foreground"
                  }`}
              >
                {suggestionsError
                  ? "Unavailable"
                  : suggestionsLoading
                    ? "Refreshing..."
                    : `Updated ${suggestionsRefreshedAt ? timeAgo(suggestionsRefreshedAt) : "just now"}`}
              </span>
              {advisoryCollapsed ? (
                <ChevronRight className="w-4 h-4 text-muted-foreground" />
              ) : (
                <ChevronDown className="w-4 h-4 text-muted-foreground" />
              )}
            </div>
          </button>
          {!advisoryCollapsed && (
            <div className="px-3 pb-3">
              <div className="grid grid-cols-1 xl:grid-cols-3 gap-3">
                {(Object.keys(CHANNEL_META) as SuggestionChannel[]).map((channel) => {
                  const meta = CHANNEL_META[channel];
                  const channelSuggestions = suggestions[channel] ?? [];
                  return (
                    <section
                      key={channel}
                      className="rounded-lg border border-border bg-background/70 p-3 space-y-2"
                      aria-label={`${meta.label} specialist recommendations`}
                    >
                      <div className="flex items-start gap-2">
                        <meta.icon className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                        <div>
                          <h3 className="text-sm font-semibold leading-tight">{meta.label}</h3>
                          <p className="text-[11px] text-muted-foreground">{meta.subtitle}</p>
                        </div>
                      </div>
                      {channelSuggestions.length === 0 ? (
                        <p className="text-xs text-muted-foreground border border-dashed border-border rounded-md p-2">
                          No recommendations right now. Keep shipping tasks to generate stronger
                          specialist signals.
                        </p>
                      ) : (
                        <div className="space-y-2">
                          {channelSuggestions.slice(0, 2).map((suggestion) => {
                            const specialist = getSpecializedAgent(suggestion.specialistId);
                            return (
                              <button
                                key={suggestion.id}
                                className="w-full text-left rounded-md border border-border p-2 hover:bg-muted/30 transition-colors"
                                onClick={() => {
                                  if (specialist) setSelectedAgent(specialist);
                                }}
                              >
                                <div className="flex items-center justify-between gap-2 mb-1">
                                  <p className="text-xs font-medium leading-tight">
                                    {suggestion.title}
                                  </p>
                                  <Badge
                                    variant="outline"
                                    className={`text-[10px] capitalize ${suggestion.priority === "high"
                                        ? "border-destructive/40 text-destructive"
                                        : suggestion.priority === "medium"
                                          ? "border-amber-500/40 text-amber-500"
                                          : "border-primary/30 text-primary"
                                      }`}
                                  >
                                    {suggestion.priority}
                                  </Badge>
                                </div>
                                <p className="text-[11px] text-muted-foreground line-clamp-2">
                                  {suggestion.summary}
                                </p>
                                <div className="mt-2 flex items-center justify-between text-[10px] text-muted-foreground">
                                  <span className="truncate">
                                    Specialist: {suggestion.specialistName}
                                  </span>
                                  <span>{Math.round(suggestion.confidence * 100)}%</span>
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </section>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* FilterBar */}
        <FilterBar
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          categories={categoryList}
          categoryFilter={categoryFilter}
          onCategoryChange={setCategoryFilter}
          statusFilter={statusFilter}
          onStatusChange={setStatusFilter}
          qualityMin={qualityMin}
          onQualityChange={setQualityMin}
          sortBy={sortBy}
          onSortChange={setSortBy}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
        />
      </header>

      {/* Main Content */}
      <ScrollArea className="flex-1">
        <main className="p-6">
          {viewMode === "comparison" ? (
            compareAgents.length === 0 ? (
              <div className="text-center py-12">
                <GitCompare className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
                <h3 className="text-lg font-medium mb-2">No agents selected for comparison</h3>
                <p className="text-sm text-muted-foreground">
                  Switch to grid or list view and use the compare checkbox on agents
                </p>
              </div>
            ) : (
              <ComparisonView
                agents={compareAgents}
                statuses={compareAgents.map((a) => getAgentStatus(a.id))}
                onRemoveAgent={(id) => toggleCompare(id)}
                onClearAll={() => setCompareList([])}
                onAssignTask={handleAssignTask}
                onStartChat={handleStartChat}
              />
            )
          ) : filteredAgents.length === 0 ? (
            <div className="text-center py-12">
              <Bot className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-lg font-medium mb-2">No agents found</h3>
              <p className="text-sm text-muted-foreground">
                Try adjusting your search or filter criteria
              </p>
            </div>
          ) : viewMode === "list" ? (
            /* List View */
            <div className="space-y-1" role="list" aria-label="Agent list">
              {/* Favorites in list view */}
              {favorites.size > 0 && filteredAgents.some((a) => favorites.has(a.id)) && (
                <>
                  <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-2 mt-2">
                    Favorites
                  </h2>
                  {filteredAgents
                    .filter((a) => favorites.has(a.id))
                    .map((agent) => (
                      <AgentListRow
                        key={`fav-${agent.id}`}
                        agent={agent}
                        status={getAgentStatus(agent.id)}
                        isFavorite={true}
                        isComparing={compareList.includes(agent.id)}
                        onSelect={() => setSelectedAgent(agent)}
                        onAssignTask={() => handleAssignTask(agent.id)}
                        onToggleFavorite={() => toggleFavorite(agent.id)}
                        onToggleCompare={() => toggleCompare(agent.id)}
                      />
                    ))}
                  <div className="border-b border-border my-3" />
                </>
              )}
              {filteredAgents
                .filter((a) => !favorites.has(a.id))
                .map((agent) => (
                  <AgentListRow
                    key={agent.id}
                    agent={agent}
                    status={getAgentStatus(agent.id)}
                    isFavorite={false}
                    isComparing={compareList.includes(agent.id)}
                    onSelect={() => setSelectedAgent(agent)}
                    onAssignTask={() => handleAssignTask(agent.id)}
                    onToggleFavorite={() => toggleFavorite(agent.id)}
                    onToggleCompare={() => toggleCompare(agent.id)}
                  />
                ))}
            </div>
          ) : (
            /* Grid View */
            <div className="space-y-8">
              {/* Specialized Teams (New) */}
              {!searchQuery && !categoryFilter && (
                <TeamTemplatesSection
                  teams={teams}
                  onSpawnTeam={handleSpawnTeam}
                  isSpawning={isSpawningTeam}
                />
              )}

              {/* Favorites section */}
              {favorites.size > 0 && filteredAgents.some((a) => favorites.has(a.id)) && (
                <section aria-labelledby="category-favorites">
                  <h2
                    id="category-favorites"
                    className="text-lg font-semibold mb-4 flex items-center gap-2"
                  >
                    <Star className="w-5 h-5 fill-yellow-400 text-yellow-400" />
                    Favorites
                  </h2>
                  <div
                    className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4"
                    role="list"
                    aria-label="Favorite agents"
                  >
                    {filteredAgents
                      .filter((a) => favorites.has(a.id))
                      .map((agent) => (
                        <AgentCard
                          key={`fav-${agent.id}`}
                          agent={agent}
                          status={getAgentStatus(agent.id)}
                          isSelected={selectedAgent?.id === agent.id}
                          isFavorite={true}
                          isComparing={compareList.includes(agent.id)}
                          showCheckbox={compareList.length > 0}
                          onSelect={() => setSelectedAgent(agent)}
                          onAssignTask={() => handleAssignTask(agent.id)}
                          onToggleFavorite={() => toggleFavorite(agent.id)}
                          onToggleCompare={() => toggleCompare(agent.id)}
                        />
                      ))}
                  </div>
                </section>
              )}

              {/* Category groups */}
              {Object.entries(agentsByCategory).map(([category, categoryAgents]) => {
                const visibleAgents = categoryAgents.filter(
                  (a) => filteredAgents.some((fa) => fa.id === a.id) && !favorites.has(a.id)
                );
                if (visibleAgents.length === 0) return null;
                return (
                  <section key={category} aria-labelledby={`category-${category}`}>
                    <h2
                      id={`category-${category}`}
                      className="text-lg font-semibold mb-4 text-muted-foreground"
                    >
                      {category}
                      <span className="ml-2 text-sm font-normal">({visibleAgents.length})</span>
                    </h2>
                    <div
                      className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4"
                      role="list"
                      aria-label={`${category} agents`}
                    >
                      {visibleAgents.map((agent) => {
                        const status = getAgentStatus(agent.id);
                        return (
                          <AgentCard
                            key={agent.id}
                            agent={agent}
                            status={status}
                            isSelected={selectedAgent?.id === agent.id}
                            isFavorite={favorites.has(agent.id)}
                            isComparing={compareList.includes(agent.id)}
                            showCheckbox={compareList.length > 0}
                            onSelect={() => setSelectedAgent(agent)}
                            onAssignTask={() => handleAssignTask(agent.id)}
                            onToggleFavorite={() => toggleFavorite(agent.id)}
                            onToggleCompare={() => toggleCompare(agent.id)}
                          />
                        );
                      })}
                    </div>
                  </section>
                );
              })}
            </div>
          )}
        </main>
      </ScrollArea>

      {/* Detail Panel (slides in from right) */}
      {selectedAgent && (
        <AgentDetailPanel
          agent={selectedAgent}
          status={getAgentStatus(selectedAgent.id)}
          recentTasks={selectedAgentRecentTasks}
          isFavorite={favorites.has(selectedAgent.id)}
          isComparing={compareList.includes(selectedAgent.id)}
          onClose={() => setSelectedAgent(null)}
          onStartChat={() => handleStartChat(selectedAgent.id)}
          onAssignTask={() => handleAssignTask(selectedAgent.id)}
          onNavigateToTask={onNavigateToTask}
          onToggleFavorite={() => toggleFavorite(selectedAgent.id)}
          onToggleCompare={() => toggleCompare(selectedAgent.id)}
        />
      )}

      {/* Quick Assign Dialog */}
      <QuickAssignDialog
        open={quickAssignOpen}
        onOpenChange={setQuickAssignOpen}
        tasks={tasks}
        agents={allAgents}
        agentStatuses={agentStatuses}
        workspaceId={workspaceId}
        onAssign={handleBulkAssign}
      />

      {/* Single Task Assign Dialog */}
      <AssignTaskDialog
        open={assignDialogOpen}
        onOpenChange={setAssignDialogOpen}
        agent={assignTarget}
        onAssign={handleCreateAndAssign}
      />

      {/* Telegram Info Dialog */}
      <Dialog open={telegramDialogOpen} onOpenChange={setTelegramDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Send className="w-5 h-5 text-sky-500" />
              Telegram Specialist Control
            </DialogTitle>
            <DialogDescription>
              Manage your AI specialists on the go. Start a chat with the OpenClaw bot and use these commands:
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div className="rounded-md border border-border bg-muted/30 p-3">
              <code className="text-sm font-semibold text-primary">/specialists</code>
              <p className="text-sm text-muted-foreground mt-1">List all available AI specialists, their active tasks, and quality scores.</p>
            </div>
            <div className="rounded-md border border-border bg-muted/30 p-3">
              <code className="text-sm font-semibold text-primary">/specialist &lt;id&gt;</code>
              <p className="text-sm text-muted-foreground mt-1">View detailed intelligence and performance metrics for a specific agent.</p>
            </div>
            <div className="rounded-md border border-border bg-muted/30 p-3">
              <code className="text-sm font-semibold text-primary">/assign &lt;id&gt; &lt;description&gt;</code>
              <p className="text-sm text-muted-foreground mt-1">Directly assign a new task to your specialist and send it to their inbox.</p>
            </div>
            <div className="rounded-lg bg-sky-500/10 border border-sky-500/20 p-3 mt-4">
              <p className="text-xs text-sky-600 dark:text-sky-400">
                You must have the Telegram bot configured in your OpenClaw Gateway to use these commands. The plugin <code className="bg-sky-500/20 px-1 rounded">specialists</code> must be loaded.
              </p>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Bulk Dispatch Bar (appears when 2+ agents selected) */}
      <BulkDispatchBar
        selectedCount={compareList.length}
        onDispatch={() => setQuickAssignOpen(true)}
        onClear={() => setCompareList([])}
      />
    </div>
  );
}

export default AISpecialists;
