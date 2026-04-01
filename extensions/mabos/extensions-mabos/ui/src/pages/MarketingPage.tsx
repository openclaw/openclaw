import { Megaphone } from "lucide-react";
import { useState } from "react";
import { CampaignTable } from "@/components/marketing/CampaignTable";
import { KpiProgressCards } from "@/components/marketing/KpiProgressCards";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useCampaigns, useMarketingKpis } from "@/hooks/useMarketing";

const statusOptions = ["all", "active", "paused", "completed", "draft"] as const;

export function MarketingPage() {
  const [statusFilter, setStatusFilter] = useState("all");

  const { data: campaignsData, isLoading: campaignsLoading } = useCampaigns(
    statusFilter !== "all" ? { status: statusFilter } : undefined,
  );
  const { data: kpisData, isLoading: kpisLoading } = useMarketingKpis();

  const campaigns = campaignsData?.campaigns ?? [];
  const kpis = kpisData?.kpis ?? [];

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
          <Megaphone className="w-5 h-5 text-[var(--accent-purple)]" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)]">Marketing</h1>
          <p className="text-sm text-[var(--text-secondary)]">Campaigns and marketing KPIs</p>
        </div>
      </div>

      {/* KPI Progress Cards */}
      <KpiProgressCards kpis={kpis} isLoading={kpisLoading} />

      {/* Campaign Table */}
      <Card className="border-[var(--border-mabos)] bg-[var(--bg-card)] shadow-none">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-medium text-[var(--text-secondary)]">
              Campaigns
            </CardTitle>
            <select
              className="text-xs px-2 py-1 rounded border border-[var(--border-mabos)] bg-[var(--bg-secondary)] text-[var(--text-primary)]"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              {statusOptions.map((s) => (
                <option key={s} value={s}>
                  {s === "all" ? "All Statuses" : s.charAt(0).toUpperCase() + s.slice(1)}
                </option>
              ))}
            </select>
          </div>
        </CardHeader>
        <CardContent>
          <CampaignTable campaigns={campaigns} isLoading={campaignsLoading} />
        </CardContent>
      </Card>
    </div>
  );
}
