"use client";

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Progress } from "@/components/ui/progress";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  GitBranch,
  Calendar,
  CheckCircle2,
  ArrowRight,
  Pause,
  Play,
  Archive,
  MoreHorizontal,
  Network,
  Pencil,
} from "lucide-react";
import type { Workstream, WorkstreamStatus } from "@/hooks/queries/useWorkstreams";
import type { Agent } from "@/stores/useAgentStore";

interface WorkstreamCardProps {
  workstream: Workstream;
  owner?: Agent | null;
  variant?: "expanded" | "compact" | "minimal";
  onViewDetails?: () => void;
  onOpenDAG?: () => void;
  onEdit?: () => void;
  className?: string;
}

const statusConfig: Record<
  WorkstreamStatus,
  { color: string; bgColor: string; label: string; icon?: React.ReactNode }
> = {
  active: {
    color: "text-green-500",
    bgColor: "bg-green-500/20",
    label: "Active",
    icon: <Play className="h-3 w-3" />,
  },
  paused: {
    color: "text-orange-500",
    bgColor: "bg-orange-500/20",
    label: "Paused",
    icon: <Pause className="h-3 w-3" />,
  },
  completed: {
    color: "text-blue-500",
    bgColor: "bg-blue-500/20",
    label: "Completed",
    icon: <CheckCircle2 className="h-3 w-3" />,
  },
  archived: {
    color: "text-gray-500",
    bgColor: "bg-gray-500/20",
    label: "Archived",
    icon: <Archive className="h-3 w-3" />,
  },
};

function formatDueDate(dueDate: string): string {
  const date = new Date(dueDate);
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

function getOwnerInitials(owner: Agent | null | undefined): string {
  if (!owner?.name) {return "?";}
  return owner.name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

export function WorkstreamCard({
  workstream,
  owner,
  variant = "expanded",
  onViewDetails,
  onOpenDAG,
  onEdit,
  className,
}: WorkstreamCardProps) {
  const [isHovered, setIsHovered] = React.useState(false);
  const status = statusConfig[workstream.status];
  const completedTasks = workstream.tasks.filter((t) => t.status === "done").length;
  const totalTasks = workstream.tasks.length;

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
                  "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors",
                  workstream.status === "active" && "bg-green-500/10",
                  workstream.status === "paused" && "bg-orange-500/10",
                  workstream.status === "completed" && "bg-blue-500/10",
                  workstream.status === "archived" && "bg-gray-500/10"
                )}
              >
                <GitBranch className={cn("h-4 w-4", status.color)} />
              </div>

              {/* Main info */}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h4 className="truncate text-sm font-medium text-foreground">
                    {workstream.name}
                  </h4>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>{workstream.progress}%</span>
                  <span>•</span>
                  <span>{completedTasks}/{totalTasks} tasks</span>
                </div>
              </div>

              {/* Overflow menu */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn(
                      "h-8 w-8 shrink-0 transition-opacity",
                      isHovered ? "opacity-100" : "opacity-0"
                    )}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={onOpenDAG}>
                    <Network className="mr-2 h-4 w-4" />
                    Open DAG
                  </DropdownMenuItem>
                  {onEdit && (
                    <DropdownMenuItem onClick={onEdit}>
                      <Pencil className="mr-2 h-4 w-4" />
                      Edit
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            {/* Compact progress bar */}
            <div className="mt-3">
              <Progress value={workstream.progress} className="h-1" />
            </div>

            {/* Hover-revealed details */}
            <AnimatePresence>
              {isHovered && (workstream.description || (workstream.tags && workstream.tags.length > 0)) && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.15 }}
                  className="overflow-hidden"
                >
                  <div className="pt-3 space-y-2 border-t border-border/50 mt-3">
                    {workstream.description && (
                      <p className="text-xs text-muted-foreground line-clamp-2">
                        {workstream.description}
                      </p>
                    )}
                    {workstream.tags && workstream.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {workstream.tags.slice(0, 3).map((tag) => (
                          <Badge key={tag} variant="secondary" className="text-[10px] px-1.5 py-0">
                            {tag}
                          </Badge>
                        ))}
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
              <GitBranch className={cn("h-5 w-5", status.color)} />
            </div>

            {/* Info */}
            <div className="min-w-0 flex-1">
              <h4 className="truncate text-sm font-medium text-foreground">
                {workstream.name}
              </h4>
              <div className="mt-1 flex items-center gap-2">
                <Progress value={workstream.progress} className="h-1.5 flex-1" />
                <span className="shrink-0 text-xs text-muted-foreground">
                  {workstream.progress}%
                </span>
              </div>
            </div>

            {/* Owner avatar */}
            {owner && (
              <Avatar className="h-6 w-6">
                <AvatarImage src={owner.avatar} alt={owner.name} />
                <AvatarFallback className="text-xs">
                  {getOwnerInitials(owner)}
                </AvatarFallback>
              </Avatar>
            )}

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

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: "easeOut" }}
      className={cn("group relative", className)}
    >
      <Card className="relative overflow-hidden rounded-2xl border-border/50 bg-gradient-to-br from-card via-card to-card/80 backdrop-blur-sm transition-all duration-500 hover:border-primary/30 hover:shadow-xl hover:shadow-primary/10">
        {/* Gradient accent line */}
        <div className="absolute left-0 right-0 top-0 h-0.5 bg-gradient-to-r from-primary via-accent to-primary opacity-60" />

        {/* Glow effect on hover */}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-primary/5 via-transparent to-accent/5 opacity-0 transition-opacity duration-500 group-hover:opacity-100" />

        <CardContent className="relative p-6">
          {/* Header */}
          <div className="mb-4 flex items-center justify-between">
            <Badge className={cn(status.bgColor, status.color, "border-0 gap-1")}>
              {status.icon}
              {status.label}
            </Badge>
            {workstream.dueDate && workstream.status === "active" && (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Calendar className="h-3.5 w-3.5" />
                <span>{formatDueDate(workstream.dueDate)}</span>
              </div>
            )}
          </div>

          {/* Title and icon */}
          <div className="mb-4 flex items-start gap-4">
            <motion.div
              whileHover={{ scale: 1.05, rotate: 5 }}
              transition={{ type: "spring", stiffness: 300 }}
              className="relative"
            >
              <div className="absolute inset-0 rounded-xl bg-gradient-to-br from-primary/40 to-accent/40 opacity-0 blur-md transition-opacity duration-300 group-hover:opacity-60" />
              <div className="relative flex h-14 w-14 items-center justify-center rounded-xl bg-primary/10 ring-2 ring-border/50 shadow-lg transition-all duration-300 group-hover:ring-primary/30">
                <GitBranch className={cn("h-7 w-7", status.color)} />
              </div>
            </motion.div>

            <div className="min-w-0 flex-1">
              <h3 className="truncate text-xl font-semibold tracking-tight text-foreground transition-colors duration-300 group-hover:text-primary">
                {workstream.name}
              </h3>
              {workstream.description && (
                <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                  {workstream.description}
                </p>
              )}
            </div>

            {/* Owner avatar */}
            {owner && (
              <div className="flex flex-col items-center gap-1">
                <Avatar className="h-10 w-10 ring-2 ring-border/50">
                  <AvatarImage src={owner.avatar} alt={owner.name} />
                  <AvatarFallback>{getOwnerInitials(owner)}</AvatarFallback>
                </Avatar>
                <span className="text-xs text-muted-foreground">{owner.role}</span>
              </div>
            )}
          </div>

          {/* Progress section */}
          <div className="mb-5">
            <div className="mb-2 flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Progress</span>
              <span className="font-medium text-foreground">{workstream.progress}%</span>
            </div>
            <Progress value={workstream.progress} className="h-2" />
          </div>

          {/* Metadata row */}
          <div className="mb-5 flex flex-wrap gap-3">
            <motion.div
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: 0.1 }}
              className="flex items-center gap-1.5 rounded-full border border-border/50 bg-secondary/80 px-3 py-1 text-xs font-medium text-secondary-foreground transition-all duration-200 hover:border-primary/30 hover:bg-secondary"
            >
              <CheckCircle2 className="h-3.5 w-3.5" />
              <span>
                {completedTasks}/{totalTasks} tasks
              </span>
            </motion.div>
            {workstream.tags && workstream.tags.length > 0 && (
              <motion.div
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: 0.15 }}
                className="flex items-center gap-1.5 rounded-full border border-border/50 bg-secondary/80 px-3 py-1 text-xs font-medium text-secondary-foreground"
              >
                {workstream.tags.slice(0, 2).join(", ")}
                {workstream.tags.length > 2 && ` +${workstream.tags.length - 2}`}
              </motion.div>
            )}
          </div>

          {/* Task status mini visualization */}
          {totalTasks > 0 && (
            <div className="mb-5">
              {(() => {
                const counts = {
                  done: workstream.tasks.filter((t) => t.status === "done").length,
                  in_progress: workstream.tasks.filter((t) => t.status === "in_progress").length,
                  review: workstream.tasks.filter((t) => t.status === "review").length,
                  blocked: workstream.tasks.filter((t) => t.status === "blocked").length,
                  todo: workstream.tasks.filter((t) => t.status === "todo").length,
                };

                const segments: Array<{ key: keyof typeof counts; label: string; color: string; count: number }> = [
                  { key: "done", label: "Done", color: "bg-green-500", count: counts.done },
                  { key: "in_progress", label: "In progress", color: "bg-yellow-500", count: counts.in_progress },
                  { key: "review", label: "Review", color: "bg-blue-500", count: counts.review },
                  { key: "blocked", label: "Blocked", color: "bg-red-500", count: counts.blocked },
                  { key: "todo", label: "Todo", color: "bg-secondary/80", count: counts.todo },
                ];

                return (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>Tasks by status</span>
                      <span className="font-mono">{totalTasks}</span>
                    </div>
                    <div className="flex items-center gap-1" aria-label="Tasks by status">
                      {segments.map((s) =>
                        s.count > 0 ? (
                          <motion.div
                            key={s.key}
                            initial={{ opacity: 0, scaleX: 0.4 }}
                            animate={{ opacity: 1, scaleX: 1 }}
                            transition={{ delay: 0.2, duration: 0.25 }}
                            title={`${s.label}: ${s.count}`}
                            className={cn("h-2 origin-left rounded-full", s.color)}
                            style={{ flexGrow: s.count }}
                          />
                        ) : null
                      )}
                      {segments.every((s) => s.count === 0) && (
                        <div className="h-2 flex-1 rounded-full bg-secondary/60" />
                      )}
                    </div>
                  </div>
                );
              })()}
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-2">
            <Button
              onClick={onOpenDAG}
              className="h-11 flex-1 rounded-xl bg-primary/10 text-primary transition-all hover:bg-primary/20"
              variant="ghost"
            >
              <GitBranch className="mr-2 h-4 w-4" />
              Open DAG
            </Button>
            <Button
              onClick={onViewDetails}
              variant="ghost"
              className="h-11 rounded-xl bg-secondary/50 transition-all hover:bg-secondary"
            >
              <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}

export default WorkstreamCard;
