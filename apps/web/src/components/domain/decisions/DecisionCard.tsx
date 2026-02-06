"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  CheckCircle2,
  XCircle,
  Clock,
  Timer,
  ChevronRight,
  Target,
  Bot,
  MessageSquare,
  ToggleLeft,
  ListChecks,
  Type,
  ShieldCheck,
} from "lucide-react";
import type { DecisionAuditEntry, DecisionOutcome } from "./decision-types";

interface DecisionCardProps {
  decision: DecisionAuditEntry;
  onViewDetails: (decision: DecisionAuditEntry) => void;
  className?: string;
}

const outcomeConfig: Record<
  DecisionOutcome,
  { icon: React.ElementType; color: string; bgColor: string; label: string }
> = {
  approved: {
    icon: CheckCircle2,
    color: "text-green-500",
    bgColor: "bg-green-500/10",
    label: "Approved",
  },
  rejected: {
    icon: XCircle,
    color: "text-red-500",
    bgColor: "bg-red-500/10",
    label: "Rejected",
  },
  expired: {
    icon: Timer,
    color: "text-orange-500",
    bgColor: "bg-orange-500/10",
    label: "Expired",
  },
  pending: {
    icon: Clock,
    color: "text-blue-500",
    bgColor: "bg-blue-500/10",
    label: "Pending",
  },
};

const typeIcons: Record<string, React.ElementType> = {
  binary: ToggleLeft,
  choice: ListChecks,
  text: Type,
  confirmation: ShieldCheck,
};

function formatTimestamp(ts: number): string {
  const date = new Date(ts);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatFullTimestamp(ts: number): string {
  return new Date(ts).toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function DecisionCard({ decision, onViewDetails, className }: DecisionCardProps) {
  const outcome = outcomeConfig[decision.outcome];
  const OutcomeIcon = outcome.icon;
  const TypeIcon = typeIcons[decision.type] || MessageSquare;

  return (
    <motion.div
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0 }}
      whileHover={{ scale: 1.005 }}
      className={cn(
        "group relative flex items-start gap-4 rounded-xl border border-border/50 bg-card p-4 transition-all hover:border-border hover:shadow-sm cursor-pointer",
        className
      )}
      onClick={() => onViewDetails(decision)}
    >
      {/* Timeline indicator */}
      <div
        className={cn(
          "flex h-10 w-10 shrink-0 items-center justify-center rounded-full",
          outcome.bgColor
        )}
      >
        <OutcomeIcon className={cn("h-5 w-5", outcome.color)} />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2 mb-1">
          <h4 className="font-medium text-sm text-foreground truncate">
            {decision.title}
          </h4>
          <span
            className="text-xs text-muted-foreground shrink-0"
            title={formatFullTimestamp(decision.timestamp)}
          >
            {formatTimestamp(decision.timestamp)}
          </span>
        </div>

        <p className="text-xs text-muted-foreground line-clamp-2 mb-2">
          {decision.question}
        </p>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Outcome badge */}
          <Badge
            variant="secondary"
            className={cn("text-xs", outcome.bgColor, outcome.color)}
          >
            {outcome.label}
          </Badge>

          {/* Type badge */}
          <Badge variant="outline" className="text-xs gap-1">
            <TypeIcon className="h-3 w-3" />
            {decision.type}
          </Badge>

          {/* Response value */}
          {decision.responseValue && (
            <Badge variant="secondary" className="text-xs">
              → {decision.responseValue}
            </Badge>
          )}

          {/* Goal link */}
          {decision.goalTitle && (
            <Badge variant="outline" className="text-xs gap-1">
              <Target className="h-3 w-3" />
              {decision.goalTitle}
            </Badge>
          )}

          {/* Agent */}
          {decision.agentId && (
            <Badge variant="outline" className="text-xs gap-1 text-muted-foreground">
              <Bot className="h-3 w-3" />
              {decision.agentId}
            </Badge>
          )}
        </div>

        {/* Respondent */}
        {decision.respondedBy && decision.respondedAt && (
          <p className="text-xs text-muted-foreground mt-2">
            Responded by{" "}
            <span className="font-medium text-foreground">
              {decision.respondedBy}
            </span>{" "}
            · {formatTimestamp(decision.respondedAt)}
          </p>
        )}
      </div>

      {/* Chevron */}
      <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0 mt-1" />
    </motion.div>
  );
}
