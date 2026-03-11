import { useRouterState } from "@tanstack/react-router";
import {
  SendHorizontal,
  History,
  Sparkles,
  X,
  Minus,
  Brain,
  Search,
  ScanSearch,
  Database,
  Workflow,
} from "lucide-react";
import { useState, useRef, useEffect, useMemo } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useChatState } from "@/contexts/ChatContext";
import { useChat } from "@/hooks/useChat";
import type { AgentActivity } from "@/hooks/useChat";
import { useChatActionDispatcher } from "@/lib/chat-actions";
import { getPageContext } from "@/lib/page-context";
import { AgentSelector } from "./AgentSelector";
import { ChatMessage } from "./ChatMessage";
import { CollapsedChatButton } from "./CollapsedChatButton";

const pageSuggestions: Record<string, string[]> = {
  "/": ["Show system overview", "Any urgent decisions?"],
  "/decisions": [
    "Summarize pending decisions",
    "Show critical decisions only",
    "Approve recommended decisions",
  ],
  "/goals": ["Show at-risk goals", "Update goal progress", "Create strategic goal"],
  "/projects": ["Show blocked tasks", "Reassign overdue tasks", "Create new task"],
  "/agents": ["Agent health check", "Trigger BDI cycle for all", "Show idle agents"],
  "/workflows": ["Show stalled workflows", "Restart paused workflow"],
  "/knowledge-graph": ["Show key dependencies", "Find disconnected nodes"],
  "/timeline": ["Overdue milestones", "Next week's deadlines"],
  "/performance": ["Refresh KPIs", "Compare month-over-month"],
  "/inventory": ["Low stock alerts", "Reorder suggestions"],
  "/accounting": ["Revenue summary", "Overdue invoices"],
  "/hr": ["Team workload balance", "Open positions status"],
};

function getSuggestions(pathname: string): string[] {
  const basepath = "/mabos/dashboard";
  const relative = pathname.startsWith(basepath)
    ? pathname.slice(basepath.length) || "/"
    : pathname;
  return pageSuggestions[relative] || pageSuggestions["/"] || [];
}

function AgentActivityIndicator({ activity }: { activity: AgentActivity }) {
  const config = {
    thinking: { icon: Brain, label: "Thinking" },
    analyzing: { icon: ScanSearch, label: "Analyzing" },
    searching: { icon: Search, label: "Searching" },
    retrieving: { icon: Database, label: "Retrieving" },
    reasoning: { icon: Workflow, label: "Reasoning" },
  };
  const { icon: Icon, label } = config[activity.status as keyof typeof config] ?? config.thinking;
  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <Icon className="w-4 h-4 text-[var(--accent-purple)] animate-pulse" />
      <span className="text-xs text-[var(--text-muted)] animate-pulse">
        {activity.label || label}...
      </span>
    </div>
  );
}

export function FloatingChat() {
  const { isMinimized, minimizeChat, setLastActiveAgent } = useChatState();
  const { dispatchAction } = useChatActionDispatcher();
  const routerState = useRouterState();
  const pageCtx = getPageContext(routerState.location.pathname);

  const { messages, status, activeAgent, setActiveAgent, sendMessage, agentActivity } = useChat(
    "default",
    {
      onAction: dispatchAction,
    },
  );

  const [input, setInput] = useState("");
  const [showResponsePanel, setShowResponsePanel] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const responseScrollRef = useRef<HTMLDivElement>(null);
  const suggestions = getSuggestions(routerState.location.pathname);

  // Derive latest agent message
  const latestAgentMessage = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "agent") return messages[i];
    }
    return null;
  }, [messages]);

  // Auto-open panel when agent activity starts
  useEffect(() => {
    if (agentActivity.status !== null) {
      setShowResponsePanel(true);
    }
  }, [agentActivity.status]);

  // Auto-scroll response area when content changes
  useEffect(() => {
    if (responseScrollRef.current) {
      responseScrollRef.current.scrollTop = responseScrollRef.current.scrollHeight;
    }
  }, [latestAgentMessage?.content, agentActivity.status]);

  // Sync activeAgent to ChatContext for collapsed button
  useEffect(() => {
    setLastActiveAgent(activeAgent);
  }, [activeAgent, setLastActiveAgent]);

  const statusColor = {
    connected: "bg-[var(--accent-green)]",
    connecting: "bg-[var(--accent-orange)]",
    disconnected: "bg-[var(--accent-red)]",
  }[status];

  // Determine if the unified panel should be visible
  const showPanel =
    agentActivity.status !== null || latestAgentMessage?.streaming || showResponsePanel;

  function handleSend(text?: string) {
    const msg = text || input;
    if (!msg.trim()) return;
    sendMessage(msg, { page: pageCtx.pageId, capabilities: pageCtx.capabilities });
    setInput("");
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleSuggestionClick(suggestion: string) {
    handleSend(suggestion);
  }

  if (isMinimized) {
    return <CollapsedChatButton />;
  }

  return (
    <div className="fixed bottom-[40px] left-1/2 -translate-x-1/2 z-[30] w-[calc(100vw-48px)] md:max-w-[800px] max-[480px]:max-w-[calc(100%-24px)] max-[480px]:bottom-[20px]">
      {/* Unified Response + Suggestions Panel */}
      {showPanel && (
        <div
          className="mb-2 rounded-xl bg-[var(--bg-secondary)] border border-[var(--border-mabos)] backdrop-blur-sm overflow-hidden"
          style={{ boxShadow: "0 0 40px rgba(0, 0, 0, 0.15)" }}
        >
          {/* Agent Response Section */}
          {(agentActivity.status || latestAgentMessage) && (
            <div className="px-3 pt-3">
              <ScrollArea className="max-h-[40vh]">
                <div ref={responseScrollRef}>
                  {/* Show latest agent response */}
                  {latestAgentMessage && <ChatMessage message={latestAgentMessage} />}
                  {/* Show activity indicator when processing */}
                  {agentActivity.status && <AgentActivityIndicator activity={agentActivity} />}
                </div>
              </ScrollArea>
            </div>
          )}

          {/* Spacer between sections */}
          {(agentActivity.status || latestAgentMessage) && suggestions.length > 0 && (
            <div className="h-[30px]" />
          )}

          {/* Suggestions Section (pinned bottom) */}
          {suggestions.length > 0 && (
            <div className="p-2 border-t border-[var(--border-mabos)]">
              <div className="flex items-center justify-between px-2 mb-1">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                  Suggestions
                </span>
                <button
                  onClick={() => setShowResponsePanel(false)}
                  className="p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {suggestions.map((s) => (
                  <button
                    key={s}
                    onClick={() => handleSuggestionClick(s)}
                    className="px-3 py-1.5 text-xs rounded-full bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Floating chat box */}
      <div
        className="relative flex flex-col rounded-[5px] bg-[var(--bg-secondary)] border border-[var(--border-mabos)] h-[175px] max-md:h-[120px] focus-within:border-[var(--accent-purple)] focus-within:ring-2 focus-within:ring-[var(--accent-purple)]/30 transition-shadow"
        style={{ boxShadow: "0 -4px 24px rgba(0,0,0,0.08)" }}
      >
        {/* Top toolbar row */}
        <div className="flex items-center gap-1 px-3 py-1.5 border-b border-[var(--border-mabos)] shrink-0">
          {/* History popover */}
          <Popover>
            <PopoverTrigger asChild>
              <button
                className="p-1.5 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors shrink-0"
                aria-label="Chat history"
              >
                <History className="w-4 h-4" />
              </button>
            </PopoverTrigger>
            <PopoverContent
              side="top"
              align="start"
              className="w-80 p-0 bg-[var(--bg-secondary)] border-[var(--border-mabos)]"
            >
              <div className="p-3 border-b border-[var(--border-mabos)]">
                <p className="text-sm font-medium text-[var(--text-primary)]">Chat History</p>
                <div className="flex items-center gap-1.5 mt-1">
                  <div className={`w-1.5 h-1.5 rounded-full ${statusColor}`} />
                  <span className="text-[10px] text-[var(--text-muted)] capitalize">{status}</span>
                </div>
              </div>
              <ScrollArea className="max-h-[60vh]">
                <div className="p-3">
                  {messages.length === 0 ? (
                    <p className="text-xs text-[var(--text-muted)] text-center py-6">
                      No messages yet
                    </p>
                  ) : (
                    messages.map((msg) => <ChatMessage key={msg.id} message={msg} />)
                  )}
                </div>
              </ScrollArea>
            </PopoverContent>
          </Popover>

          {/* Agent selector (compact) */}
          <AgentSelector activeAgent={activeAgent} onSelect={setActiveAgent} />

          {/* Suggestions toggle */}
          <button
            onClick={() => setShowResponsePanel((s) => !s)}
            className="p-1.5 rounded text-[var(--text-muted)] hover:text-[var(--accent-purple)] hover:bg-[var(--bg-hover)] transition-colors shrink-0"
            aria-label="Show suggestions"
          >
            <Sparkles className="w-4 h-4" />
          </button>

          {/* Minimize button */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              minimizeChat();
            }}
            className="relative z-10 p-1.5 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors shrink-0 ml-auto"
            aria-label="Minimize chat"
          >
            <Minus className="w-4 h-4" />
          </button>
        </div>

        {/* Textarea */}
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onFocus={() => setShowResponsePanel(true)}
          onKeyDown={handleKeyDown}
          placeholder="Message your agents..."
          className="flex-1 min-h-0 w-full resize-none px-3 py-2 pr-14 text-sm bg-transparent text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
        />

        {/* Send button */}
        <button
          onClick={() => handleSend()}
          disabled={!input.trim()}
          className="absolute bottom-3 right-3 flex items-center justify-center w-10 h-10 rounded-[5px] bg-[var(--accent-purple)] text-white hover:opacity-90 transition-opacity disabled:opacity-50 shrink-0"
          aria-label="Send message"
        >
          <SendHorizontal className="w-5 h-5" />
        </button>
      </div>
    </div>
  );
}
