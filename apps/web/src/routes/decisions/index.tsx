"use client";

import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DecisionTimeline,
  DecisionDetailPanel,
  DecisionStats,
} from "@/components/domain/decisions";
import type {
  DecisionAuditEntry,
  DecisionOutcome,
  DecisionFilterState,
} from "@/components/domain/decisions";
import { CardSkeleton } from "@/components/composed/LoadingSkeleton";
import { useDecisions } from "@/hooks/queries/useDecisions";
import { useDebounce } from "@/hooks/useDebounce";
import {
  Scale,
  Search,
  SlidersHorizontal,
  RefreshCw,
} from "lucide-react";

export const Route = createFileRoute("/decisions/")({
  component: DecisionsPage,
});

const outcomeOptions: { value: DecisionOutcome | "all"; label: string }[] = [
  { value: "all", label: "All Outcomes" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "expired", label: "Expired" },
  { value: "pending", label: "Pending" },
];

const typeOptions: { value: string; label: string }[] = [
  { value: "all", label: "All Types" },
  { value: "binary", label: "Binary" },
  { value: "choice", label: "Choice" },
  { value: "text", label: "Text" },
  { value: "confirmation", label: "Confirmation" },
];

const dateRangeOptions: { value: string; label: string }[] = [
  { value: "all", label: "All Time" },
  { value: "today", label: "Today" },
  { value: "week", label: "This Week" },
  { value: "month", label: "This Month" },
];

function getDateRangeStart(range: string): number | undefined {
  const now = Date.now();
  switch (range) {
    case "today":
      return now - 24 * 60 * 60 * 1000;
    case "week":
      return now - 7 * 24 * 60 * 60 * 1000;
    case "month":
      return now - 30 * 24 * 60 * 60 * 1000;
    default:
      return undefined;
  }
}

function DecisionsPage() {
  const [filters, setFilters] = React.useState<DecisionFilterState>({
    outcome: "all",
    type: "all",
    goalId: "",
    search: "",
    dateRange: "all",
  });
  const [selectedDecision, setSelectedDecision] =
    React.useState<DecisionAuditEntry | null>(null);
  const [isDetailOpen, setIsDetailOpen] = React.useState(false);

  const debouncedSearch = useDebounce(filters.search, 300);

  const { data: decisions, isLoading, error, refetch, isFetching } = useDecisions();

  // Filter decisions client-side
  const filteredDecisions = React.useMemo(() => {
    if (!decisions) return [];

    return decisions.filter((d) => {
      // Outcome filter
      if (filters.outcome !== "all" && d.outcome !== filters.outcome) {
        return false;
      }

      // Type filter
      if (filters.type !== "all" && d.type !== filters.type) {
        return false;
      }

      // Date range filter
      const rangeStart = getDateRangeStart(filters.dateRange);
      if (rangeStart && d.timestamp < rangeStart) {
        return false;
      }

      // Search filter
      if (debouncedSearch) {
        const q = debouncedSearch.toLowerCase();
        return (
          d.title.toLowerCase().includes(q) ||
          d.question.toLowerCase().includes(q) ||
          d.responseValue?.toLowerCase().includes(q) ||
          d.agentId?.toLowerCase().includes(q) ||
          d.goalTitle?.toLowerCase().includes(q) ||
          d.respondedBy?.toLowerCase().includes(q)
        );
      }

      return true;
    });
  }, [decisions, filters.outcome, filters.type, filters.dateRange, debouncedSearch]);

  const handleViewDetails = (decision: DecisionAuditEntry) => {
    setSelectedDecision(decision);
    setIsDetailOpen(true);
  };

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
              <Scale className="h-6 w-6 text-primary" />
            </div>
            <div>
              <h1 className="text-3xl font-bold tracking-tight text-foreground">
                Decision Audit Log
              </h1>
              <p className="text-muted-foreground">
                Every Overseer decision, timestamped and searchable
              </p>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
            className="gap-2"
          >
            <RefreshCw
              className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
        </div>
      </motion.div>

      {/* Stats */}
      {decisions && decisions.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.05 }}
          className="mb-6"
        >
          <DecisionStats decisions={decisions} />
        </motion.div>
      )}

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
            value={filters.search}
            onChange={(e) =>
              setFilters((f) => ({ ...f, search: e.target.value }))
            }
            placeholder="Search decisions..."
            className="h-11 pl-10 rounded-xl"
          />
        </div>

        {/* Outcome Filter */}
        <Select
          value={filters.outcome}
          onValueChange={(value) =>
            setFilters((f) => ({
              ...f,
              outcome: value as DecisionOutcome | "all",
            }))
          }
        >
          <SelectTrigger className="h-11 w-full sm:w-[160px] rounded-xl">
            <SlidersHorizontal className="h-4 w-4 mr-2 text-muted-foreground" />
            <SelectValue placeholder="Outcome" />
          </SelectTrigger>
          <SelectContent>
            {outcomeOptions.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Type Filter */}
        <Select
          value={filters.type}
          onValueChange={(value) =>
            setFilters((f) => ({ ...f, type: value }))
          }
        >
          <SelectTrigger className="h-11 w-full sm:w-[150px] rounded-xl">
            <SelectValue placeholder="Type" />
          </SelectTrigger>
          <SelectContent>
            {typeOptions.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Date Range Filter */}
        <Select
          value={filters.dateRange}
          onValueChange={(value) =>
            setFilters((f) => ({ ...f, dateRange: value as DecisionFilterState["dateRange"] }))
          }
        >
          <SelectTrigger className="h-11 w-full sm:w-[140px] rounded-xl">
            <SelectValue placeholder="Time" />
          </SelectTrigger>
          <SelectContent>
            {dateRangeOptions.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </motion.div>

      {/* Content */}
      {isLoading ? (
        <div className="space-y-4">
          {Array.from({ length: 5 }).map((_, i) => (
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
            <Scale className="h-8 w-8 text-destructive" />
          </div>
          <h3 className="text-lg font-medium text-foreground mb-2">
            Error Loading Decisions
          </h3>
          <p className="text-sm text-muted-foreground max-w-sm">
            {error instanceof Error
              ? error.message
              : "Could not load decisions from the gateway"}
          </p>
          <Button
            variant="outline"
            className="mt-4 gap-2"
            onClick={() => refetch()}
          >
            <RefreshCw className="h-4 w-4" />
            Retry
          </Button>
        </motion.div>
      ) : filteredDecisions.length === 0 ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="flex flex-col items-center justify-center py-16 text-center"
        >
          <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-secondary">
            <Scale className="h-8 w-8 text-muted-foreground" />
          </div>
          <h3 className="text-lg font-medium text-foreground mb-2">
            {filters.search ||
            filters.outcome !== "all" ||
            filters.type !== "all" ||
            filters.dateRange !== "all"
              ? "No matching decisions"
              : "No decisions yet"}
          </h3>
          <p className="text-sm text-muted-foreground max-w-sm">
            {filters.search ||
            filters.outcome !== "all" ||
            filters.type !== "all" ||
            filters.dateRange !== "all"
              ? "Try adjusting your filters"
              : "Decisions will appear here as agents request user input"}
          </p>
          {(filters.search ||
            filters.outcome !== "all" ||
            filters.type !== "all" ||
            filters.dateRange !== "all") && (
            <Button
              variant="outline"
              className="mt-4"
              onClick={() =>
                setFilters({
                  outcome: "all",
                  type: "all",
                  goalId: "",
                  search: "",
                  dateRange: "all",
                })
              }
            >
              Clear Filters
            </Button>
          )}
        </motion.div>
      ) : (
        <DecisionTimeline
          decisions={filteredDecisions}
          onViewDetails={handleViewDetails}
        />
      )}

      {/* Detail Panel */}
      <DecisionDetailPanel
        decision={selectedDecision}
        open={isDetailOpen}
        onClose={() => setIsDetailOpen(false)}
      />
    </>
  );
}
