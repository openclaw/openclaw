import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";

export default async function AdminUserDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const user = await prisma.user.findUnique({
    where: { id },
    include: {
      subscription: true,
      channels: { orderBy: { createdAt: "asc" } },
      usageRecords: { orderBy: { createdAt: "desc" }, take: 20 },
      _count: { select: { messages: true, usageRecords: true } },
    },
  });

  if (!user) notFound();

  const totalBilled = await prisma.usageRecord.aggregate({
    where: { userId: id },
    _sum: { billedUsd: true, inputTokens: true, outputTokens: true },
  });

  const plan = user.subscription?.plan ?? "free";
  const isPaid = plan !== "free";

  const channelIcons: Record<string, string> = {
    telegram: "✈️", whatsapp: "💬", discord: "🎮", slack: "🟣",
    signal: "🔒", imessage: "💙", teams: "🏢", matrix: "🌐",
    zalo: "🇻🇳", voice: "📞",
  };

  return (
    <>
      <div style={{ marginBottom: "1.5rem" }}>
        <Link href="/admin/users" style={{ color: "#666", fontSize: "0.85rem" }}>← Users</Link>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "1rem", marginBottom: "2rem" }}>
        <div>
          <h1 style={{ fontSize: "1.4rem", fontWeight: 700, marginBottom: "0.2rem" }}>
            {user.name ?? "Unnamed user"}
          </h1>
          <p style={{ color: "#666" }}>{user.email}</p>
          <p style={{ color: "#555", fontSize: "0.8rem", marginTop: "0.25rem" }}>
            Joined {new Date(user.createdAt).toLocaleDateString()} · ID: <code style={{ fontSize: "0.75rem", color: "#555" }}>{user.id}</code>
          </p>
        </div>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          <span style={{
            padding: "0.3rem 0.75rem",
            borderRadius: 999,
            fontSize: "0.82rem",
            fontWeight: 600,
            textTransform: "capitalize",
            background: isPaid ? "rgba(224,90,43,0.12)" : "#1a1a1a",
            color: isPaid ? "#e05a2b" : "#888",
            border: `1px solid ${isPaid ? "rgba(224,90,43,0.25)" : "#2a2a2a"}`,
          }}>
            {plan}
          </span>
          {user.role === "admin" && (
            <span style={{ padding: "0.3rem 0.75rem", borderRadius: 999, fontSize: "0.82rem", fontWeight: 600, background: "rgba(34,197,94,0.1)", color: "#22c55e", border: "1px solid rgba(34,197,94,0.25)" }}>
              admin
            </span>
          )}
        </div>
      </div>

      {/* Stats row */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "1rem", marginBottom: "2rem" }}>
        {[
          { label: "Messages", value: user._count.messages.toLocaleString() },
          { label: "Channels", value: user.channels.length.toString() },
          { label: "Total billed", value: `$${(totalBilled._sum.billedUsd ?? 0).toFixed(4)}` },
          { label: "Input tokens", value: (totalBilled._sum.inputTokens ?? 0).toLocaleString() },
          { label: "Output tokens", value: (totalBilled._sum.outputTokens ?? 0).toLocaleString() },
        ].map((s) => (
          <div key={s.label} style={{ background: "#111", border: "1px solid #1f1f1f", borderRadius: 12, padding: "1rem 1.25rem" }}>
            <p style={{ color: "#666", fontSize: "0.78rem", marginBottom: "0.3rem" }}>{s.label}</p>
            <p style={{ fontWeight: 700, fontSize: "1.1rem" }}>{s.value}</p>
          </div>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1.5rem", marginBottom: "2rem" }}>
        {/* Subscription */}
        <div style={{ background: "#111", border: "1px solid #1f1f1f", borderRadius: 12, padding: "1.5rem" }}>
          <h3 style={{ fontWeight: 600, fontSize: "0.95rem", marginBottom: "1rem" }}>Subscription</h3>
          {user.subscription ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", fontSize: "0.875rem" }}>
              {[
                ["Plan", user.subscription.plan],
                ["Status", user.subscription.status],
                ["Stripe Customer", user.subscription.stripeCustomerId ?? "—"],
                ["Stripe Sub ID", user.subscription.stripeSubscriptionId ?? "—"],
                ["Period ends", user.subscription.stripeCurrentPeriodEnd ? new Date(user.subscription.stripeCurrentPeriodEnd).toLocaleDateString() : "—"],
              ].map(([label, value]) => (
                <div key={label} style={{ display: "flex", gap: "0.5rem" }}>
                  <span style={{ color: "#555", minWidth: 110 }}>{label}</span>
                  <span style={{ color: "#ccc", wordBreak: "break-all" }}>{value}</span>
                </div>
              ))}
            </div>
          ) : (
            <p style={{ color: "#555", fontSize: "0.875rem" }}>No subscription record</p>
          )}
        </div>

        {/* AI keys */}
        <div style={{ background: "#111", border: "1px solid #1f1f1f", borderRadius: 12, padding: "1.5rem" }}>
          <h3 style={{ fontWeight: 600, fontSize: "0.95rem", marginBottom: "1rem" }}>BYOK keys</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", fontSize: "0.875rem" }}>
            {[
              ["Anthropic", user.anthropicApiKey],
              ["OpenAI", user.openaiApiKey],
              ["Gemini", user.geminiApiKey],
            ].map(([label, key]) => (
              <div key={label} style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                <span style={{ color: "#555", minWidth: 80 }}>{label}</span>
                {key ? (
                  <span style={{ color: "#22c55e", fontSize: "0.8rem" }}>● Set ({key.length} chars)</span>
                ) : (
                  <span style={{ color: "#444", fontSize: "0.8rem" }}>Not set</span>
                )}
              </div>
            ))}
            <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.25rem" }}>
              <span style={{ color: "#555", minWidth: 80 }}>Model</span>
              <span style={{ color: "#aaa", fontSize: "0.85rem" }}>{user.preferredModel ?? "default"}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Channels */}
      {user.channels.length > 0 && (
        <div style={{ background: "#111", border: "1px solid #1f1f1f", borderRadius: 12, padding: "1.5rem", marginBottom: "2rem" }}>
          <h3 style={{ fontWeight: 600, fontSize: "0.95rem", marginBottom: "1rem" }}>Channels</h3>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
            {user.channels.map((ch) => (
              <span key={ch.id} style={{
                background: ch.enabled ? "#1a1a1a" : "#111",
                border: `1px solid ${ch.enabled ? "#2a2a2a" : "#1a1a1a"}`,
                borderRadius: 999,
                padding: "0.3rem 0.75rem",
                fontSize: "0.82rem",
                color: ch.enabled ? "#ccc" : "#444",
                display: "flex",
                alignItems: "center",
                gap: "0.4rem",
              }}>
                {channelIcons[ch.channel] ?? "🔌"} {ch.channel}
                {!ch.enabled && <span style={{ color: "#444" }}>(disabled)</span>}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Recent usage */}
      {user.usageRecords.length > 0 && (
        <div style={{ background: "#111", border: "1px solid #1f1f1f", borderRadius: 12, overflow: "hidden" }}>
          <div style={{ padding: "1.25rem 1.5rem", borderBottom: "1px solid #1a1a1a" }}>
            <h3 style={{ fontWeight: 600, fontSize: "0.95rem" }}>Recent usage</h3>
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8rem" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #1a1a1a" }}>
                {["Date", "Channel", "Model", "In tokens", "Out tokens", "Billed"].map((h) => (
                  <th key={h} style={{ padding: "0.7rem 1rem", textAlign: "left", color: "#555", fontWeight: 600, fontSize: "0.72rem", textTransform: "uppercase" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {user.usageRecords.map((r, i) => (
                <tr key={r.id} style={{ borderBottom: i < user.usageRecords.length - 1 ? "1px solid #161616" : "none" }}>
                  <td style={{ padding: "0.65rem 1rem", color: "#666" }}>{new Date(r.createdAt).toLocaleDateString()}</td>
                  <td style={{ padding: "0.65rem 1rem", color: "#aaa" }}>{r.channel}</td>
                  <td style={{ padding: "0.65rem 1rem", color: "#aaa" }}>{r.model}</td>
                  <td style={{ padding: "0.65rem 1rem", color: "#888" }}>{r.inputTokens.toLocaleString()}</td>
                  <td style={{ padding: "0.65rem 1rem", color: "#888" }}>{r.outputTokens.toLocaleString()}</td>
                  <td style={{ padding: "0.65rem 1rem", color: "#e05a2b" }}>${r.billedUsd.toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
