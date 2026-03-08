"use client";

import { useState, useEffect, useRef } from "react";
import { motion } from "framer-motion";
import { GlassCard } from "@/components/ui/glass-card";
import { EmptyState } from "@/components/ui/empty-state";
import { VoiceInput } from "@/components/voice-input";
import { formatRelativeTime, cn } from "@/lib/utils";
import { staggerItem } from "@/lib/motion";
import { MessageSquare, Send, Bot, User, Hash } from "lucide-react";

interface Session {
  sessionKey: string;
  agentId: string;
  agentName: string;
  sessionId: string;
  updatedAt: number;
}

interface Message {
  id: string;
  role: string;
  content: string;
  timestamp: string;
  channel?: string;
  model?: string;
}

export function ChatCenterView() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [selectedSession, setSelectedSession] = useState<Session | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Fetch sessions
  useEffect(() => {
    fetch("/api/chat-history")
      .then((r) => r.json())
      .then((json) => {
        setSessions(json.data || []);
        setLoadingSessions(false);
      })
      .catch(() => setLoadingSessions(false));
  }, []);

  // Fetch messages when session selected
  useEffect(() => {
    if (!selectedSession) return;
    setLoadingMessages(true);
    fetch(`/api/chat-history?agent=${selectedSession.agentId}&session=${selectedSession.sessionId}&limit=100`)
      .then((r) => r.json())
      .then((json) => {
        setMessages(json.data || []);
        setLoadingMessages(false);
        setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
      })
      .catch(() => setLoadingMessages(false));
  }, [selectedSession]);

  async function sendMessage() {
    if (!input.trim() || sending) return;
    setSending(true);
    try {
      await fetch("/api/chat-send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: input.trim(),
          agentId: selectedSession?.agentId || "jaum",
        }),
      });
      setInput("");
    } catch {
      // handle error
    }
    setSending(false);
  }

  function handleVoiceResult(text: string) {
    setInput((prev) => (prev ? prev + " " + text : text));
  }

  function getDateSeparator(timestamp: string, prevTimestamp?: string): string | null {
    const date = new Date(timestamp).toDateString();
    if (!prevTimestamp) return date;
    const prevDate = new Date(prevTimestamp).toDateString();
    return date !== prevDate ? date : null;
  }

  return (
    <div className="flex gap-4 h-[calc(100vh-140px)]">
      {/* Session sidebar */}
      <GlassCard padding="none" className="w-64 shrink-0 hidden md:flex flex-col">
        <div className="p-3 border-b border-white/[0.06]">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Sessions
          </h3>
        </div>
        <div className="flex-1 overflow-y-auto">
          {loadingSessions ? (
            <div className="p-3 space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="h-10 bg-white/[0.04] rounded-lg animate-pulse" />
              ))}
            </div>
          ) : sessions.length === 0 ? (
            <p className="p-3 text-[11px] text-muted-foreground">No sessions found.</p>
          ) : (
            sessions.map((session) => (
              <button
                key={session.sessionKey}
                onClick={() => setSelectedSession(session)}
                className={cn(
                  "w-full text-left px-3 py-2.5 border-b border-white/[0.03] hover:bg-white/[0.04] transition-colors",
                  selectedSession?.sessionId === session.sessionId && "bg-primary/[0.06]"
                )}
              >
                <div className="flex items-center gap-2">
                  <Bot className="w-3.5 h-3.5 text-primary shrink-0" />
                  <div className="min-w-0">
                    <p className="text-[11px] font-medium truncate">{session.agentName}</p>
                    <p className="text-[9px] text-muted-foreground">
                      {formatRelativeTime(session.updatedAt)}
                    </p>
                  </div>
                </div>
              </button>
            ))
          )}
        </div>
      </GlassCard>

      {/* Chat area */}
      <div className="flex-1 flex flex-col min-w-0">
        {!selectedSession ? (
          <GlassCard className="flex-1 flex items-center justify-center">
            <EmptyState
              icon={MessageSquare}
              title="Select a session"
              description="Choose a session from the sidebar to view the conversation."
            />
          </GlassCard>
        ) : (
          <>
            {/* Chat header */}
            <div className="glass-card rounded-b-none px-4 py-2.5 flex items-center gap-2">
              <Bot className="w-4 h-4 text-primary" />
              <span className="text-sm font-medium">{selectedSession.agentName}</span>
              <span className="text-[10px] text-muted-foreground font-mono">
                {selectedSession.sessionKey}
              </span>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto bg-white/[0.01] border-x border-white/[0.06] px-4 py-3 space-y-1">
              {loadingMessages ? (
                <div className="flex items-center justify-center h-full">
                  <span className="text-xs text-muted-foreground">Loading messages...</span>
                </div>
              ) : messages.length === 0 ? (
                <div className="flex items-center justify-center h-full">
                  <span className="text-xs text-muted-foreground">No messages in this session.</span>
                </div>
              ) : (
                messages
                  .filter((m) => m.role === "user" || m.role === "assistant")
                  .map((msg, i, arr) => {
                    const dateSep = getDateSeparator(msg.timestamp, arr[i - 1]?.timestamp);
                    return (
                      <div key={msg.id}>
                        {dateSep && (
                          <div className="flex items-center gap-2 my-3">
                            <div className="flex-1 h-px bg-white/[0.06]" />
                            <span className="text-[9px] text-muted-foreground font-mono">{dateSep}</span>
                            <div className="flex-1 h-px bg-white/[0.06]" />
                          </div>
                        )}
                        <motion.div
                          variants={staggerItem}
                          initial="initial"
                          animate="animate"
                          className={cn(
                            "flex gap-2 mb-2",
                            msg.role === "user" ? "justify-end" : "justify-start"
                          )}
                        >
                          {msg.role === "assistant" && (
                            <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-1">
                              <Bot className="w-3 h-3 text-primary" />
                            </div>
                          )}
                          <div
                            className={cn(
                              "max-w-[75%] rounded-2xl px-3 py-2 text-[12px] leading-relaxed",
                              msg.role === "user"
                                ? "bg-primary/20 text-foreground rounded-br-md"
                                : "bg-white/[0.04] text-foreground/90 rounded-bl-md"
                            )}
                          >
                            <p className="whitespace-pre-wrap break-words">{msg.content}</p>
                            <p className="text-[8px] text-muted-foreground mt-1">
                              {new Date(msg.timestamp).toLocaleTimeString()}
                            </p>
                          </div>
                          {msg.role === "user" && (
                            <div className="w-6 h-6 rounded-full bg-white/[0.06] flex items-center justify-center shrink-0 mt-1">
                              <User className="w-3 h-3 text-muted-foreground" />
                            </div>
                          )}
                        </motion.div>
                      </div>
                    );
                  })
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Input bar */}
            <div className="glass-card rounded-t-none px-3 py-2.5 flex items-center gap-2">
              <VoiceInput onResult={handleVoiceResult} />
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && sendMessage()}
                placeholder="Send a message..."
                className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
              />
              <button
                onClick={sendMessage}
                disabled={!input.trim() || sending}
                className={cn(
                  "p-2 rounded-lg transition-colors",
                  input.trim()
                    ? "bg-primary text-primary-foreground hover:bg-primary/80"
                    : "text-muted-foreground"
                )}
              >
                <Send className="w-3.5 h-3.5" />
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
