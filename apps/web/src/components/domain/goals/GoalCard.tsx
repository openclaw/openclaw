"use client";

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Target, Calendar, ArrowRight, MoreHorizontal, Pencil } from "lucide-react";

export type GoalStatus = "active" | "completed" | "archived";

export interface Milestone {
  id: string;
  title: string;
  completed: boolean;
  completedAt?: string;
}

export interface Goal {
  id: string;
  title: string;
  description?: string;
  deadline?: string;
  progress: number;
  status: GoalStatus;
  milestones?: Milestone[];
  workstreamCount?: number;
  createdAt?: string;
  completedAt?: string;
}

interface GoalCardProps {
  goal: Goal;
  variant?: "expanded" | "compact" | "minimal";
  onViewDetails?: () => void;
  onEdit?: () => void;
  className?: string;
}

const statusConfig: Record<GoalStatus, { color: string; bgColor: string; label: string }> = {
  active: { color: "text-primary", bgColor: "bg-primary/20", label: "Active" },
  completed: { color: "text-success", bgColor: "bg-success/20", label: "Completed" },
  archived: { color: "text-muted-foreground", bgColor: "bg-muted", label: "Archived" },
};

function formatDeadline(deadline: string): string {
  const date = new Date(deadline);
  const now = new Date();
  const diffTime = date.getTime() - now.getTime();
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

  if (diffDays < 0) {
    return `${Math.abs(diffDays)} days overdue`;
  } else if (diffDays === 0) {
    return "Due today";
  } else if (diffDays === 1) {
    return "Due tomorrow";
  } else if (diffDays <= 7) {
    return `${diffDays} days left`;
  } else {
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
}

function ProgressBar({ progress, status, compact }: { progress: number; status: GoalStatus; compact?: boolean }) {
  const progressColor = status === "completed"
    ? "bg-success"
    : status === "archived"
      ? "bg-muted-foreground"
      : "bg-primary";

  return (
    <div className={cn("relative w-full overflow-hidden rounded-full bg-secondary/50", compact ? "h-1" : "h-2")}>
      <motion.div
        initial={{ width: 0 }}
        animate={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
        transition={{ duration: 0.6, ease: "easeOut" }}
        className={cn("h-full rounded-full", progressColor)}
      />
    </div>
  );
}

export function GoalCard({
  goal,
  variant = "expanded",
  onViewDetails,
  onEdit,
  className,
}: GoalCardProps) {
  const [isHovered, setIsHovered] = React.useState(false);
  const status = statusConfig[goal.status];
  const completedMilestones = goal.milestones?.filter((m) => m.completed).length ?? 0;
  const totalMilestones = goal.milestones?.length ?? 0;

  // Minimal variant - most compact, for dense lists
  if (variant === "minimal") {
    return (
      <motion.div
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2 }}
        className={cn("group", className)}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        <Card 
          className="cursor-pointer overflow-hidden border-border/50 bg-card/80 backdrop-blur-sm transition-all duration-200 hover:border-primary/30 hover:bg-accent/5"
          onClick={onViewDetails}
        >
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              {/* Compact icon with status color */}
              <div 
                className={cn(
                  "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
                  status.bgColor
                )}
              >
                <Target className={cn("h-4 w-4", status.color)} />
              </div>

              {/* Main info */}
              <div className="min-w-0 flex-1">
                <h4 className="truncate text-sm font-medium text-foreground">
                  {goal.title}
                </h4>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>{goal.progress}% complete</span>
                  {totalMilestones > 0 && (
                    <>
                      <span>•</span>
                      <span>{completedMilestones}/{totalMilestones} milestones</span>
                    </>
                  )}
                </div>
              </div>

              {/* Status badge - compact */}
              <Badge variant="secondary" className={cn("text-[10px] px-1.5 py-0 shrink-0", status.bgColor, status.color, "border-0")}>
                {status.label}
              </Badge>

              {/* Arrow on hover */}
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  "h-8 w-8 shrink-0 transition-opacity",
                  isHovered ? "opacity-100" : "opacity-0"
                )}
                onClick={(e) => {
                  e.stopPropagation();
                  onViewDetails?.();
                }}
              >
                <ArrowRight className="h-4 w-4" />
              </Button>
            </div>

            {/* Compact progress bar */}
            <div className="mt-3">
              <ProgressBar progress={goal.progress} status={goal.status} compact />
            </div>

            {/* Hover-revealed details */}
            <AnimatePresence>
              {isHovered && (goal.description || goal.deadline) && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.15 }}
                  className="overflow-hidden"
                >
                  <div className="pt-3 space-y-2 border-t border-border/50 mt-3">
                    {goal.description && (
                      <p className="text-xs text-muted-foreground line-clamp-2">
                        {goal.description}
                      </p>
                    )}
                    {goal.deadline && goal.status === "active" && (
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Calendar className="h-3 w-3" />
                        <span>{formatDeadline(goal.deadline)}</span>
                      </div>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </CardContent>
        </Card>
      </motion.div>
    );
  }

  if (variant === "compact") {
    return (
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: "easeOut" }}
        whileHover={{ scale: 1.02 }}
        className={cn("group", className)}
      >
        <Card className="overflow-hidden border-border/50 bg-card/80 backdrop-blur-sm transition-all duration-300 hover:border-primary/30 hover:shadow-lg hover:shadow-primary/5">
          <CardContent className="flex items-center gap-4 p-4">
            {/* Icon */}
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10">
              <Target className={cn("h-5 w-5", status.color)} />
            </div>

            {/* Info */}
            <div className="min-w-0 flex-1">
              <h4 className="truncate text-sm font-medium text-foreground">{goal.title}</h4>
              <div className="mt-1 flex items-center gap-2">
                <ProgressBar progress={goal.progress} status={goal.status} />
                <span className="shrink-0 text-xs text-muted-foreground">{goal.progress}%</span>
              </div>
            </div>

            {/* Quick action */}
            <Button
              variant="ghost"
              size="icon"
              onClick={onViewDetails}
              className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
            >
              <ArrowRight className="h-4 w-4" />
            </Button>
          </CardContent>
        </Card>
      </motion.div>
    );
  }

  // Expanded variant - full details, for detail-oriented views
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
      className={cn("group relative", className)}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <Card className="relative overflow-hidden rounded-xl border-border/50 bg-card/95 backdrop-blur-sm transition-all duration-300 hover:border-primary/30 hover:shadow-lg">
        <CardContent className="p-5">
          {/* Header: Icon + Title + Status */}
          <div className="mb-4 flex items-start gap-3">
            <div 
              className={cn(
                "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg",
                status.bgColor
              )}
            >
              <Target className={cn("h-5 w-5", status.color)} />
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-2">
                <h3 className="text-base font-semibold text-foreground transition-colors group-hover:text-primary line-clamp-1">
                  {goal.title}
                </h3>
                <Badge variant="secondary" className={cn("shrink-0 text-[10px] px-1.5 py-0", status.bgColor, status.color, "border-0")}>
                  {status.label}
                </Badge>
              </div>
              <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                <span>{goal.progress}% complete</span>
                {totalMilestones > 0 && (
                  <>
                    <span>•</span>
                    <span>{completedMilestones}/{totalMilestones} milestones</span>
                  </>
                )}
                {goal.deadline && goal.status === "active" && (
                  <>
                    <span>•</span>
                    <span>{formatDeadline(goal.deadline)}</span>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Progress bar */}
          <div className="mb-4">
            <ProgressBar progress={goal.progress} status={goal.status} />
          </div>

          {/* Description - always visible in expanded mode */}
          {goal.description && (
            <p className="mb-4 text-sm text-muted-foreground line-clamp-2">
              {goal.description}
            </p>
          )}

          {/* Milestone visualization - visible on hover */}
          <AnimatePresence>
            {isHovered && goal.milestones && goal.milestones.length > 0 && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.15 }}
                className="overflow-hidden"
              >
                <div className="mb-4 pb-4 border-b border-border/50">
                  <div className="flex items-center gap-1">
                    {goal.milestones.slice(0, 8).map((milestone) => (
                      <div
                        key={milestone.id}
                        title={milestone.title}
                        className={cn(
                          "h-1.5 flex-1 rounded-full transition-colors",
                          milestone.completed ? "bg-success" : "bg-secondary/80"
                        )}
                      />
                    ))}
                    {goal.milestones.length > 8 && (
                      <span className="ml-1 text-[10px] text-muted-foreground">
                        +{goal.milestones.length - 8}
                      </span>
                    )}
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Actions - single primary action with overflow */}
          <div className="flex items-center justify-between">
            <Button
              onClick={onViewDetails}
              variant="ghost"
              size="sm"
              className="h-9 gap-2 text-primary hover:text-primary hover:bg-primary/10"
            >
              <ArrowRight className="h-4 w-4" />
              View Details
            </Button>

            {goal.status !== "archived" && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn(
                      "h-8 w-8 transition-opacity",
                      isHovered ? "opacity-100" : "opacity-0"
                    )}
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={onEdit}>
                    <Pencil className="mr-2 h-4 w-4" />
                    Edit Goal
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>

          {/* Completed date */}
          {goal.completedAt && goal.status === "completed" && (
            <p className="mt-3 text-center text-xs text-muted-foreground/70">
              Completed on {new Date(goal.completedAt).toLocaleDateString()}
            </p>
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
}

export default GoalCard;
