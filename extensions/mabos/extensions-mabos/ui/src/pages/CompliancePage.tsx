import { ShieldCheck } from "lucide-react";
import { AlertTriangle, CheckCircle, XCircle, FileText } from "lucide-react";
import { useState } from "react";
import { ComplianceGauge } from "@/components/compliance/ComplianceGauge";
import { PolicyTable } from "@/components/compliance/PolicyTable";
import { ViolationTable } from "@/components/compliance/ViolationTable";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { StatCard, StatCardRow } from "@/components/ui/stat-card";
import { usePolicies, useViolations } from "@/hooks/useCompliance";

const severityOptions = ["all", "critical", "high", "medium", "low"] as const;
const tabs = ["Violations", "Policies"] as const;

export function CompliancePage() {
  const [activeTab, setActiveTab] = useState<(typeof tabs)[number]>("Violations");
  const [severityFilter, setSeverityFilter] = useState("all");

  const { data: policiesData, isLoading: policiesLoading } = usePolicies();
  const { data: violationsData, isLoading: violationsLoading } = useViolations(
    severityFilter !== "all" ? { severity: severityFilter } : undefined,
  );

  const policies = policiesData?.policies ?? [];
  const violations = violationsData?.violations ?? [];
  const openViolations = violations.filter((v) => v.status !== "resolved").length;
  const resolvedViolations = violations.filter((v) => v.status === "resolved").length;
  const criticalCount = violations.filter(
    (v) => v.severity === "critical" && v.status !== "resolved",
  ).length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div
          className="w-10 h-10 rounded-lg flex items-center justify-center"
          style={{ backgroundColor: "color-mix(in srgb, var(--accent-green) 15%, var(--bg-card))" }}
        >
          <ShieldCheck className="w-5 h-5 text-[var(--accent-green)]" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)]">Compliance</h1>
          <p className="text-sm text-[var(--text-secondary)]">
            Policies, violations, and compliance tracking
          </p>
        </div>
      </div>

      {/* Gauge */}
      <Card className="border-[var(--border-mabos)] bg-[var(--bg-card)] shadow-none">
        <CardContent className="py-6">
          <ComplianceGauge policies={policies} violations={violations} />
        </CardContent>
      </Card>

      {/* Stats */}
      <StatCardRow isLoading={policiesLoading || violationsLoading}>
        <StatCard
          label="Total Policies"
          value={policies.length}
          icon={FileText}
          color="var(--accent-blue)"
        />
        <StatCard
          label="Open Violations"
          value={openViolations}
          icon={AlertTriangle}
          color="var(--accent-orange)"
        />
        <StatCard
          label="Resolved"
          value={resolvedViolations}
          icon={CheckCircle}
          color="var(--accent-green)"
        />
        <StatCard label="Critical" value={criticalCount} icon={XCircle} color="var(--accent-red)" />
      </StatCardRow>

      {/* Tabs + Content */}
      <Card className="border-[var(--border-mabos)] bg-[var(--bg-card)] shadow-none">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <div className="flex gap-1">
              {tabs.map((tab) => (
                <button
                  key={tab}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                    activeTab === tab
                      ? "bg-[var(--accent-green)] text-white"
                      : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                  }`}
                  onClick={() => setActiveTab(tab)}
                >
                  {tab}
                </button>
              ))}
            </div>
            {activeTab === "Violations" && (
              <select
                className="text-xs px-2 py-1 rounded border border-[var(--border-mabos)] bg-[var(--bg-secondary)] text-[var(--text-primary)]"
                value={severityFilter}
                onChange={(e) => setSeverityFilter(e.target.value)}
              >
                {severityOptions.map((s) => (
                  <option key={s} value={s}>
                    {s === "all" ? "All Severities" : s.charAt(0).toUpperCase() + s.slice(1)}
                  </option>
                ))}
              </select>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {activeTab === "Violations" ? (
            <ViolationTable violations={violations} isLoading={violationsLoading} />
          ) : (
            <PolicyTable policies={policies} isLoading={policiesLoading} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
