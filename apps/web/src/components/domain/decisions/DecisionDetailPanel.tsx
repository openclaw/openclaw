"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { DetailPanel } from "@/components/composed/DetailPanel";
import {
  CheckCircle2,
  XCircle,
  Clock,
  Timer,
  Target,
  Bot,
  User,
  Calendar,
  ArrowRight,
  MessageSquare,
  Copy,
  ToggleLeft,
  ListChecks,
  Type,
  ShieldCheck,
} from "lucide-react";
import type { DecisionAuditEntry, DecisionOutcome } from "./decision-types";

interface DecisionDetailPanelProps {
  decision: DecisionAuditEntry | null;
  open: boolean;
  onClose: () => void;
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

const typeLabels: Record<string, string> = {
  binary: "Binary (Yes/No)",
  choice: "Multiple Choice",
  text: "Free Text",
  confirmation: "Confirmation",
};

const typeIcons: Record<string, React.ElementType> = {
  binary: ToggleLeft,
  choice: ListChecks,
  text: Type,
  confirmation: ShieldCheck,
};

function formatFullDate(ts: number): string {
  return new Date(ts).toLocaleString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatDuration(startTs: number, endTs: number): string {
  const diffMs = endTs - startTs;
  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

export function DecisionDetailPanel({
  decision,
  open,
  onClose,
  className,
}: DecisionDetailPanelProps) {
  if (!decision) return null;

  const outcome = outcomeConfig[decision.outcome];
  const OutcomeIcon = outcome.icon;
  const TypeIcon = typeIcons[decision.type] || MessageSquare;

  const handleCopyId = () => {
    navigator.clipboard.writeText(decision.id);
  };

  return (
    <DetailPanel
      open={open}
      onClose={onClose}
      title="Decision Details"
      className={className}
    >
      <div className="space-y-6 p-4">
        {/* Header */}
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <div
              className={cn(
                "flex h-12 w-12 items-center justify-center rounded-full",
                outcome.bgColor
              )}
            >
              <OutcomeIcon className={cn("h-6 w-6", outcome.color)} />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-foreground">
                {decision.title}
              </h3>
              <div className="flex items-center gap-2 mt-1">
                <Badge
                  variant="secondary"
                  className={cn("text-xs", outcome.bgColor, outcome.color)}
                >
                  {outcome.label}
                </Badge>
                <Badge variant="outline" className="text-xs gap-1">
                  <TypeIcon className="h-3 w-3" />
                  {typeLabels[decision.type] || decision.type}
                </Badge>
              </div>
            </div>
          </div>
        </div>

        <Separator />

        {/* Question */}
        <div className="space-y-2">
          <h4 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <MessageSquare className="h-4 w-4" />
            Question
          </h4>
          <p className="text-sm text-foreground bg-muted/50 rounded-lg p-3">
            {decision.question}
          </p>
        </div>

        {/* Options */}
        {decision.options && decision.options.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <ListChecks className="h-4 w-4" />
              Available Options
            </h4>
            <div className="space-y-1.5">
              {decision.options.map((option, i) => (
                <div
                  key={i}
                  className={cn(
                    "flex items-center gap-2 rounded-lg border px-3 py-2 text-sm",
                    decision.responseValue === option.value
                      ? "border-primary bg-primary/5"
                      : "border-border/50"
                  )}
                >
                  {decision.responseValue === option.value && (
                    <CheckCircle2 className="h-4 w-4 text-primary shrink-0" />
                  )}
                  <span
                    className={cn(
                      decision.responseValue === option.value
                        ? "font-medium text-foreground"
                        : "text-muted-foreground"
                    )}
                  >
                    {option.label}
                  </span>
                  {decision.responseValue === option.value && (
                    <Badge variant="secondary" className="ml-auto text-xs">
                      Selected
                    </Badge>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Response */}
        {decision.responseValue && !decision.options?.length && (
          <div className="space-y-2">
            <h4 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <ArrowRight className="h-4 w-4" />
              Response
            </h4>
            <p className="text-sm text-foreground bg-primary/5 border border-primary/20 rounded-lg p-3">
              {decision.responseValue}
            </p>
          </div>
        )}

        {/* Reasoning */}
        {decision.reasoning && (
          <div className="space-y-2">
            <h4 className="text-sm font-medium text-muted-foreground">
              Reasoning
            </h4>
            <p className="text-sm text-muted-foreground bg-muted/50 rounded-lg p-3 leading-relaxed">
              {decision.reasoning}
            </p>
          </div>
        )}

        {/* Dispatched Actions */}
        {decision.dispatchedActions && decision.dispatchedActions.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <ArrowRight className="h-4 w-4" />
              Dispatched Actions
            </h4>
            <div className="space-y-1.5">
              {decision.dispatchedActions.map((action, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 text-sm text-foreground bg-muted/50 rounded-lg px-3 py-2"
                >
                  <div className="h-1.5 w-1.5 rounded-full bg-primary shrink-0" />
                  {action}
                </div>
              ))}
            </div>
          </div>
        )}

        <Separator />

        {/* Metadata Grid */}
        <div className="grid grid-cols-2 gap-4">
          {/* Created */}
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <Calendar className="h-3 w-3" />
              Created
            </p>
            <p className="text-sm text-foreground">
              {formatFullDate(decision.timestamp)}
            </p>
          </div>

          {/* Response Time */}
          {decision.respondedAt && (
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <Clock className="h-3 w-3" />
                Response Time
              </p>
              <p className="text-sm text-foreground">
                {formatDuration(decision.timestamp, decision.respondedAt)}
              </p>
            </div>
          )}

          {/* Responded By */}
          {decision.respondedBy && (
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <User className="h-3 w-3" />
                Responded By
              </p>
              <p className="text-sm text-foreground font-medium">
                {decision.respondedBy}
              </p>
            </div>
          )}

          {/* Agent */}
          {decision.agentId && (
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <Bot className="h-3 w-3" />
                Requesting Agent
              </p>
              <p className="text-sm text-foreground font-mono">
                {decision.agentId}
              </p>
            </div>
          )}

          {/* Goal */}
          {decision.goalTitle && (
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <Target className="h-3 w-3" />
                Related Goal
              </p>
              <p className="text-sm text-foreground">{decision.goalTitle}</p>
            </div>
          )}
        </div>

        <Separator />

        {/* Footer */}
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground font-mono">
            {decision.id}
          </p>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs gap-1"
            onClick={handleCopyId}
          >
            <Copy className="h-3 w-3" />
            Copy ID
          </Button>
        </div>
      </div>
    </DetailPanel>
  );
}
