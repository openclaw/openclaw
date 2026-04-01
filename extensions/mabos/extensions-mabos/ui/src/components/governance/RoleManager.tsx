import { Shield, UserPlus, RefreshCw, AlertTriangle } from "lucide-react";
import { useEffect, useState } from "react";

type Role = {
  id: string;
  name: string;
  permissions: string[];
  agentCount: number;
};

export function RoleManager() {
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [assigning, setAssigning] = useState<string | null>(null);
  const [agentIdInput, setAgentIdInput] = useState("");
  const [assignError, setAssignError] = useState<string | null>(null);

  const fetchRoles = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/mabos/governance/roles");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setRoles(Array.isArray(json) ? json : (json.roles ?? []));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load roles");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRoles();
  }, []);

  const assignRole = async (roleId: string) => {
    if (!agentIdInput.trim()) return;
    setAssignError(null);
    try {
      const res = await fetch(`/mabos/governance/roles/${agentIdInput.trim()}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roleId }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(body || `HTTP ${res.status}`);
      }
      setAssigning(null);
      setAgentIdInput("");
      // Refresh to show updated counts
      fetchRoles();
    } catch (err) {
      setAssignError(err instanceof Error ? err.message : "Assignment failed");
    }
  };

  return (
    <div
      className="rounded-lg border p-5 space-y-4"
      style={{
        backgroundColor: "var(--bg-card)",
        borderColor: "var(--border-mabos)",
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div
            className="flex items-center justify-center w-8 h-8 rounded-lg"
            style={{ backgroundColor: "color-mix(in srgb, var(--accent-orange) 15%, transparent)" }}
          >
            <Shield className="w-4 h-4" style={{ color: "var(--accent-orange)" }} />
          </div>
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">Role Manager</h3>
        </div>
        <button
          type="button"
          onClick={fetchRoles}
          disabled={loading}
          className="p-1.5 rounded-md hover:bg-[var(--bg-tertiary)] transition-colors disabled:opacity-50"
          title="Refresh"
        >
          <RefreshCw
            className={`w-4 h-4 text-[var(--text-muted)] ${loading ? "animate-spin" : ""}`}
          />
        </button>
      </div>

      {error && (
        <p className="text-xs text-[var(--accent-red)] bg-[var(--bg-tertiary)] rounded-md px-3 py-2">
          {error}
        </p>
      )}

      {/* Loading */}
      {loading && (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="h-16 rounded-md animate-pulse"
              style={{ backgroundColor: "var(--bg-tertiary)" }}
            />
          ))}
        </div>
      )}

      {/* Roles table */}
      {!loading && roles.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b text-left" style={{ borderColor: "var(--border-mabos)" }}>
                <th className="pb-2 pr-4 font-medium text-[var(--text-muted)]">Role</th>
                <th className="pb-2 pr-4 font-medium text-[var(--text-muted)]">Permissions</th>
                <th className="pb-2 pr-4 font-medium text-[var(--text-muted)]">Agents</th>
                <th className="pb-2 font-medium text-[var(--text-muted)]">Actions</th>
              </tr>
            </thead>
            <tbody>
              {roles.map((role) => (
                <tr
                  key={role.id}
                  className="border-b last:border-b-0"
                  style={{ borderColor: "var(--border-mabos)" }}
                >
                  <td className="py-3 pr-4">
                    <span className="text-[var(--text-primary)] font-medium">{role.name}</span>
                  </td>
                  <td className="py-3 pr-4">
                    <div className="flex flex-wrap gap-1">
                      {role.permissions.slice(0, 5).map((perm) => (
                        <span
                          key={perm}
                          className="inline-block px-1.5 py-0.5 rounded text-[10px] font-mono"
                          style={{
                            backgroundColor: "var(--bg-tertiary)",
                            color: "var(--text-secondary)",
                          }}
                        >
                          {perm}
                        </span>
                      ))}
                      {role.permissions.length > 5 && (
                        <span className="text-[10px] text-[var(--text-muted)]">
                          +{role.permissions.length - 5} more
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="py-3 pr-4 text-[var(--text-secondary)]">{role.agentCount}</td>
                  <td className="py-3">
                    {assigning === role.id ? (
                      <div className="flex items-center gap-1.5">
                        <input
                          type="text"
                          value={agentIdInput}
                          onChange={(e) => setAgentIdInput(e.target.value)}
                          placeholder="Agent ID"
                          className="w-28 px-2 py-1 text-xs rounded border bg-[var(--bg-secondary)] border-[var(--border-mabos)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-blue)]"
                          onKeyDown={(e) => {
                            if (e.key === "Enter") assignRole(role.id);
                            if (e.key === "Escape") {
                              setAssigning(null);
                              setAgentIdInput("");
                              setAssignError(null);
                            }
                          }}
                        />
                        <button
                          type="button"
                          onClick={() => assignRole(role.id)}
                          className="px-2 py-1 rounded text-xs font-medium transition-colors"
                          style={{
                            backgroundColor: "var(--accent-green)",
                            color: "var(--bg-primary)",
                          }}
                        >
                          Assign
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setAssigning(null);
                            setAgentIdInput("");
                            setAssignError(null);
                          }}
                          className="px-2 py-1 rounded text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setAssigning(role.id);
                          setAssignError(null);
                        }}
                        className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors hover:bg-[var(--bg-tertiary)] text-[var(--accent-blue)]"
                      >
                        <UserPlus className="w-3 h-3" />
                        Assign
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Assign error */}
      {assignError && (
        <div
          className="flex items-center gap-2 text-xs px-3 py-2 rounded-md"
          style={{
            backgroundColor: "color-mix(in srgb, var(--accent-red) 15%, transparent)",
            color: "var(--accent-red)",
          }}
        >
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          {assignError}
        </div>
      )}

      {/* Empty state */}
      {!loading && roles.length === 0 && !error && (
        <p className="text-sm text-center text-[var(--text-muted)] py-6">No roles configured</p>
      )}
    </div>
  );
}
