"use client";

import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AgentAvatar, StatusBadge } from "@/components/composed";
import { ChatBackendToggle } from "./ChatBackendToggle";
import type { Agent, AgentStatus } from "@/hooks/queries/useAgents";
import type { GatewaySessionRow } from "@/lib/api/sessions";
import {
  ArrowLeft,
  Settings,
  MoreVertical,
  Plus,
  Clock,
  MessageSquare,
} from "lucide-react";

export interface SessionHeaderProps {
  /** The agent data */
  agent: Agent;
  /** Available sessions for dropdown */
  sessions: GatewaySessionRow[];
  /** Currently selected session key */
  selectedSessionKey: string | null;
  /** Callback when session is changed */
  onSessionChange: (sessionKey: string) => void;
  /** Callback to create new session */
  onNewSession?: () => void;
  /** Additional CSS classes */
  className?: string;
}

/**
 * Format relative time from timestamp
 */
function formatRelativeTime(timestamp?: number): string {
  if (!timestamp) return "";

  const now = Date.now();
  const diffMs = now - timestamp;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

/**
 * Get display label for a session
 */
function getSessionLabel(session: GatewaySessionRow): string {
  if (session.label) return session.label;
  if (session.derivedTitle) return session.derivedTitle;
  // Extract the session name from the key (e.g., "agent:1:main" -> "main")
  const parts = session.key.split(":");
  return parts[parts.length - 1] || "Session";
}

export function SessionHeader({
  agent,
  sessions,
  selectedSessionKey,
  onSessionChange,
  onNewSession,
  className,
}: SessionHeaderProps) {
  const selectedSession = sessions.find((s) => s.key === selectedSessionKey);
  const agentStatus = agent.status as AgentAvatarStatus;

  return (
    <div
      className={cn(
        "flex items-center justify-between gap-4 border-b border-border/50 bg-background px-4 py-3 shrink-0",
        className
      )}
    >
      {/* Left section: Back button + Agent info */}
      <div className="flex items-center gap-4 min-w-0">
        <Link to="/agents/$agentId" params={{ agentId: agent.id }}>
          <Button variant="ghost" size="icon" className="shrink-0">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>

        <AgentAvatar
          name={agent.name}
          avatarUrl={agent.avatar}
          status={agentStatus}
          size="md"
          className="shrink-0"
        />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold truncate">{agent.name}</h1>
            <StatusBadge status={agent.status as AgentStatus} size="sm" />
          </div>
          {agent.role && (
            <p className="text-sm text-muted-foreground truncate">
              {agent.role}
            </p>
          )}
        </div>
      </div>

      {/* Center section: Session selector */}
      <div className="flex items-center gap-2">
        <Select
          value={selectedSessionKey ?? ""}
          onValueChange={onSessionChange}
        >
          <SelectTrigger className="w-[200px] md:w-[280px]">
            <div className="flex items-center gap-2 min-w-0">
              <MessageSquare className="h-4 w-4 shrink-0 text-muted-foreground" />
              <SelectValue placeholder="Select session">
                {selectedSession && (
                  <span className="truncate">
                    {getSessionLabel(selectedSession)}
                  </span>
                )}
              </SelectValue>
            </div>
          </SelectTrigger>
          <SelectContent align="center" className="max-h-[300px]">
            {sessions.length === 0 ? (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                No sessions yet
              </div>
            ) : (
              sessions.map((session) => (
                <SelectItem key={session.key} value={session.key}>
                  <div className="flex flex-col gap-0.5">
                    <div className="flex items-center gap-2">
                      <span className="truncate">
                        {getSessionLabel(session)}
                      </span>
                      {session.messageCount && (
                        <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                          {session.messageCount}
                        </Badge>
                      )}
                    </div>
                    {session.lastMessageAt && (
                      <span className="text-xs text-muted-foreground flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {formatRelativeTime(session.lastMessageAt)}
                      </span>
                    )}
                  </div>
                </SelectItem>
              ))
            )}
          </SelectContent>
        </Select>

        {onNewSession && (
          <Button
            variant="outline"
            size="icon"
            onClick={onNewSession}
            title="New session"
          >
            <Plus className="h-4 w-4" />
          </Button>
        )}
      </div>

      {/* Right section: Actions */}
      <div className="flex items-center gap-2 shrink-0">
        <ChatBackendToggle />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon">
              <MoreVertical className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem>
              <Settings className="mr-2 h-4 w-4" />
              Session Settings
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-destructive">
              End Session
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

export type AgentAvatarStatus = "active" | "ready" | "busy" | "paused" | "offline";

export default SessionHeader;
