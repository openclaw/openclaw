"use client";

import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { GoalCard, GoalDetailPanel, CreateGoalModal } from "@/components/domain/goals";
import { CardSkeleton } from "@/components/composed/LoadingSkeleton";
import { useGoals } from "@/hooks/queries/useGoals";
import { useCreateGoal } from "@/hooks/mutations/useGoalMutations";
import { useDebounce } from "@/hooks/useDebounce";
import { uuidv7 } from "@/lib/ids";
import { Target, Plus, Search, SlidersHorizontal } from "lucide-react";
import type { Goal, GoalStatus } from "@/hooks/queries/useGoals";

import { RouteErrorFallback } from "@/components/composed";
export const Route = createFileRoute("/goals/")({
  component: GoalsPage,
  errorComponent: RouteErrorFallback,
});

type StatusFilter = "all" | GoalStatus;

const statusOptions: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All Goals" },
  { value: "in_progress", label: "In Progress" },
  { value: "not_started", label: "Not Started" },
  { value: "completed", label: "Completed" },
  { value: "paused", label: "Paused" },
];

// Animation variants for staggered grid
const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.1,
    },
  },
} as const;

const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      type: "spring" as const,
      stiffness: 300,
      damping: 24,
    },
  },
};

function GoalsPage() {
  const [searchQuery, setSearchQuery] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>("all");
  const [selectedGoal, setSelectedGoal] = React.useState<Goal | null>(null);
  const [isDetailOpen, setIsDetailOpen] = React.useState(false);
  const [isCreateOpen, setIsCreateOpen] = React.useState(false);

  const debouncedSearch = useDebounce(searchQuery, 300);

  const { data: goals, isLoading, error } = useGoals();
  const createGoal = useCreateGoal();

  // Filter goals based on search and status
  const filteredGoals = React.useMemo(() => {
    if (!goals) {return [];}

    return goals.filter((goal) => {
      // Status filter
      if (statusFilter !== "all" && goal.status !== statusFilter) {
        return false;
      }

      // Search filter
      if (debouncedSearch) {
        const searchLower = debouncedSearch.toLowerCase();
        return (
          goal.title.toLowerCase().includes(searchLower) ||
          goal.description?.toLowerCase().includes(searchLower) ||
          goal.tags?.some((tag) => tag.toLowerCase().includes(searchLower))
        );
      }

      return true;
    });
  }, [goals, statusFilter, debouncedSearch]);

  const handleViewDetails = (goal: Goal) => {
    setSelectedGoal(goal);
    setIsDetailOpen(true);
  };

  const handleEdit = (goal: Goal) => {
    // Close detail panel and open edit modal
    setIsDetailOpen(false);
    // For now, just log - in a real app, open edit modal
    console.log("Edit goal:", goal);
  };

  const handleCreateGoal = (data: {
    title: string;
    description?: string;
    milestones: { title: string; completed: boolean }[];
    status: "not_started";
    dueDate?: string;
  }) => {
    createGoal.mutate(
      {
        ...data,
        milestones: data.milestones.map((m) => ({ ...m, id: uuidv7() })),
      },
      {
      onSuccess: () => {
        setIsCreateOpen(false);
      },
      }
    );
  };

  // Convert Goal from query to GoalCard format
  const convertToCardGoal = (goal: Goal) => ({
    id: goal.id,
    title: goal.title,
    description: goal.description,
    deadline: goal.dueDate,
    progress: goal.progress,
    status: goal.status === "in_progress" ? "active" as const :
            goal.status === "completed" ? "completed" as const :
            goal.status === "paused" ? "archived" as const : "active" as const,
    milestones: goal.milestones.map((m) => ({
      id: m.id,
      title: m.title,
      completed: m.completed,
    })),
    createdAt: goal.createdAt,
  });

  return (
    <>
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="mb-8"
        >
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10">
                <Target className="h-6 w-6 text-primary" />
              </div>
              <div>
                <h1 className="text-3xl font-bold tracking-tight text-foreground">
                  Goals
                </h1>
                <p className="text-muted-foreground">
                  Track and manage your objectives
                </p>
              </div>
            </div>
            <Button
              onClick={() => setIsCreateOpen(true)}
              className="h-11 rounded-xl gap-2"
            >
              <Plus className="h-4 w-4" />
              New Goal
            </Button>
          </div>
        </motion.div>

        {/* Filters */}
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.1 }}
          className="flex flex-col sm:flex-row gap-3 mb-8"
        >
          {/* Search */}
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search goals..."
              className="h-11 pl-10 rounded-xl"
            />
          </div>

          {/* Status Filter */}
          <Select
            value={statusFilter}
            onValueChange={(value) => setStatusFilter(value as StatusFilter)}
          >
            <SelectTrigger className="h-11 w-full sm:w-[180px] rounded-xl">
              <SlidersHorizontal className="h-4 w-4 mr-2 text-muted-foreground" />
              <SelectValue placeholder="Filter by status" />
            </SelectTrigger>
            <SelectContent>
              {statusOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </motion.div>

        {/* Content */}
        {isLoading ? (
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <CardSkeleton key={i} />
            ))}
          </div>
        ) : error ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex flex-col items-center justify-center py-16 text-center"
          >
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10">
              <Target className="h-8 w-8 text-destructive" />
            </div>
            <h3 className="text-lg font-medium text-foreground mb-2">
              Error Loading Goals
            </h3>
            <p className="text-sm text-muted-foreground max-w-sm">
              {error instanceof Error ? error.message : "An error occurred"}
            </p>
          </motion.div>
        ) : filteredGoals.length === 0 ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex flex-col items-center justify-center py-16 text-center"
          >
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-secondary">
              <Target className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-medium text-foreground mb-2">
              {searchQuery || statusFilter !== "all"
                ? "No matching goals"
                : "No goals yet"}
            </h3>
            <p className="text-sm text-muted-foreground max-w-sm mb-4">
              {searchQuery || statusFilter !== "all"
                ? "Try adjusting your filters"
                : "Create your first goal to start tracking progress"}
            </p>
            {!searchQuery && statusFilter === "all" && (
              <Button
                onClick={() => setIsCreateOpen(true)}
                className="rounded-xl gap-2"
              >
                <Plus className="h-4 w-4" />
                Create Goal
              </Button>
            )}
          </motion.div>
        ) : (
          <motion.div
            variants={containerVariants}
            initial="hidden"
            animate="visible"
            className="grid gap-6 md:grid-cols-2 lg:grid-cols-3"
          >
            <AnimatePresence mode="popLayout">
              {filteredGoals.map((goal) => (
                <motion.div
                  key={goal.id}
                  variants={itemVariants}
                  layout
                  exit={{ opacity: 0, scale: 0.9 }}
                >
                  <GoalCard
                    goal={convertToCardGoal(goal)}
                    onViewDetails={() => handleViewDetails(goal)}
                    onEdit={() => handleEdit(goal)}
                  />
                </motion.div>
              ))}
            </AnimatePresence>
          </motion.div>
        )}

        {/* Goal Detail Panel */}
        <GoalDetailPanel
          goal={selectedGoal}
          open={isDetailOpen}
          onClose={() => setIsDetailOpen(false)}
          onEdit={handleEdit}
        />

      {/* Create Goal Modal */}
      <CreateGoalModal
        open={isCreateOpen}
        onOpenChange={setIsCreateOpen}
        onSubmit={handleCreateGoal}
        isLoading={createGoal.isPending}
      />
    </>
  );
}
