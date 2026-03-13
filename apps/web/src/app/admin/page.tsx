import { prisma } from "@/lib/prisma";

export default async function AdminOverviewPage() {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);

  const [
    totalUsers,
    newUsersThisMonth,
    planCounts,
    totalMessages,
    messagesToday,
    revenueResult,
    revenueThisMonth,
    recentUsers,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { createdAt: { gte: monthStart } } }),
    prisma.subscription.groupBy({ by: ["plan"], _count: { plan: true } }),
    prisma.message.count({ where: { role: "user" } }),
    prisma.message.count({ where: { role: "user", createdAt: { gte: todayStart } } }),
    prisma.usageRecord.aggregate({ _sum: { billedUsd: true } }),
    prisma.usageRecord.aggregate({ _sum: { billedUsd: true }, where: { createdAt: { gte: monthStart } } }),
    prisma.user.findMany({
      take: 10,
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true, email: true, createdAt: true, subscription: { select: { plan: true, status: true } } },
    }),
  ]);

  const plans: Record<string, number> = {};
  for (const p of planCounts) plans[p.plan] = p._count.plan;

  const totalRevenue = revenueResult._sum.billedUsd ?? 0;
  const monthRevenue = revenueThisMonth._sum.billedUsd ?? 0;

  return (
    <>
      <div style={{ marginBottom: "2rem" }}>
        <h1 style={{ fontSize: "1.5rem", fontWeight: 700, marginBottom: "0.25rem" }}>Overview</h1>
        <p style={{ color: "#666", fontSize: "0.875rem" }}>Platform-wide stats</p>
      </div>

      {/* Stat cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "1rem", marginBottom: "2rem" }}>
        {[
          { label: "Total users", value: totalUsers.toLocaleString() },
          { label: "New this month", value: `+${newUsersThisMonth}` },
          { label: "Messages today", value: messagesToday.toLocaleString() },
          { label: "Total messages", value: totalMessages.toLocaleString() },
          { label: "Revenue (month)", value: `$${monthRevenue.toFixed(2)}` },
          { label: "Revenue (all time)", value: `$${totalRevenue.toFixed(2)}` },
        ].map((stat) => (
          <div key={stat.label} style={{
            background: "#111",
            border: "1px solid #1f1f1f",
            borderRadius: 12,
            padding: "1.25rem",
          }}>
            <p style={{ color: "#666", fontSize: "0.78rem", marginBottom: "0.4rem" }}>{stat.label}</p>
            <p style={{ fontWeight: 700, fontSize: "1.3rem" }}>{stat.value}</p>
          </div>
        ))}
      </div>

      {/* Plan distribution */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1.5rem", marginBottom: "2rem" }}>
        <div style={{ background: "#111", border: "1px solid #1f1f1f", borderRadius: 12, padding: "1.5rem" }}>
          <h3 style={{ fontWeight: 600, fontSize: "0.95rem", marginBottom: "1rem" }}>Users by plan</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
            {["free", "starter", "growth", "pro"].map((plan) => {
              const count = plans[plan] ?? 0;
              const pct = totalUsers > 0 ? Math.round((count / totalUsers) * 100) : 0;
              const colors: Record<string, string> = { free: "#555", starter: "#3b82f6", growth: "#e05a2b", pro: "#22c55e" };
              return (
                <div key={plan}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.25rem" }}>
                    <span style={{ fontSize: "0.85rem", textTransform: "capitalize" }}>{plan}</span>
                    <span style={{ fontSize: "0.85rem", color: "#888" }}>{count} ({pct}%)</span>
                  </div>
                  <div style={{ height: 6, background: "#1a1a1a", borderRadius: 999 }}>
                    <div style={{ height: 6, width: `${pct}%`, background: colors[plan], borderRadius: 999 }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Recent signups */}
        <div style={{ background: "#111", border: "1px solid #1f1f1f", borderRadius: 12, padding: "1.5rem" }}>
          <h3 style={{ fontWeight: 600, fontSize: "0.95rem", marginBottom: "1rem" }}>Recent signups</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
            {recentUsers.map((u) => (
              <div key={u.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ minWidth: 0 }}>
                  <p style={{ fontSize: "0.85rem", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {u.name ?? u.email}
                  </p>
                  <p style={{ fontSize: "0.75rem", color: "#555" }}>
                    {new Date(u.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <span style={{
                  fontSize: "0.72rem",
                  padding: "0.15rem 0.5rem",
                  borderRadius: 999,
                  background: u.subscription?.plan === "free" || !u.subscription ? "#1a1a1a" : "rgba(224,90,43,0.15)",
                  color: u.subscription?.plan === "free" || !u.subscription ? "#666" : "#e05a2b",
                  border: `1px solid ${u.subscription?.plan === "free" || !u.subscription ? "#2a2a2a" : "rgba(224,90,43,0.3)"}`,
                  flexShrink: 0,
                  marginLeft: "0.5rem",
                }}>
                  {u.subscription?.plan ?? "free"}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
