import Link from "next/link";
import { prisma } from "@/lib/prisma";

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  const params = await searchParams;
  const query = params.q ?? "";
  const page = Math.max(1, parseInt(params.page ?? "1", 10));
  const pageSize = 25;

  const where = query
    ? { OR: [{ email: { contains: query, mode: "insensitive" as const } }, { name: { contains: query, mode: "insensitive" as const } }] }
    : {};

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        createdAt: true,
        subscription: { select: { plan: true, status: true } },
        _count: { select: { channels: true, messages: true } },
      },
    }),
    prisma.user.count({ where }),
  ]);

  const totalPages = Math.ceil(total / pageSize);

  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "2rem", flexWrap: "wrap", gap: "1rem" }}>
        <div>
          <h1 style={{ fontSize: "1.5rem", fontWeight: 700, marginBottom: "0.25rem" }}>Users</h1>
          <p style={{ color: "#666", fontSize: "0.875rem" }}>{total.toLocaleString()} total</p>
        </div>
        <form method="GET" style={{ display: "flex", gap: "0.5rem" }}>
          <input
            name="q"
            defaultValue={query}
            placeholder="Search by name or email…"
            style={{ width: 260, background: "#111", border: "1px solid #222", borderRadius: 8, color: "#f0f0f0", padding: "0.55rem 0.85rem", fontSize: "0.875rem" }}
          />
          <button type="submit" className="btn btn-outline" style={{ fontSize: "0.875rem" }}>Search</button>
        </form>
      </div>

      <div style={{ background: "#111", border: "1px solid #1f1f1f", borderRadius: 12, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
          <thead>
            <tr style={{ borderBottom: "1px solid #1f1f1f" }}>
              {["User", "Plan", "Channels", "Messages", "Joined", ""].map((h) => (
                <th key={h} style={{ padding: "0.85rem 1rem", textAlign: "left", color: "#555", fontWeight: 600, fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.05em", whiteSpace: "nowrap" }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {users.map((u, i) => {
              const plan = u.subscription?.plan ?? "free";
              const isPaid = plan !== "free";
              return (
                <tr key={u.id} style={{ borderBottom: i < users.length - 1 ? "1px solid #161616" : "none" }}>
                  <td style={{ padding: "0.85rem 1rem" }}>
                    <p style={{ fontWeight: 500 }}>{u.name ?? <span style={{ color: "#555" }}>—</span>}</p>
                    <p style={{ color: "#666", fontSize: "0.8rem" }}>{u.email}</p>
                    {u.role === "admin" && (
                      <span style={{ fontSize: "0.68rem", background: "rgba(224,90,43,0.15)", color: "#e05a2b", border: "1px solid rgba(224,90,43,0.3)", borderRadius: 999, padding: "0.1rem 0.4rem" }}>
                        admin
                      </span>
                    )}
                  </td>
                  <td style={{ padding: "0.85rem 1rem" }}>
                    <span style={{
                      fontSize: "0.78rem",
                      padding: "0.2rem 0.55rem",
                      borderRadius: 999,
                      background: isPaid ? "rgba(224,90,43,0.12)" : "#1a1a1a",
                      color: isPaid ? "#e05a2b" : "#666",
                      border: `1px solid ${isPaid ? "rgba(224,90,43,0.25)" : "#2a2a2a"}`,
                      textTransform: "capitalize",
                    }}>
                      {plan}
                    </span>
                    {u.subscription?.status && u.subscription.status !== "inactive" && (
                      <p style={{ color: "#555", fontSize: "0.72rem", marginTop: "0.2rem" }}>{u.subscription.status}</p>
                    )}
                  </td>
                  <td style={{ padding: "0.85rem 1rem", color: "#888" }}>{u._count.channels}</td>
                  <td style={{ padding: "0.85rem 1rem", color: "#888" }}>{u._count.messages.toLocaleString()}</td>
                  <td style={{ padding: "0.85rem 1rem", color: "#666", whiteSpace: "nowrap", fontSize: "0.8rem" }}>
                    {new Date(u.createdAt).toLocaleDateString()}
                  </td>
                  <td style={{ padding: "0.85rem 1rem" }}>
                    <Link href={`/admin/users/${u.id}`} style={{ color: "#e05a2b", fontSize: "0.8rem" }}>
                      View →
                    </Link>
                  </td>
                </tr>
              );
            })}
            {users.length === 0 && (
              <tr>
                <td colSpan={6} style={{ padding: "3rem", textAlign: "center", color: "#555" }}>
                  No users found
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: "0.5rem", marginTop: "1.5rem" }}>
          {page > 1 && (
            <Link href={`/admin/users?q=${query}&page=${page - 1}`} className="btn btn-outline" style={{ fontSize: "0.8rem", padding: "0.45rem 0.9rem" }}>
              Previous
            </Link>
          )}
          <span style={{ color: "#666", fontSize: "0.875rem" }}>Page {page} of {totalPages}</span>
          {page < totalPages && (
            <Link href={`/admin/users?q=${query}&page=${page + 1}`} className="btn btn-outline" style={{ fontSize: "0.8rem", padding: "0.45rem 0.9rem" }}>
              Next
            </Link>
          )}
        </div>
      )}
    </>
  );
}
