"use client";

import { ReactNode } from "react";
import {
  Inbox,
  Bot,
  Rocket,
  Zap,
  ClipboardList,
  CheckCircle2,
  Clock,
  Search,
  Plus,
  ArrowRight,
  Lightbulb,
  Sparkles,
  Target,
  Send,
  BookOpen,
  MessageSquare,
} from "lucide-react";
import { Button } from "@/components/ui/button";

// --- Types ---

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description: string;
  tips?: string[];
  primaryAction?: {
    label: string;
    icon?: ReactNode;
    onClick: () => void;
  };
  secondaryAction?: {
    label: string;
    onClick: () => void;
  };
  variant?: "default" | "minimal" | "feature";
}

// --- Base Empty State Component ---

export function EmptyState({
  icon,
  title,
  description,
  tips,
  primaryAction,
  secondaryAction,
  variant = "default",
}: EmptyStateProps) {
  if (variant === "minimal") {
    return (
      <div className="text-center py-8 text-muted-foreground">
        {icon && <div className="mx-auto mb-2 opacity-30">{icon}</div>}
        <p className="text-sm">{title}</p>
        {primaryAction && (
          <Button
            size="sm"
            variant="ghost"
            onClick={primaryAction.onClick}
            className="mt-2 text-xs"
          >
            {primaryAction.icon}
            {primaryAction.label}
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center py-12 px-6">
      {/* Icon */}
      {icon && (
        <div className="w-20 h-20 rounded-2xl bg-primary/10 flex items-center justify-center mb-6 relative">
          <div className="absolute inset-0 rounded-2xl bg-primary/5 animate-pulse" />
          <div className="relative text-primary/40">{icon}</div>
        </div>
      )}

      {/* Title & Description */}
      <h3 className="text-lg font-semibold mb-2 text-center">{title}</h3>
      <p className="text-sm text-muted-foreground text-center max-w-md mb-6">
        {description}
      </p>

      {/* Tips */}
      {tips && tips.length > 0 && (
        <div className="bg-muted/50 rounded-lg p-4 mb-6 max-w-md w-full">
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground mb-3">
            <Lightbulb className="w-3.5 h-3.5" />
            Quick Tips
          </div>
          <ul className="space-y-2">
            {tips.map((tip, index) => (
              <li key={index} className="flex items-start gap-2 text-sm text-muted-foreground">
                <span className="text-primary mt-0.5">•</span>
                <span>{tip}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Actions */}
      {(primaryAction || secondaryAction) && (
        <div className="flex items-center gap-3">
          {primaryAction && (
            <Button onClick={primaryAction.onClick} className="gap-2">
              {primaryAction.icon}
              {primaryAction.label}
            </Button>
          )}
          {secondaryAction && (
            <Button variant="outline" onClick={secondaryAction.onClick}>
              {secondaryAction.label}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

// --- Specialized Empty States ---

export function EmptyInbox({ onCreateTask }: { onCreateTask: () => void }) {
  return (
    <EmptyState
      icon={<Inbox className="w-10 h-10" />}
      title="Your inbox is empty"
      description="Tasks you create will appear here first. Create a task to get started, or use the Orchestrator to run multiple tasks in parallel."
      tips={[
        "Press ⌘N to quickly create a new task",
        "Drag tasks between columns to change their status",
        "Assign tasks to agents for autonomous work",
      ]}
      primaryAction={{
        label: "Create Task",
        icon: <Plus className="w-4 h-4" />,
        onClick: onCreateTask,
      }}
      secondaryAction={{
        label: "Learn More",
        onClick: () => (window.location.hash = "learn"),
      }}
    />
  );
}

export function EmptyColumn({
  columnName,
  columnId,
}: {
  columnName: string;
  columnId: string;
}) {
  const displayColumnName = columnName.replace(/_/g, " ");

  const getColumnGuidance = () => {
    switch (columnId) {
      case "inbox":
        return {
          icon: <Inbox className="w-6 h-6" />,
          text: "New tasks appear here",
          hint: "Create or drop tasks here to start",
        };
      case "assigned":
        return {
          icon: <Bot className="w-6 h-6" />,
          text: "Tasks assigned to agents",
          hint: "Dispatch inbox tasks to agents",
        };
      case "in_progress":
        return {
          icon: <Zap className="w-6 h-6" />,
          text: "Agents are working",
          hint: "Tasks being actively processed",
        };
      case "review":
        return {
          icon: <ClipboardList className="w-6 h-6" />,
          text: "Ready for your review",
          hint: "Agent work awaiting approval",
        };
      case "done":
        return {
          icon: <CheckCircle2 className="w-6 h-6" />,
          text: "Completed tasks",
          hint: "Approved and finished work",
        };
      default:
        return {
          icon: <Target className="w-6 h-6" />,
          text: `No tasks in ${displayColumnName}`,
          hint: "Drop tasks here",
        };
    }
  };

  const guidance = getColumnGuidance();

  return (
    <div className="text-center py-8 px-4">
      <div className="w-12 h-12 rounded-xl bg-muted/50 flex items-center justify-center mx-auto mb-3 text-muted-foreground/30">
        {guidance.icon}
      </div>
      <p className="text-sm text-muted-foreground mb-1">{guidance.text}</p>
      <p className="text-xs text-muted-foreground/60">{guidance.hint}</p>
    </div>
  );
}

export function EmptySearchResults({
  query,
  onClearSearch,
}: {
  query: string;
  onClearSearch: () => void;
}) {
  return (
    <EmptyState
      icon={<Search className="w-10 h-10" />}
      title="No tasks found"
      description={`No tasks match "${query}". Try adjusting your search or filters.`}
      tips={[
        "Check for typos in your search",
        "Try searching for part of the task title",
        "Clear filters to see all tasks",
      ]}
      primaryAction={{
        label: "Clear Search",
        icon: <Search className="w-4 h-4" />,
        onClick: onClearSearch,
      }}
    />
  );
}

export function EmptyAgents({
  onCreateAgent,
  isConnected,
  onStartGateway,
}: {
  onCreateAgent: () => void;
  isConnected: boolean;
  onStartGateway?: () => void;
}) {
  if (!isConnected) {
    return (
      <EmptyState
        icon={<Bot className="w-10 h-10" />}
        title="Gateway not connected"
        description="Connect to the OpenClaw gateway to manage agents. Start the gateway directly or check your settings."
        tips={[
          "Click 'Start Gateway' to launch it automatically",
          "Verify the WebSocket URL in settings",
          "Restart the gateway if issues persist",
        ]}
        primaryAction={
          onStartGateway
            ? {
              label: "Start Gateway",
              icon: <Rocket className="w-4 h-4" />,
              onClick: onStartGateway,
            }
            : {
              label: "Check Settings",
              icon: <ArrowRight className="w-4 h-4" />,
              onClick: () => (window.location.hash = "settings"),
            }
        }
        secondaryAction={{
          label: "Check Settings",
          onClick: () => (window.location.hash = "settings"),
        }}
      />
    );
  }

  return (
    <EmptyState
      icon={<Bot className="w-10 h-10" />}
      title="No agents created yet"
      description="Agents are AI workers that can autonomously complete tasks. Create your first agent to start delegating work."
      tips={[
        "Give agents specific personas (e.g., 'researcher', 'writer')",
        "Each agent can work on tasks independently",
        "Use the Orchestrator for parallel multi-agent workflows",
      ]}
      primaryAction={{
        label: "Create Agent",
        icon: <Plus className="w-4 h-4" />,
        onClick: onCreateAgent,
      }}
    />
  );
}

export function EmptyMissions({ onCreateMission }: { onCreateMission: () => void }) {
  return (
    <EmptyState
      icon={<Rocket className="w-10 h-10" />}
      title="No missions yet"
      description="Missions help you organize related tasks into projects. Create a mission to group tasks together."
      tips={[
        "Use missions for multi-step projects",
        "Track progress across related tasks",
        "Archive completed missions to keep things tidy",
      ]}
      primaryAction={{
        label: "Create Mission",
        icon: <Plus className="w-4 h-4" />,
        onClick: onCreateMission,
      }}
    />
  );
}

export function EmptyOrchestrator({
  onAddTask,
  onShowTemplates,
}: {
  onAddTask: () => void;
  onShowTemplates: () => void;
}) {
  return (
    <EmptyState
      icon={<Zap className="w-10 h-10" />}
      title="Ready to orchestrate"
      description="Create multiple tasks, assign each to a different agent, and launch them all in parallel. Monitor progress in real-time."
      tips={[
        "Use templates for common workflows",
        "Assign different agents to different tasks",
        "Tasks run in parallel for faster completion",
      ]}
      primaryAction={{
        label: "Add Task",
        icon: <Plus className="w-4 h-4" />,
        onClick: onAddTask,
      }}
      secondaryAction={{
        label: "Browse Templates",
        onClick: onShowTemplates,
      }}
    />
  );
}

export function EmptyActivity() {
  return (
    <EmptyState
      icon={<Clock className="w-10 h-10" />}
      title="No recent activity"
      description="Activity will appear here as you create tasks, dispatch to agents, and make progress on your work."
      variant="minimal"
    />
  );
}

export function EmptyChat({ onStartChat }: { onStartChat?: () => void }) {
  return (
    <EmptyState
      icon={<MessageSquare className="w-10 h-10" />}
      title="Start a conversation"
      description="Chat with your AI assistant to brainstorm, get help, or delegate tasks. Your conversation history is saved."
      tips={[
        "Ask questions about your tasks",
        "Request help with research or writing",
        "Use chat to quickly create and assign tasks",
      ]}
      primaryAction={
        onStartChat
          ? {
            label: "Start Chatting",
            icon: <Send className="w-4 h-4" />,
            onClick: onStartChat,
          }
          : undefined
      }
    />
  );
}

export function EmptyLearning() {
  return (
    <EmptyState
      icon={<BookOpen className="w-10 h-10" />}
      title="Welcome to the Learning Hub"
      description="Explore tutorials, best practices, and tips to get the most out of OpenClaw Mission Control and your AI agents."
      tips={[
        "Start with the Getting Started guide",
        "Learn about effective task delegation",
        "Discover advanced orchestration patterns",
      ]}
    />
  );
}

// --- Feature Highlight Empty State ---

export function FeatureHighlight({
  icon,
  title,
  description,
  features,
  primaryAction,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  features: Array<{ icon: ReactNode; label: string }>;
  primaryAction?: {
    label: string;
    onClick: () => void;
  };
}) {
  return (
    <div className="bg-gradient-to-br from-primary/5 via-transparent to-transparent rounded-2xl p-8 border border-primary/10">
      <div className="flex items-start gap-6">
        <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center shrink-0 text-primary">
          {icon}
        </div>
        <div className="flex-1">
          <h3 className="text-xl font-semibold mb-2">{title}</h3>
          <p className="text-muted-foreground mb-6">{description}</p>

          <div className="grid grid-cols-2 gap-3 mb-6">
            {features.map((feature, index) => (
              <div
                key={index}
                className="flex items-center gap-2 text-sm text-muted-foreground"
              >
                <span className="text-primary">{feature.icon}</span>
                {feature.label}
              </div>
            ))}
          </div>

          {primaryAction && (
            <Button onClick={primaryAction.onClick} className="gap-2">
              <Sparkles className="w-4 h-4" />
              {primaryAction.label}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export default EmptyState;
