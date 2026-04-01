import { Users, UserPlus, UserCheck, Target } from "lucide-react";
import { StatCard, StatCardRow } from "@/components/ui/stat-card";
import type { Contact } from "@/lib/types";

type Props = {
  contacts: Contact[] | undefined;
  isLoading: boolean;
};

export function CustomerStatsRow({ contacts, isLoading }: Props) {
  const total = contacts?.length ?? 0;
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const newThisMonth = contacts?.filter((c) => c.created_at >= monthStart).length ?? 0;
  const active = contacts?.filter((c) => c.lifecycle_stage === "customer").length ?? 0;
  const leads = contacts?.filter((c) => c.lifecycle_stage === "lead").length ?? 0;

  return (
    <StatCardRow isLoading={isLoading}>
      <StatCard label="Total Contacts" value={total} icon={Users} color="var(--accent-purple)" />
      <StatCard
        label="New This Month"
        value={newThisMonth}
        icon={UserPlus}
        color="var(--accent-blue)"
      />
      <StatCard
        label="Active Customers"
        value={active}
        icon={UserCheck}
        color="var(--accent-green)"
      />
      <StatCard label="Leads" value={leads} icon={Target} color="var(--accent-orange)" />
    </StatCardRow>
  );
}
