import { Heart, MessageSquare, ChevronRight, Package, Shield } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useContractors } from "@/hooks/useContractors";
import type { Contractor } from "@/lib/types";

const upcomingFeatures = [
  "Employee directory and profiles",
  "Hiring pipeline and applicant tracking",
  "Attendance tracking and leave management",
  "Performance reviews and goal setting",
];

const statusColors: Record<string, string> = {
  active: "var(--accent-green)",
  inactive: "var(--text-muted)",
  pending: "var(--accent-orange)",
};

function ContractorCard({ contractor }: { contractor: Contractor }) {
  const statusColor = statusColors[contractor.status] || "var(--text-muted)";

  return (
    <Card className="bg-[var(--bg-card)] border-[var(--border-mabos)] py-4">
      <CardContent className="space-y-3">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-sm font-medium text-[var(--text-primary)]">{contractor.name}</p>
            <p className="text-xs text-[var(--text-muted)]">{contractor.role}</p>
          </div>
          <Badge
            variant="outline"
            className="text-[10px] capitalize"
            style={{
              borderColor: `color-mix(in srgb, ${statusColor} 40%, transparent)`,
              color: statusColor,
            }}
          >
            {contractor.status}
          </Badge>
        </div>

        {/* Trust Score */}
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-xs text-[var(--text-muted)] flex items-center gap-1">
              <Shield className="w-3 h-3" />
              Trust Score
            </span>
            <span className="text-xs text-[var(--text-secondary)]">{contractor.trustScore}%</span>
          </div>
          <div className="h-1.5 rounded-full bg-[var(--bg-tertiary)]">
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${contractor.trustScore}%`,
                backgroundColor:
                  contractor.trustScore >= 80
                    ? "var(--accent-green)"
                    : contractor.trustScore >= 50
                      ? "var(--accent-orange)"
                      : "var(--accent-red)",
              }}
            />
          </div>
        </div>

        {/* Packages */}
        <div className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
          <Package className="w-3 h-3" />
          {contractor.packages} package{contractor.packages !== 1 ? "s" : ""}
        </div>
      </CardContent>
    </Card>
  );
}

export function HRPage() {
  const { data: contractorsRaw } = useContractors();
  const contractors = contractorsRaw?.contractors;
  const hasContractors = contractors && contractors.length > 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div
          className="w-10 h-10 rounded-lg flex items-center justify-center"
          style={{
            backgroundColor: "color-mix(in srgb, var(--accent-purple) 15%, var(--bg-card))",
          }}
        >
          <Heart className="w-5 h-5 text-[var(--accent-purple)]" />
        </div>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold text-[var(--text-primary)]">HR & Workforce</h1>
            {!hasContractors && (
              <Badge
                variant="outline"
                className="border-[var(--accent-purple)]/30 text-[var(--accent-purple)] text-[10px]"
              >
                Coming Soon
              </Badge>
            )}
          </div>
          <p className="text-sm text-[var(--text-secondary)] mt-0.5">
            {hasContractors
              ? `${contractors.length} contractor${contractors.length !== 1 ? "s" : ""} in workforce`
              : "Workforce management and employee engagement"}
          </p>
        </div>
      </div>

      {/* Workforce Grid (when data available) */}
      {hasContractors && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {contractors.map((contractor) => (
            <ContractorCard key={contractor.id} contractor={contractor} />
          ))}
        </div>
      )}

      {/* Fallback content when no contractors */}
      {!hasContractors && (
        <div className="max-w-2xl space-y-6">
          {/* Description card */}
          <Card className="border-[var(--border-mabos)] bg-[var(--bg-card)] shadow-none">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-[var(--text-secondary)]">
                About this Module
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-[var(--text-primary)] leading-relaxed">
                Workforce management, hiring pipelines, and employee engagement.
              </p>
              <p className="text-sm text-[var(--text-muted)] mt-3 leading-relaxed">
                While this module is under development, you can interact with the{" "}
                <span className="text-[var(--accent-purple)] font-medium">HR (Harbor)</span> agent
                through the chat panel for workforce queries and operations.
              </p>
            </CardContent>
          </Card>

          {/* Upcoming features */}
          <Card className="border-[var(--border-mabos)] bg-[var(--bg-card)] shadow-none">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-[var(--text-secondary)]">
                Upcoming Features
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-3">
                {upcomingFeatures.map((feature) => (
                  <li key={feature} className="flex items-center gap-3">
                    <ChevronRight className="w-4 h-4 text-[var(--accent-purple)] shrink-0" />
                    <span className="text-sm text-[var(--text-primary)]">{feature}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>

          {/* Chat CTA */}
          <Card className="border-[var(--border-mabos)] bg-[var(--bg-card)] shadow-none">
            <CardContent className="py-4">
              <div className="flex items-center gap-3">
                <div
                  className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
                  style={{
                    backgroundColor: "color-mix(in srgb, var(--accent-green) 15%, var(--bg-card))",
                  }}
                >
                  <MessageSquare className="w-4 h-4 text-[var(--accent-green)]" />
                </div>
                <div>
                  <p className="text-sm font-medium text-[var(--text-primary)]">
                    Use the Chat Panel
                  </p>
                  <p className="text-xs text-[var(--text-muted)] mt-0.5">
                    Open the chat panel and ask the HR (Harbor) agent about employees, hiring, or
                    attendance.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
