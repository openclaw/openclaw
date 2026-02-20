"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { DEFAULT_WORKSPACE } from "@/lib/workspaces";
import {
  Command,
  Search,
  Plus,
  Bot,
  MessageSquare,
  Clock,
  Zap,
  Settings,
  FileText,
  DollarSign,
  Shield,
  Rocket,
  Wrench,
  Link2,
  BookOpen,
  LayoutDashboard,
  Bell,
  BellDot,
  X,
  ChevronRight,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  Info,
  Wifi,
  WifiOff,
  Send,
  ArrowRight,
  Sparkles,
  History,
  Keyboard,
  Terminal,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// --- Types ---

interface QuickCommand {
  id: string;
  label: string;
  description?: string;
  icon: React.ElementType;
  shortcut?: string;
  category: "navigation" | "action" | "task" | "session" | "model";
  action: () => void;
  badge?: string;
  badgeVariant?: "default" | "secondary" | "destructive" | "outline";
}

interface RecentSession {
  id: string;
  key: string;
  label?: string;
  lastActive: string;
  model?: string;
  tokenCount?: number;
}

interface Notification {
  id: string;
  type: "info" | "success" | "warning" | "error";
  title: string;
  message: string;
  timestamp: string;
  read: boolean;
  action?: {
    label: string;
    onClick: () => void;
  };
}

interface GatewayStatus {
  connected: boolean;
  agentCount: number;
  cronJobCount: number;
  uptime?: string;
}

interface QuickActionsProps {
  onNavigate: (view: string) => void;
  onCreateTask: () => void;
  gatewayStatus: GatewayStatus;
  taskCount: number;
  pendingApprovals?: number;
  workspaceId?: string;
}

// --- Model Options ---

const MODEL_OPTIONS = [
  { id: "claude-sonnet-4-5-20250929", provider: "anthropic", label: "Claude Sonnet 4.5", badge: "Popular" },
  { id: "claude-opus-4-6", provider: "anthropic", label: "Claude Opus 4.6", badge: "Popular" },
  { id: "gpt-5.2", provider: "openai", label: "GPT-5.2", badge: "Popular" },
  { id: "gemini-3-flash-preview", provider: "google", label: "Gemini 3 Flash", badge: "Fast" },
  { id: "claude-haiku-4-5-20251001", provider: "anthropic", label: "Claude Haiku 4.5", badge: "Fast" },
  { id: "deepseek-chat", provider: "deepseek", label: "DeepSeek V3", badge: "Best Value" },
  { id: "o3-mini", provider: "openai", label: "o3 Mini", badge: "Reasoning" },
];

// --- Helpers ---

function timeAgo(dateStr: string): string {
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return "unknown";
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function getNotificationIcon(type: Notification["type"]) {
  switch (type) {
    case "success": return CheckCircle2;
    case "warning": return AlertTriangle;
    case "error": return AlertTriangle;
    default: return Info;
  }
}

function getNotificationColor(type: Notification["type"]) {
  switch (type) {
    case "success": return "text-green-500";
    case "warning": return "text-amber-500";
    case "error": return "text-red-500";
    default: return "text-primary";
  }
}

// --- Main Component ---

export function QuickActions({
  onNavigate,
  onCreateTask,
  gatewayStatus,
  taskCount,
  pendingApprovals = 0,
  workspaceId,
}: QuickActionsProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [activeTab, setActiveTab] = useState<"commands" | "tasks" | "sessions" | "models" | "notifications">("commands");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [recentSessions, setRecentSessions] = useState<RecentSession[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [selectedModel, setSelectedModel] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      const stored = localStorage.getItem("mission-control-model-preference");
      if (!stored) return null;
      const parsed = JSON.parse(stored) as { model?: unknown };
      return typeof parsed.model === "string" ? parsed.model : null;
    } catch {
      return null;
    }
  });
  const [quickTaskTitle, setQuickTaskTitle] = useState("");
  const [creatingTask, setCreatingTask] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const closePalette = useCallback(() => {
    setOpen(false);
    setSearch("");
    setActiveTab("commands");
    setSelectedIndex(0);
    setQuickTaskTitle("");
  }, []);

  // --- Commands ---

  const commands: QuickCommand[] = useMemo(() => [
    // Navigation
    {
      id: "nav-dashboard",
      label: "Go to Dashboard",
      description: "View task board and overview",
      icon: LayoutDashboard,
      shortcut: "D",
      category: "navigation",
      action: () => { onNavigate("board"); closePalette(); },
    },
    {
      id: "nav-chat",
      label: "Open Chat",
      description: "Chat with AI assistant",
      icon: MessageSquare,
      shortcut: "C",
      category: "navigation",
      action: () => { onNavigate("chat"); closePalette(); },
    },
    {
      id: "nav-orchestrate",
      label: "Open Orchestrator",
      description: "Multi-agent workflow builder",
      icon: Zap,
      shortcut: "O",
      category: "navigation",
      action: () => { onNavigate("orchestrate"); closePalette(); },
    },
    {
      id: "nav-agents",
      label: "Manage Agents",
      description: "View and create agents",
      icon: Bot,
      category: "navigation",
      action: () => { onNavigate("agents"); closePalette(); },
    },
    {
      id: "nav-tools",
      label: "Tools Playground",
      description: "Test and explore tools",
      icon: Wrench,
      category: "navigation",
      action: () => { onNavigate("tools"); closePalette(); },
    },
    {
      id: "nav-integrations",
      label: "Integrations",
      description: "Manage GitHub, Vercel, Neon, and Render tokens",
      icon: Link2,
      category: "navigation",
      action: () => { onNavigate("integrations"); closePalette(); },
    },
    {
      id: "nav-cron",
      label: "Schedules",
      description: "Manage cron jobs",
      icon: Clock,
      category: "navigation",
      action: () => { onNavigate("cron"); closePalette(); },
    },
    {
      id: "nav-approvals",
      label: "Approval Center",
      description: "Review pending approvals",
      icon: Shield,
      category: "navigation",
      action: () => { onNavigate("approvals"); closePalette(); },
      badge: pendingApprovals > 0 ? `${pendingApprovals}` : undefined,
      badgeVariant: "destructive",
    },
    {
      id: "nav-logs",
      label: "View Logs",
      description: "System and agent logs",
      icon: FileText,
      category: "navigation",
      action: () => { onNavigate("logs"); closePalette(); },
    },
    {
      id: "nav-usage",
      label: "Usage & Costs",
      description: "Monitor API usage",
      icon: DollarSign,
      category: "navigation",
      action: () => { onNavigate("usage"); closePalette(); },
    },
    {
      id: "nav-learn",
      label: "Learning Hub",
      description: "Tutorials and documentation",
      icon: BookOpen,
      category: "navigation",
      action: () => { onNavigate("learn"); closePalette(); },
    },
    {
      id: "nav-settings",
      label: "Settings",
      description: "Configure preferences",
      icon: Settings,
      shortcut: ",",
      category: "navigation",
      action: () => { onNavigate("settings"); closePalette(); },
    },
    // Actions
    {
      id: "action-new-task",
      label: "Create New Task",
      description: "Add a task to the inbox",
      icon: Plus,
      shortcut: "N",
      category: "action",
      action: () => { setActiveTab("tasks"); setSearch(""); },
    },
    {
      id: "action-new-mission",
      label: "Create Mission",
      description: "Start a new mission",
      icon: Rocket,
      category: "action",
      action: () => { onNavigate("missions"); closePalette(); },
    },
    {
      id: "action-switch-model",
      label: "Switch Model",
      description: "Change the AI model",
      icon: Sparkles,
      shortcut: "M",
      category: "action",
      action: () => { setActiveTab("models"); setSearch(""); },
    },
    {
      id: "action-refresh",
      label: "Refresh Data",
      description: "Reload dashboard data",
      icon: RefreshCw,
      shortcut: "R",
      category: "action",
      action: () => { window.location.reload(); },
    },
  ], [closePalette, onNavigate, pendingApprovals]);

  // --- Filter commands by search ---

  const filteredCommands = useMemo(() => {
    if (!search.trim()) return commands;
    const lower = search.toLowerCase();
    return commands.filter(
      (cmd) =>
        cmd.label.toLowerCase().includes(lower) ||
        cmd.description?.toLowerCase().includes(lower) ||
        cmd.category.toLowerCase().includes(lower)
    );
  }, [commands, search]);

  // --- Fetch recent sessions ---

  const fetchSessions = useCallback(async () => {
    setLoadingSessions(true);
    try {
      const res = await fetch("/api/chat/sessions?limit=5");
      if (res.ok) {
        const data = await res.json();
        const sessions = Array.isArray(data.sessions) ? data.sessions : [];
        setRecentSessions(
          sessions.slice(0, 5).map((session: Record<string, unknown>) => ({
            id: String(session.key ?? crypto.randomUUID()),
            key: String(session.key ?? ""),
            label:
              typeof session.label === "string" && session.label.trim().length > 0
                ? session.label
                : "Untitled Session",
            lastActive:
              typeof session.lastActivity === "string"
                ? session.lastActivity
                : new Date().toISOString(),
            model:
              typeof session.model === "string" ? session.model : undefined,
            tokenCount:
              typeof session.totalTokens === "number"
                ? session.totalTokens
                : undefined,
          }))
        );
      } else {
        setRecentSessions([]);
      }
    } catch {
      setRecentSessions([]);
    }
    setLoadingSessions(false);
  }, []);

  const openPalette = useCallback(
    (tab?: "commands" | "tasks" | "sessions" | "models" | "notifications") => {
      setOpen(true);
      if (tab) {
        setActiveTab(tab);
      }
      setTimeout(() => inputRef.current?.focus(), 50);
      void fetchSessions();
    },
    [fetchSessions]
  );

  // --- Generate notifications ---

  const notifications = useMemo(() => {
    const notifs: Notification[] = [];
    
    if (!gatewayStatus.connected) {
      notifs.push({
        id: "gateway-offline",
        type: "error",
        title: "Gateway Offline",
        message: "Cannot connect to OpenClaw gateway at ws://127.0.0.1:18789",
        timestamp: new Date().toISOString(),
        read: false,
        action: {
          label: "Check Settings",
          onClick: () => { onNavigate("settings"); closePalette(); },
        },
      });
    }
    
    if (pendingApprovals > 0) {
      notifs.push({
        id: "pending-approvals",
        type: "warning",
        title: `${pendingApprovals} Pending Approval${pendingApprovals > 1 ? "s" : ""}`,
        message: "Commands require your review before execution",
        timestamp: new Date().toISOString(),
        read: false,
        action: {
          label: "Review",
          onClick: () => { onNavigate("approvals"); closePalette(); },
        },
      });
    }

    if (gatewayStatus.agentCount > 0) {
      notifs.push({
        id: "agents-active",
        type: "success",
        title: `${gatewayStatus.agentCount} Agent${gatewayStatus.agentCount > 1 ? "s" : ""} Online`,
        message: "Agents are ready to accept tasks",
        timestamp: new Date().toISOString(),
        read: true,
      });
    }

    return notifs;
  }, [closePalette, gatewayStatus, onNavigate, pendingApprovals]);

  const unreadCount = notifications.filter(n => !n.read).length;

  // --- Quick task creation ---

  const handleQuickCreateTask = useCallback(async () => {
    if (!quickTaskTitle.trim() || creatingTask) return;
    setCreatingTask(true);
    try {
      await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: quickTaskTitle.trim(),
          description: "",
          priority: "medium",
          workspace_id: workspaceId || DEFAULT_WORKSPACE,
        }),
      });
      setQuickTaskTitle("");
      closePalette();
    } catch {
      // Handle error
    }
    setCreatingTask(false);
  }, [closePalette, creatingTask, quickTaskTitle, workspaceId]);

  // --- Keyboard shortcuts ---

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Open with Cmd+K or Ctrl+K
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        if (open) {
          closePalette();
        } else {
          openPalette();
        }
        return;
      }

      if (!open) return;

      // Tab navigation
      if (e.key === "Tab") {
        e.preventDefault();
        const tabs = ["commands", "tasks", "sessions", "models", "notifications"] as const;
        const currentIndex = tabs.indexOf(activeTab);
        const nextIndex = e.shiftKey
          ? (currentIndex - 1 + tabs.length) % tabs.length
          : (currentIndex + 1) % tabs.length;
        setActiveTab(tabs[nextIndex]);
        setSelectedIndex(0);
        return;
      }

      // Arrow navigation
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((prev) => Math.min(prev + 1, filteredCommands.length - 1));
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
      }

      // Execute selected command
      if (e.key === "Enter" && activeTab === "commands" && filteredCommands[selectedIndex]) {
        e.preventDefault();
        filteredCommands[selectedIndex].action();
      }

      // Quick task creation
      if (e.key === "Enter" && activeTab === "tasks" && quickTaskTitle.trim()) {
        e.preventDefault();
        handleQuickCreateTask();
      }

      // Escape to close
      if (e.key === "Escape") {
        closePalette();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    open,
    activeTab,
    filteredCommands,
    selectedIndex,
    quickTaskTitle,
    handleQuickCreateTask,
    closePalette,
    openPalette,
  ]);

  // Scroll selected item into view
  useEffect(() => {
    if (listRef.current && activeTab === "commands") {
      const selected = listRef.current.querySelector(`[data-index="${selectedIndex}"]`);
      selected?.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex, activeTab]);

  // --- Model selection ---

  const handleSelectModel = (model: typeof MODEL_OPTIONS[0]) => {
    setSelectedModel(model.id);
    try {
      localStorage.setItem(
        "mission-control-model-preference",
        JSON.stringify({ model: model.id, provider: model.provider })
      );
    } catch {}
    closePalette();
  };

  // --- Render ---

  return (
    <>
      {/* Floating Action Button */}
      <div className="fixed bottom-6 right-6 z-50 flex items-center gap-3">
        {/* Notifications indicator */}
        {unreadCount > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                className="h-12 w-12 rounded-full shadow-lg border-amber-500/50 bg-background/95 backdrop-blur-sm hover:bg-amber-500/10"
                onClick={() => openPalette("notifications")}
                aria-label={`Open notifications (${unreadCount} unread)`}
              >
                <BellDot className="h-5 w-5 text-amber-500" />
                <span className="absolute -top-1 -right-1 h-5 w-5 rounded-full bg-amber-500 text-[10px] font-bold text-white flex items-center justify-center">
                  {unreadCount}
                </span>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">
              <p>{unreadCount} notification{unreadCount > 1 ? "s" : ""}</p>
            </TooltipContent>
          </Tooltip>
        )}

        {/* Main Quick Actions Button */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              className="h-14 w-14 rounded-full shadow-lg shadow-primary/25 hover:shadow-primary/40 transition-all hover:scale-105"
              onClick={() => openPalette()}
              aria-label="Open Quick Actions"
            >
              <Command className="h-6 w-6" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">
            <p className="flex items-center gap-2">
              Quick Actions
              <kbd className="px-1.5 py-0.5 text-[10px] font-mono bg-muted rounded border border-border">⌘K</kbd>
            </p>
          </TooltipContent>
        </Tooltip>
      </div>

      {/* Command Palette Dialog */}
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (nextOpen) {
            openPalette();
          } else {
            closePalette();
          }
        }}
      >
        <DialogContent className="sm:max-w-[640px] p-0 gap-0 overflow-hidden">
          <DialogTitle className="sr-only">Quick Actions</DialogTitle>
          <DialogDescription className="sr-only">
            Command palette for navigation, quick task actions, sessions, models, and alerts.
          </DialogDescription>
          {/* Header with Search */}
          <div className="flex items-center border-b border-border px-4">
            <Search className="h-4 w-4 text-muted-foreground shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setSelectedIndex(0);
              }}
              placeholder="Search commands, tasks, sessions..."
              maxLength={200}
              className="flex-1 h-14 px-3 bg-transparent border-none text-sm focus:outline-none placeholder:text-muted-foreground/50"
            />
            <div className="flex items-center gap-1">
              <kbd className="px-1.5 py-0.5 text-[10px] font-mono bg-muted rounded border border-border text-muted-foreground">
                Tab
              </kbd>
              <span className="text-[10px] text-muted-foreground">switch tabs</span>
            </div>
          </div>

          {/* Tab Bar */}
          <div className="flex items-center gap-1 px-4 py-2 border-b border-border bg-muted/30">
            {[
              { id: "commands", label: "Commands", icon: Terminal },
              { id: "tasks", label: "Quick Task", icon: Plus },
              { id: "sessions", label: "Sessions", icon: History },
              { id: "models", label: "Models", icon: Sparkles },
              { id: "notifications", label: "Alerts", icon: Bell, badge: unreadCount },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => { setActiveTab(tab.id as typeof activeTab); setSelectedIndex(0); }}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                  activeTab === tab.id
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted"
                }`}
              >
                <tab.icon className="h-3.5 w-3.5" />
                {tab.label}
                {tab.badge ? (
                  <span className="ml-1 px-1.5 py-0.5 text-[10px] rounded-full bg-amber-500 text-white">
                    {tab.badge}
                  </span>
                ) : null}
              </button>
            ))}
          </div>

          {/* Status Bar */}
          <div className="flex items-center justify-between px-4 py-2 bg-muted/20 border-b border-border">
            <div className="flex items-center gap-4 text-xs">
              <div className="flex items-center gap-1.5">
                {gatewayStatus.connected ? (
                  <Wifi className="h-3.5 w-3.5 text-green-500" />
                ) : (
                  <WifiOff className="h-3.5 w-3.5 text-red-500" />
                )}
                <span className={gatewayStatus.connected ? "text-green-500" : "text-red-500"}>
                  {gatewayStatus.connected ? "Connected" : "Offline"}
                </span>
              </div>
              <Separator orientation="vertical" className="h-4" />
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <Bot className="h-3.5 w-3.5" />
                <span>{gatewayStatus.agentCount} agents</span>
              </div>
              <Separator orientation="vertical" className="h-4" />
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <FileText className="h-3.5 w-3.5" />
                <span>{taskCount} tasks</span>
              </div>
            </div>
            {selectedModel && (
              <Badge variant="outline" className="text-[10px] gap-1">
                <Sparkles className="h-3 w-3" />
                {MODEL_OPTIONS.find(m => m.id === selectedModel)?.label || selectedModel}
              </Badge>
            )}
          </div>

          {/* Content Area */}
          <ScrollArea className="h-[360px]">
            {/* Commands Tab */}
            {activeTab === "commands" && (
              <div ref={listRef} className="p-2">
                {filteredCommands.length === 0 ? (
                  <div className="py-12 text-center text-muted-foreground">
                    <Search className="h-8 w-8 mx-auto mb-2 opacity-30" />
                    <p>No commands found for &quot;{search}&quot;</p>
                  </div>
                ) : (
                  <>
                    {/* Group by category */}
                    {(["navigation", "action"] as const).map((category) => {
                      const categoryCommands = filteredCommands.filter(c => c.category === category);
                      if (categoryCommands.length === 0) return null;
                      return (
                        <div key={category} className="mb-2">
                          <div className="px-2 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                            {category === "navigation" ? "Go To" : "Actions"}
                          </div>
                          {categoryCommands.map((cmd) => {
                            const globalIdx = filteredCommands.indexOf(cmd);
                            const isSelected = selectedIndex === globalIdx;
                            return (
                              <button
                                key={cmd.id}
                                data-index={globalIdx}
                                onClick={cmd.action}
                                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-md transition-all ${
                                  isSelected
                                    ? "bg-primary/10 text-primary"
                                    : "hover:bg-muted text-foreground"
                                }`}
                              >
                                <div className={`w-8 h-8 rounded-md flex items-center justify-center shrink-0 ${
                                  isSelected ? "bg-primary/20" : "bg-muted"
                                }`}>
                                  <cmd.icon className="h-4 w-4" />
                                </div>
                                <div className="flex-1 text-left">
                                  <div className="text-sm font-medium flex items-center gap-2">
                                    {cmd.label}
                                    {cmd.badge && (
                                      <Badge variant={cmd.badgeVariant || "secondary"} className="text-[10px] px-1.5 py-0">
                                        {cmd.badge}
                                      </Badge>
                                    )}
                                  </div>
                                  {cmd.description && (
                                    <div className="text-xs text-muted-foreground">{cmd.description}</div>
                                  )}
                                </div>
                                {cmd.shortcut && (
                                  <kbd className="px-1.5 py-0.5 text-[10px] font-mono bg-muted rounded border border-border text-muted-foreground">
                                    ⌘{cmd.shortcut}
                                  </kbd>
                                )}
                                <ChevronRight className="h-4 w-4 text-muted-foreground/50" />
                              </button>
                            );
                          })}
                        </div>
                      );
                    })}
                  </>
                )}
              </div>
            )}

            {/* Quick Task Tab */}
            {activeTab === "tasks" && (
              <div className="p-4 space-y-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium flex items-center gap-2">
                    <Zap className="h-4 w-4 text-primary" />
                    Quick Task Creation
                  </label>
                  <p className="text-xs text-muted-foreground">
                    Create a task instantly. Press Enter to submit.
                  </p>
                </div>
                
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={quickTaskTitle}
                    onChange={(e) => setQuickTaskTitle(e.target.value)}
                    placeholder="What needs to be done?"
                    maxLength={200}
                    className="flex-1 px-3 py-2.5 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    autoFocus
                  />
                  <Button
                    onClick={handleQuickCreateTask}
                    disabled={!quickTaskTitle.trim() || creatingTask}
                    className="shrink-0"
                  >
                    {creatingTask ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Send className="h-4 w-4" />
                    )}
                  </Button>
                </div>

                <Separator />

                <div className="space-y-2">
                  <div className="text-xs font-medium text-muted-foreground">Or open full task creator</div>
                  <Button
                    variant="outline"
                    className="w-full justify-between"
                    onClick={() => { onCreateTask(); closePalette(); }}
                  >
                    <span className="flex items-center gap-2">
                      <Plus className="h-4 w-4" />
                      Create Task with Details
                    </span>
                    <ArrowRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}

            {/* Sessions Tab */}
            {activeTab === "sessions" && (
              <div className="p-2">
                {loadingSessions ? (
                  <div className="py-12 text-center">
                    <Loader2 className="h-6 w-6 mx-auto animate-spin text-primary" />
                    <p className="text-sm text-muted-foreground mt-2">Loading sessions...</p>
                  </div>
                ) : recentSessions.length === 0 ? (
                  <div className="py-12 text-center text-muted-foreground">
                    <History className="h-8 w-8 mx-auto mb-2 opacity-30" />
                    <p>No recent sessions</p>
                  </div>
                ) : (
                  <>
                    <div className="px-2 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      Recent Sessions
                    </div>
                    {recentSessions.map((session) => (
                      <button
                        key={session.id}
                        onClick={() => {
                          onNavigate("chat");
                          closePalette();
                        }}
                        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md transition-all hover:bg-muted"
                      >
                        <div className="w-8 h-8 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
                          <MessageSquare className="h-4 w-4 text-primary" />
                        </div>
                        <div className="flex-1 text-left min-w-0">
                          <div className="text-sm font-medium truncate">
                            {session.label || session.key}
                          </div>
                          <div className="text-xs text-muted-foreground flex items-center gap-2">
                            <span>{timeAgo(session.lastActive)}</span>
                            {session.model && (
                              <>
                                <span>•</span>
                                <span>{session.model}</span>
                              </>
                            )}
                            {session.tokenCount && (
                              <>
                                <span>•</span>
                                <span>{session.tokenCount.toLocaleString()} tokens</span>
                              </>
                            )}
                          </div>
                        </div>
                        <ChevronRight className="h-4 w-4 text-muted-foreground/50 shrink-0" />
                      </button>
                    ))}
                  </>
                )}
              </div>
            )}

            {/* Models Tab */}
            {activeTab === "models" && (
              <div className="p-2">
                <div className="px-2 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Select Model
                </div>
                {MODEL_OPTIONS.map((model) => (
                  <button
                    key={model.id}
                    onClick={() => handleSelectModel(model)}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-md transition-all ${
                      selectedModel === model.id
                        ? "bg-primary/10 text-primary"
                        : "hover:bg-muted"
                    }`}
                  >
                    <div className={`w-8 h-8 rounded-md flex items-center justify-center shrink-0 ${
                      selectedModel === model.id ? "bg-primary/20" : "bg-muted"
                    }`}>
                      <Sparkles className="h-4 w-4" />
                    </div>
                    <div className="flex-1 text-left">
                      <div className="text-sm font-medium flex items-center gap-2">
                        {model.label}
                        {model.badge && (
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                            {model.badge}
                          </Badge>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">{model.provider}</div>
                    </div>
                    {selectedModel === model.id && (
                      <CheckCircle2 className="h-4 w-4 text-primary shrink-0" />
                    )}
                  </button>
                ))}
              </div>
            )}

            {/* Notifications Tab */}
            {activeTab === "notifications" && (
              <div className="p-2">
                {notifications.length === 0 ? (
                  <div className="py-12 text-center text-muted-foreground">
                    <Bell className="h-8 w-8 mx-auto mb-2 opacity-30" />
                    <p>No notifications</p>
                  </div>
                ) : (
                  <>
                    <div className="px-2 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      Notifications
                    </div>
                    {notifications.map((notif) => {
                      const Icon = getNotificationIcon(notif.type);
                      const colorClass = getNotificationColor(notif.type);
                      return (
                        <div
                          key={notif.id}
                          className={`flex items-start gap-3 px-3 py-3 rounded-md transition-all ${
                            notif.read ? "opacity-60" : "bg-muted/50"
                          }`}
                        >
                          <div className={`w-8 h-8 rounded-md flex items-center justify-center shrink-0 ${
                            notif.type === "error" ? "bg-red-500/10" :
                            notif.type === "warning" ? "bg-amber-500/10" :
                            notif.type === "success" ? "bg-green-500/10" :
                            "bg-primary/10"
                          }`}>
                            <Icon className={`h-4 w-4 ${colorClass}`} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium">{notif.title}</div>
                            <div className="text-xs text-muted-foreground">{notif.message}</div>
                            {notif.action && (
                              <Button
                                variant="link"
                                size="sm"
                                className="h-auto p-0 text-xs mt-1"
                                onClick={notif.action.onClick}
                              >
                                {notif.action.label}
                                <ChevronRight className="h-3 w-3 ml-1" />
                              </Button>
                            )}
                          </div>
                          <div className="text-[10px] text-muted-foreground shrink-0">
                            {timeAgo(notif.timestamp)}
                          </div>
                        </div>
                      );
                    })}
                  </>
                )}
              </div>
            )}
          </ScrollArea>

          {/* Footer */}
          <div className="flex items-center justify-between px-4 py-2 border-t border-border bg-muted/30">
            <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
              <span className="flex items-center gap-1">
                <Keyboard className="h-3 w-3" />
                <kbd className="px-1 py-0.5 font-mono bg-background rounded border border-border">↑↓</kbd>
                navigate
              </span>
              <span className="flex items-center gap-1">
                <kbd className="px-1 py-0.5 font-mono bg-background rounded border border-border">↵</kbd>
                select
              </span>
              <span className="flex items-center gap-1">
                <kbd className="px-1 py-0.5 font-mono bg-background rounded border border-border">esc</kbd>
                close
              </span>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[10px]"
              onClick={() => closePalette()}
            >
              <X className="h-3 w-3 mr-1" />
              Close
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default QuickActions;
