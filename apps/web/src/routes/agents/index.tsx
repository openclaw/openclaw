import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AgentCard } from "@/components/domain/agents/AgentCard";
import { CreateAgentWizard } from "@/components/domain/agents/CreateAgentWizard";
import { NewSessionDialog } from "@/components/domain/agents/NewSessionDialog";
import { CardSkeleton , RouteErrorFallback } from "@/components/composed";
import { useAgents } from "@/hooks/queries/useAgents";
import { useUpdateAgentStatus } from "@/hooks/mutations/useAgentMutations";
import { useDebounce } from "@/hooks/useDebounce";
import type { Agent, AgentStatus } from "@/hooks/queries/useAgents";
import {
  Search,
  Plus,
  Users,
  Bot,
  Sparkles,
  Activity,
} from "lucide-react";

type SortOption = "recent" | "name" | "status";
// Extended filter includes "waiting" which maps to "paused" status
type StatusFilter = "all" | AgentStatus | "waiting";

export const Route = createFileRoute("/agents/")({
  component: AgentsPage,
  errorComponent: RouteErrorFallback,
  validateSearch: (search: Record<string, unknown>): { status?: StatusFilter } => {
    const validStatuses: StatusFilter[] = ["all", "online", "busy", "paused", "offline", "waiting"];
    const status = search.status as StatusFilter | undefined;
    return {
      status: status && validStatuses.includes(status) ? status : undefined,
    };
  },
});

function AgentsPage() {
  const navigate = Route.useNavigate();
  const { status: searchStatus } = Route.useSearch();
  const [searchQuery, setSearchQuery] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>(searchStatus || "all");
  const [sortBy, setSortBy] = React.useState<SortOption>("recent");
  const [wizardOpen, setWizardOpen] = React.useState(false);
  const [newSessionAgent, setNewSessionAgent] = React.useState<Agent | null>(null);

  const debouncedSearch = useDebounce(searchQuery, 300);

  const { data: agents, isLoading, error } = useAgents();
  const updateStatus = useUpdateAgentStatus();

  // Sync status filter with URL
  React.useEffect(() => {
    if (searchStatus && searchStatus !== statusFilter) {
      setStatusFilter(searchStatus);
    }
  }, [searchStatus, statusFilter]);

  // Update URL when filter changes
  const handleStatusFilterChange = (value: StatusFilter) => {
    setStatusFilter(value);
    navigate({
      search: (prev) => (value === "all" ? {} : { ...prev, status: value }),
      replace: true,
    });
  };

  const handleViewSession = (agent: Agent) => {
    // Navigate to the new Agent Session UI with current session
    navigate({
      to: "/agents/$agentId/session/$sessionKey",
      params: { agentId: agent.id, sessionKey: "current" },
      search: { newSession: false },
    });
  };

  const handleNewSession = (agent: Agent) => {
    // Open the New Session dialog for this agent
    setNewSessionAgent(agent);
  };

  const handleChat = (agent: Agent) => {
    // Navigate to the new Agent Session UI (existing/current session)
    navigate({
      to: "/agents/$agentId/session/$sessionKey",
      params: { agentId: agent.id, sessionKey: "current" },
      search: { newSession: false },
    });
  };

  // Filter and sort agents
  const filteredAgents = React.useMemo(() => {
    if (!agents) {return [];}

    let result = [...agents];

    // Filter by search query
    if (debouncedSearch) {
      const query = debouncedSearch.toLowerCase();
      result = result.filter(
        (agent) =>
          agent.name.toLowerCase().includes(query) ||
          agent.role.toLowerCase().includes(query) ||
          agent.description?.toLowerCase().includes(query) ||
          agent.tags?.some((tag) => tag.toLowerCase().includes(query))
      );
    }

    // Filter by status
    if (statusFilter !== "all") {
      // "waiting" maps to "paused" status (agents waiting for user input)
      const effectiveStatus = statusFilter === "waiting" ? "paused" : statusFilter;
      result = result.filter((agent) => agent.status === effectiveStatus);
    }

    const statusOrder: Record<AgentStatus, number> = {
      online: 0,
      busy: 1,
      paused: 2,
      offline: 3,
    };

    // Sort
    switch (sortBy) {
      case "name":
        result.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case "status":
        result.sort(
          (a, b) => statusOrder[a.status] - statusOrder[b.status]
        );
        break;
      case "recent":
      default:
        result.sort((a, b) => {
          const dateA = a.lastActive ? new Date(a.lastActive).getTime() : 0;
          const dateB = b.lastActive ? new Date(b.lastActive).getTime() : 0;
          return dateB - dateA;
        });
        break;
    }

    return result;
  }, [agents, debouncedSearch, statusFilter, sortBy]);

  const handleToggleAgent = (agent: Agent) => {
    const newStatus: AgentStatus =
      agent.status === "paused" ? "online" : "paused";
    updateStatus.mutate({ id: agent.id, status: newStatus });
  };

  // Stats
  const stats = React.useMemo(() => {
    if (!agents) {return { total: 0, online: 0, busy: 0 };}
    return {
      total: agents.length,
      online: agents.filter((a) => a.status === "online").length,
      busy: agents.filter((a) => a.status === "busy").length,
    };
  }, [agents]);

  return (
    <>
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="mb-8"
        >
          <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h1 className="text-3xl font-bold tracking-tight">Agents</h1>
              <p className="mt-1 text-muted-foreground">
                Discover and manage your AI agents
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                onClick={() => navigate({ to: "/agents/dashboard" })}
                className="gap-2"
              >
                <Activity className="h-4 w-4" />
                Dashboard
              </Button>
              <Button onClick={() => setWizardOpen(true)} className="gap-2">
                <Plus className="h-4 w-4" />
                Create Agent
              </Button>
            </div>
          </div>

          {/* Stats Cards */}
          <div className="mt-6 grid grid-cols-3 gap-4">
            <Card className="border-border/50 bg-card/50">
              <CardContent className="flex items-center gap-3 p-4">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                  <Users className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{stats.total}</p>
                  <p className="text-xs text-muted-foreground">Total Agents</p>
                </div>
              </CardContent>
            </Card>
            <Card className="border-border/50 bg-card/50">
              <CardContent className="flex items-center gap-3 p-4">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-500/10">
                  <Bot className="h-5 w-5 text-green-500" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{stats.online}</p>
                  <p className="text-xs text-muted-foreground">Online</p>
                </div>
              </CardContent>
            </Card>
            <Card className="border-border/50 bg-card/50">
              <CardContent className="flex items-center gap-3 p-4">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-yellow-500/10">
                  <Sparkles className="h-5 w-5 text-yellow-500" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{stats.busy}</p>
                  <p className="text-xs text-muted-foreground">Working</p>
                </div>
              </CardContent>
            </Card>
          </div>
        </motion.div>

        {/* Filters */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.1 }}
          className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center"
        >
          {/* Search Input */}
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search agents..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="flex h-10 w-full rounded-md border border-input bg-background pl-10 pr-4 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            />
          </div>

          {/* Status Filter */}
          <Select
            value={statusFilter}
            onValueChange={(v) => handleStatusFilterChange(v as StatusFilter)}
          >
            <SelectTrigger className="w-[160px]">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="online">Online</SelectItem>
              <SelectItem value="busy">Active / Working</SelectItem>
              <SelectItem value="waiting">Waiting for Input</SelectItem>
              <SelectItem value="paused">Paused</SelectItem>
              <SelectItem value="offline">Offline</SelectItem>
            </SelectContent>
          </Select>

          {/* Sort */}
          <Select
            value={sortBy}
            onValueChange={(v) => setSortBy(v as SortOption)}
          >
            <SelectTrigger className="w-[140px]">
              <SelectValue placeholder="Sort by" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="recent">Recent</SelectItem>
              <SelectItem value="name">Name</SelectItem>
              <SelectItem value="status">Status</SelectItem>
            </SelectContent>
          </Select>
        </motion.div>

        {/* Agents Grid */}
        {isLoading ? (
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <CardSkeleton key={i} />
            ))}
          </div>
        ) : error ? (
          <Card className="border-destructive/50 bg-destructive/10">
            <CardContent className="p-6 text-center">
              <p className="text-destructive">Failed to load agents</p>
              <p className="text-sm text-muted-foreground mt-1">
                Please try again later
              </p>
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
                {debouncedSearch || statusFilter !== "all"
                  ? "Try adjusting your search or filters"
                  : "Create your first agent to get started"}
              </p>
              {!debouncedSearch && statusFilter === "all" && (
                <Button
                  onClick={() => setWizardOpen(true)}
                  className="mt-4 gap-2"
                >
                  <Plus className="h-4 w-4" />
                  Create Agent
                </Button>
              )}
            </CardContent>
          </Card>
        ) : (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.3, delay: 0.2 }}
            className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3"
          >
            {filteredAgents.map((agent, index) => (
              <motion.div
                key={agent.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, delay: index * 0.05 }}
              >
                  <AgentCard
                    agent={agent}
                    variant="expanded"
                    onChat={() => handleChat(agent)}
                    onSettings={() => {
                      navigate({ to: "/agents/$agentId", params: { agentId: agent.id }, search: { tab: "overview" } });
                    }}
                    onToggle={() => handleToggleAgent(agent)}
                    onViewSession={() => handleViewSession(agent)}
                    onNewSession={() => handleNewSession(agent)}
                    onCardClick={() => {
                      navigate({ to: "/agents/$agentId", params: { agentId: agent.id } });
                    }}
                  />
              </motion.div>
            ))}
          </motion.div>
        )}
      {/* Create Agent Wizard */}
      <CreateAgentWizard open={wizardOpen} onOpenChange={setWizardOpen} />

      {/* New Session Dialog */}
      {newSessionAgent && (
        <NewSessionDialog
          open={!!newSessionAgent}
          onOpenChange={(open) => {
            if (!open) {setNewSessionAgent(null);}
          }}
          agentId={newSessionAgent.id}
          agentName={newSessionAgent.name}
        />
      )}
    </>
  );
}
