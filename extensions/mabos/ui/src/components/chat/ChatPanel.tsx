import { useState, useRef, useEffect } from "react";
import { Send } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useChat } from "@/hooks/useChat";
import { ChatMessage } from "./ChatMessage";
import { AgentSelector } from "./AgentSelector";
import { getAgentName } from "@/lib/agent-icons";

export function ChatPanel() {
  const { messages, status, activeAgent, setActiveAgent, sendMessage } =
    useChat();
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function handleSend() {
    if (!input.trim()) return;
    sendMessage(input);
    setInput("");
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  const statusColor = {
    connected: "bg-[var(--accent-green)]",
    connecting: "bg-[var(--accent-orange)]",
    disconnected: "bg-[var(--accent-red)]",
  }[status];

  return (
    <aside className="w-[400px] h-screen fixed right-0 top-0 bg-[var(--bg-secondary)] border-l border-[var(--border-mabos)] flex flex-col z-50">
      {/* Header */}
      <div className="px-4 py-3 border-b border-[var(--border-mabos)] flex items-center gap-3">
        <AgentSelector activeAgent={activeAgent} onSelect={setActiveAgent} />
        <div className="ml-auto flex items-center gap-1.5">
          <div className={`w-2 h-2 rounded-full ${statusColor}`} />
          <span className="text-xs text-[var(--text-muted)] capitalize">
            {status}
          </span>
        </div>
      </div>

      {/* Messages */}
      <ScrollArea className="flex-1">
        <div className="p-4">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-center">
              <p className="text-sm text-[var(--text-secondary)] mb-1">
                Chat with {getAgentName(activeAgent)}
              </p>
              <p className="text-xs text-[var(--text-muted)]">
                Ask questions, give instructions, or review decisions
              </p>
            </div>
          ) : (
            messages.map((msg) => <ChatMessage key={msg.id} message={msg} />)
          )}
          <div ref={messagesEndRef} />
        </div>
      </ScrollArea>

      {/* Input */}
      <div className="p-3 border-t border-[var(--border-mabos)]">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={`Message ${getAgentName(activeAgent)}...`}
            className="flex-1 px-3 py-2 rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-mabos)] text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-green)] transition-colors"
          />
          <button
            onClick={handleSend}
            disabled={!input.trim()}
            className="p-2 rounded-lg bg-[var(--accent-green)] text-[var(--bg-primary)] hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
      </div>
    </aside>
  );
}
