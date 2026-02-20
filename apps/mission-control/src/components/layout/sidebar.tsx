"use client";

import { useSyncExternalStore } from "react";
import {
  LayoutDashboard,
  Bot,
  Users,
  Brain,
  Link2,
  Rocket,
  Settings,

  Wrench,
  Radio,
  Puzzle,
  DollarSign,
  Shield,
  Clock,
  FileText,
  MessageSquare,
  Zap,
  BookOpen,
  Package,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// --- View routing ---
export const VALID_VIEWS = [
  "board",
  "chat",
  "orchestrate",
  "agents",
  "employees",
  "specialists",
  "learn",
  "all-tools",
  // Advanced / less-used pages (reachable via All Tools)
  "missions",
  "integrations",
  "channels",
  "tools",
  "skills",
  "plugins",
  "mcp-servers",
  "usage",
  "approvals",
  "cron",
  "logs",
  "settings",
] as const;

export type ViewId = (typeof VALID_VIEWS)[number];

export function getViewFromHash(): ViewId {
  if (typeof window === "undefined") return "board";
  const hash = window.location.hash.replace("#", "");
  return (VALID_VIEWS as readonly string[]).includes(hash) ? (hash as ViewId) : "board";
}

const NAV_ITEMS = [
  // Daily use
  { id: "board" as const, icon: LayoutDashboard, label: "Dashboard" },
  { id: "chat" as const, icon: MessageSquare, label: "Chat" },
  { id: "orchestrate" as const, icon: Zap, label: "Orchestrate" },
  { id: "agents" as const, icon: Bot, label: "Agents" },
  { id: "employees" as const, icon: Users, label: "Employees" },
  { id: "specialists" as const, icon: Brain, label: "Specialists" },
  { id: "learn" as const, icon: BookOpen, label: "Learning Hub" },

  // Directory of everything else
  { id: "all-tools" as const, icon: Wrench, label: "All Tools" },

  // Advanced / less-used pages (not shown directly in sidebar groups)
  { id: "usage" as const, icon: DollarSign, label: "Usage" },
  { id: "logs" as const, icon: FileText, label: "Logs" },
  { id: "approvals" as const, icon: Shield, label: "Approvals" },
  { id: "missions" as const, icon: Rocket, label: "Missions" },
  { id: "integrations" as const, icon: Link2, label: "Integrations" },
  { id: "channels" as const, icon: Radio, label: "Channels" },
  { id: "tools" as const, icon: Wrench, label: "Tools Playground" },
  { id: "skills" as const, icon: Puzzle, label: "Skills" },
  { id: "plugins" as const, icon: Package, label: "Plugins" },
  { id: "mcp-servers" as const, icon: Plug, label: "MCP Servers" },
  { id: "cron" as const, icon: Clock, label: "Schedules" },
];

type NavItemId = (typeof NAV_ITEMS)[number]["id"];

const NAV_GROUPS: Array<{
  id: string;
  label: string;
  views: NavItemId[];
}> = [
    { id: "command", label: "Command", views: ["board", "chat", "orchestrate"] },
    { id: "team", label: "Team", views: ["agents", "employees", "specialists"] },
    { id: "learn", label: "Learn", views: ["learn", "channels"] },
    { id: "tools", label: "Tools", views: ["all-tools", "plugins"] },
  ];

interface SidebarProps {
  activeView: ViewId;
  onViewChange: (view: ViewId) => void;
  onAgentsClick?: () => void;
  mobileOpen?: boolean;
  onMobileClose?: () => void;
}

const SIDEBAR_COLLAPSED_STORAGE_KEY = "mc:sidebar-collapsed";
const SIDEBAR_COLLAPSED_EVENT = "mc:sidebar-collapsed-changed";

function getSidebarCollapsedSnapshot(): boolean {
  if (typeof window === "undefined") return false;
  const stored = window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY);
  return stored == null ? false : stored === "true";
}

function subscribeToSidebarCollapsed(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => { };

  const onStorage = (event: StorageEvent) => {
    if (event.key && event.key !== SIDEBAR_COLLAPSED_STORAGE_KEY) return;
    onStoreChange();
  };
  const onLocal = () => onStoreChange();

  window.addEventListener("storage", onStorage);
  window.addEventListener(SIDEBAR_COLLAPSED_EVENT, onLocal);

  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(SIDEBAR_COLLAPSED_EVENT, onLocal);
  };
}

export function Sidebar({
  activeView,
  onViewChange,
  onAgentsClick,
  mobileOpen,
  onMobileClose
}: SidebarProps) {
  const collapsed = useSyncExternalStore(
    subscribeToSidebarCollapsed,
    getSidebarCollapsedSnapshot,
    () => false
  );

  const toggleSidebar = () => {
    const next = !collapsed;
    if (typeof window !== "undefined") {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(next));
      window.dispatchEvent(new Event(SIDEBAR_COLLAPSED_EVENT));
    }
  };

  const itemsById = new Map(NAV_ITEMS.map((item) => [item.id, item]));

  const renderNavButton = (viewId: NavItemId) => {
    const item = itemsById.get(viewId);
    if (!item) return null;

    const isActive = activeView === item.id;
    const Icon = item.icon;
    const button = (
      <button
        onClick={() => {
          onViewChange(item.id);
          if (item.id === "agents" && onAgentsClick) {
            onAgentsClick();
          }
          if (onMobileClose) {
            onMobileClose();
          }
        }}
        aria-current={isActive ? "page" : undefined}
        className={`w-full rounded flex items-center transition-all relative group ${collapsed
          ? "h-10 justify-center"
          : "h-10 px-3 gap-2.5"
          } ${isActive
            ? "text-primary bg-primary/10 shadow-[0_0_10px_oklch(0.58_0.2_260/0.25)]"
            : "text-muted-foreground hover:text-primary hover:bg-primary/5"
          }`}
      >
        {isActive && (
          <span className="absolute left-0 w-1 h-6 bg-primary rounded-r" />
        )}
        <Icon className="w-5 h-5 shrink-0" />
        {!collapsed && (
          <span className="text-sm font-medium truncate">{item.label}</span>
        )}
      </button>
    );

    if (!collapsed) return button;

    return (
      <Tooltip key={item.id}>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent side="right">
          <p>{item.label}</p>
        </TooltipContent>
      </Tooltip>
    );
  };

  return (
    <>
      {/* Mobile Backdrop */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-background/80 backdrop-blur-sm md:hidden"
          onClick={onMobileClose}
        />
      )}

      <aside
        className={`fixed md:relative inset-y-0 left-0 flex flex-col py-4 border-r border-border bg-card/95 backdrop-blur z-50 shrink-0 transition-all duration-300 h-[100dvh] min-h-0 overflow-hidden ${collapsed ? "w-16 items-center" : "w-56 px-2"
          } ${mobileOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"}`}
      >
        <div
          className={`mb-6 flex items-center ${collapsed ? "flex-col gap-3" : "justify-between"
            } ${collapsed ? "" : "px-2"}`}
        >
          <div className="w-10 h-10 rounded bg-primary/20 flex items-center justify-center shadow-[0_0_5px_oklch(0.58_0.2_260/0.3)] cursor-pointer group">
            <span className="text-xl group-hover:animate-pulse">🦞</span>
          </div>
          <button
            onClick={toggleSidebar}
            className="w-8 h-8 rounded flex items-center justify-center text-muted-foreground hover:text-primary hover:bg-primary/5 transition-all"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? (
              <PanelLeftOpen className="w-4 h-4" />
            ) : (
              <PanelLeftClose className="w-4 h-4" />
            )}
          </button>
        </div>

        <nav
          aria-label="Main navigation"
          className={`flex-1 min-h-0 flex flex-col gap-4 w-full overflow-y-auto overscroll-contain ${collapsed ? "items-center" : ""
            }`}
        >
          {NAV_GROUPS.map((group) => (
            <div key={group.id} className={`w-full ${collapsed ? "flex flex-col gap-2 items-center" : "px-1"}`}>
              {!collapsed && (
                <p className="px-2 mb-1 text-[10px] uppercase tracking-wider text-muted-foreground/80 font-semibold">
                  {group.label}
                </p>
              )}
              <div className={`flex flex-col gap-2 ${collapsed ? "items-center w-full" : ""}`}>
                {group.views.map((viewId) => (
                  <div key={viewId} className={collapsed ? "w-10" : "w-full"}>
                    {renderNavButton(viewId)}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </nav>

        <div className={`flex flex-col gap-3 w-full ${collapsed ? "items-center" : "px-2"}`}>
          <div className={collapsed ? "w-10" : "w-full"}>
            {collapsed ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => onViewChange("settings")}
                    aria-current={activeView === "settings" ? "page" : undefined}
                    className={`w-10 h-10 rounded flex items-center justify-center transition-all relative group ${activeView === "settings"
                      ? "text-primary bg-primary/10 shadow-[0_0_10px_oklch(0.58_0.2_260/0.3)]"
                      : "text-muted-foreground hover:text-primary hover:bg-primary/5"
                      }`}
                  >
                    {activeView === "settings" && (
                      <span className="absolute left-0 w-1 h-6 bg-primary rounded-r" />
                    )}
                    <Settings className="w-5 h-5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">
                  <p>Settings</p>
                </TooltipContent>
              </Tooltip>
            ) : (
              <button
                onClick={() => onViewChange("settings")}
                aria-current={activeView === "settings" ? "page" : undefined}
                className={`w-full h-10 rounded flex items-center gap-2.5 px-3 transition-all relative group ${activeView === "settings"
                  ? "text-primary bg-primary/10 shadow-[0_0_10px_oklch(0.58_0.2_260/0.3)]"
                  : "text-muted-foreground hover:text-primary hover:bg-primary/5"
                  }`}
              >
                {activeView === "settings" && (
                  <span className="absolute left-0 w-1 h-6 bg-primary rounded-r" />
                )}
                <Settings className="w-5 h-5" />
                <span className="text-sm font-medium">Settings</span>
              </button>
            )}
          </div>
          <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center text-xs font-bold text-primary border border-primary/30 mx-auto">
            MC
          </div>
        </div>
      </aside>
    </>
  );
}
