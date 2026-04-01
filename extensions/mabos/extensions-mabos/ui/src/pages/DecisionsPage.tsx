import { Bell, AlertCircle } from "lucide-react";
import { useMemo, useState } from "react";
import { DecisionCard } from "@/components/decisions/DecisionCard";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { usePanels } from "@/contexts/PanelContext";
import { useDecisions } from "@/hooks/useDecisions";
import type { DecisionUrgency } from "@/lib/types";

const urgencyOptions: DecisionUrgency[] = ["critical", "high", "medium", "low"];

function DecisionCardSkeleton() {
  return (
    <Card className="bg-[var(--bg-card)] border-[var(--border-mabos)] py-4">
      <CardContent className="space-y-3">
        <div className="flex items-start justify-between">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-5 w-14 rounded-full" />
        </div>
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-2/3" />
        <div className="flex gap-2">
          <Skeleton className="h-5 w-20 rounded-full" />
          <Skeleton className="h-5 w-20 rounded-full" />
        </div>
      </CardContent>
    </Card>
  );
}

export function DecisionsPage() {
  const { data: decisions, isLoading, error } = useDecisions();
  const { openDetailPanel } = usePanels();
  const [urgencyFilter, setUrgencyFilter] = useState<DecisionUrgency | "all">("all");
  const [businessFilter, setBusinessFilter] = useState<string>("all");

  const businessNames = useMemo(() => {
    if (!decisions) return [];
    const names = new Set(decisions.map((d) => d.businessName));
    return Array.from(names);
  }, [decisions]);

  const filtered = useMemo(() => {
    if (!decisions) return [];
    return decisions.filter((d) => {
      if (urgencyFilter !== "all" && d.urgency !== urgencyFilter) return false;
      if (businessFilter !== "all" && d.businessName !== businessFilter) return false;
      return true;
    });
  }, [decisions, urgencyFilter, businessFilter]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div
          className="flex items-center justify-center w-10 h-10 rounded-lg"
          style={{
            backgroundColor: `color-mix(in srgb, var(--accent-orange) 15%, transparent)`,
          }}
        >
          <Bell className="w-5 h-5 text-[var(--accent-orange)]" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)]">Decision Queue</h1>
          <p className="text-sm text-[var(--text-secondary)]">
            {decisions
              ? `${decisions.length} pending decision${decisions.length !== 1 ? "s" : ""}`
              : "Loading decisions..."}
          </p>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="flex items-center gap-3 p-4 rounded-lg bg-[color-mix(in_srgb,var(--accent-red)_10%,var(--bg-card))] border border-[var(--accent-red)]/20">
          <AlertCircle className="w-5 h-5 text-[var(--accent-red)] shrink-0" />
          <div>
            <p className="text-sm font-medium text-[var(--text-primary)]">
              Failed to load decisions
            </p>
            <p className="text-xs text-[var(--text-secondary)]">
              Unable to fetch decisions from the API. Please try again later.
            </p>
          </div>
        </div>
      )}

      {/* Filter row */}
      {!isLoading && decisions && decisions.length > 0 && (
        <div className="flex items-center gap-3 flex-wrap">
          <select
            value={urgencyFilter}
            onChange={(e) => setUrgencyFilter(e.target.value as DecisionUrgency | "all")}
            className="px-3 py-1.5 text-sm rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-mabos)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-purple)]"
          >
            <option value="all">All Urgencies</option>
            {urgencyOptions.map((u) => (
              <option key={u} value={u} className="capitalize">
                {u.charAt(0).toUpperCase() + u.slice(1)}
              </option>
            ))}
          </select>

          <select
            value={businessFilter}
            onChange={(e) => setBusinessFilter(e.target.value)}
            className="px-3 py-1.5 text-sm rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-mabos)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-purple)]"
          >
            <option value="all">All Businesses</option>
            {businessNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Decision Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {isLoading
          ? Array.from({ length: 6 }).map((_, i) => <DecisionCardSkeleton key={i} />)
          : filtered.map((decision) => (
              <DecisionCard
                key={decision.id}
                decision={decision}
                onClick={() => openDetailPanel("decision", decision.id, decision)}
              />
            ))}
      </div>

      {/* Empty state */}
      {!isLoading && !error && filtered.length === 0 && (
        <div className="text-center py-12">
          <Bell className="w-12 h-12 text-[var(--text-muted)] mx-auto mb-4" />
          <p className="text-sm text-[var(--text-secondary)]">
            {decisions && decisions.length > 0
              ? "No decisions match the current filters."
              : "No pending decisions."}
          </p>
        </div>
      )}
    </div>
  );
}
