"use client";

import { useTheme } from "next-themes";
import { Wifi, WifiOff, Moon, Sun, Terminal, Activity, ExternalLink, Play, Loader2, Menu, X as XIcon } from "lucide-react";
import { useState, useCallback } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import type { GatewayStatus } from "@/lib/hooks/use-tasks";

import { ProfileSwitcher } from "@/components/layout/profile-switcher";
import { ProviderStatusWidget } from "@/components/ui/provider-status-widget";

// --- Theme Toggle ---

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const activeTheme = resolvedTheme || "dark";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={() => setTheme(activeTheme === "dark" ? "light" : "dark")}
          className="w-8 h-8 rounded flex items-center justify-center text-muted-foreground hover:text-primary hover:bg-primary/5 transition-all"
          aria-label={activeTheme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
        >
          {activeTheme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <p>{activeTheme === "dark" ? "Light mode" : "Dark mode"}</p>
      </TooltipContent>
    </Tooltip>
  );
}

interface WorkspaceOption {
  id: string;
  label: string;
  color: string;
}

interface HeaderProps {
  gatewayStatus: GatewayStatus;
  gatewayConnectionState: "connecting" | "connected" | "disconnected";
  gatewayEventsPerMinute: number;
  gatewayLastEventAt?: string | null;
  taskCount: number;
  activeWorkspace: string;
  onWorkspaceChange: (workspaceId: string) => void;
  workspaceOptions: WorkspaceOption[];
  onManageProfiles: () => void;
  terminalOpen: boolean;
  onTerminalToggle: () => void;
  showToast?: (message: string, type: "success" | "error") => void;
  mobileSidebarOpen?: boolean;
  onMobileSidebarToggle?: () => void;
}

export function Header({
  gatewayStatus,
  gatewayConnectionState,
  gatewayEventsPerMinute,
  gatewayLastEventAt,
  taskCount,
  activeWorkspace,
  onWorkspaceChange,
  workspaceOptions,
  onManageProfiles,
  terminalOpen,
  onTerminalToggle,
  showToast,
  mobileSidebarOpen,
  onMobileSidebarToggle
}: HeaderProps) {
  const liveConnected =
    gatewayConnectionState === "connected" && gatewayStatus.connected;
  const statusLabel =
    gatewayConnectionState === "connecting"
      ? "CONNECTING"
      : liveConnected
        ? "SYSTEM ONLINE"
        : "OFFLINE";

  const throughputLabel =
    gatewayEventsPerMinute > 0 ? `${gatewayEventsPerMinute}/min` : "idle";

  const [startingGateway, setStartingGateway] = useState(false);

  const handleStartGateway = useCallback(async () => {
    setStartingGateway(true);
    try {
      const res = await fetch("/api/gateway/start", { method: "POST" });
      const data = await res.json();
      if (data.ok) {
        showToast?.(data.alreadyRunning ? "Gateway is already running" : "Gateway started", "success");
      } else {
        showToast?.(data.message || "Failed to start gateway", "error");
      }
    } catch {
      showToast?.("Failed to start gateway", "error");
    } finally {
      setStartingGateway(false);
    }
  }, [showToast]);

  return (
    <header className="h-14 border-b border-border bg-card/80 backdrop-blur-sm flex items-center justify-between px-4 sm:px-6 z-10 shrink-0">
      <div className="flex items-center gap-2 sm:gap-4">
        {onMobileSidebarToggle && (
          <button
            onClick={onMobileSidebarToggle}
            className="md:hidden w-8 h-8 rounded flex items-center justify-center text-muted-foreground hover:text-primary hover:bg-primary/5 transition-all"
            aria-label="Toggle sidebar"
          >
            {mobileSidebarOpen ? <XIcon className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        )}
        <h1 className="text-lg font-bold tracking-wider uppercase flex items-center gap-2">
          <span className="text-xl">{"🦞"}</span>
          <span className="hidden sm:inline">OpenClaw Mission Control</span>
          <span className="inline sm:hidden text-base">OMC</span>
        </h1>
        <ProfileSwitcher onManageProfiles={onManageProfiles} />
        <div className="hidden md:flex items-center gap-2">
          <Select
            value={activeWorkspace}
            onValueChange={(value: string) => onWorkspaceChange(value)}
          >
            <SelectTrigger className="h-8 w-auto min-w-[120px] border-border text-xs font-medium" aria-label="Workspace">
              <SelectValue placeholder="Workspace" />
            </SelectTrigger>
            <SelectContent>
              {workspaceOptions.map((workspace) => (
                <SelectItem key={workspace.id} value={workspace.id}>
                  {workspace.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Separator orientation="vertical" className="h-6" />
        <div className="flex items-center gap-2 text-xs font-mono text-primary" role="status" aria-label={`Gateway status: ${statusLabel}`}>
          <span className="relative flex h-2 w-2" aria-hidden="true">
            {liveConnected && (
              <span className="ping-slow absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
            )}
            <span className={`relative inline-flex rounded-full h-2 w-2 ${liveConnected
              ? "bg-primary"
              : gatewayConnectionState === "connecting"
                ? "bg-amber-500"
                : "bg-destructive"
              }`} />
          </span>
          {statusLabel}
        </div>
      </div>

      <div className="flex items-center gap-4 text-xs font-mono">
        {/* Connection pill */}
        <div className="flex items-center gap-2 text-muted-foreground bg-muted px-3 py-1.5 rounded border border-border">
          {liveConnected ? (
            <Wifi className="w-3.5 h-3.5 text-green-500" />
          ) : gatewayConnectionState === "connecting" ? (
            <Activity className="w-3.5 h-3.5 text-amber-500 animate-pulse" />
          ) : (
            <WifiOff className="w-3.5 h-3.5 text-destructive" />
          )}
          <span className="hidden sm:inline">ws://127.0.0.1:18789</span>
          {!liveConnected && gatewayConnectionState !== "connecting" && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={handleStartGateway}
                  disabled={startingGateway}
                  className="ml-1 w-6 h-6 rounded flex items-center justify-center bg-primary/10 text-primary hover:bg-primary/20 transition-all disabled:opacity-50"
                  aria-label="Start gateway"
                >
                  {startingGateway ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <Play className="w-3 h-3" />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p>Start gateway</p>
              </TooltipContent>
            </Tooltip>
          )}
        </div>

        {/* Live throughput */}
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex items-center gap-2 text-muted-foreground bg-muted px-3 py-1.5 rounded border border-border">
              <Activity
                className={`w-3.5 h-3.5 ${gatewayEventsPerMinute > 0 ? "text-primary" : "text-muted-foreground"
                  }`}
              />
              <span>{throughputLabel}</span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p>
              Gateway stream throughput
              {gatewayLastEventAt ? ` • Last event ${new Date(gatewayLastEventAt).toLocaleTimeString()}` : ""}
            </p>
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <a
              href="http://127.0.0.1:18789"
              target="_blank"
              rel="noopener noreferrer"
              className="w-8 h-8 rounded flex items-center justify-center text-muted-foreground hover:text-primary hover:bg-primary/5 transition-all"
              aria-label="Open built-in dashboard"
            >
              <ExternalLink className="w-4 h-4" />
            </a>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p>Open built-in dashboard</p>
          </TooltipContent>
        </Tooltip>

        {/* Stats */}
        <div className="hidden lg:flex items-center gap-4">
          <div className="flex flex-col items-end leading-none gap-1">
            <span className="text-muted-foreground text-[10px] uppercase">Agents</span>
            <span className="font-bold">{gatewayStatus.agentCount}</span>
          </div>
          <div className="flex flex-col items-end leading-none gap-1">
            <span className="text-muted-foreground text-[10px] uppercase">Tasks</span>
            <span className="text-primary font-bold">{taskCount}</span>
          </div>
        </div>

        <ProviderStatusWidget />

        <Separator orientation="vertical" className="h-6" />
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onTerminalToggle}
              className={`w-8 h-8 rounded flex items-center justify-center transition-all ${terminalOpen
                ? "text-primary bg-primary/10"
                : "text-muted-foreground hover:text-primary hover:bg-primary/5"
                }`}
              aria-label={terminalOpen ? "Hide terminal" : "Show terminal"}
              aria-pressed={terminalOpen}
            >
              <Terminal className="w-4 h-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p>{terminalOpen ? "Hide terminal" : "Show terminal"}</p>
          </TooltipContent>
        </Tooltip>
        <ThemeToggle />
      </div>
    </header>
  );
}
