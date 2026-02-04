/**
 * Agent Status Dashboard Route
 *
 * Real-time view of all running agents with WebSocket streaming,
 * resource usage indicators, health status, and drill-down to sessions.
 */

import * as React from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { motion } from "framer-motion";
import {
  Search,
  RefreshCw,
  SlidersHorizontal,
  Activity,
  Bot,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CardSkeleton } from "@/components/composed";
import {
  AgentStatusRow,
  AgentStatusSummary,
  AgentDetailPanel,
} from "@/components/domain/agent-status";
import {
  useAgentStatusDashboard,
  useAgentStatusSummary,
  type AgentStatusEntry,
  type AgentHealthStatus,
} from "@/hooks/queries/useAgentStatus";
import { useDebounce } from "@/hooks/useDebounce";

// ── Route definition ───────────────────────────────────────────────

type HealthFilter = "all" | AgentHealthStatus;
type SortOption = "recent" | "name" | "status" | "cost" | "tokens";

export const Route = createFileRoute("/agent-status/")({
  component: AgentStatusDashboardPage,
  validateSearch: (search: Record<string, unknown>): { health?: HealthFilter } => {
    const validStatuses: HealthFilter[] = ["all", "active", "stalled", "idle", "errored"];
    const health = search.health as HealthFilter | undefined;
    return {
      health: health && validStatuses.includes(health) ? health : undefined,
    };
  },
});

// ── Page component ─────────────────────────────────────────────────

function AgentStatusDashboardPage() {
  const navigate = useNavigate();
  const { health: searchHealth } = Route.useSearch();

  // ── Local state ─────────────────────────────────────────────────
  const [searchQuery, setSearchQuery] = React.useState("");
  const [healthFilter, setHealthFilter] = React.useState<HealthFilter>(searchHealth || "all");
  const [sortBy, setSortBy] = React.useState<SortOption>("recent");
  const [selectedAgent, setSelectedAgent] = React.useState<AgentStatusEntry | null>(null);

  const debouncedSearch = useDebounce(searchQuery, 300);

  // ── Data fetching ───────────────────────────────────────────────
  const {
    data: snapshot,
    isLoading,
    error,
    refetch,
    isFetching,
  } = useAgentStatusDashboard({ pollInterval: 10_000 });

  const agents = snapshot?.agents;
  const summary = useAgentStatusSummary(agents);

  // ── Sync health filter with URL ─────────────────────────────────
  React.useEffect(() => {
    if (searchHealth && searchHealth !== healthFilter) {
      setHealthFilter(searchHealth);
    }
  }, [searchHealth, healthFilter]);

  const handleHealthFilterChange = (value: HealthFilter) => {
    setHealthFilter(value);
    navigate({
      search: (prev) => ({ ...prev, health: value === "all" ? undefined : value }),
      replace: true,
    });
  };

  // ── Filter and sort agents ──────────────────────────────────────
  const filteredAgents = React.useMemo(() => {
    if (!agents) return [];

    let result = [...agents];

    // Search filter
    if (debouncedSearch) {
      const query = debouncedSearch.toLowerCase();
      result = result.filter(
        (agent) =>
          agent.name.toLowerCase().includes(query) ||
          agent.id.toLowerCase().includes(query) ||
          agent.currentTask?.toLowerCase().includes(query) ||
          agent.label?.toLowerCase().includes(query) ||
          agent.tags?.some((tag) => tag.toLowerCase().includes(query))
      );
    }

    // Health filter
    if (healthFilter !== "all") {
      result = result.filter((agent) => agent.health === healthFilter);
    }

    // Sort
    const healthOrder: Record<AgentHealthStatus, number> = {
      active: 0,
      stalled: 1,
      idle: 2,
      errored: 3,
    };

    switch (sortBy) {
      case "name":
        result.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case "status":
        result.sort((a, b) => healthOrder[a.health] - healthOrder[b.health]);
        break;
      case "cost":
        result.sort((a, b) => b.resources.estimatedCost - a.resources.estimatedCost);
        break;
      case "tokens":
        result.sort((a, b) => b.resources.tokensUsed - a.resources.tokensUsed);
        break;
      case "recent":
      default:
        result.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
        break;
    }

    return result;
  }, [agents, debouncedSearch, healthFilter, sortBy]);

  // ── Drill-down handlers ─────────────────────────────────────────
  const handleDrillDown = (agent: AgentStatusEntry) => {
    setSelectedAgent(agent);
  };

  const handleNavigateToSession = (agent: AgentStatusEntry) => {
    navigate({
      to: "/agents/$agentId/session/$sessionKey",
      params: { agentId: agent.id, sessionKey: "current" },
      search: { newSession: false },
    });
  };

  // ── Auto-refresh "last activity" timestamps ─────────────────────
  const [, forceUpdate] = React.useReducer((x: number) => x + 1, 0);
  React.useEffect(() => {
    const timer = setInterval(forceUpdate, 5_000);
    return () => clearInterval(timer);
  }, []);

  // ── Render ──────────────────────────────────────────────────────

  return (
    <div className="flex gap-6">
      {/* Main Content */}
      <div className="flex-1 min-w-0">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="mb-6"
        >
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h1 className="text-3xl font-bold tracking-tight flex items-center gap-3">
                <Activity className="h-8 w-8 text-primary" />
                Agent Status
              </h1>
              <p className="mt-1 text-muted-foreground">
                Real-time monitoring of all running agents
              </p>
            </div>
            <div className="flex items-center gap-2">
              {isFetching && !isLoading && (
                <motion.div
                  animate={{ rotate: 360 }}
                  transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
                >
                  <RefreshCw className="h-4 w-4 text-muted-foreground" />
                </motion.div>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => refetch()}
                disabled={isFetching}
                className="gap-2"
              >
                <RefreshCw className="h-4 w-4" />
                Refresh
              </Button>
            </div>
          </div>
        </motion.div>

        {/* Summary Stats */}
        {!isLoading && agents && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: 0.1 }}
            className="mb-6"
          >
            <AgentStatusSummary {...summary} />
          </motion.div>
        )}

        {/* Filters */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.15 }}
          className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center"
        >
          {/* Search */}
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search agents by name, task, or tag..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="flex h-10 w-full rounded-md border border-input bg-background pl-10 pr-4 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            />
          </div>

          {/* Health Filter */}
          <Select
            value={healthFilter}
            onValueChange={(v) => handleHealthFilterChange(v as HealthFilter)}
          >
            <SelectTrigger className="w-[150px]">
              <SelectValue placeholder="Health" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Health</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="stalled">Stalled</SelectItem>
              <SelectItem value="idle">Idle</SelectItem>
              <SelectItem value="errored">Errored</SelectItem>
            </SelectContent>
          </Select>

          {/* Sort */}
          <Select
            value={sortBy}
            onValueChange={(v) => setSortBy(v as SortOption)}
          >
            <SelectTrigger className="w-[140px]">
              <SlidersHorizontal className="h-4 w-4 mr-2" />
              <SelectValue placeholder="Sort by" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="recent">Most Recent</SelectItem>
              <SelectItem value="name">Name</SelectItem>
              <SelectItem value="status">Health</SelectItem>
              <SelectItem value="cost">Highest Cost</SelectItem>
              <SelectItem value="tokens">Most Tokens</SelectItem>
            </SelectContent>
          </Select>
        </motion.div>

        {/* Agent List */}
        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3, 4].map((i) => (
              <CardSkeleton key={i} />
            ))}
          </div>
        ) : error ? (
          <Card className="border-destructive/50 bg-destructive/10">
            <CardContent className="p-6 text-center">
              <p className="text-destructive">Failed to load agent status</p>
              <p className="text-sm text-muted-foreground mt-1">
                Please check your gateway connection
              </p>
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => refetch()}
              >
                Retry
              </Button>
            </CardContent>
          </Card>
        ) : filteredAgents.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center justify-center py-12">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted">
                <Bot className="h-8 w-8 text-muted-foreground" />
              </div>
              <h3 className="mt-4 text-lg font-medium">No agents found</h3>
              <p className="mt-1 text-sm text-muted-foreground text-center max-w-sm">
                {debouncedSearch || healthFilter !== "all"
                  ? "Try adjusting your search or filters"
                  : "No agents are currently running"}
              </p>
            </CardContent>
          </Card>
        ) : (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.3, delay: 0.2 }}
            className="space-y-2"
          >
            {filteredAgents.map((agent) => (
              <AgentStatusRow
                key={agent.id}
                agent={agent}
                onDrillDown={handleDrillDown}
              />
            ))}
          </motion.div>
        )}

        {/* Timestamp footer */}
        {snapshot && (
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="mt-4 text-xs text-muted-foreground text-center"
          >
            Last updated: {new Date(snapshot.timestamp).toLocaleTimeString()}
            {isFetching && " · Refreshing..."}
          </motion.p>
        )}
      </div>

      {/* Detail Panel (right side) */}
      {selectedAgent && (
        <motion.div
          initial={{ opacity: 0, width: 0 }}
          animate={{ opacity: 1, width: 360 }}
          exit={{ opacity: 0, width: 0 }}
          transition={{ duration: 0.2 }}
          className="hidden lg:block flex-shrink-0 border-l border-border pl-6"
        >
          <AgentDetailPanel
            agent={selectedAgent}
            onClose={() => setSelectedAgent(null)}
            onNavigateToSession={handleNavigateToSession}
          />
        </motion.div>
      )}
    </div>
  );
}
