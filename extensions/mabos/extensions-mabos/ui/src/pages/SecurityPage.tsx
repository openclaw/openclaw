import { Shield, AlertTriangle, CheckCircle, Clock, XCircle } from "lucide-react";
import { useState, useEffect } from "react";

interface ApprovalRequest {
  id: string;
  toolName: string;
  actorRole: string;
  reason: string;
  createdAt: number;
  redactedArgs: Record<string, unknown>;
}

interface ScanEvent {
  timestamp: string;
  toolName: string;
  pattern: string;
  threat: string;
  blocked: boolean;
}

export function SecurityPage() {
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [scanLog, setScanLog] = useState<ScanEvent[]>([]);
  const [activeTab, setActiveTab] = useState<"overview" | "approvals" | "scans">("overview");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch("/mabos/security/approvals")
        .then((r) => r.json())
        .catch(() => ({ approvals: [] })),
      fetch("/mabos/security/scan-log")
        .then((r) => r.json())
        .catch(() => ({ events: [] })),
    ]).then(([appData, scanData]) => {
      setApprovals(appData.approvals ?? []);
      setScanLog(scanData.events ?? []);
      setLoading(false);
    });
  }, []);

  const stats = {
    totalScans: scanLog.length,
    blocked: scanLog.filter((s) => s.blocked).length,
    pendingApprovals: approvals.length,
    threatBreakdown: scanLog.reduce<Record<string, number>>((acc, s) => {
      acc[s.threat] = (acc[s.threat] ?? 0) + 1;
      return acc;
    }, {}),
  };

  const tabs = [
    { id: "overview" as const, label: "Overview" },
    {
      id: "approvals" as const,
      label: `Approvals${approvals.length > 0 ? ` (${approvals.length})` : ""}`,
    },
    { id: "scans" as const, label: "Scan Log" },
  ];

  return (
    <div className="flex flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-bold" style={{ color: "var(--text-primary)" }}>
          Security
        </h1>
        <p className="text-sm mt-1" style={{ color: "var(--text-secondary)" }}>
          Injection detection, tool approval gates, and threat monitoring
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 rounded-lg p-1" style={{ backgroundColor: "var(--bg-secondary)" }}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className="rounded-md px-4 py-2 text-sm font-medium transition-colors"
            style={{
              color: activeTab === tab.id ? "var(--text-primary)" : "var(--text-secondary)",
              backgroundColor:
                activeTab === tab.id
                  ? "color-mix(in srgb, var(--accent-purple) 15%, transparent)"
                  : "transparent",
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Overview */}
      {activeTab === "overview" && (
        <div className="grid gap-4 md:grid-cols-3">
          <div
            className="rounded-lg border p-4"
            style={{ borderColor: "var(--border-mabos)", backgroundColor: "var(--bg-secondary)" }}
          >
            <div className="flex items-center gap-2 mb-2">
              <Shield className="h-4 w-4" style={{ color: "var(--accent-green)" }} />
              <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
                Scans
              </span>
            </div>
            <p className="text-2xl font-bold" style={{ color: "var(--text-primary)" }}>
              {stats.totalScans}
            </p>
            <p className="text-xs" style={{ color: "var(--text-secondary)" }}>
              {stats.blocked} blocked
            </p>
          </div>
          <div
            className="rounded-lg border p-4"
            style={{ borderColor: "var(--border-mabos)", backgroundColor: "var(--bg-secondary)" }}
          >
            <div className="flex items-center gap-2 mb-2">
              <AlertTriangle
                className="h-4 w-4"
                style={{ color: "var(--accent-yellow, #eab308)" }}
              />
              <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
                Pending Approvals
              </span>
            </div>
            <p className="text-2xl font-bold" style={{ color: "var(--text-primary)" }}>
              {stats.pendingApprovals}
            </p>
            <p className="text-xs" style={{ color: "var(--text-secondary)" }}>
              requiring operator action
            </p>
          </div>
          <div
            className="rounded-lg border p-4"
            style={{ borderColor: "var(--border-mabos)", backgroundColor: "var(--bg-secondary)" }}
          >
            <div className="flex items-center gap-2 mb-2">
              <CheckCircle className="h-4 w-4" style={{ color: "var(--accent-green)" }} />
              <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
                Status
              </span>
            </div>
            <p className="text-2xl font-bold" style={{ color: "var(--accent-green)" }}>
              Active
            </p>
            <p className="text-xs" style={{ color: "var(--text-secondary)" }}>
              scanner + guard + SSRF
            </p>
          </div>
        </div>
      )}

      {/* Approvals */}
      {activeTab === "approvals" && (
        <div className="flex flex-col gap-3">
          {approvals.length === 0 ? (
            <div
              className="rounded-lg border p-8 text-center"
              style={{ borderColor: "var(--border-mabos)", backgroundColor: "var(--bg-secondary)" }}
            >
              <CheckCircle
                className="mx-auto h-8 w-8 mb-3"
                style={{ color: "var(--accent-green)" }}
              />
              <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
                No pending approvals.
              </p>
            </div>
          ) : (
            approvals.map((a) => (
              <div
                key={a.id}
                className="rounded-lg border p-4"
                style={{
                  borderColor: "var(--border-mabos)",
                  backgroundColor: "var(--bg-secondary)",
                }}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="font-semibold text-sm" style={{ color: "var(--text-primary)" }}>
                    {a.toolName}
                  </span>
                  <span className="text-xs" style={{ color: "var(--text-secondary)" }}>
                    <Clock className="inline h-3 w-3 mr-1" />
                    {new Date(a.createdAt).toLocaleString()}
                  </span>
                </div>
                <p className="text-xs mb-3" style={{ color: "var(--text-secondary)" }}>
                  {a.reason}
                </p>
                <div className="flex gap-2">
                  <button
                    className="rounded px-3 py-1.5 text-xs font-medium"
                    style={{ backgroundColor: "var(--accent-green)", color: "white" }}
                  >
                    Approve
                  </button>
                  <button
                    className="rounded px-3 py-1.5 text-xs font-medium border"
                    style={{ borderColor: "var(--border-mabos)", color: "var(--text-secondary)" }}
                  >
                    Deny
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* Scan Log */}
      {activeTab === "scans" && (
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
                  Tool
                </th>
                <th
                  className="text-left px-4 py-2 font-medium"
                  style={{ color: "var(--text-secondary)" }}
                >
                  Pattern
                </th>
                <th
                  className="text-left px-4 py-2 font-medium"
                  style={{ color: "var(--text-secondary)" }}
                >
                  Threat
                </th>
                <th
                  className="text-left px-4 py-2 font-medium"
                  style={{ color: "var(--text-secondary)" }}
                >
                  Action
                </th>
              </tr>
            </thead>
            <tbody>
              {scanLog.length === 0 ? (
                <tr>
                  <td
                    colSpan={5}
                    className="px-4 py-8 text-center"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    No scan events recorded.
                  </td>
                </tr>
              ) : (
                scanLog.map((event, i) => (
                  <tr key={i} className="border-t" style={{ borderColor: "var(--border-mabos)" }}>
                    <td
                      className="px-4 py-2 font-mono text-xs"
                      style={{ color: "var(--text-secondary)" }}
                    >
                      {new Date(event.timestamp).toLocaleString()}
                    </td>
                    <td className="px-4 py-2" style={{ color: "var(--text-primary)" }}>
                      {event.toolName}
                    </td>
                    <td className="px-4 py-2" style={{ color: "var(--text-primary)" }}>
                      {event.pattern}
                    </td>
                    <td className="px-4 py-2">
                      <span
                        className="text-xs px-1.5 py-0.5 rounded"
                        style={{
                          backgroundColor:
                            event.threat === "critical"
                              ? "color-mix(in srgb, var(--accent-red, #ef4444) 15%, transparent)"
                              : event.threat === "high"
                                ? "color-mix(in srgb, var(--accent-yellow, #eab308) 15%, transparent)"
                                : "var(--bg-secondary)",
                          color:
                            event.threat === "critical"
                              ? "var(--accent-red, #ef4444)"
                              : event.threat === "high"
                                ? "var(--accent-yellow, #eab308)"
                                : "var(--text-secondary)",
                        }}
                      >
                        {event.threat}
                      </span>
                    </td>
                    <td className="px-4 py-2">
                      {event.blocked ? (
                        <span
                          className="flex items-center gap-1 text-xs"
                          style={{ color: "var(--accent-red, #ef4444)" }}
                        >
                          <XCircle className="h-3 w-3" /> Blocked
                        </span>
                      ) : (
                        <span
                          className="flex items-center gap-1 text-xs"
                          style={{ color: "var(--accent-yellow, #eab308)" }}
                        >
                          <AlertTriangle className="h-3 w-3" /> Warned
                        </span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
