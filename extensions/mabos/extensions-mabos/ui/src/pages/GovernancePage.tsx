import { Wallet, Shield, FileText } from "lucide-react";
import { useState, useEffect } from "react";

interface BudgetStatus {
  agentId: string;
  daily: { limit: number; spent: number; reserved: number; remaining: number } | null;
  monthly: { limit: number; spent: number; reserved: number; remaining: number } | null;
  canSpend: boolean;
}

interface AuditEntry {
  id: number;
  timestamp: string;
  actorType: string;
  actorId: string;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  outcome: string;
}

function BudgetGauge({
  label,
  spent,
  limit,
  reserved,
}: {
  label: string;
  spent: number;
  limit: number;
  reserved: number;
}) {
  const usedPercent = limit > 0 ? ((spent + reserved) / limit) * 100 : 0;
  const isWarning = usedPercent > 80;
  const isDanger = usedPercent > 95;

  return (
    <div
      className="rounded-lg border p-4"
      style={{ borderColor: "var(--border-mabos)", backgroundColor: "var(--bg-secondary)" }}
    >
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
          {label}
        </span>
        <span
          className="text-xs"
          style={{
            color: isDanger
              ? "var(--accent-red, #ef4444)"
              : isWarning
                ? "var(--accent-yellow, #eab308)"
                : "var(--accent-green)",
          }}
        >
          ${(limit - spent - reserved).toFixed(2)} remaining
        </span>
      </div>
      <div
        className="h-2 rounded-full overflow-hidden"
        style={{ backgroundColor: "color-mix(in srgb, var(--text-secondary) 20%, transparent)" }}
      >
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{
            width: `${Math.min(usedPercent, 100)}%`,
            backgroundColor: isDanger
              ? "var(--accent-red, #ef4444)"
              : isWarning
                ? "var(--accent-yellow, #eab308)"
                : "var(--accent-green)",
          }}
        />
      </div>
      <div
        className="flex justify-between mt-1 text-[11px]"
        style={{ color: "var(--text-secondary)" }}
      >
        <span>${spent.toFixed(2)} spent</span>
        <span>${reserved.toFixed(2)} reserved</span>
        <span>${limit.toFixed(2)} limit</span>
      </div>
    </div>
  );
}

export function GovernancePage() {
  const [budgets, setBudgets] = useState<BudgetStatus[]>([]);
  const [auditLog, setAuditLog] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"budget" | "audit" | "roles">("budget");

  useEffect(() => {
    Promise.all([
      fetch("/mabos/governance/budget/summary")
        .then((r) => r.json())
        .catch(() => ({ budgets: [] })),
      fetch("/mabos/governance/audit?limit=50")
        .then((r) => r.json())
        .catch(() => ({ entries: [] })),
    ]).then(([budgetData, auditData]) => {
      setBudgets(budgetData.budgets ?? []);
      setAuditLog(auditData.entries ?? []);
      setLoading(false);
    });
  }, []);

  const tabs = [
    { id: "budget" as const, label: "Budget", icon: Wallet },
    { id: "audit" as const, label: "Audit Log", icon: FileText },
    { id: "roles" as const, label: "Roles", icon: Shield },
  ];

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: "var(--text-primary)" }}>
            Governance
          </h1>
          <p className="text-sm mt-1" style={{ color: "var(--text-secondary)" }}>
            Budget enforcement, audit trail, and access control
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 rounded-lg p-1" style={{ backgroundColor: "var(--bg-secondary)" }}>
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className="flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors"
              style={{
                color: activeTab === tab.id ? "var(--text-primary)" : "var(--text-secondary)",
                backgroundColor:
                  activeTab === tab.id
                    ? "color-mix(in srgb, var(--accent-purple) 15%, transparent)"
                    : "transparent",
              }}
            >
              <Icon className="h-4 w-4" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Budget Tab */}
      {activeTab === "budget" && (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {loading ? (
            Array.from({ length: 3 }).map((_, i) => (
              <div
                key={i}
                className="h-24 rounded-lg animate-pulse"
                style={{ backgroundColor: "var(--bg-secondary)" }}
              />
            ))
          ) : budgets.length === 0 ? (
            <div
              className="col-span-full rounded-lg border p-8 text-center"
              style={{ borderColor: "var(--border-mabos)", backgroundColor: "var(--bg-secondary)" }}
            >
              <Wallet className="mx-auto h-8 w-8 mb-3" style={{ color: "var(--text-secondary)" }} />
              <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
                No budget allocations configured. Enable governance in your MABOS config.
              </p>
            </div>
          ) : (
            budgets.map((b) => (
              <div key={b.agentId}>
                <h3 className="text-sm font-semibold mb-2" style={{ color: "var(--text-primary)" }}>
                  {b.agentId}
                </h3>
                {b.daily && (
                  <BudgetGauge
                    label="Daily"
                    spent={b.daily.spent}
                    limit={b.daily.limit}
                    reserved={b.daily.reserved}
                  />
                )}
                {b.monthly && (
                  <BudgetGauge
                    label="Monthly"
                    spent={b.monthly.spent}
                    limit={b.monthly.limit}
                    reserved={b.monthly.reserved}
                  />
                )}
              </div>
            ))
          )}
        </div>
      )}

      {/* Audit Tab */}
      {activeTab === "audit" && (
        <div
          className="rounded-lg border overflow-hidden"
          style={{ borderColor: "var(--border-mabos)" }}
        >
          <table className="w-full text-sm">
            <thead>
              <tr style={{ backgroundColor: "var(--bg-secondary)" }}>
                <th
                  className="text-left px-4 py-2 font-medium"
                  style={{ color: "var(--text-secondary)" }}
                >
                  Time
                </th>
                <th
                  className="text-left px-4 py-2 font-medium"
                  style={{ color: "var(--text-secondary)" }}
                >
                  Actor
                </th>
                <th
                  className="text-left px-4 py-2 font-medium"
                  style={{ color: "var(--text-secondary)" }}
                >
                  Action
                </th>
                <th
                  className="text-left px-4 py-2 font-medium"
                  style={{ color: "var(--text-secondary)" }}
                >
                  Resource
                </th>
                <th
                  className="text-left px-4 py-2 font-medium"
                  style={{ color: "var(--text-secondary)" }}
                >
                  Outcome
                </th>
              </tr>
            </thead>
            <tbody>
              {auditLog.length === 0 ? (
                <tr>
                  <td
                    colSpan={5}
                    className="px-4 py-8 text-center"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    No audit entries yet.
                  </td>
                </tr>
              ) : (
                auditLog.map((entry) => (
                  <tr
                    key={entry.id}
                    className="border-t"
                    style={{ borderColor: "var(--border-mabos)" }}
                  >
                    <td
                      className="px-4 py-2 font-mono text-xs"
                      style={{ color: "var(--text-secondary)" }}
                    >
                      {new Date(entry.timestamp).toLocaleString()}
                    </td>
                    <td className="px-4 py-2" style={{ color: "var(--text-primary)" }}>
                      <span
                        className="text-xs px-1.5 py-0.5 rounded"
                        style={{ backgroundColor: "var(--bg-secondary)" }}
                      >
                        {entry.actorType}
                      </span>{" "}
                      {entry.actorId}
                    </td>
                    <td className="px-4 py-2" style={{ color: "var(--text-primary)" }}>
                      {entry.action}
                    </td>
                    <td className="px-4 py-2" style={{ color: "var(--text-secondary)" }}>
                      {entry.resourceType ? `${entry.resourceType}:${entry.resourceId}` : "-"}
                    </td>
                    <td className="px-4 py-2">
                      <span
                        className="text-xs px-1.5 py-0.5 rounded"
                        style={{
                          backgroundColor:
                            entry.outcome === "success"
                              ? "color-mix(in srgb, var(--accent-green) 15%, transparent)"
                              : entry.outcome === "denied"
                                ? "color-mix(in srgb, var(--accent-red, #ef4444) 15%, transparent)"
                                : "var(--bg-secondary)",
                          color:
                            entry.outcome === "success"
                              ? "var(--accent-green)"
                              : entry.outcome === "denied"
                                ? "var(--accent-red, #ef4444)"
                                : "var(--text-secondary)",
                        }}
                      >
                        {entry.outcome}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Roles Tab */}
      {activeTab === "roles" && (
        <div className="grid gap-4 md:grid-cols-2">
          {[
            {
              role: "Admin",
              desc: "Full access to all tools and configuration",
              color: "var(--accent-purple)",
            },
            {
              role: "Operator",
              desc: "Can use all tools, view budgets, read config",
              color: "var(--accent-green)",
            },
            {
              role: "Agent",
              desc: "Can use business tools, denied destructive operations",
              color: "var(--accent-blue, #3b82f6)",
            },
            {
              role: "Viewer",
              desc: "Read-only access to data and budgets",
              color: "var(--text-secondary)",
            },
          ].map((r) => (
            <div
              key={r.role}
              className="rounded-lg border p-4"
              style={{ borderColor: "var(--border-mabos)", backgroundColor: "var(--bg-secondary)" }}
            >
              <div className="flex items-center gap-2 mb-1">
                <div className="h-2 w-2 rounded-full" style={{ backgroundColor: r.color }} />
                <span className="font-semibold text-sm" style={{ color: "var(--text-primary)" }}>
                  {r.role}
                </span>
              </div>
              <p className="text-xs" style={{ color: "var(--text-secondary)" }}>
                {r.desc}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
