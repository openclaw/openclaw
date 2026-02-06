"use client";

import type { UIMessage } from "ai";

export function ChatMessage({ message }: { message: UIMessage }) {
  const isUser = message.role === "user";

  return (
    <div className={`flex gap-3 py-4 ${isUser ? "justify-end" : "justify-start"}`}>
      {!isUser && (
        <div className="flex-shrink-0 w-8 h-8 rounded-full bg-[var(--color-accent)] flex items-center justify-center text-white text-sm font-bold">
          O
        </div>
      )}

      <div
        className={`max-w-[75%] rounded-2xl px-4 py-3 ${
          isUser
            ? "bg-[var(--color-accent)] text-white"
            : "bg-[var(--color-surface)] text-[var(--color-text)]"
        }`}
      >
        {message.parts.map((part, index) => {
          if (part.type === "text") {
            return (
              <div key={index} className="whitespace-pre-wrap text-[15px] leading-relaxed">
                {part.text}
              </div>
            );
          }
          if (part.type.startsWith("tool-")) {
            const toolPart = part as { type: string; toolCallId: string; state?: string; title?: string };
            return (
              <div
                key={index}
                className="text-xs text-[var(--color-text-muted)] mt-2 px-2 py-1 bg-[var(--color-bg)] rounded font-mono"
              >
                Tool: {toolPart.title ?? toolPart.toolCallId}
                {toolPart.state === "result" && (
                  <span className="ml-2 text-green-400">done</span>
                )}
              </div>
            );
          }
          return null;
        })}
      </div>

      {isUser && (
        <div className="flex-shrink-0 w-8 h-8 rounded-full bg-[var(--color-border)] flex items-center justify-center text-[var(--color-text-muted)] text-sm font-bold">
          U
        </div>
      )}
    </div>
  );
}
