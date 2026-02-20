"use client";

import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import {
  Search,
  X,
  SlidersHorizontal,
  ArrowUpDown,
  Tag,
  Bot,
  Plus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

// --- Types ---

export interface TaskFilters {
  search: string;
  priority: string | null;
  assignee: string | null;
  status: string | null;
  sortBy: "created" | "updated" | "priority" | "title";
  sortOrder: "asc" | "desc";
}

interface Agent {
  id: string;
  name?: string;
}

interface TaskFilterBarProps {
  filters: TaskFilters;
  onFiltersChange: (filters: TaskFilters) => void;
  agents: Agent[];
  taskCount: number;
  filteredCount: number;
  onCreateTask?: () => void;
}

// --- Default Filters ---

export const DEFAULT_FILTERS: TaskFilters = {
  search: "",
  priority: null,
  assignee: null,
  status: null,
  sortBy: "created",
  sortOrder: "desc",
};

// --- Priority Options ---

const PRIORITY_OPTIONS = [
  { value: "urgent", label: "Urgent", color: "text-red-400 bg-red-400/10 border-red-400/20" },
  { value: "high", label: "High", color: "text-red-400 bg-red-400/10 border-red-400/20" },
  { value: "medium", label: "Medium", color: "text-orange-400 bg-orange-400/10 border-orange-400/20" },
  { value: "low", label: "Low", color: "text-primary bg-primary/10 border-primary/20" },
];

const STATUS_OPTIONS = [
  { value: "inbox", label: "Inbox" },
  { value: "assigned", label: "Assigned" },
  { value: "in_progress", label: "In Progress" },
  { value: "review", label: "Review" },
  { value: "done", label: "Done" },
];

// --- Main Component ---

export function TaskFilterBar({
  filters,
  onFiltersChange,
  agents,
  taskCount,
  filteredCount,
  onCreateTask,
}: TaskFilterBarProps) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  // Count active filters
  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (filters.search) count++;
    if (filters.priority) count++;
    if (filters.assignee) count++;
    if (filters.status) count++;
    if (filters.sortBy !== "created" || filters.sortOrder !== "desc") count++;
    return count;
  }, [filters]);

  // Update individual filter
  const updateFilter = useCallback(
    <K extends keyof TaskFilters>(key: K, value: TaskFilters[K]) => {
      onFiltersChange({ ...filters, [key]: value });
    },
    [filters, onFiltersChange]
  );

  // Clear all filters
  const clearFilters = useCallback(() => {
    onFiltersChange(DEFAULT_FILTERS);
  }, [onFiltersChange]);

  // Keyboard shortcut for search focus
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd/Ctrl + F to focus search
      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        e.preventDefault();
        searchRef.current?.focus();
      }
      // Escape to clear search
      if (e.key === "Escape" && document.activeElement === searchRef.current) {
        updateFilter("search", "");
        searchRef.current?.blur();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [updateFilter]);

  const isFiltered = activeFilterCount > 0;

  return (
    <div className="space-y-3">
      {/* Main Search Bar */}
      <div className="flex items-center gap-3">
        {/* Search Input */}
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            ref={searchRef}
            type="text"
            value={filters.search}
            onChange={(e) => updateFilter("search", e.target.value)}
            placeholder="Search tasks... (⌘F)"
            maxLength={200}
            className="w-full h-9 pl-9 pr-9 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring placeholder:text-muted-foreground/50"
          />
          {filters.search && (
            <button
              onClick={() => updateFilter("search", "")}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        {/* Quick Filters */}
        <div className="flex items-center gap-2">
          {/* Priority Quick Filter */}
          <Select
            value={filters.priority || "all"}
            onValueChange={(v) => updateFilter("priority", v === "all" ? null : v)}
          >
            <SelectTrigger className="h-9 w-[130px] text-xs">
              <Tag className="h-3.5 w-3.5 mr-1.5 text-muted-foreground" />
              <SelectValue placeholder="Priority" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Priorities</SelectItem>
              {PRIORITY_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  <span className={`px-1.5 py-0.5 rounded text-[10px] border ${opt.color}`}>
                    {opt.label}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Agent Quick Filter */}
          <Select
            value={filters.assignee || "all"}
            onValueChange={(v) => updateFilter("assignee", v === "all" ? null : v)}
          >
            <SelectTrigger className="h-9 w-[140px] text-xs">
              <Bot className="h-3.5 w-3.5 mr-1.5 text-muted-foreground" />
              <SelectValue placeholder="Agent" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Agents</SelectItem>
              <SelectItem value="unassigned">Unassigned</SelectItem>
              {agents.map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>
                  {agent.name || agent.id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Advanced Filters Toggle */}
          <Popover open={showAdvanced} onOpenChange={setShowAdvanced}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className={`h-9 gap-1.5 ${showAdvanced ? "bg-primary/10 border-primary/30" : ""}`}
              >
                <SlidersHorizontal className="h-3.5 w-3.5" />
                More
                {activeFilterCount > 0 && (
                  <Badge variant="secondary" className="h-5 w-5 p-0 text-[10px] justify-center">
                    {activeFilterCount}
                  </Badge>
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72 p-4">
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h4 className="font-medium text-sm">Advanced Filters</h4>
                  {isFiltered && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={clearFilters}
                      className="h-7 text-xs text-muted-foreground hover:text-foreground"
                    >
                      Clear all
                    </Button>
                  )}
                </div>

                {/* Status Filter */}
                <div className="space-y-2">
                  <label className="text-xs font-medium text-muted-foreground">Status</label>
                  <Select
                    value={filters.status || "all"}
                    onValueChange={(v) => updateFilter("status", v === "all" ? null : v)}
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue placeholder="All Statuses" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Statuses</SelectItem>
                      {STATUS_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Sort Options */}
                <div className="space-y-2">
                  <label className="text-xs font-medium text-muted-foreground">Sort By</label>
                  <div className="flex gap-2">
                    <Select
                      value={filters.sortBy}
                      onValueChange={(v) => updateFilter("sortBy", v as TaskFilters["sortBy"])}
                    >
                      <SelectTrigger className="h-8 text-xs flex-1">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="created">Created Date</SelectItem>
                        <SelectItem value="updated">Updated Date</SelectItem>
                        <SelectItem value="priority">Priority</SelectItem>
                        <SelectItem value="title">Title</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 w-8 p-0"
                      onClick={() => updateFilter("sortOrder", filters.sortOrder === "asc" ? "desc" : "asc")}
                    >
                      <ArrowUpDown className={`h-3.5 w-3.5 ${filters.sortOrder === "asc" ? "rotate-180" : ""} transition-transform`} />
                    </Button>
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    {filters.sortOrder === "desc" ? "Newest first" : "Oldest first"}
                  </p>
                </div>
              </div>
            </PopoverContent>
          </Popover>

          {/* Clear Filters Button */}
          {isFiltered && (
            <Button
              variant="ghost"
              size="sm"
              onClick={clearFilters}
              className="h-9 gap-1.5 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
              Clear
            </Button>
          )}
        </div>

        {/* New Task CTA */}
        {onCreateTask && (
          <Button
            size="sm"
            onClick={onCreateTask}
            className="h-9 gap-1.5 ml-auto bg-primary hover:bg-primary/90 text-primary-foreground shadow-sm hover:shadow-md transition-all"
          >
            <Plus className="h-4 w-4" />
            New Task
          </Button>
        )}
      </div>

      {/* Filter Summary */}
      {isFiltered && (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">
            Showing <span className="font-medium text-foreground">{filteredCount}</span> of{" "}
            <span className="font-medium text-foreground">{taskCount}</span> tasks
          </span>

          {/* Active Filter Tags */}
          <div className="flex items-center gap-1.5">
            {filters.search && (
              <Badge variant="secondary" className="gap-1 text-[10px] pl-2 pr-1 py-0.5">
                Search: &quot;{filters.search}&quot;
                <button
                  onClick={() => updateFilter("search", "")}
                  className="hover:bg-muted-foreground/20 rounded p-0.5"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            )}
            {filters.priority && (
              <Badge variant="secondary" className="gap-1 text-[10px] pl-2 pr-1 py-0.5">
                Priority: {filters.priority}
                <button
                  onClick={() => updateFilter("priority", null)}
                  className="hover:bg-muted-foreground/20 rounded p-0.5"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            )}
            {filters.assignee && (
              <Badge variant="secondary" className="gap-1 text-[10px] pl-2 pr-1 py-0.5">
                Agent: {filters.assignee === "unassigned" ? "Unassigned" : filters.assignee}
                <button
                  onClick={() => updateFilter("assignee", null)}
                  className="hover:bg-muted-foreground/20 rounded p-0.5"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            )}
            {filters.status && (
              <Badge variant="secondary" className="gap-1 text-[10px] pl-2 pr-1 py-0.5">
                Status: {filters.status.replace("_", " ")}
                <button
                  onClick={() => updateFilter("status", null)}
                  className="hover:bg-muted-foreground/20 rounded p-0.5"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// --- Filter Logic Helper ---

// Import Task type from the central hook to ensure compatibility
import type { Task } from "@/lib/hooks/use-tasks";

const PRIORITY_ORDER: Record<string, number> = {
  urgent: 4,
  high: 3,
  medium: 2,
  low: 1,
};

export function filterTasks(tasks: Task[], filters: TaskFilters): Task[] {
  let result = [...tasks];

  // Search filter
  if (filters.search) {
    const search = filters.search.toLowerCase();
    result = result.filter(
      (task) =>
        task.title.toLowerCase().includes(search) ||
        task.description.toLowerCase().includes(search)
    );
  }

  // Priority filter
  if (filters.priority) {
    result = result.filter((task) => task.priority === filters.priority);
  }

  // Assignee filter
  if (filters.assignee) {
    if (filters.assignee === "unassigned") {
      result = result.filter((task) => !task.assigned_agent_id);
    } else {
      result = result.filter((task) => task.assigned_agent_id === filters.assignee);
    }
  }

  // Status filter
  if (filters.status) {
    result = result.filter((task) => task.status === filters.status);
  }

  // Sorting
  result.sort((a, b) => {
    let comparison = 0;

    switch (filters.sortBy) {
      case "created":
        comparison = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        break;
      case "updated":
        comparison = new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime();
        break;
      case "priority":
        comparison = (PRIORITY_ORDER[a.priority] || 0) - (PRIORITY_ORDER[b.priority] || 0);
        break;
      case "title":
        comparison = a.title.localeCompare(b.title);
        break;
    }

    return filters.sortOrder === "asc" ? comparison : -comparison;
  });

  return result;
}

export default TaskFilterBar;
