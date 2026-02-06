"use client";

import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { CheckCircle2, XCircle, Timer, Clock, TrendingUp } from "lucide-react";
import type { DecisionAuditEntry } from "./decision-types";

interface DecisionStatsProps {
  decisions: DecisionAuditEntry[];
  className?: string;
}

export function DecisionStats({ decisions, className }: DecisionStatsProps) {
  const total = decisions.length;
  const approved = decisions.filter((d) => d.outcome === "approved").length;
  const rejected = decisions.filter((d) => d.outcome === "rejected").length;
  const expired = decisions.filter((d) => d.outcome === "expired").length;
  const pending = decisions.filter((d) => d.outcome === "pending").length;

  // Average response time (for decisions that were responded to)
  const responseTimes = decisions
    .filter((d) => d.respondedAt)
    .map((d) => d.respondedAt! - d.timestamp);
  const avgResponseTime =
    responseTimes.length > 0
      ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length
      : 0;

  const formatAvgTime = (ms: number): string => {
    if (ms === 0) return "N/A";
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m`;
    return `${seconds}s`;
  };

  const stats = [
    {
      label: "Total",
      value: total,
      icon: TrendingUp,
      color: "text-foreground",
      bgColor: "bg-muted",
    },
    {
      label: "Approved",
      value: approved,
      icon: CheckCircle2,
      color: "text-green-500",
      bgColor: "bg-green-500/10",
    },
    {
      label: "Rejected",
      value: rejected,
      icon: XCircle,
      color: "text-red-500",
      bgColor: "bg-red-500/10",
    },
    {
      label: "Expired",
      value: expired,
      icon: Timer,
      color: "text-orange-500",
      bgColor: "bg-orange-500/10",
    },
    {
      label: "Pending",
      value: pending,
      icon: Clock,
      color: "text-blue-500",
      bgColor: "bg-blue-500/10",
    },
    {
      label: "Avg Response",
      value: formatAvgTime(avgResponseTime),
      icon: Clock,
      color: "text-purple-500",
      bgColor: "bg-purple-500/10",
      isText: true,
    },
  ];

  return (
    <div className={cn("grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3", className)}>
      {stats.map((stat, i) => {
        const Icon = stat.icon;
        return (
          <motion.div
            key={stat.label}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.05 }}
            className="flex items-center gap-3 rounded-xl border border-border/50 bg-card p-3"
          >
            <div
              className={cn(
                "flex h-9 w-9 items-center justify-center rounded-lg shrink-0",
                stat.bgColor
              )}
            >
              <Icon className={cn("h-4 w-4", stat.color)} />
            </div>
            <div className="min-w-0">
              <p className="text-lg font-bold text-foreground leading-tight">
                {stat.isText ? stat.value : stat.value}
              </p>
              <p className="text-xs text-muted-foreground truncate">{stat.label}</p>
            </div>
          </motion.div>
        );
      })}
    </div>
  );
}
