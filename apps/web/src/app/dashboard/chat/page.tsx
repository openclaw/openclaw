"use client";

import { useState, useRef, useEffect, FormEvent } from "react";
import Link from "next/link";
import Navbar from "@/components/Navbar";
import { MODELS, DEFAULT_MODEL_ID } from "@/lib/models";

interface Message {
  role: "user" | "assistant";
  content: string;
}

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState(DEFAULT_MODEL_ID);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  async function send(e: FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || loading) return;

    const next: Message[] = [...messages, { role: "user", content: text }];
    setMessages(next);
    setInput("");
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/gateway/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          stream: true,
          messages: next.map((m) => ({ role: m.role, content: m.content })),
        }),
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(err || `HTTP ${res.status}`);
      }

      const contentType = res.headers.get("Content-Type") ?? "";
      const isStream = contentType.includes("text/event-stream");

      if (isStream && res.body) {
        // SSE streaming
        let assistantText = "";
        setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });

          const lines = buf.split("\n");
          buf = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6).trim();
            if (data === "[DONE]") continue;
            try {
              const chunk = JSON.parse(data);
              const delta = chunk.choices?.[0]?.delta?.content ?? "";
              assistantText += delta;
              setMessages((prev) => [
                ...prev.slice(0, -1),
                { role: "assistant", content: assistantText },
              ]);
            } catch { /* ignore malformed chunks */ }
          }
        }
      } else {
        // Non-streaming JSON
        const data = await res.json();
        const content = data.choices?.[0]?.message?.content ?? JSON.stringify(data);
        setMessages((prev) => [...prev, { role: "assistant", content }]);
      }
    } catch (err) {
      setError(String(err));
      // Remove the empty assistant placeholder if streaming failed mid-way
      setMessages((prev) =>
        prev[prev.length - 1]?.content === "" ? prev.slice(0, -1) : prev
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Navbar />
      <main style={{ padding: "1.5rem", display: "flex", flexDirection: "column", height: "calc(100vh - 64px)" }}>
        <div className="container" style={{ maxWidth: 760, flex: 1, display: "flex", flexDirection: "column" }}>
          {/* Header */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1rem" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
              <Link href="/dashboard/gateway" style={{ color: "#666", fontSize: "0.85rem" }}>← Gateway</Link>
              <h1 style={{ fontSize: "1.25rem", fontWeight: 700 }}>Chat</h1>
            </div>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              style={{
                background: "#111", border: "1px solid #2a2a2a", borderRadius: 8,
                color: "#ccc", padding: "0.35rem 0.6rem", fontSize: "0.8rem", cursor: "pointer",
              }}
            >
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </div>

          {/* Message list */}
          <div style={{
            flex: 1, overflowY: "auto", display: "flex", flexDirection: "column",
            gap: "1rem", paddingBottom: "1rem",
          }}>
            {messages.length === 0 && (
              <div style={{ textAlign: "center", color: "#444", marginTop: "4rem" }}>
                <div style={{ fontSize: "2.5rem", marginBottom: "0.75rem" }}>💬</div>
                <p>Send a message to start chatting with your OpenClaw agent.</p>
              </div>
            )}
            {messages.map((m, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  justifyContent: m.role === "user" ? "flex-end" : "flex-start",
                }}
              >
                <div style={{
                  maxWidth: "75%",
                  background: m.role === "user" ? "#e05a2b" : "#111",
                  border: m.role === "user" ? "none" : "1px solid #222",
                  borderRadius: m.role === "user" ? "18px 18px 4px 18px" : "18px 18px 18px 4px",
                  padding: "0.75rem 1rem",
                  fontSize: "0.9rem",
                  lineHeight: 1.6,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}>
                  {m.content || (
                    <span style={{ opacity: 0.5 }}>▋</span>
                  )}
                </div>
              </div>
            ))}
            {loading && messages[messages.length - 1]?.role !== "assistant" && (
              <div style={{ display: "flex" }}>
                <div style={{ background: "#111", border: "1px solid #222", borderRadius: "18px 18px 18px 4px", padding: "0.75rem 1rem" }}>
                  <span style={{ opacity: 0.5 }}>▋</span>
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* Error */}
          {error && (
            <div style={{ color: "#ef4444", fontSize: "0.82rem", marginBottom: "0.5rem", padding: "0.5rem 0.75rem", background: "rgba(239,68,68,0.08)", borderRadius: 8 }}>
              {error}
            </div>
          )}

          {/* Input */}
          <form onSubmit={send} style={{ display: "flex", gap: "0.5rem" }}>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Type a message…"
              disabled={loading}
              style={{
                flex: 1, background: "#111", border: "1px solid #2a2a2a", borderRadius: 12,
                padding: "0.75rem 1rem", color: "#fff", fontSize: "0.9rem", outline: "none",
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send(e as unknown as FormEvent);
                }
              }}
            />
            <button
              type="submit"
              disabled={loading || !input.trim()}
              className="btn btn-primary"
              style={{ flexShrink: 0, opacity: loading || !input.trim() ? 0.5 : 1 }}
            >
              {loading ? "…" : "Send"}
            </button>
          </form>
        </div>
      </main>
    </>
  );
}
