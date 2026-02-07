import * as React from "react";
import { createFileRoute, Outlet, useMatches } from "@tanstack/react-router";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { StatusBadge } from "@/components/composed/StatusBadge";
import { CardSkeleton , RouteErrorFallback } from "@/components/composed";
import {
  AgentOverviewTab,
  AgentWorkstreamsTab,
  AgentRitualsTab,
  AgentToolsTab,
  AgentSkillsTab,
  AgentChannelsTab,
  AgentCronTab,
  AgentSoulTab,
  AgentCoreFilesTab,
  AgentActivityTab,
  NewSessionDialog,
} from "@/components/domain/agents";
import { useAgent } from "@/hooks/queries/useAgents";
import { useWorkstreamsByOwner } from "@/hooks/queries/useWorkstreams";
import { useRitualsByAgent } from "@/hooks/queries/useRituals";
import { useUpdateAgentStatus } from "@/hooks/mutations/useAgentMutations";
import { useUIStore } from "@/stores/useUIStore";
import type { AgentStatus } from "@/hooks/queries/useAgents";
import {
  ArrowLeft,
  MessageSquare,
  Settings,
  Play,
  Pause,
  MoreVertical,
  Calendar,
  Clock,
  Edit,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type AgentDetailTab =
  | "overview"
  | "workstreams"
  | "rituals"
  | "tools"
  | "files"
  | "skills"
  | "channels"
  | "cron"
  | "soul"
  | "activity";

export const Route = createFileRoute("/agents/$agentId")({
  component: AgentDetailPage,
  errorComponent: RouteErrorFallback,
  validateSearch: (search: Record<string, unknown>): { tab?: AgentDetailTab; activityId?: string; newSession?: boolean } => {
    const validTabs: AgentDetailTab[] = [
      "overview",
      "workstreams",
      "rituals",
      "tools",
      "soul",
      "files",
      "skills",
      "channels",
      "cron",
      "activity",
    ];
    const tab = typeof search.tab === "string" && validTabs.includes(search.tab as AgentDetailTab)
      ? (search.tab as AgentDetailTab)
      : undefined;
    const activityId = typeof search.activityId === "string" ? search.activityId : undefined;
    const newSession = search.newSession === true || search.newSession === "true";
    return { tab, activityId, newSession };
  },
});

function AgentDetailPage() {
  const { agentId } = Route.useParams();
  const navigate = Route.useNavigate();
  const { tab: searchTab, activityId, newSession } = Route.useSearch();
  const [activeTab, setActiveTab] = React.useState<AgentDetailTab>(searchTab ?? "overview");
  const [showNewSessionDialog, setShowNewSessionDialog] = React.useState(false);

  // Check if a child route is active (e.g., /agents/$agentId/session/...)
  const matches = useMatches();
  const currentRouteId = Route.id;
  const hasChildRoute = matches.some(
    (match) => match.routeId !== currentRouteId && match.routeId.startsWith(currentRouteId)
  );

  // All hooks must be called before any conditional returns
  const { data: agent, isLoading, error } = useAgent(agentId);
  const { data: workstreams } = useWorkstreamsByOwner(agentId);
  const { data: rituals } = useRitualsByAgent(agentId);
  const updateStatus = useUpdateAgentStatus();
  const useLiveGateway = useUIStore((state) => state.useLiveGateway);

  const handleChatClick = () => {
    // Navigate to the agent's current session (existing session)
    navigate({
      to: "/agents/$agentId/session/$sessionKey",
      params: { agentId, sessionKey: "current" },
      search: { newSession: false },
    });
  };

  const handleEditClick = () => {
    navigate({
      to: "/settings",
      search: (prev) => ({ ...prev, section: "agents", agentId }),
    });
  };

  // Handle newSession param - show dialog and clear param
  React.useEffect(() => {
    if (newSession) {
      setShowNewSessionDialog(true);
      // Clear the newSession param from URL
      navigate({
        search: (prev) => ({ ...prev, newSession: undefined }),
        replace: true,
      });
    }
  }, [newSession, navigate]);

  React.useEffect(() => {
    if (searchTab && searchTab !== activeTab) {setActiveTab(searchTab);}
  }, [searchTab, activeTab]);

  React.useEffect(() => {
    if (!activityId) {return;}
    if (searchTab === "activity") {return;}
    setActiveTab("activity");
    navigate({
      search: (prev) => ({ ...prev, tab: "activity", activityId }),
      replace: true,
    });
  }, [activityId, searchTab, navigate]);

  // If a child route is active, render only the Outlet (child content)
  if (hasChildRoute) {
    return <Outlet />;
  }

  const showModeBadge = (import.meta.env?.DEV ?? false);
  const modeLabel = useLiveGateway ? "Live gateway" : "Mock data";
  const modeVariant = useLiveGateway ? "success" : "secondary";

  const handleToggleStatus = () => {
    if (!agent) {return;}
    const newStatus: AgentStatus =
      agent.status === "paused" ? "online" : "paused";
    updateStatus.mutate({ id: agent.id, status: newStatus });
  };

  const formatDate = (dateString?: string) => {
    if (!dateString) {return "Unknown";}
    const date = new Date(dateString);
    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  };

  const formatRelativeTime = (dateString?: string) => {
    if (!dateString) {return "Never";}
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) {return "Just now";}
    if (diffMins < 60) {return `${diffMins}m ago`;}
    if (diffHours < 24) {return `${diffHours}h ago`;}
    if (diffDays < 7) {return `${diffDays}d ago`;}
    return date.toLocaleDateString();
  };

  if (isLoading) {
    return (
      <div className="min-h-full bg-background text-foreground">
        <div className="container mx-auto max-w-6xl px-6 py-8">
          <div className="space-y-6">
            <CardSkeleton />
            <CardSkeleton />
          </div>
        </div>
      </div>
    );
  }

  if (error || !agent) {
    return (
      <div className="min-h-full bg-background text-foreground">
        <div className="container mx-auto max-w-6xl px-6 py-8">
          <Card className="border-destructive/50 bg-destructive/10">
            <CardContent className="p-8 text-center">
              <h2 className="text-xl font-semibold text-destructive mb-2">
                Agent Not Found
              </h2>
              <p className="text-muted-foreground mb-4">
                The agent you're looking for doesn't exist or has been removed.
              </p>
              <Button variant="outline" onClick={() => navigate({ to: "/agents" })}>
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back to Agents
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-full bg-background text-foreground">
      <div className="container mx-auto max-w-6xl px-6 py-8">
        {/* Back Button */}
        <motion.div
          initial={{ opacity: 0, x: -10 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.2 }}
          className="mb-6"
        >
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate({ to: "/agents" })}
            className="gap-2 text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Agents
          </Button>
        </motion.div>

        {/* Agent Header Card */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="mb-8"
        >
          <Card className="border-border/50 overflow-hidden">
            {/* Gradient accent */}
            <div className="h-1 bg-gradient-to-r from-primary via-accent to-primary" />

            <CardContent className="p-6">
              <div className="flex flex-col sm:flex-row sm:items-start gap-6">
                {/* Avatar */}
                <motion.div
                  whileHover={{ scale: 1.02 }}
                  className="relative shrink-0"
                >
                  <div className="h-24 w-24 rounded-2xl bg-gradient-to-br from-primary/20 to-accent/20 flex items-center justify-center ring-4 ring-border/50 shadow-lg">
                    {agent.avatar ? (
                      <img
                        src={agent.avatar}
                        alt={agent.name}
                        className="h-full w-full rounded-2xl object-cover"
                      />
                    ) : (
                      <span className="text-4xl font-bold text-foreground">
                        {agent.name.charAt(0)}
                      </span>
                    )}
                  </div>
                  {/* Status indicator */}
                  <div className="absolute -bottom-1 -right-1">
                    <div
                      className={cn(
                        "h-5 w-5 rounded-full border-4 border-card",
                        agent.status === "online" && "bg-green-500",
                        agent.status === "busy" && "bg-yellow-500",
                        agent.status === "paused" && "bg-orange-500",
                        agent.status === "offline" && "bg-gray-400"
                      )}
                    />
                  </div>
                </motion.div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <h1 className="text-2xl font-bold tracking-tight">
                          {agent.name}
                        </h1>
                        {showModeBadge && (
                          <Badge variant={modeVariant} className="text-xs">
                            {modeLabel}
                          </Badge>
                        )}
                      </div>
                      <p className="text-muted-foreground">{agent.role}</p>
                      <div className="mt-2">
                        <StatusBadge status={agent.status} size="md" />
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-2">
                      <Button className="gap-2" onClick={handleChatClick}>
                        <MessageSquare className="h-4 w-4" />
                        Chat
                      </Button>
                      <Button variant="outline" className="gap-2" onClick={handleEditClick}>
                        <Edit className="h-4 w-4" />
                        Edit
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon">
                            <MoreVertical className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={handleToggleStatus}>
                            {agent.status === "paused" ? (
                              <>
                                <Play className="mr-2 h-4 w-4" />
                                Resume Agent
                              </>
                            ) : (
                              <>
                                <Pause className="mr-2 h-4 w-4" />
                                Pause Agent
                              </>
                            )}
                          </DropdownMenuItem>
                          <DropdownMenuItem>
                            <Settings className="mr-2 h-4 w-4" />
                            Settings
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem className="text-destructive">
                            Delete Agent
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>

                  {/* Description */}
                  {agent.description && (
                    <p className="mt-4 text-sm text-muted-foreground max-w-2xl">
                      {agent.description}
                    </p>
                  )}

                  {/* Meta info */}
                  <div className="mt-4 flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
                    <span className="flex items-center gap-1.5">
                      <Calendar className="h-4 w-4" />
                      Created {formatDate(agent.lastActive)}
                    </span>
                    <span className="flex items-center gap-2">
                      <Clock className="h-4 w-4" />
                      <span className="text-muted-foreground">Last active</span>
                      <Badge variant="secondary" className="text-xs font-medium">
                        {formatRelativeTime(agent.lastActive)}
                      </Badge>
                    </span>
                    {agent.taskCount !== undefined && agent.taskCount > 0 && (
                      <span className="text-primary font-medium">
                        {agent.taskCount} active task
                        {agent.taskCount !== 1 ? "s" : ""}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </motion.div>

        {/* Tabs */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.1 }}
        >
          <Tabs
            value={activeTab}
            onValueChange={(v) => {
              const next = v as AgentDetailTab;
              setActiveTab(next);
              navigate({
                search: (prev) => {
                  // eslint-disable-next-line @typescript-eslint/no-unused-vars
                  const { activityId: _activityId, ...rest } = prev as Record<string, unknown>;
                  if (next === "activity") {
                    return activityId ? { ...rest, tab: next, activityId } : { ...rest, tab: next };
                  }
                  return { ...rest, tab: next };
                },
                replace: true,
              });
            }}
            className="space-y-6"
          >
            <TabsList className="w-full justify-start bg-muted/50 p-1">
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="workstreams">Workstreams</TabsTrigger>
              <TabsTrigger value="rituals">Rituals</TabsTrigger>
              <TabsTrigger value="tools">Tools</TabsTrigger>
              <TabsTrigger value="skills">Skills</TabsTrigger>
              <TabsTrigger value="channels">Channels</TabsTrigger>
              <TabsTrigger value="cron">Cron</TabsTrigger>
              <TabsTrigger value="soul">Soul</TabsTrigger>
              <TabsTrigger value="files">Core Files</TabsTrigger>
              <TabsTrigger value="activity">Activity</TabsTrigger>
            </TabsList>

            <TabsContent value="overview">
              <AgentOverviewTab
                agent={agent}
                workstreams={workstreams}
                rituals={rituals}
              />
            </TabsContent>

            <TabsContent value="workstreams">
              <AgentWorkstreamsTab agentId={agentId} />
            </TabsContent>

            <TabsContent value="rituals">
              <AgentRitualsTab agentId={agentId} />
            </TabsContent>

            <TabsContent value="tools">
              <AgentToolsTab agentId={agentId} />
            </TabsContent>

            <TabsContent value="skills">
              <AgentSkillsTab agentId={agentId} />
            </TabsContent>

            <TabsContent value="channels">
              <AgentChannelsTab />
            </TabsContent>

            <TabsContent value="cron">
              <AgentCronTab agentId={agentId} />
            </TabsContent>

            <TabsContent value="soul">
              <AgentSoulTab agentId={agentId} />
            </TabsContent>

            <TabsContent value="files">
              <AgentCoreFilesTab agentId={agentId} />
            </TabsContent>

            <TabsContent value="activity">
              <AgentActivityTab
                agentId={agentId}
                selectedActivityId={activityId ?? null}
                onSelectedActivityIdChange={(nextActivityId) => {
                  setActiveTab("activity");
                  navigate({
                    search: (prev) => {
                      // eslint-disable-next-line @typescript-eslint/no-unused-vars
                      const { activityId: _activityId, ...rest } = prev as Record<string, unknown>;
                      return nextActivityId
                        ? { ...rest, tab: "activity", activityId: nextActivityId }
                        : { ...rest, tab: "activity" };
                    },
                    replace: true,
                  });
                }}
              />
            </TabsContent>
          </Tabs>
        </motion.div>
      </div>

      {/* New Session Dialog */}
      <NewSessionDialog
        open={showNewSessionDialog}
        onOpenChange={setShowNewSessionDialog}
        agentId={agentId}
        agentName={agent.name}
      />
    </div>
  );
}
