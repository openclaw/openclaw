import { redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { gatewayHealth, gatewayRpc, GatewayAgent, GatewaySession, GATEWAY_URL } from "@/lib/gateway";
import Navbar from "@/components/Navbar";

export const dynamic = "force-dynamic";

export default async function GatewayPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login?callbackUrl=/dashboard/gateway");

  const [health, agents, sessions] = await Promise.allSettled([
    gatewayHealth(),
    gatewayRpc<GatewayAgent[]>("agents.list"),
    gatewayRpc<GatewaySession[]>("sessions.list"),
  ]);

  const online = health.status === "fulfilled" && health.value.online;
  const agentList = agents.status === "fulfilled" ? (agents.value ?? []) : [];
  const sessionList = sessions.status === "fulfilled" ? (sessions.value ?? []) : [];

  const maskedUrl = GATEWAY_URL.replace(/\/\/[^@]+@/, "//***@");

  const tile = (label: string, value: string | number, sub?: string, color?: string) => (
    <div style={{ background: "#111", border: "1px solid #1f1f1f", borderRadius: 12, padding: "1.25rem" }}>
      <p style={{ color: "#666", fontSize: "0.8rem", marginBottom: "0.4rem" }}>{label}</p>
      <p style={{ fontWeight: 700, fontSize: "1.4rem", color: color ?? "inherit" }}>{value}</p>
      {sub && <p style={{ color: "#555", fontSize: "0.75rem", marginTop: "0.25rem" }}>{sub}</p>}
    </div>
  );

  return (
    <>
      <Navbar />
      <main style={{ padding: "3rem 1.5rem" }}>
        <div className="container" style={{ maxWidth: 860 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "0.5rem" }}>
            <Link href="/dashboard" style={{ color: "#666", fontSize: "0.85rem" }}>← Dashboard</Link>
          </div>
          <h1 style={{ fontSize: "1.75rem", fontWeight: 700, marginBottom: "0.25rem" }}>Gateway</h1>
          <p style={{ color: "#666", marginBottom: "2rem" }}>
            {maskedUrl} &nbsp;
            <span style={{
              display: "inline-flex", alignItems: "center", gap: "0.3rem",
              background: online ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)",
              color: online ? "#22c55e" : "#ef4444",
              border: `1px solid ${online ? "rgba(34,197,94,0.3)" : "rgba(239,68,68,0.3)"}`,
              borderRadius: 999, padding: "0.15rem 0.6rem", fontSize: "0.75rem", fontWeight: 600,
            }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: "currentColor", display: "inline-block" }} />
              {online ? "Online" : "Offline"}
            </span>
          </p>

          {/* Stats row */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "1rem", marginBottom: "2rem" }}>
            {tile("Status", online ? "Connected" : "Unreachable", undefined, online ? "#22c55e" : "#ef4444")}
            {tile("Agents", agents.status === "fulfilled" ? agentList.length : "—", "total configured")}
            {tile("Sessions", sessions.status === "fulfilled" ? sessionList.length : "—", "stored sessions")}
          </div>

          {/* Quick actions */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "1rem", marginBottom: "2rem" }}>
            {[
              { href: "/dashboard/channels", icon: "🔌", label: "Channels", desc: "Connect Telegram, Discord, Slack…" },
              { href: "/dashboard/chat", icon: "💬", label: "Chat", desc: "Send messages to your agent" },
              { href: "/dashboard/agents", icon: "🤖", label: "Agents", desc: "Create and manage agents" },
              { href: "/dashboard/sessions", icon: "🗂️", label: "Sessions", desc: "Browse conversation history" },
            ].map((card) => (
              <Link key={card.href} href={card.href} style={{ textDecoration: "none" }}>
                <div style={{
                  background: "#111", border: "1px solid #1f1f1f", borderRadius: 14, padding: "1.5rem",
                  cursor: "pointer", transition: "border-color 0.15s",
                }}>
                  <div style={{ fontSize: "1.75rem", marginBottom: "0.5rem" }}>{card.icon}</div>
                  <p style={{ fontWeight: 700, marginBottom: "0.2rem" }}>{card.label}</p>
                  <p style={{ color: "#666", fontSize: "0.82rem" }}>{card.desc}</p>
                </div>
              </Link>
            ))}
          </div>

          {!online && (
            <div style={{
              background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.25)",
              borderRadius: 12, padding: "1.25rem 1.5rem", color: "#f87171",
            }}>
              <strong>Gateway unreachable.</strong> Make sure the gateway is running and{" "}
              <code style={{ fontSize: "0.85em" }}>GATEWAY_URL</code> is set correctly.
              {" "}If deploying on Fly.io, set{" "}
              <code style={{ fontSize: "0.85em" }}>GATEWAY_URL=http://openclaw-gateway.internal:18789</code>.
            </div>
          )}
        </div>
      </main>
    </>
  );
}
