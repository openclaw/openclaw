"use client";

import { useCallback, useEffect, useState } from "react";
import {
    Activity,
    Bot,
    BrainCircuit,
    Server,
    TrendingUp,
    ArrowUpRight,
} from "lucide-react";
import type { Task } from "@/lib/hooks/use-tasks";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type GatewayConnectionState = "connected" | "disconnected" | "connecting";

interface StatCardsProps {
    tasks: Task[];
    agents: Array<{ id: string; name?: string }>;
    gatewayConnectionState: GatewayConnectionState;
    onNavigate: (view: string) => void;
}

interface HealthData {
    status: "healthy" | "degraded" | "unhealthy";
    uptime?: number;
    uptime_seconds?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatUptime(seconds: number): string {
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
    return `${Math.floor(seconds / 86400)}d`;
}

// ---------------------------------------------------------------------------
// Individual Stat Card
// ---------------------------------------------------------------------------

interface StatCardProps {
    icon: React.ReactNode;
    label: string;
    value: string | number;
    subtitle?: string;
    accentClass: string;
    glowClass: string;
    onClick: () => void;
    trend?: { value: string; positive: boolean };
}

function StatCard({
    icon,
    label,
    value,
    subtitle,
    accentClass,
    glowClass,
    onClick,
    trend,
}: StatCardProps) {
    const buttonClassName =
        "group relative flex-1 min-w-[180px] p-5 rounded-xl bg-card/60 backdrop-blur-md border border-border/50 hover:border-border hover:bg-card/80 transition-all duration-300 ease-out cursor-pointer hover:-translate-y-0.5 hover:shadow-lg focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 text-left";
    const glowClassName =
        `absolute inset-0 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none ${glowClass}`;
    const iconClassName =
        `w-9 h-9 rounded-lg flex items-center justify-center ${accentClass} transition-transform duration-300 group-hover:scale-110`;
    const arrowClassName =
        "w-4 h-4 text-muted-foreground/0 group-hover:text-muted-foreground/60 transition-all duration-300 group-hover:translate-x-0.5 group-hover:-translate-y-0.5";
    const trendClassName =
        `inline-flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${trend?.positive
            ? "text-emerald-600 bg-emerald-500/10 dark:text-emerald-400 dark:bg-emerald-500/15"
            : "text-amber-600 bg-amber-500/10 dark:text-amber-400 dark:bg-amber-500/15"
        }`;

    return (
        <button
            onClick={onClick}
            className={buttonClassName}
            aria-label={`${label}: ${value}. Click to view details.`}
        >
            {/* Subtle glow on hover */}
            <div className={glowClassName} />

            {/* Content */}
            <div className="relative z-10">
                {/* Header row: icon + navigate arrow */}
                <div className="flex items-center justify-between mb-3">
                    <div className={iconClassName}>
                        {icon}
                    </div>
                    <ArrowUpRight className={arrowClassName} />
                </div>

                {/* Value */}
                <div className="text-2xl font-bold font-display tracking-tight text-foreground mb-0.5">
                    {value}
                </div>

                {/* Label + trend */}
                <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-muted-foreground">{label}</span>
                    {trend && (
                        <span className={trendClassName}>
                            <TrendingUp className={`w-2.5 h-2.5 ${!trend.positive ? "rotate-180" : ""}`} />
                            {trend.value}
                        </span>
                    )}
                </div>

                {/* Subtitle */}
                {subtitle && (
                    <span className="text-[10px] text-muted-foreground/60 mt-1 block">{subtitle}</span>
                )}
            </div>
        </button>
    );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export function StatCards({
    tasks,
    agents,
    gatewayConnectionState,
    onNavigate,
}: StatCardsProps) {
    // ---- Derived task stats ----
    const activeAgentCount = agents.length;
    const inProgressCount = tasks.filter(
        (t) => t.status === "in_progress" || t.status === "assigned"
    ).length;
    const totalTasks = tasks.length;
    const completedTasks = tasks.filter((t) => t.status === "done").length;

    // ---- Model count from /api/models ----
    const [modelCount, setModelCount] = useState(0);

    const fetchModels = useCallback(async () => {
        try {
            const res = await fetch("/api/models");
            if (res.ok) {
                const data = (await res.json()) as { models?: unknown[] };
                setModelCount(data.models?.length ?? 0);
            }
        } catch {
            // silent
        }
    }, []);

    // ---- Health endpoint ----
    const [health, setHealth] = useState<HealthData | null>(null);

    const fetchHealth = useCallback(async () => {
        // /api/health intentionally returns 503 when degraded; skip it when gateway
        // is known disconnected to avoid noisy failed fetches in the dashboard.
        if (gatewayConnectionState !== "connected") {
            setHealth(null);
            return;
        }
        try {
            const res = await fetch("/api/health?soft=true");
            if (res.ok) {
                const data = (await res.json()) as HealthData;
                setHealth(data);
            }
        } catch {
            // silent — keep previous
        }
    }, [gatewayConnectionState]);

    useEffect(() => {
        const id = setTimeout(() => {
            void fetchModels();
            void fetchHealth();
        }, 0);
        const interval = setInterval(() => {
            void fetchHealth();
            void fetchModels();
        }, 30_000);
        return () => {
            clearTimeout(id);
            clearInterval(interval);
        };
    }, [fetchHealth, fetchModels]);

    // ---- Compute health display ----
    const healthStatus = health?.status ?? (gatewayConnectionState === "connected" ? "healthy" : "degraded");
    const healthLabel =
        healthStatus === "healthy" ? "Healthy" : healthStatus === "degraded" ? "Degraded" : "Offline";
    const uptimeSeconds = health?.uptime ?? health?.uptime_seconds;
    const uptimeLabel = typeof uptimeSeconds === "number" ? formatUptime(uptimeSeconds) : "—";

    return (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {/* Active Agents */}
            <StatCard
                icon={<Bot className="w-4.5 h-4.5 text-emerald-600 dark:text-emerald-400" />}
                label="Active Agents"
                value={activeAgentCount}
                subtitle={gatewayConnectionState === "connected" ? "Gateway connected" : "Gateway offline"}
                accentClass="bg-emerald-500/10 dark:bg-emerald-500/15"
                glowClass="bg-gradient-to-br from-emerald-500/5 to-transparent"
                onClick={() => onNavigate("agents")}
            />

            {/* Tasks In Progress */}
            <StatCard
                icon={<Activity className="w-4.5 h-4.5 text-purple-600 dark:text-purple-400" />}
                label="Tasks Active"
                value={inProgressCount}
                subtitle={`${completedTasks} of ${totalTasks} completed`}
                accentClass="bg-purple-500/10 dark:bg-purple-500/15"
                glowClass="bg-gradient-to-br from-purple-500/5 to-transparent"
                onClick={() => onNavigate("board")}
                trend={
                    totalTasks > 0
                        ? {
                            value: `${Math.round((completedTasks / totalTasks) * 100)}%`,
                            positive: completedTasks / totalTasks > 0.5,
                        }
                        : undefined
                }
            />

            {/* Models Running */}
            <StatCard
                icon={<BrainCircuit className="w-4.5 h-4.5 text-blue-600 dark:text-blue-400" />}
                label="Models Loaded"
                value={modelCount}
                subtitle={modelCount === 1 ? "1 model" : `${modelCount} models`}
                accentClass="bg-blue-500/10 dark:bg-blue-500/15"
                glowClass="bg-gradient-to-br from-blue-500/5 to-transparent"
                onClick={() => onNavigate("settings")}
            />

            {/* System Health */}
            <StatCard
                icon={
                    <Server
                        className={`w-4.5 h-4.5 ${healthStatus === "healthy"
                            ? "text-emerald-600 dark:text-emerald-400"
                            : healthStatus === "degraded"
                                ? "text-amber-600 dark:text-amber-400"
                                : "text-red-600 dark:text-red-400"
                            }`}
                    />
                }
                label="System Health"
                value={healthLabel}
                subtitle={`Uptime: ${uptimeLabel}`}
                accentClass={
                    healthStatus === "healthy"
                        ? "bg-emerald-500/10 dark:bg-emerald-500/15"
                        : healthStatus === "degraded"
                            ? "bg-amber-500/10 dark:bg-amber-500/15"
                            : "bg-red-500/10 dark:bg-red-500/15"
                }
                glowClass={
                    healthStatus === "healthy"
                        ? "bg-gradient-to-br from-emerald-500/5 to-transparent"
                        : "bg-gradient-to-br from-amber-500/5 to-transparent"
                }
                onClick={() => onNavigate("logs")}
            />
        </div>
    );
}
