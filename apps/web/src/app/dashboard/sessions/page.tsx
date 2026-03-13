"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import Navbar from "@/components/Navbar";

interface Session {
  id: string;
  title?: string;
  summary?: string;
  createdAt?: string;
  updatedAt?: string;
  messageCount?: number;
}

export default function SessionsPage() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/gateway/sessions")
      .then((r) => r.json())
      .then((data) => {
        if (data.error) throw new Error(data.error);
        setSessions(Array.isArray(data) ? data : []);
      })
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, []);

  async function deleteSession(id: string) {
    if (!confirm("Delete this session?")) return;
    try {
      await fetch(`/api/gateway/sessions/${id}`, { method: "DELETE" });
      setSessions((prev) => prev.filter((s) => s.id !== id));
    } catch (err) {
      setError(String(err));
    }
  }

  function fmt(iso?: string) {
    if (!iso) return "—";
    return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  }

  return (
    <>
      <Navbar />
      <main style={{ padding: "3rem 1.5rem" }}>
        <div className="container" style={{ maxWidth: 860 }}>
          <Link href="/dashboard/gateway" style={{ color: "#666", fontSize: "0.85rem" }}>← Gateway</Link>
          <h1 style={{ fontSize: "1.75rem", fontWeight: 700, margin: "0.75rem 0 2rem" }}>Sessions</h1>

          {error && (
            <div style={{ color: "#ef4444", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 10, padding: "0.75rem 1rem", marginBottom: "1rem", fontSize: "0.85rem" }}>
              {error}
            </div>
          )}

          {loading ? (
            <p style={{ color: "#555" }}>Loading sessions…</p>
          ) : sessions.length === 0 ? (
            <div style={{ background: "#111", border: "1px dashed #252525", borderRadius: 14, padding: "3rem", textAlign: "center" }}>
              <div style={{ fontSize: "2.5rem", marginBottom: "0.75rem" }}>🗂️</div>
              <p style={{ fontWeight: 600, marginBottom: "0.25rem" }}>No sessions yet</p>
              <p style={{ color: "#666", fontSize: "0.85rem" }}>Start a conversation in Chat to create sessions.</p>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
              {sessions.map((s) => (
                <div key={s.id} style={{ background: "#111", border: "1px solid #1f1f1f", borderRadius: 12, padding: "1.25rem 1.5rem", display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "1rem" }}>
                  <div style={{ minWidth: 0 }}>
                    <p style={{ fontWeight: 600, marginBottom: "0.2rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {s.title ?? s.id}
                    </p>
                    {s.summary && (
                      <p style={{ color: "#666", fontSize: "0.82rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.summary}</p>
                    )}
                    <p style={{ color: "#444", fontSize: "0.75rem", marginTop: "0.2rem" }}>
                      {fmt(s.updatedAt ?? s.createdAt)}
                      {s.messageCount != null ? ` · ${s.messageCount} messages` : ""}
                    </p>
                  </div>
                  <button
                    onClick={() => deleteSession(s.id)}
                    style={{ background: "transparent", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 8, color: "#ef4444", padding: "0.35rem 0.75rem", fontSize: "0.8rem", cursor: "pointer", flexShrink: 0 }}
                  >
                    Delete
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </>
  );
}
