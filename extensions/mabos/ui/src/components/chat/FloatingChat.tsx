import { useRouterState } from "@tanstack/react-router";
import { Send, History, Sparkles, X } from "lucide-react";
import { useState, useRef } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useChat } from "@/hooks/useChat";
import { AgentSelector } from "./AgentSelector";
import { ChatMessage } from "./ChatMessage";

const pageSuggestions: Record<string, string[]> = {
  "/": ["Show system overview", "Any urgent decisions?"],
  "/decisions": ["Summarize pending decisions", "What needs my attention?"],
  "/goals": ["Show goal progress", "Which goals are at risk?"],
  "/projects": ["Show project status", "Which tasks are blocked?"],
  "/agents": ["Agent health check", "Which agents need attention?"],
  "/workflows": ["Show active workflows", "Any stalled workflows?"],
  "/knowledge-graph": ["Explain relationships", "Show key dependencies"],
  "/timeline": ["Upcoming milestones", "What is overdue?"],
  "/performance": ["Show KPIs", "Performance summary"],
  "/inventory": ["Stock status", "Low inventory alerts"],
  "/accounting": ["Revenue summary", "Pending invoices"],
  "/hr": ["Team workload", "Hiring status"],
};

function getSuggestions(pathname: string): string[] {
  const basepath = "/mabos/dashboard";
  const relative = pathname.startsWith(basepath)
    ? pathname.slice(basepath.length) || "/"
    : pathname;
  return pageSuggestions[relative] || pageSuggestions["/"] || [];
}

export function FloatingChat() {
  const { messages, status, activeAgent, setActiveAgent, sendMessage } = useChat();
  const [input, setInput] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const routerState = useRouterState();
  const suggestions = getSuggestions(routerState.location.pathname);

  const statusColor = {
    connected: "bg-[var(--accent-green)]",
    connecting: "bg-[var(--accent-orange)]",
    disconnected: "bg-[var(--accent-red)]",
  }[status];

  function handleSend(text?: string) {
    const msg = text || input;
    if (!msg.trim()) return;
    sendMessage(msg);
    setInput("");
    setShowSuggestions(false);
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

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[70] w-[calc(100vw-2rem)] md:w-full md:max-w-[600px]">
      {/* Suggestion popup */}
      {showSuggestions && suggestions.length > 0 && (
        <div
          className="mb-2 p-2 rounded-xl bg-[var(--bg-secondary)] border border-[var(--border-mabos)] backdrop-blur-sm"
          style={{ boxShadow: "0 0 40px rgba(0, 0, 0, 0.15)" }}
        >
          <div className="flex items-center justify-between px-2 mb-1">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              Suggestions
            </span>
            <button
              onClick={() => setShowSuggestions(false)}
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

      {/* Floating chat bar */}
      <div
        className="flex items-center gap-2 px-3 py-2 rounded-full bg-[var(--bg-secondary)] border border-[var(--border-mabos)] backdrop-blur-sm"
        style={{ boxShadow: "0 0 40px rgba(0, 0, 0, 0.15)" }}
      >
        {/* History popover */}
        <Popover>
          <PopoverTrigger asChild>
            <button
              className="p-1.5 rounded-full text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors shrink-0"
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

        {/* Input */}
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onFocus={() => setShowSuggestions(true)}
          onKeyDown={handleKeyDown}
          placeholder="Ask about this page..."
          className="flex-1 min-w-0 px-2 py-1 text-sm bg-transparent text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
        />

        {/* Suggestions toggle */}
        <button
          onClick={() => setShowSuggestions((s) => !s)}
          className="p-1.5 rounded-full text-[var(--text-muted)] hover:text-[var(--accent-purple)] hover:bg-[var(--bg-hover)] transition-colors shrink-0"
          aria-label="Show suggestions"
        >
          <Sparkles className="w-4 h-4" />
        </button>

        {/* Send button */}
        <button
          onClick={() => handleSend()}
          disabled={!input.trim()}
          className="p-2 rounded-full bg-[var(--accent-green)] text-[var(--bg-primary)] hover:opacity-90 transition-opacity disabled:opacity-50 shrink-0"
          aria-label="Send message"
        >
          <Send className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
