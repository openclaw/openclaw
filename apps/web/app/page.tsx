"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useEffect, useRef, useState } from "react";
import { ChatMessage } from "./components/chat-message";
import { Sidebar } from "./components/sidebar";

const transport = new DefaultChatTransport({ api: "/api/chat" });

export default function Home() {
  const { messages, sendMessage, status, stop, error } = useChat({ transport });
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const isStreaming = status === "streaming" || status === "submitted";

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isStreaming) return;
    sendMessage({ text: input });
    setInput("");
  };

  return (
    <div className="flex h-screen">
      <Sidebar />

      {/* Main chat area */}
      <main className="flex-1 flex flex-col min-w-0">
        {/* Chat header */}
        <header className="px-6 py-3 border-b border-[var(--color-border)] flex items-center justify-between bg-[var(--color-surface)]">
          <div>
            <h2 className="text-sm font-semibold">Agent Chat</h2>
            <p className="text-xs text-[var(--color-text-muted)]">
              {status === "ready"
                ? "Ready"
                : status === "submitted"
                  ? "Thinking..."
                  : status === "streaming"
                    ? "Streaming..."
                    : status === "error"
                      ? "Error"
                      : status}
            </p>
          </div>
          {isStreaming && (
            <button
              onClick={() => stop()}
              className="px-3 py-1 text-xs rounded-md bg-[var(--color-border)] hover:bg-[var(--color-text-muted)] text-[var(--color-text)] transition-colors"
            >
              Stop
            </button>
          )}
        </header>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-6">
          {messages.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-center">
                <p className="text-6xl mb-4">🦞</p>
                <h3 className="text-lg font-semibold mb-1">OpenClaw Chat</h3>
                <p className="text-sm text-[var(--color-text-muted)]">
                  Send a message to start a conversation with your agent.
                </p>
              </div>
            </div>
          ) : (
            <div className="max-w-3xl mx-auto py-4">
              {messages.map((message) => (
                <ChatMessage key={message.id} message={message} />
              ))}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {/* Error display */}
        {error && (
          <div className="px-6 py-2 bg-red-900/20 border-t border-red-800/30">
            <p className="text-sm text-red-400">Error: {error.message}</p>
          </div>
        )}

        {/* Input */}
        <div className="px-6 py-4 border-t border-[var(--color-border)] bg-[var(--color-surface)]">
          <form onSubmit={handleSubmit} className="max-w-3xl mx-auto flex gap-3">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Message OpenClaw..."
              disabled={isStreaming}
              className="flex-1 px-4 py-3 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-xl text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:border-transparent disabled:opacity-50 text-sm"
            />
            <button
              type="submit"
              disabled={!input.trim() || isStreaming}
              className="px-5 py-3 bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white rounded-xl font-medium text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {isStreaming ? (
                <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                "Send"
              )}
            </button>
          </form>
        </div>
      </main>
    </div>
  );
}
