import Link from "next/link";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user || (session.user as { role?: string }).role !== "admin") {
    redirect("/dashboard");
  }

  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      {/* Sidebar */}
      <aside style={{
        width: 220,
        background: "#0d0d0d",
        borderRight: "1px solid #1f1f1f",
        padding: "1.5rem 0",
        flexShrink: 0,
        position: "sticky",
        top: 0,
        height: "100vh",
        overflowY: "auto",
      }}>
        <div style={{ padding: "0 1.25rem 1.5rem", borderBottom: "1px solid #1a1a1a" }}>
          <Link href="/" style={{ fontSize: "1.1rem", fontWeight: 700, display: "flex", alignItems: "center", gap: "0.4rem" }}>
            🦞 <span>OpenClaw</span>
          </Link>
          <p style={{ color: "#555", fontSize: "0.7rem", marginTop: "0.25rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em" }}>
            Admin
          </p>
        </div>

        <nav style={{ padding: "1rem 0.75rem", display: "flex", flexDirection: "column", gap: "0.15rem" }}>
          {[
            { href: "/admin", label: "Overview", icon: "▦" },
            { href: "/admin/users", label: "Users", icon: "👤" },
          ].map((item) => (
            <Link
              key={item.href}
              href={item.href}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.6rem",
                padding: "0.55rem 0.75rem",
                borderRadius: 8,
                color: "#aaa",
                fontSize: "0.875rem",
                transition: "all 0.15s",
              }}
              className="admin-nav-link"
            >
              <span style={{ fontSize: "0.9rem" }}>{item.icon}</span>
              {item.label}
            </Link>
          ))}
        </nav>

        <div style={{ position: "absolute", bottom: "1.25rem", left: 0, right: 0, padding: "0 0.75rem" }}>
          <Link
            href="/dashboard"
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              padding: "0.55rem 0.75rem",
              borderRadius: 8,
              color: "#555",
              fontSize: "0.8rem",
            }}
          >
            ← Back to app
          </Link>
        </div>
      </aside>

      {/* Main */}
      <main style={{ flex: 1, padding: "2rem 2.5rem", maxWidth: "calc(100vw - 220px)", overflowX: "auto" }}>
        {children}
      </main>

      <style>{`
        .admin-nav-link:hover { background: #1a1a1a; color: #f0f0f0 !important; }
      `}</style>
    </div>
  );
}
