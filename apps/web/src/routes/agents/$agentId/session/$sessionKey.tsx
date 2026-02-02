import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { CardSkeleton } from "@/components/composed";
import {
  SessionHeader,
  SessionChat,
  SessionActivityFeed,
  SessionWorkspacePane,
  type Activity,
} from "@/components/domain/session";
import { useAgent } from "@/hooks/queries/useAgents";
import { useAgentSessions, useChatHistory } from "@/hooks/queries/useSessions";
import { useChatBackend } from "@/hooks/useChatBackend";
import { usePreferencesStore } from "@/stores/usePreferencesStore";
import { useVercelSessionStore } from "@/stores/useVercelSessionStore";
import { buildAgentSessionKey } from "@/lib/api/sessions";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";

export const Route = createFileRoute("/agents/$agentId/session/$sessionKey")({
  component: AgentSessionPage,
  validateSearch: (search: Record<string, unknown>): { newSession?: boolean; initialMessage?: string } => {
    const newSession = search.newSession === true || search.newSession === "true";
    const initialMessage = typeof search.initialMessage === "string" ? search.initialMessage : undefined;
    return { newSession: newSession || undefined, initialMessage };
  },
});

// Mock activities for development
const mockActivities: Activity[] = [
  {
    id: "live-1",
    type: "task_live",
    title: "Processing request",
    description: "Analyzing user query...",
    progress: 65,
    timestamp: new Date(Date.now() - 30000).toISOString(),
  },
  {
    id: "1",
    type: "message",
    title: "Response generated",
    description: "Completed AI response",
    timestamp: new Date(Date.now() - 120000).toISOString(),
  },
  {
    id: "2",
    type: "search",
    title: "Web search",
    description: "Searched for relevant information",
    timestamp: new Date(Date.now() - 180000).toISOString(),
  },
  {
    id: "3",
    type: "code",
    title: "Code execution",
    description: "Ran analysis script",
    timestamp: new Date(Date.now() - 300000).toISOString(),
  },
  {
    id: "4",
    type: "task_complete",
    title: "Task completed",
    description: "Finished data processing",
    timestamp: new Date(Date.now() - 600000).toISOString(),
  },
];

function AgentSessionPage() {
  const { agentId, sessionKey: sessionKeyParam } = Route.useParams();
  const navigate = Route.useNavigate();

  // State
  const [workspacePaneMaximized, setWorkspacePaneMaximized] = React.useState(false);
  const [activities] = React.useState<Activity[]>(mockActivities);

  // Preferences (for backend selection)
  const chatBackend = usePreferencesStore((state) => state.chatBackend);
  const vercelStore = useVercelSessionStore();

  // Queries
  const { data: agent, isLoading: agentLoading, error: agentError } = useAgent(agentId);
  const { data: sessions, defaults } = useAgentSessions(agentId);

  // Determine active session key
  const sessionKey = React.useMemo(() => {
    // If sessionKey param is "current" or empty, use the first session or build default
    if (sessionKeyParam === "current" || !sessionKeyParam) {
      if (sessions && sessions.length > 0) {
        return sessions[0].key;
      }
      return buildAgentSessionKey(agentId, defaults?.mainKey ?? "main");
    }
    return sessionKeyParam;
  }, [sessionKeyParam, sessions, agentId, defaults?.mainKey]);

  // Load chat history for the active session (gateway only)
  const { data: chatHistory, isLoading: chatLoading } = useChatHistory(sessionKey);

  // Use unified chat backend hook
  const { streamingMessage, handleSend, handleStop, isStreaming } = useChatBackend(sessionKey, agent);

  // Get messages based on active backend
  const messages = React.useMemo(() => {
    if (chatBackend === "vercel-ai") {
      // Use Vercel AI local history
      return vercelStore.getHistory(sessionKey);
    }
    // Use gateway history from server
    return chatHistory?.messages ?? [];
  }, [chatBackend, sessionKey, chatHistory?.messages, vercelStore]);

  // Handle session change (switching to an existing session)
  const handleSessionChange = React.useCallback(
    (newSessionKey: string) => {
      navigate({
        to: "/agents/$agentId/session/$sessionKey",
        params: { agentId, sessionKey: newSessionKey },
        search: { newSession: false },
      });
    },
    [navigate, agentId]
  );

  // Handle new session (creating a fresh session)
  const handleNewSession = React.useCallback(() => {
    const newKey = buildAgentSessionKey(agentId, `session-${Date.now()}`);
    navigate({
      to: "/agents/$agentId/session/$sessionKey",
      params: { agentId, sessionKey: newKey },
      search: { newSession: true },
    });
  }, [navigate, agentId]);

  // Loading state
  if (agentLoading) {
    return (
      <div className="min-h-full bg-background text-foreground p-6">
        <CardSkeleton />
      </div>
    );
  }

  // Error state
  if (agentError || !agent) {
    return (
      <div className="min-h-screen bg-background text-foreground p-6">
        <Card className="border-destructive/50 bg-destructive/10 max-w-2xl mx-auto">
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
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground overflow-hidden">
      {/* Session Header - Always visible, shrink-0 prevents it from shrinking */}
      <SessionHeader
        agent={agent}
        sessions={sessions ?? []}
        selectedSessionKey={sessionKey}
        onSessionChange={handleSessionChange}
        onNewSession={handleNewSession}
      />

      {/* Main content area - flex-1 with min-h-0 allows proper height distribution */}
      <div className="flex-1 flex min-h-0">
        {/* Chat section (center ~60%) - min-h-0 is critical for flex children */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.2 }}
          className={cn(
            "flex-1 min-w-0 min-h-0 flex flex-col",
            workspacePaneMaximized && "hidden"
          )}
        >
          <SessionChat
            messages={messages}
            streamingMessage={streamingMessage}
            agentName={agent.name}
            agentStatus={agent.status === "online" ? "active" : "ready"}
            isLoading={chatBackend === "gateway" ? chatLoading : false}
            onSend={handleSend}
            onStop={handleStop}
            disabled={isStreaming}
          />
        </motion.div>

        {/* Right sidebar (activity + workspace) */}
        <motion.div
          initial={{ opacity: 0, x: 10 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.2, delay: 0.1 }}
          className={cn(
            "w-[380px] border-l border-border/50 flex flex-col bg-card/30 p-3 gap-3",
            workspacePaneMaximized && "flex-1 w-full"
          )}
        >
          {/* Activity Feed (top of right sidebar) - hidden when maximized */}
          {!workspacePaneMaximized && (
            <div className="h-[280px] border border-border/50 rounded-xl overflow-hidden shrink-0 bg-card/40">
              <div className="px-4 py-3 border-b border-border/50">
                <h3 className="text-sm font-medium">Activity</h3>
              </div>
              <SessionActivityFeed activities={activities} maxItems={8} />
            </div>
          )}

          {/* Workspace Pane (bottom of right sidebar or full when maximized) */}
          <div className={cn("flex-1 min-h-0", workspacePaneMaximized && "p-4")}>
            <SessionWorkspacePane
              isMaximized={workspacePaneMaximized}
              onToggleMaximize={() => setWorkspacePaneMaximized((v) => !v)}
              sessionKey={sessionKey}
              workspaceDir={`~/.clawdbrain/agents/${agentId}/workspace`}
              className="h-full"
            />
          </div>
        </motion.div>
      </div>
    </div>
  );
}

export default AgentSessionPage;
