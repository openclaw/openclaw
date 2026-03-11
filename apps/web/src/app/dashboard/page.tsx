import { redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import Navbar from "@/components/Navbar";
import BillingButton from "./BillingButton";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ upgraded?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login?callbackUrl=/dashboard");

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [user, subscription, channels, messagesToday] = await Promise.all([
    prisma.user.findUnique({ where: { id: session.user.id } }),
    prisma.subscription.findUnique({ where: { userId: session.user.id } }),
    prisma.userChannel.findMany({ where: { userId: session.user.id }, orderBy: { createdAt: "asc" } }),
    prisma.message.count({
      where: { userId: session.user.id, role: "user", createdAt: { gte: todayStart } },
    }),
  ]);

  const params = await searchParams;
  const justUpgraded = params.upgraded === "true";
  const isPaid = subscription?.status === "active" && subscription?.plan !== "free";
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
            border: `1px solid ${isPaid ? "rgba(224,90,43,0.4)" : "#222"}`,
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
                    background: isPaid ? "rgba(224,90,43,0.15)" : "#1a1a1a",
                    color: isPaid ? "#e05a2b" : "#666",
                    border: `1px solid ${isPaid ? "rgba(224,90,43,0.3)" : "#2a2a2a"}`,
                    borderRadius: 999,
                    padding: "0.2rem 0.6rem",
                    fontSize: "0.75rem",
                    fontWeight: 600,
                  }}>
                    {subscription?.status ?? "inactive"}
                  </span>
                </div>
                {periodEnd && (
                  <p style={{ color: "#555", fontSize: "0.8rem", marginTop: "0.3rem" }}>
                    Renews {new Date(periodEnd).toLocaleDateString()}
                  </p>
                )}
              </div>
              <div style={{ display: "flex", gap: "0.6rem" }}>
                {isPaid ? (
                  <BillingButton label="Manage billing" />
                ) : (
                  <Link href="/pricing" className="btn btn-primary">
                    Upgrade plan
                  </Link>
                )}
              </div>
            </div>
          </div>

          {/* Channel summary */}
          {channels.length > 0 ? (
            <div style={{ background: "#111", border: "1px solid #1f1f1f", borderRadius: 16, padding: "1.5rem", marginBottom: "1.5rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
                <h3 style={{ fontWeight: 700, fontSize: "1rem" }}>Connected channels</h3>
                <Link href="/onboarding" style={{ color: "#e05a2b", fontSize: "0.8rem" }}>Edit</Link>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
                {channels.map((ch) => {
                  const icons: Record<string, string> = {
                    telegram: "✈️", whatsapp: "💬", discord: "🎮", slack: "🟣",
                    signal: "🔒", imessage: "💙", teams: "🏢", matrix: "🌐",
                    zalo: "🇻🇳", voice: "📞",
                  };
                  return (
                    <span key={ch.id} style={{
                      background: "#1a1a1a",
                      border: "1px solid #2a2a2a",
                      borderRadius: 999,
                      padding: "0.3rem 0.75rem",
                      fontSize: "0.82rem",
                      display: "flex",
                      alignItems: "center",
                      gap: "0.4rem",
                    }}>
                      {icons[ch.channel] ?? "🔌"} {ch.channel.charAt(0).toUpperCase() + ch.channel.slice(1)}
                    </span>
                  );
                })}
              </div>
            </div>
          ) : (
            <div style={{ background: "#111", border: "1px dashed #252525", borderRadius: 16, padding: "1.5rem", marginBottom: "1.5rem", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <p style={{ fontWeight: 600, fontSize: "0.95rem", marginBottom: "0.2rem" }}>No channels configured</p>
                <p style={{ color: "#666", fontSize: "0.8rem" }}>Connect Telegram, WhatsApp, Discord and more.</p>
              </div>
              <Link href="/onboarding" className="btn btn-outline" style={{ fontSize: "0.85rem", flexShrink: 0 }}>
                Set up channels
              </Link>
            </div>
          )}

          {/* Webhook URLs for channels that need manual configuration */}
          {channels.some((c) => ["discord", "slack", "whatsapp"].includes(c.channel) && c.enabled) && process.env.NEXTAUTH_URL && (
            <div style={{ background: "#111", border: "1px solid #1f1f1f", borderRadius: 16, padding: "1.5rem", marginBottom: "1.5rem" }}>
              <h3 style={{ fontWeight: 700, fontSize: "1rem", marginBottom: "0.25rem" }}>Webhook URLs</h3>
              <p style={{ color: "#666", fontSize: "0.8rem", marginBottom: "1rem" }}>
                Paste these into each platform&apos;s developer settings to receive messages.
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                {channels
                  .filter((c) => ["discord", "slack", "whatsapp"].includes(c.channel) && c.enabled)
                  .map((c) => {
                    const labels: Record<string, string> = {
                      discord: "Discord → Interactions Endpoint URL",
                      slack: "Slack → Event Subscriptions → Request URL",
                      whatsapp: "Twilio → WhatsApp → Webhook URL",
                    };
                    const icons: Record<string, string> = { discord: "🎮", slack: "🟣", whatsapp: "💬" };
                    return (
                      <div key={c.id}>
                        <p style={{ color: "#888", fontSize: "0.75rem", marginBottom: "0.3rem" }}>
                          {icons[c.channel]} {labels[c.channel]}
                        </p>
                        <code style={{
                          display: "block",
                          background: "#0d0d0d",
                          border: "1px solid #222",
                          borderRadius: 8,
                          padding: "0.5rem 0.75rem",
                          fontSize: "0.78rem",
                          color: "#ccc",
                          wordBreak: "break-all",
                        }}>
                          {process.env.NEXTAUTH_URL}/api/webhook/{c.channel}/{session.user.id}
                        </code>
                      </div>
                    );
                  })}
              </div>
            </div>
          )}

          {/* Paywall gate */}
          {!isPaid ? (
            <div style={{
              background: "#111",
              border: "1px solid #1f1f1f",
              borderRadius: 16,
              padding: "2.5rem",
              textAlign: "center",
            }}>
              <div style={{ fontSize: "2.5rem", marginBottom: "1rem" }}>🔒</div>
              <h3 style={{ fontSize: "1.2rem", fontWeight: 700, marginBottom: "0.5rem" }}>
                Upgrade to unlock full access
              </h3>
              <p style={{ color: "#777", marginBottom: "1.5rem", maxWidth: 400, margin: "0 auto 1.5rem" }}>
                Connect unlimited channels, access voice features, and get priority support.
              </p>
              <Link href="/pricing" className="btn btn-primary">
                View plans
              </Link>
            </div>
          ) : (
            <div style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
              gap: "1rem",
            }}>
              {[
                { label: "Gateway status", value: "Active", color: "#22c55e" },
                { label: "Channels connected", value: String(channels.filter((c) => c.enabled).length) },
                { label: "Messages today", value: String(messagesToday) },
                { label: "Memory entries", value: "—" },
              ].map((stat) => (
                <div key={stat.label} style={{
                  background: "#111",
                  border: "1px solid #1f1f1f",
                  borderRadius: 12,
                  padding: "1.25rem",
                }}>
                  <p style={{ color: "#666", fontSize: "0.8rem", marginBottom: "0.4rem" }}>{stat.label}</p>
                  <p style={{ fontWeight: 700, fontSize: "1.2rem", color: stat.color ?? "inherit" }}>{stat.value}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </>
  );
}
