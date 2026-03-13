"use client";

import { useState, useEffect, FormEvent } from "react";
import Link from "next/link";
import Navbar from "@/components/Navbar";

interface Agent {
  id: string;
  name: string;
  description?: string;
  model?: string;
}

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");

  async function loadAgents() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/gateway/agents");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setAgents(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadAgents(); }, []);

  async function createAgent(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    try {
      const res = await fetch("/api/gateway/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), instructions: instructions.trim() || undefined }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setName("");
      setInstructions("");
      setShowForm(false);
      await loadAgents();
    } catch (err) {
      setError(String(err));
    } finally {
      setCreating(false);
    }
  }

  async function deleteAgent(id: string) {
    if (!confirm("Delete this agent?")) return;
    try {
      await fetch(`/api/gateway/agents/${id}`, { method: "DELETE" });
      setAgents((prev) => prev.filter((a) => a.id !== id));
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <>
      <Navbar />
      <main style={{ padding: "3rem 1.5rem" }}>
        <div className="container" style={{ maxWidth: 860 }}>
          <Link href="/dashboard/gateway" style={{ color: "#666", fontSize: "0.85rem" }}>← Gateway</Link>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "0.75rem 0 2rem" }}>
            <h1 style={{ fontSize: "1.75rem", fontWeight: 700 }}>Agents</h1>
            <button className="btn btn-primary" onClick={() => setShowForm(!showForm)} style={{ fontSize: "0.875rem" }}>
              {showForm ? "Cancel" : "+ New agent"}
            </button>
          </div>

          {/* Create form */}
          {showForm && (
            <form onSubmit={createAgent} style={{ background: "#111", border: "1px solid #1f1f1f", borderRadius: 14, padding: "1.5rem", marginBottom: "1.5rem" }}>
              <h3 style={{ fontWeight: 700, marginBottom: "1rem" }}>New agent</h3>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Agent name *"
                  required
                  style={{ background: "#0d0d0d", border: "1px solid #2a2a2a", borderRadius: 8, padding: "0.6rem 0.9rem", color: "#fff", fontSize: "0.9rem" }}
                />
                <textarea
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  placeholder="System instructions (optional)"
                  rows={4}
                  style={{ background: "#0d0d0d", border: "1px solid #2a2a2a", borderRadius: 8, padding: "0.6rem 0.9rem", color: "#fff", fontSize: "0.9rem", resize: "vertical" }}
                />
                <button
                  type="submit"
                  disabled={creating || !name.trim()}
                  className="btn btn-primary"
                  style={{ alignSelf: "flex-start", opacity: creating ? 0.6 : 1 }}
                >
                  {creating ? "Creating…" : "Create agent"}
                </button>
              </div>
            </form>
          )}

          {error && (
            <div style={{ color: "#ef4444", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 10, padding: "0.75rem 1rem", marginBottom: "1rem", fontSize: "0.85rem" }}>
              {error}
            </div>
          )}

          {loading ? (
            <p style={{ color: "#555" }}>Loading agents…</p>
          ) : agents.length === 0 ? (
            <div style={{ background: "#111", border: "1px dashed #252525", borderRadius: 14, padding: "3rem", textAlign: "center" }}>
              <div style={{ fontSize: "2.5rem", marginBottom: "0.75rem" }}>🤖</div>
              <p style={{ fontWeight: 600, marginBottom: "0.25rem" }}>No agents yet</p>
              <p style={{ color: "#666", fontSize: "0.85rem" }}>Create an agent to get started.</p>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
              {agents.map((agent) => (
                <div key={agent.id} style={{ background: "#111", border: "1px solid #1f1f1f", borderRadius: 12, padding: "1.25rem 1.5rem", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem" }}>
                  <div style={{ minWidth: 0 }}>
                    <p style={{ fontWeight: 600, marginBottom: "0.2rem" }}>{agent.name}</p>
                    {agent.description && <p style={{ color: "#666", fontSize: "0.82rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{agent.description}</p>}
                    {agent.model && <p style={{ color: "#444", fontSize: "0.75rem", marginTop: "0.15rem" }}>{agent.model}</p>}
                  </div>
                  <div style={{ display: "flex", gap: "0.5rem", flexShrink: 0 }}>
                    <Link href={`/dashboard/chat?agent=${agent.id}`} className="btn btn-outline" style={{ fontSize: "0.8rem", padding: "0.35rem 0.75rem" }}>
                      Chat
                    </Link>
                    <button
                      onClick={() => deleteAgent(agent.id)}
                      style={{ background: "transparent", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 8, color: "#ef4444", padding: "0.35rem 0.75rem", fontSize: "0.8rem", cursor: "pointer" }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </>
  );
}
