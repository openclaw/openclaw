"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { CheckCircle2, X, AlertTriangle, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// Layout components
import { Sidebar, getViewFromHash, type ViewId } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { LiveTerminal } from "@/components/layout/live-terminal";

// Kanban components
import { KanbanBoard } from "@/components/kanban/board";

// Modal components
import { CreateTaskModal } from "@/components/modals/create-task";
import { DispatchModal } from "@/components/modals/dispatch-modal";
import { TaskDetailModal } from "@/components/modals/task-detail";

// New UX components
import { TaskFilterBar } from "@/components/task-filter-bar";
import { UndoToast, useUndoKeyboard } from "@/components/undo-toast";
import { EmptyInbox, EmptySearchResults } from "@/components/empty-states";
import { StatCards } from "@/components/dashboard/stat-cards";
import { ViewErrorBoundary } from "@/components/error-boundary";

// View components — lazy-loaded for code splitting (PERF-H1 / ARCH-M1)
import dynamic from "next/dynamic";
import { ViewSkeleton } from "@/components/layout/view-skeleton";

const AgentsView = dynamic(() => import("@/components/views/agents-view").then(m => ({ default: m.AgentsView })), { loading: () => <ViewSkeleton variant="grid" /> });
const MissionsView = dynamic(() => import("@/components/views/missions-view").then(m => ({ default: m.MissionsView })), { loading: () => <ViewSkeleton variant="list" /> });
const EmployeesView = dynamic(() => import("@/components/views/employees-view").then(m => ({ default: m.EmployeesView })), { loading: () => <ViewSkeleton variant="list" /> });
const ToolsPlayground = dynamic(() => import("@/components/views/tools-playground").then(m => ({ default: m.ToolsPlayground })), { loading: () => <ViewSkeleton variant="dashboard" /> });
const CostDashboard = dynamic(() => import("@/components/views/cost-dashboard").then(m => ({ default: m.CostDashboard })), { loading: () => <ViewSkeleton variant="dashboard" /> });
const ApprovalCenter = dynamic(() => import("@/components/views/approval-center").then(m => ({ default: m.ApprovalCenter })), { loading: () => <ViewSkeleton variant="list" /> });
const CronScheduler = dynamic(() => import("@/components/views/cron-scheduler").then(m => ({ default: m.CronScheduler })), { loading: () => <ViewSkeleton variant="list" /> });
const LogsViewer = dynamic(() => import("@/components/views/logs-viewer").then(m => ({ default: m.LogsViewer })), { loading: () => <ViewSkeleton variant="log" /> });
const SettingsPanel = dynamic(() => import("@/components/views/settings-panel"), { loading: () => <ViewSkeleton variant="form" /> });
const ChatPanel = dynamic(() => import("@/components/views/chat-panel").then(m => ({ default: m.ChatPanel })), { loading: () => <ViewSkeleton variant="chat" /> });
const Orchestrator = dynamic(() => import("@/components/views/orchestrator").then(m => ({ default: m.Orchestrator })), { loading: () => <ViewSkeleton variant="dashboard" /> });
const LearningHub = dynamic(() => import("@/components/views/learning-hub").then(m => ({ default: m.LearningHub })), { loading: () => <ViewSkeleton variant="grid" /> });
const QuickActions = dynamic(() => import("@/components/views/quick-actions").then(m => ({ default: m.QuickActions })), { loading: () => <ViewSkeleton variant="grid" /> });
const IntegrationsView = dynamic(() => import("@/components/views/integrations-view").then(m => ({ default: m.IntegrationsView })), { loading: () => <ViewSkeleton variant="grid" /> });
const AISpecialists = dynamic(() => import("@/components/views/ai-specialists").then(m => ({ default: m.AISpecialists })), { loading: () => <ViewSkeleton variant="grid" /> });
const ChannelsView = dynamic(() => import("@/components/views/channels-guide").then(m => ({ default: m.ChannelsGuidePage })), { loading: () => <ViewSkeleton variant="grid" /> });
const SkillsDashboard = dynamic(() => import("@/components/views/skills-dashboard").then(m => ({ default: m.SkillsDashboard })), { loading: () => <ViewSkeleton variant="grid" /> });
const AllToolsView = dynamic(() => import("@/components/views/all-tools").then(m => ({ default: m.AllToolsView })), { loading: () => <ViewSkeleton variant="grid" /> });
const PluginsRegistry = dynamic(() => import("@/components/views/plugins-registry").then(m => ({ default: m.PluginsRegistry })), { loading: () => <ViewSkeleton variant="grid" /> });
const MCPServersView = dynamic(() => import("@/components/views/mcp-servers-view").then(m => ({ default: m.MCPServersView })), { loading: () => <ViewSkeleton variant="grid" /> });


// Hooks
import { useTasks, type Task } from "@/lib/hooks/use-tasks";
import { usePolling } from "@/lib/hooks/use-polling";
import { useGatewayTelemetry } from "@/lib/hooks/use-gateway-telemetry";
import { useConnectionToast } from "@/lib/hooks/use-connection-toast";
import { DEFAULT_WORKSPACE } from "@/lib/workspaces";
import { ProfileProvider, useProfiles } from "@/lib/hooks/use-profiles";
import { ManageProfilesDialog } from "@/components/modals/manage-profiles";
import { apiFetch } from "@/lib/api-fetch";
import { suggestAgentForTask } from "@/lib/agent-registry";
import { loadCommunityUsecaseFavorites } from "@/lib/community-usecase-favorites";

interface CommunityUsecaseTemplate {
  id: string;
  slug?: string;
  title: string;
  summary: string;
  category: string;
  rating: number;
  tags?: string[];
  source?: string;
  sourceDetail?: string;
  url?: string;
}

interface CommunityUsecasesResponse {
  usecases?: CommunityUsecaseTemplate[];
  error?: string;
}

interface CreateTaskSeedDraft {
  title: string;
  description: string;
  priority: string;
  assigned_agent_id?: string;
}

function buildUsecaseSeed(template: CommunityUsecaseTemplate): CreateTaskSeedDraft {
  const suggested = suggestAgentForTask(`${template.title} ${template.summary}`);
  return {
    title: `Implement use case: ${template.title}`.slice(0, 200),
    description: [
      "You are implementing this OpenClaw community use case in OpenClaw Mission Control.",
      "",
      `Use case: ${template.title}`,
      `Category: ${template.category}`,
      `Source: ${template.sourceDetail || template.source || "community catalog"}`,
      `Reference: ${template.url || "N/A"}`,
      "",
      `Summary: ${template.summary}`,
      "",
      "Delivery criteria:",
      "1. Add or improve a concrete feature in this workspace.",
      "2. Keep the implementation production-safe (types, error handling, tests or verifiable behavior).",
      "3. Leave a short note in task comments describing what changed.",
    ].join("\n"),
    priority: template.rating >= 94 ? "high" : "medium",
    ...(suggested?.id ? { assigned_agent_id: suggested.id } : {}),
  };
}

// --- Main Component ---

export default function Dashboard() {
  return (
    <ProfileProvider>
      <DashboardInner />
    </ProfileProvider>
  );
}

function DashboardInner() {
  const { activeProfile } = useProfiles();
  const [manageProfilesOpen, setManageProfilesOpen] = useState(false);

  // Derive workspace options dynamically from the active profile's linked workspaces
  const workspaceOptions = useMemo(() => {
    if (!activeProfile) return [];
    return activeProfile.workspaces.map((pw) => ({
      id: pw.workspace_id,
      label: pw.label || pw.workspace_id,
      color: pw.color || "slate",
    }));
  }, [activeProfile]);

  const [activeWorkspace, setActiveWorkspace] = useState<string>(() => {
    if (typeof window === "undefined") return DEFAULT_WORKSPACE;
    const fromQuery = new URLSearchParams(window.location.search).get("workspace");
    if (fromQuery) return fromQuery;
    const fromStorage = window.localStorage.getItem("mission-control:workspace");
    return fromStorage || DEFAULT_WORKSPACE;
  });

  const validWorkspaceIds = useMemo(() => workspaceOptions.map((ws) => ws.id), [workspaceOptions]);
  const effectiveWorkspace = useMemo<string>(() => {
    if (!activeProfile) return activeWorkspace;
    if (validWorkspaceIds.includes(activeWorkspace)) return activeWorkspace;
    return validWorkspaceIds[0] || DEFAULT_WORKSPACE;
  }, [activeProfile, validWorkspaceIds, activeWorkspace]);

  useEffect(() => {
    window.localStorage.setItem("mission-control:workspace", effectiveWorkspace);
    const url = new URL(window.location.href);
    url.searchParams.set("workspace", effectiveWorkspace);
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  }, [effectiveWorkspace]);

  // Task state management
  const {
    tasks,
    filteredTasks,
    activity,
    agents,
    gatewayStatus,
    toast,
    // Filters
    taskFilters,
    setTaskFilters,
    hasActiveFilters,
    clearFilters,
    // Fetch
    fetchTasks,
    fetchActivity,
    fetchAgents,
    fetchGatewayStatus,
    // Actions
    createTask,
    moveTask,
    deleteTask,
    dispatchTask,
    getColumnTasks,
    // Toast
    showToast,
    clearToast,
  } = useTasks(effectiveWorkspace);

  // Undo keyboard shortcut (Cmd+Z)
  useUndoKeyboard(() => {
    fetchTasks();
    fetchActivity();
    showToast("Action undone", "success");
  });

  // Polling for updates
  const { connectionState } = usePolling({
    fetchTasks,
    fetchActivity,
    fetchGatewayStatus,
  });
  const gatewayTelemetry = useGatewayTelemetry();
  const liveConnectionState = gatewayTelemetry.connectionState || connectionState;

  // Auto-toast on gateway disconnect/reconnect (AA+ UX)
  useConnectionToast(liveConnectionState, showToast);

  // Start gateway from dashboard
  const handleStartGateway = useCallback(async () => {
    try {
      const res = await fetch("/api/gateway/start", { method: "POST" });
      const data = await res.json();
      if (data.ok) {
        showToast(data.alreadyRunning ? "Gateway is already running" : "Gateway started successfully", "success");
        // Re-fetch gateway status after a brief delay
        setTimeout(() => fetchGatewayStatus(), 2000);
      } else {
        showToast(data.message || "Failed to start gateway", "error");
      }
    } catch {
      showToast("Failed to start gateway", "error");
    }
  }, [showToast, fetchGatewayStatus]);

  // Initial agents fetch
  useEffect(() => {
    fetchAgents();
  }, [fetchAgents]);

  // Initial hydration for core dashboard data.
  useEffect(() => {
    void fetchTasks();
    void fetchActivity();
    void fetchGatewayStatus();
  }, [fetchTasks, fetchActivity, fetchGatewayStatus]);

  // View state
  const [activeView, setActiveViewState] = useState<ViewId>("board");
  const setActiveView = useCallback((view: ViewId) => {
    setActiveViewState(view);
    window.location.hash = view === "board" ? "" : view;
  }, []);

  useEffect(() => {
    const onHashChange = () => setActiveViewState(getViewFromHash());
    onHashChange();
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // UI state
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createTaskSeed, setCreateTaskSeed] = useState<CreateTaskSeedDraft | null>(null);
  const [createTaskSeedNonce, setCreateTaskSeedNonce] = useState(0);
  const [favoriteQuickTemplates, setFavoriteQuickTemplates] = useState<CommunityUsecaseTemplate[]>([]);
  const [favoriteQuickTemplatesLoading, setFavoriteQuickTemplatesLoading] = useState(false);
  const [showDispatchModal, setShowDispatchModal] = useState<Task | null>(null);
  const [showTaskDetail, setShowTaskDetail] = useState<Task | null>(null);
  const taskDetailTaskIdRef = useRef<string | null>(null);
  const suppressTaskDetailOpenUntilRef = useRef<number>(0);
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; title: string } | null>(null);
  // Views that implement their own internal scrolling.
  // (Chat is the main one; others should generally use the shared scroll root.)
  const viewOwnsScroll = activeView === "chat";

  const openTaskDetail = useCallback((task: Task) => {
    if (Date.now() < suppressTaskDetailOpenUntilRef.current) return;
    taskDetailTaskIdRef.current = task.id;
    setShowTaskDetail(task);
  }, []);

  const closeTaskDetail = useCallback(() => {
    taskDetailTaskIdRef.current = null;
    suppressTaskDetailOpenUntilRef.current = Date.now() + 350;
    setShowTaskDetail(null);
  }, []);

  const openCreateTaskModal = useCallback((seed?: CreateTaskSeedDraft) => {
    if (seed) {
      setCreateTaskSeed(seed);
    } else {
      setCreateTaskSeed(null);
    }
    setCreateTaskSeedNonce((prev) => prev + 1);
    setShowCreateModal(true);
  }, []);

  const loadFavoriteQuickActions = useCallback(async () => {
    const favoriteIds = loadCommunityUsecaseFavorites();
    if (favoriteIds.length === 0) {
      setFavoriteQuickTemplates([]);
      return;
    }

    setFavoriteQuickTemplatesLoading(true);
    try {
      const res = await fetch("/api/openclaw/community-usecases");
      const data = (await res.json()) as CommunityUsecasesResponse;
      if (!res.ok) {
        throw new Error(data.error || `Failed to load templates (${res.status})`);
      }

      const usecases = Array.isArray(data.usecases) ? data.usecases : [];
      const byId = new Map(usecases.map((template) => [template.id, template]));
      const pinned = favoriteIds
        .map((id) => byId.get(id))
        .filter((template): template is CommunityUsecaseTemplate => Boolean(template))
        .slice(0, 3);
      setFavoriteQuickTemplates(pinned);
    } catch {
      setFavoriteQuickTemplates([]);
    } finally {
      setFavoriteQuickTemplatesLoading(false);
    }
  }, []);

  const handleQuickCreateFromFavorite = useCallback(
    (template: CommunityUsecaseTemplate) => {
      openCreateTaskModal(buildUsecaseSeed(template));
    },
    [openCreateTaskModal]
  );

  // Task actions
  const handleCreateTask = async (data: {
    title: string;
    description: string;
    priority: string;
    assigned_agent_id?: string;
  }) => {
    const success = await createTask(data);
    if (success) {
      setShowCreateModal(false);
    }
    return success;
  };

  const handleDeleteTask = (taskId: string) => {
    const task = tasks.find(t => t.id === taskId);
    if (task) {
      setDeleteConfirm({ id: task.id, title: task.title });
    }
  };

  const confirmDelete = async () => {
    if (deleteConfirm) {
      await deleteTask(deleteConfirm.id);
      setDeleteConfirm(null);
    }
  };

  const handleDispatch = async (taskId: string, agentId: string) => {
    const result = await dispatchTask(taskId, agentId);
    if (!result.error) {
      setShowDispatchModal(null);
    }
    return result;
  };

  const handleStartSpecialistChat = useCallback(
    (agentId: string) => {
      const sessionKey = `agent:${agentId}:mission-control:chat`;
      const url = new URL(window.location.href);
      url.searchParams.set("chatSession", sessionKey);
      window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
      setActiveView("chat");
    },
    [setActiveView]
  );

  const handleOpenLearningHubTask = useCallback(
    async (taskId: string) => {
      setActiveView("board");
      try {
        const params = new URLSearchParams({ workspace_id: effectiveWorkspace });
        const res = await apiFetch(`/api/tasks?${params.toString()}`);
        const data = (await res.json()) as { tasks?: Task[] };
        const matchedTask = data.tasks?.find((task) => task.id === taskId);
        if (matchedTask) {
          openTaskDetail(matchedTask);
          return;
        }
        showToast("Built task not found in current workspace", "error");
      } catch {
        showToast("Failed to open built task", "error");
      }
    },
    [effectiveWorkspace, openTaskDetail, setActiveView, showToast]
  );

  useEffect(() => {
    if (activeView !== "board" || showCreateModal) return;
    void loadFavoriteQuickActions();
  }, [activeView, showCreateModal, loadFavoriteQuickActions]);

  return (
    <div className="flex h-[100dvh] min-h-screen overflow-hidden">
      {/* Sidebar Navigation */}
      <Sidebar
        activeView={activeView}
        onViewChange={setActiveView}
        onAgentsClick={fetchAgents}
        mobileOpen={mobileSidebarOpen}
        onMobileClose={() => setMobileSidebarOpen(false)}
      />

      {/* Main Content */}
      <main id="main-content" className="flex-1 flex flex-col min-w-0 relative">
        {/* Grid pattern background */}
        <div className="absolute inset-0 z-0 opacity-50 pointer-events-none grid-pattern" />

        {/* Header */}
        <Header
          gatewayStatus={gatewayStatus}
          gatewayConnectionState={liveConnectionState}
          gatewayEventsPerMinute={gatewayTelemetry.eventsPerMinute}
          gatewayLastEventAt={gatewayTelemetry.lastEventAt}
          taskCount={tasks.length}
          activeWorkspace={effectiveWorkspace}
          onWorkspaceChange={setActiveWorkspace}
          workspaceOptions={workspaceOptions}
          onManageProfiles={() => setManageProfilesOpen(true)}
          terminalOpen={terminalOpen}
          onTerminalToggle={() => setTerminalOpen(!terminalOpen)}
          showToast={showToast}
          mobileSidebarOpen={mobileSidebarOpen}
          onMobileSidebarToggle={() => setMobileSidebarOpen(!mobileSidebarOpen)}
        />

        {/* Content area */}
        <div className="flex-1 flex flex-col min-h-0 z-10 relative">
          <div
            data-testid="mc-view-scroll-root"
            className={`flex-1 min-h-0 overscroll-contain ${viewOwnsScroll ? "overflow-hidden" : "overflow-y-auto"
              }`}
          >
            {activeView === "board" && (
              <div className="flex flex-col min-h-full">
                {/* Stat Cards Strip */}
                <div className="px-6 py-4 border-b border-border/50 bg-background/30">
                  <StatCards
                    tasks={tasks}
                    agents={agents}
                    gatewayConnectionState={liveConnectionState}
                    onNavigate={(view) => setActiveView(view as ViewId)}
                  />
                </div>
                {(favoriteQuickTemplatesLoading || favoriteQuickTemplates.length > 0) && (
                  <div className="px-6 py-3 border-b border-border/50 bg-background/40">
                    <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      <Star className="w-3.5 h-3.5 text-yellow-500" />
                      Favorite Use Cases
                    </div>
                    {favoriteQuickTemplatesLoading ? (
                      <p className="mt-2 text-xs text-muted-foreground">Loading favorites...</p>
                    ) : (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {favoriteQuickTemplates.map((template) => (
                          <Button
                            key={template.id}
                            variant="outline"
                            size="sm"
                            className="h-8 max-w-full gap-1.5"
                            onClick={() => handleQuickCreateFromFavorite(template)}
                          >
                            <Star className="w-3.5 h-3.5 fill-yellow-500 text-yellow-500" />
                            <span className="truncate max-w-[260px]">{template.title}</span>
                          </Button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {/* Task Filter Bar */}
                <div className="px-6 py-4 border-b border-border/50 bg-background/50 backdrop-blur-sm">
                  <TaskFilterBar
                    filters={taskFilters}
                    onFiltersChange={setTaskFilters}
                    agents={agents}
                    taskCount={tasks.length}
                    filteredCount={filteredTasks.length}
                    onCreateTask={() => openCreateTaskModal()}
                  />
                </div>

                {/* Show empty search state if filtering returns no results */}
                {hasActiveFilters && filteredTasks.length === 0 ? (
                  <EmptySearchResults
                    query={taskFilters.search || "filters"}
                    onClearSearch={clearFilters}
                  />
                ) : tasks.length === 0 ? (
                  <EmptyInbox onCreateTask={() => openCreateTaskModal()} />
                ) : (
                  <KanbanBoard
                    getColumnTasks={getColumnTasks}
                    onDeleteTask={handleDeleteTask}
                    onDispatchTask={(task) => setShowDispatchModal(task)}
                    onViewTask={openTaskDetail}
                    onMoveTask={moveTask}
                    onCreateTask={() => openCreateTaskModal()}
                  />
                )}
              </div>
            )}
            {activeView === "agents" && (
              <ViewErrorBoundary key="agents" viewName="Agents">
                <AgentsView
                  status={gatewayStatus}
                  agents={agents}
                  onRefresh={fetchAgents}
                  onStartGateway={handleStartGateway}
                />
              </ViewErrorBoundary>
            )}
            {activeView === "employees" && (
              <ViewErrorBoundary key="employees" viewName="Employees">
                <EmployeesView
                  workspaceId={effectiveWorkspace}
                  tasks={tasks}
                  activity={activity}
                  agents={agents}
                  onCreateTask={(data) => createTask(data)}
                  onDispatchTask={(taskId, agentId) => {
                    void dispatchTask(taskId, agentId);
                  }}
                  onOpenTask={(taskId) => {
                    const task = tasks.find((t) => t.id === taskId);
                    if (task) openTaskDetail(task);
                  }}
                />
              </ViewErrorBoundary>
            )}
            {activeView === "specialists" && (
              <ViewErrorBoundary key="specialists" viewName="AI Specialists">
                <AISpecialists
                  tasks={tasks}
                  workspaceId={effectiveWorkspace}
                  onAssignTask={(taskId, agentId) => {
                    void dispatchTask(taskId, agentId);
                  }}
                  onStartChat={handleStartSpecialistChat}
                  onNavigateToTask={(taskId) => {
                    const task = tasks.find((t) => t.id === taskId);
                    if (task) {
                      openTaskDetail(task);
                    }
                  }}
                  onCreateAndAssignTask={async ({ title, description, agentId }) => {
                    return createTask({
                      title,
                      description,
                      priority: "medium",
                      assigned_agent_id: agentId,
                    });
                  }}
                />
              </ViewErrorBoundary>
            )}
            {activeView === "missions" && <ViewErrorBoundary key="missions" viewName="Missions"><MissionsView /></ViewErrorBoundary>}
            {activeView === "integrations" && <ViewErrorBoundary key="integrations" viewName="Integrations"><IntegrationsView /></ViewErrorBoundary>}
            {activeView === "channels" && <ViewErrorBoundary key="channels" viewName="Channels"><ChannelsView /></ViewErrorBoundary>}
            {activeView === "skills" && <ViewErrorBoundary key="skills" viewName="Skills"><SkillsDashboard /></ViewErrorBoundary>}
            {activeView === "plugins" && <ViewErrorBoundary key="plugins" viewName="Plugins"><PluginsRegistry /></ViewErrorBoundary>}
            {activeView === "all-tools" && (
              <ViewErrorBoundary key="all-tools" viewName="All Tools">
                <AllToolsView onNavigate={setActiveView} />
              </ViewErrorBoundary>
            )}
            {activeView === "tools" && <ViewErrorBoundary key="tools" viewName="Tools Playground"><ToolsPlayground /></ViewErrorBoundary>}
            {activeView === "mcp-servers" && (
              <ViewErrorBoundary key="mcp-servers" viewName="MCP Servers">
                <MCPServersView />
              </ViewErrorBoundary>
            )}
            {activeView === "usage" && (
              <ViewErrorBoundary key="usage" viewName="Usage & Cost">
                <div className="p-4 sm:p-6">
                  <CostDashboard />
                </div>
              </ViewErrorBoundary>
            )}
            {activeView === "approvals" && <ViewErrorBoundary key="approvals" viewName="Approvals"><ApprovalCenter /></ViewErrorBoundary>}
            {activeView === "cron" && <ViewErrorBoundary key="cron" viewName="Schedules"><CronScheduler /></ViewErrorBoundary>}
            {activeView === "logs" && <ViewErrorBoundary key="logs" viewName="Logs"><LogsViewer /></ViewErrorBoundary>}
            {activeView === "settings" && (
              <ViewErrorBoundary key="settings" viewName="Settings">
                <div className="p-4 sm:p-6">
                  <SettingsPanel />
                </div>
              </ViewErrorBoundary>
            )}
            {activeView === "chat" && <ViewErrorBoundary key="chat" viewName="Chat"><ChatPanel /></ViewErrorBoundary>}
            {activeView === "orchestrate" && (
              <ViewErrorBoundary key="orchestrate" viewName="Orchestrator">
                <Orchestrator workspaceId={effectiveWorkspace} />
              </ViewErrorBoundary>
            )}
            {activeView === "learn" && (
              <ViewErrorBoundary key="learn" viewName="Learning Hub">
                <LearningHub
                  workspaceId={effectiveWorkspace}
                  tasks={tasks}
                  onOpenTask={handleOpenLearningHubTask}
                />
              </ViewErrorBoundary>
            )}
          </div>

          {/* Live Terminal Sidebar */}
          <LiveTerminal
            open={terminalOpen}
            onClose={() => setTerminalOpen(false)}
            activity={activity}
          />
        </div>
      </main>

      {/* Modals */}
      <CreateTaskModal
        open={showCreateModal}
        onOpenChange={setShowCreateModal}
        onCreate={handleCreateTask}
        agents={agents}
        seedDraft={createTaskSeed}
        seedNonce={createTaskSeedNonce}
      />

      {showDispatchModal && (
        <DispatchModal
          task={showDispatchModal}
          agents={agents}
          onClose={() => setShowDispatchModal(null)}
          onDispatch={handleDispatch}
        />
      )}

      {showTaskDetail && (
        <TaskDetailModal
          task={showTaskDetail}
          onClose={closeTaskDetail}
          onMoveToDone={async () => {
            const moved = await moveTask(showTaskDetail.id, "done");
            if (moved) {
              closeTaskDetail();
            }
            return moved;
          }}
          onRefresh={async () => {
            const taskId = taskDetailTaskIdRef.current;
            if (!taskId) return;
            try {
              const params = new URLSearchParams({ workspace_id: effectiveWorkspace });
              const res = await apiFetch(`/api/tasks?${params.toString()}`);
              const data = (await res.json()) as { tasks?: Task[] };
              if (taskDetailTaskIdRef.current !== taskId) {
                return;
              }
              const updated = data.tasks?.find((t) => t.id === taskId);
              if (updated) {
                openTaskDetail(updated);
              }
            } catch {
              showToast("Failed to refresh task details", "error");
            }
          }}
        />
      )}

      {/* Quick Actions (Cmd+K) */}
      <QuickActions
        onNavigate={(view) => setActiveView(view as ViewId)}
        onCreateTask={() => openCreateTaskModal()}
        gatewayStatus={gatewayStatus}
        taskCount={tasks.length}
        pendingApprovals={0}
        workspaceId={effectiveWorkspace}
      />

      {/* Delete Confirmation Dialog */}
      <Dialog open={!!deleteConfirm} onOpenChange={(open) => !open && setDeleteConfirm(null)}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="w-5 h-5" />
              Delete Task?
            </DialogTitle>
            <DialogDescription>
              Are you sure you want to delete &quot;{deleteConfirm?.title}&quot;?
              <span className="block mt-1 text-muted-foreground/80">
                💡 You&apos;ll have 30 seconds to undo this action.
              </span>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setDeleteConfirm(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDelete}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Manage Profiles Dialog */}
      <ManageProfilesDialog
        open={manageProfilesOpen}
        onOpenChange={setManageProfilesOpen}
      />

      {/* Undo Toast */}
      <UndoToast
        onUndoComplete={() => {
          showToast("Action undone", "success");
        }}
      />

      {/* Toast Notification */}
      {toast && (
        <div
          role="status"
          aria-live="polite"
          className={`fixed bottom-6 right-6 z-50 px-4 py-3 rounded-lg shadow-lg flex items-center gap-3 animate-in slide-in-from-bottom-5 fade-in duration-300 ${toast.type === "success"
            ? "bg-green-600 text-white"
            : "bg-destructive text-destructive-foreground"
            }`}
        >
          {toast.type === "success" ? (
            <CheckCircle2 className="w-5 h-5" />
          ) : (
            <AlertTriangle className="w-5 h-5" />
          )}
          <span className="text-sm font-medium">{toast.message}</span>
          <button
            onClick={clearToast}
            className="ml-2 hover:opacity-70 transition-opacity"
            aria-label="Dismiss notification"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
}
