import { redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import Navbar from "@/components/Navbar";
import BillingButton from "./BillingButton";
import { gatewayHealth } from "@/lib/gateway";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ upgraded?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login?callbackUrl=/dashboard");

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [user, subscription, messagesToday, gwHealth] = await Promise.all([
    prisma.user.findUnique({ where: { id: session.user.id } }),
    prisma.subscription.findUnique({ where: { userId: session.user.id } }),
    prisma.message.count({
      where: { userId: session.user.id, role: "user", createdAt: { gte: todayStart } },
    }),
    gatewayHealth(),
  ]);

  const params = await searchParams;
  const justUpgraded = params.upgraded === "true";
  const isPaid = subscription?.status === "active" && subscription?.plan !== "free";
  if (!isPaid) redirect("/pricing");

  const plan = subscription?.plan ?? "free";
  const periodEnd = subscription?.stripeCurrentPeriodEnd;

  return (
    <>
      <Navbar />
      <main style={{ padding: "3rem 1.5rem" }}>
        <div className="container" style={{ maxWidth: 800 }}>
          {justUpgraded && (
            <div style={{
              background: "rgba(34,197,94,0.1)",
              border: "1px solid rgba(34,197,94,0.3)",
              borderRadius: 10,
              padding: "1rem 1.25rem",
              color: "#22c55e",
              marginBottom: "1.5rem",
              fontSize: "0.95rem",
            }}>
              🎉 You&apos;re now on the <strong style={{ textTransform: "capitalize" }}>{plan}</strong> plan! Welcome aboard.
            </div>
          )}

          {/* Header row with settings link */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "0.75rem", marginBottom: "2.5rem" }}>
            <div>
              <h1 style={{ fontSize: "1.75rem", fontWeight: 700, marginBottom: "0.25rem" }}>
                Welcome back{user?.name ? `, ${user.name}` : ""}!
              </h1>
              <p style={{ color: "#777" }}>{user?.email}</p>
            </div>
            <Link href="/dashboard/settings" className="btn btn-outline" style={{ fontSize: "0.875rem" }}>
              Account settings
            </Link>
          </div>

          {/* Subscription card */}
          <div style={{
            background: "#111",
            border: "1px solid rgba(224,90,43,0.4)",
            borderRadius: 16,
            padding: "1.75rem",
            marginBottom: "1.5rem",
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "1rem" }}>
              <div>
                <p style={{ color: "#777", fontSize: "0.875rem", marginBottom: "0.25rem" }}>Current plan</p>
                <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
                  <h2 style={{ fontSize: "1.4rem", fontWeight: 700, textTransform: "capitalize" }}>{plan}</h2>
                  <span style={{
                    background: "rgba(224,90,43,0.15)",
                    color: "#e05a2b",
                    border: "1px solid rgba(224,90,43,0.3)",
                    borderRadius: 999,
                    padding: "0.2rem 0.6rem",
                    fontSize: "0.75rem",
                    fontWeight: 600,
                  }}>
                    {subscription?.status ?? "active"}
                  </span>
                </div>
                {periodEnd && (
                  <p style={{ color: "#555", fontSize: "0.8rem", marginTop: "0.3rem" }}>
                    Renews {new Date(periodEnd).toLocaleDateString()}
                  </p>
                )}
              </div>
              <div style={{ display: "flex", gap: "0.6rem" }}>
                <BillingButton label="Manage billing" />
              </div>
            </div>
          </div>

          {/* Channel quick-link */}
          <div style={{ background: "#111", border: "1px solid #1f1f1f", borderRadius: 16, padding: "1.5rem", marginBottom: "1.5rem", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <p style={{ fontWeight: 600, fontSize: "0.95rem", marginBottom: "0.2rem" }}>Channel connections</p>
              <p style={{ color: "#666", fontSize: "0.8rem" }}>Connect Telegram, Discord, Slack and more via the gateway.</p>
            </div>
            <Link href="/dashboard/channels" className="btn btn-outline" style={{ fontSize: "0.85rem", flexShrink: 0 }}>
              Manage channels
            </Link>
          </div>

          {/* Stats */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "1rem", marginBottom: "1.5rem" }}>
            {[
              { label: "Gateway", value: gwHealth.online ? "Online" : "Offline", color: gwHealth.online ? "#22c55e" : "#ef4444" },
              { label: "Messages today", value: String(messagesToday) },
            ].map((stat) => (
              <div key={stat.label} style={{ background: "#111", border: "1px solid #1f1f1f", borderRadius: 12, padding: "1.25rem" }}>
                <p style={{ color: "#666", fontSize: "0.8rem", marginBottom: "0.4rem" }}>{stat.label}</p>
                <p style={{ fontWeight: 700, fontSize: "1.2rem", color: stat.color ?? "inherit" }}>{stat.value}</p>
              </div>
            ))}
          </div>

          {/* Quick-access cards */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "0.75rem" }}>
            {[
              { href: "/dashboard/gateway", icon: "⚡", label: "Gateway", desc: "Status & overview" },
              { href: "/dashboard/channels", icon: "🔌", label: "Channels", desc: "Telegram, Discord, Slack…" },
              { href: "/dashboard/chat", icon: "💬", label: "Chat", desc: "Talk to your agent" },
              { href: "/dashboard/agents", icon: "🤖", label: "Agents", desc: "Manage agents" },
              { href: "/dashboard/sessions", icon: "🗂️", label: "Sessions", desc: "View history" },
            ].map((card) => (
              <Link key={card.href} href={card.href} style={{ textDecoration: "none" }}>
                <div style={{ background: "#111", border: "1px solid #1f1f1f", borderRadius: 12, padding: "1rem" }}>
                  <div style={{ fontSize: "1.4rem", marginBottom: "0.35rem" }}>{card.icon}</div>
                  <p style={{ fontWeight: 600, fontSize: "0.9rem", marginBottom: "0.1rem" }}>{card.label}</p>
                  <p style={{ color: "#555", fontSize: "0.78rem" }}>{card.desc}</p>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </main>
    </>
  );
}
