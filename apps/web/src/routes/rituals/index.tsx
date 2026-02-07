"use client";

import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RitualCard, RitualDetailPanel, CreateRitualModal } from "@/components/domain/rituals";
import { ListItemSkeleton } from "@/components/composed/LoadingSkeleton";
import { useRituals, useRitualExecutions } from "@/hooks/queries/useRituals";
import { useAgents } from "@/hooks/queries/useAgents";
import {
  useCreateRitual,
  useUpdateRitual,
  usePauseRitual,
  useResumeRitual,
  useDeleteRitual,
  useTriggerRitual,
} from "@/hooks/mutations/useRitualMutations";
import { useDebounce } from "@/hooks/useDebounce";
import {
  RefreshCw,
  Plus,
  Search,
  SlidersHorizontal,
  Pause,
  Play,
  Calendar,
  RotateCcw,
} from "lucide-react";
import type { Ritual, RitualStatus, RitualFrequency } from "@/hooks/queries/useRituals";

import { RouteErrorFallback } from "@/components/composed";
export const Route = createFileRoute("/rituals/")({
  component: RitualsPage,
  errorComponent: RouteErrorFallback,
  validateSearch: (search: Record<string, unknown>): { ritualId?: string } => {
    const ritualId = typeof search.ritualId === "string" ? search.ritualId : undefined;
    return { ritualId };
  },
});

type StatusFilter = "all" | RitualStatus;
type FrequencyFilter = "all" | RitualFrequency;

const statusOptions: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All Rituals" },
  { value: "active", label: "Active" },
  { value: "paused", label: "Paused" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
];

const frequencyOptions: { value: FrequencyFilter; label: string }[] = [
  { value: "all", label: "All Frequencies" },
  { value: "hourly", label: "Hourly" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "custom", label: "Custom" },
];

// Animation variants for staggered list
const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.08,
    },
  },
} as const;

const itemVariants = {
  hidden: { opacity: 0, x: -20 },
  visible: {
    opacity: 1,
    x: 0,
    transition: {
      type: "spring" as const,
      stiffness: 300,
      damping: 24,
    },
  },
};

function RitualsPage() {
  const { ritualId } = Route.useSearch();
  const navigate = Route.useNavigate();
  const [searchQuery, setSearchQuery] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>("all");
  const [frequencyFilter, setFrequencyFilter] = React.useState<FrequencyFilter>("all");
  const [density, setDensity] = React.useState<"compact" | "expanded">("compact");
  const [selectedRitual, setSelectedRitual] = React.useState<Ritual | null>(null);
  const [isDetailOpen, setIsDetailOpen] = React.useState(false);
  const [isCreateOpen, setIsCreateOpen] = React.useState(false);

  const debouncedSearch = useDebounce(searchQuery, 300);

  const { data: rituals, isLoading, error } = useRituals();
  const { data: agents } = useAgents();
  const { data: executions } = useRitualExecutions(selectedRitual?.id || "");

  const createRitual = useCreateRitual();
  const updateRitual = useUpdateRitual();
  const pauseRitual = usePauseRitual();
  const resumeRitual = useResumeRitual();
  const deleteRitual = useDeleteRitual();
  const triggerRitual = useTriggerRitual();

  React.useEffect(() => {
    if (!ritualId || !rituals || rituals.length === 0) {return;}
    const ritual = rituals.find((r) => r.id === ritualId);
    if (!ritual) {return;}
    setSelectedRitual(ritual);
    setIsDetailOpen(true);
  }, [ritualId, rituals]);

  // Filter rituals based on search and status
  const resolvedStatusFilter = statusOptions.some((option) => option.value === statusFilter)
    ? statusFilter
    : "all";
  const resolvedFrequencyFilter = frequencyOptions.some((option) => option.value === frequencyFilter)
    ? frequencyFilter
    : "all";

  React.useEffect(() => {
    if (resolvedStatusFilter !== statusFilter) {
      setStatusFilter(resolvedStatusFilter);
    }
  }, [resolvedStatusFilter, statusFilter]);

  React.useEffect(() => {
    if (resolvedFrequencyFilter !== frequencyFilter) {
      setFrequencyFilter(resolvedFrequencyFilter);
    }
  }, [resolvedFrequencyFilter, frequencyFilter]);

  const filteredRituals = React.useMemo(() => {
    if (!rituals) {return [];}

    return rituals.filter((ritual) => {
      // Status filter
      if (resolvedStatusFilter !== "all" && ritual.status !== resolvedStatusFilter) {
        return false;
      }

      if (resolvedFrequencyFilter !== "all" && ritual.frequency !== resolvedFrequencyFilter) {
        return false;
      }

      // Search filter
      if (debouncedSearch) {
        const searchLower = debouncedSearch.toLowerCase();
        return (
          ritual.name.toLowerCase().includes(searchLower) ||
          ritual.description?.toLowerCase().includes(searchLower)
        );
      }

      return true;
    });
  }, [rituals, resolvedStatusFilter, resolvedFrequencyFilter, debouncedSearch]);

  const activeCount = filteredRituals.filter((r) => r.status === "active").length;
  const pausedCount = filteredRituals.filter((r) => r.status === "paused").length;

  const handleViewDetails = (ritual: Ritual) => {
    navigate({ search: { ritualId: ritual.id } });
    setSelectedRitual(ritual);
    setIsDetailOpen(true);
  };

  const handleCloseDetail = React.useCallback(() => {
    setIsDetailOpen(false);
    setSelectedRitual(null);
    navigate({ search: {} });
  }, [navigate]);

  const handleToggle = (ritual: Ritual) => {
    if (ritual.status === "active") {
      pauseRitual.mutate(ritual.id);
    } else if (ritual.status === "paused") {
      resumeRitual.mutate(ritual.id);
    }
  };

  const handleSkipNext = (id: string) => {
    toast.success("Next run skipped (mock)");
    console.log("Skip next ritual:", id);
  };

  const handleCreateRitual = (data: {
    name: string;
    description?: string;
    schedule: string;
    frequency: Ritual["frequency"];
    agentId?: string;
    status: "active";
  }) => {
    createRitual.mutate(data, {
      onSuccess: () => {
        setIsCreateOpen(false);
      },
    });
  };

  const buildSchedule = (time: string, frequency: RitualFrequency): string => {
    const [hours, minutes] = time.split(":");
    switch (frequency) {
      case "hourly":
        return `${minutes} * * * *`;
      case "daily":
        return `${minutes} ${hours} * * *`;
      case "weekly":
        return `${minutes} ${hours} * * 1`;
      case "monthly":
        return `${minutes} ${hours} 1 * *`;
      default:
        return `${minutes} ${hours} * * *`;
    }
  };

  // Convert Ritual from query to RitualCard format
  const convertToCardRitual = (ritual: Ritual) => {
    // Extract time from schedule or nextRun
    let time = "09:00";
    if (ritual.nextRun) {
      const date = new Date(ritual.nextRun);
      time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    }

    // Find agent name
    const agent = agents?.find((a) => a.id === ritual.agentId);

    return {
      id: ritual.id,
      name: ritual.name,
      description: ritual.description,
      frequency: ritual.frequency,
      time,
      enabled: ritual.status === "active",
      status: ritual.status,
      successRate: ritual.successRate,
      agentId: ritual.agentId,
      agentName: agent?.name,
      nextOccurrence: ritual.nextRun ? new Date(ritual.nextRun) : undefined,
      lastRun: ritual.lastRun ? new Date(ritual.lastRun) : undefined,
    };
  };

  // Convert agents for selectors
  const agentOptions = React.useMemo(() => {
    if (!agents) {return [];}
    return agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
    }));
  }, [agents]);

  return (
    <div className="max-w-5xl mx-auto">
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
                <RefreshCw className="h-6 w-6 text-primary" />
              </div>
              <div>
                <h1 className="text-3xl font-bold tracking-tight text-foreground">
                  Rituals
                </h1>
                <p className="text-muted-foreground">
                  Automated recurring tasks and schedules
                </p>
              </div>
            </div>
            <Button
              onClick={() => setIsCreateOpen(true)}
              className="h-11 rounded-xl gap-2"
            >
              <Plus className="h-4 w-4" />
              New Ritual
            </Button>
          </div>
        </motion.div>

        {/* Filters */}
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.1 }}
          className="flex flex-col sm:flex-row sm:items-center gap-3 mb-8"
        >
          {/* Search */}
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search rituals..."
              className="h-11 pl-10 rounded-xl"
            />
          </div>

          {/* Status Filter */}
          <Select
            value={resolvedStatusFilter}
            onValueChange={(value) => setStatusFilter((value || "all") as StatusFilter)}
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

          {/* Frequency Filter */}
          <Select
            value={resolvedFrequencyFilter}
            onValueChange={(value) => setFrequencyFilter((value || "all") as FrequencyFilter)}
          >
            <SelectTrigger className="h-11 w-full sm:w-[180px] rounded-xl">
              <Calendar className="h-4 w-4 mr-2 text-muted-foreground" />
              <SelectValue placeholder="Filter by frequency" />
            </SelectTrigger>
            <SelectContent>
              {frequencyOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Density Toggle */}
          <div className="flex items-center gap-2 rounded-xl border border-border/60 bg-card/60 p-1">
            <Button
              type="button"
              variant={density === "compact" ? "default" : "ghost"}
              size="sm"
              className="h-9 rounded-lg"
              onClick={() => setDensity("compact")}
            >
              Compact
            </Button>
            <Button
              type="button"
              variant={density === "expanded" ? "default" : "ghost"}
              size="sm"
              className="h-9 rounded-lg"
              onClick={() => setDensity("expanded")}
            >
              Expanded
            </Button>
          </div>

          {(searchQuery || resolvedStatusFilter !== "all" || resolvedFrequencyFilter !== "all") && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-11 rounded-xl gap-2"
              onClick={() => {
                setSearchQuery("");
                setStatusFilter("all");
                setFrequencyFilter("all");
              }}
            >
              <RotateCcw className="h-4 w-4" />
              Reset Filters
            </Button>
          )}
        </motion.div>

        {/* Content */}
        {isLoading ? (
          <div className="space-y-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <ListItemSkeleton key={i} />
            ))}
          </div>
        ) : error ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex flex-col items-center justify-center py-16 text-center"
          >
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10">
              <RefreshCw className="h-8 w-8 text-destructive" />
            </div>
            <h3 className="text-lg font-medium text-foreground mb-2">
              Error Loading Rituals
            </h3>
            <p className="text-sm text-muted-foreground max-w-sm">
              {error instanceof Error ? error.message : "An error occurred"}
            </p>
          </motion.div>
        ) : filteredRituals.length === 0 ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex flex-col items-center justify-center py-16 text-center"
          >
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-secondary">
              <RefreshCw className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-medium text-foreground mb-2">
              {searchQuery || statusFilter !== "all"
                ? "No matching rituals"
                : "No rituals yet"}
            </h3>
            <p className="text-sm text-muted-foreground max-w-sm mb-4">
              {searchQuery || statusFilter !== "all"
                ? "Try adjusting your filters"
                : "Create your first automated ritual"}
            </p>
            {!searchQuery && statusFilter === "all" && (
              <Button
                onClick={() => setIsCreateOpen(true)}
                className="rounded-xl gap-2"
              >
                <Plus className="h-4 w-4" />
                Create Ritual
              </Button>
            )}
          </motion.div>
        ) : (
          <motion.div
            variants={containerVariants}
            initial="hidden"
            animate="visible"
            className="space-y-4"
          >
            <AnimatePresence mode="popLayout">
              {filteredRituals.map((ritual) => (
                <motion.div
                  key={ritual.id}
                  variants={itemVariants}
                  layout
                  exit={{ opacity: 0, x: -20 }}
                >
                  <RitualCard
                    ritual={convertToCardRitual(ritual)}
                    variant={density}
                    onToggle={() => handleToggle(ritual)}
                    onSettings={() => handleViewDetails(ritual)}
                    onTrigger={() => triggerRitual.mutate(ritual.id)}
                    onUpdateSchedule={(schedule) => {
                      updateRitual.mutate({
                        id: ritual.id,
                        frequency: schedule.frequency,
                        schedule: buildSchedule(schedule.time, schedule.frequency),
                      });
                    }}
                    onAssign={(payload) => {
                      updateRitual.mutate({
                        id: ritual.id,
                        agentId: payload.agentId,
                        goals: payload.goals,
                        workstreams: payload.workstreams,
                        directivesMarkdown: payload.directivesMarkdown ?? undefined,
                        guidancePackIds: payload.guidancePackIds,
                      });
                    }}
                    agents={(agents ?? []).map((agent) => ({
                      id: agent.id,
                      name: agent.name,
                      role: agent.role,
                      status: agent.status,
                      description: agent.description,
                      tags: agent.tags,
                      currentTask: agent.currentTask,
                    }))}
                  />
                </motion.div>
              ))}
            </AnimatePresence>
          </motion.div>
        )}

        {/* Quick Actions Bar */}
        {filteredRituals.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
            className="fixed bottom-8 left-1/2 -translate-x-1/2 flex items-center gap-3 rounded-2xl border border-primary/20 bg-card/98 backdrop-blur-lg px-5 py-3 shadow-2xl ring-1 ring-border/40"
          >
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2 rounded-full bg-secondary/40 px-3 py-1">
                <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
                <span className="text-sm font-medium text-foreground">
                  {activeCount} active
                </span>
              </div>
              <div className="flex items-center gap-2 rounded-full bg-secondary/40 px-3 py-1">
                <span className="h-2.5 w-2.5 rounded-full bg-orange-500" />
                <span className="text-sm font-medium text-foreground">
                  {pausedCount} paused
                </span>
              </div>
            </div>
            <div className="w-px h-6 bg-border" />
            <Button
              variant="ghost"
              size="sm"
              className="gap-2"
              onClick={() => {
                filteredRituals
                  .filter((r) => r.status === "active")
                  .forEach((r) => pauseRitual.mutate(r.id));
              }}
            >
              <Pause className="h-4 w-4" />
              Pause All
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="gap-2"
              onClick={() => {
                filteredRituals
                  .filter((r) => r.status === "paused")
                  .forEach((r) => resumeRitual.mutate(r.id));
              }}
            >
              <Play className="h-4 w-4" />
              Resume All
            </Button>
          </motion.div>
        )}

        {/* Ritual Detail Panel */}
        <RitualDetailPanel
          ritual={selectedRitual}
          executions={executions}
          open={isDetailOpen}
          onClose={handleCloseDetail}
          onPause={(id) => pauseRitual.mutate(id)}
          onResume={(id) => resumeRitual.mutate(id)}
          onSkipNext={handleSkipNext}
          onUpdateSchedule={(id, schedule) => {
            updateRitual.mutate({
              id,
              frequency: schedule.frequency,
              schedule: buildSchedule(schedule.time, schedule.frequency),
            });
          }}
          onDelete={(id) => {
            deleteRitual.mutate(id);
            handleCloseDetail();
          }}
          onTrigger={(id) => triggerRitual.mutate(id)}
          agents={agentOptions}
        />

        {/* Create Ritual Modal */}
        <CreateRitualModal
          open={isCreateOpen}
          onOpenChange={setIsCreateOpen}
          onSubmit={handleCreateRitual}
          agents={agentOptions}
          isLoading={createRitual.isPending}
        />
      </div>
  );
}
