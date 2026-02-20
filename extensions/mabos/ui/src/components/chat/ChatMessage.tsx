import { getAgentIcon, getAgentName } from "@/lib/agent-icons";
import type { ChatMessage as ChatMessageType } from "@/lib/types";

export function ChatMessage({ message }: { message: ChatMessageType }) {
  const isUser = message.role === "user";
  const Icon = message.agentId ? getAgentIcon(message.agentId) : null;
  const name = message.agentId ? getAgentName(message.agentId) : "You";

  return (
    <div className={`flex gap-3 mb-4 ${isUser ? "flex-row-reverse" : ""}`}>
      {/* Avatar */}
      <div
        className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
          isUser
            ? "bg-[var(--accent-blue)]"
            : "bg-[var(--bg-tertiary)] border border-[var(--border-mabos)]"
        }`}
      >
        {isUser ? (
          <span className="text-xs font-bold text-white">U</span>
        ) : Icon ? (
          <Icon className="w-4 h-4 text-[var(--accent-green)]" />
        ) : (
          <span className="text-xs">?</span>
        )}
      </div>

      {/* Content */}
      <div className={`flex-1 max-w-[85%] ${isUser ? "text-right" : ""}`}>
        <div className="flex items-center gap-2 mb-1">
          <span className={`text-xs font-medium ${isUser ? "ml-auto" : ""}`}>
            {isUser ? "You" : name}
          </span>
          <span className="text-xs text-[var(--text-muted)]">
            {message.timestamp.toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        </div>
        <div
          className={`inline-block px-3 py-2 rounded-lg text-sm leading-relaxed ${
            isUser
              ? "bg-[var(--accent-blue)] text-white"
              : "bg-[var(--bg-tertiary)] text-[var(--text-primary)]"
          } ${message.streaming ? "animate-pulse" : ""}`}
        >
          {message.content}
          {message.streaming && (
            <span className="inline-block w-1.5 h-4 ml-0.5 bg-current animate-pulse" />
          )}
        </div>
      </div>
    </div>
  );
}
