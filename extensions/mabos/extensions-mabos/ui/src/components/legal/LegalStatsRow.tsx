import { Scale, Clock, FileText, Shield } from "lucide-react";
import { StatCard, StatCardRow } from "@/components/ui/stat-card";
import type {
  PartnershipContract,
  FreelancerContract,
  CorporateDocument,
  ComplianceGuardrail,
} from "@/lib/types";

type Props = {
  partnerContracts: PartnershipContract[] | undefined;
  freelancerContracts: FreelancerContract[] | undefined;
  corporateDocs: CorporateDocument[] | undefined;
  guardrails: ComplianceGuardrail[] | undefined;
  isLoading: boolean;
};

export function LegalStatsRow({
  partnerContracts,
  freelancerContracts,
  corporateDocs,
  guardrails,
  isLoading,
}: Props) {
  const activeContracts =
    (partnerContracts?.filter((c) => c.status === "active").length ?? 0) +
    (freelancerContracts?.filter((c) => c.status === "active").length ?? 0);
  const now = new Date();
  const thirtyDays = new Date(now.getTime() + 30 * 86400000).toISOString();
  const expiringSoon =
    (partnerContracts?.filter(
      (c) => c.end_date && c.end_date <= thirtyDays && c.end_date >= now.toISOString(),
    ).length ?? 0) +
    (freelancerContracts?.filter(
      (c) => c.end_date && c.end_date <= thirtyDays && c.end_date >= now.toISOString(),
    ).length ?? 0);
  const docCount = corporateDocs?.length ?? 0;
  const activeGuardrails = guardrails?.filter((g) => g.active).length ?? 0;

  return (
    <StatCardRow isLoading={isLoading}>
      <StatCard
        label="Active Contracts"
        value={activeContracts}
        icon={Scale}
        color="var(--accent-purple)"
      />
      <StatCard
        label="Expiring Soon"
        value={expiringSoon}
        icon={Clock}
        color="var(--accent-orange)"
      />
      <StatCard
        label="Corporate Docs"
        value={docCount}
        icon={FileText}
        color="var(--accent-blue)"
      />
      <StatCard
        label="Active Guardrails"
        value={activeGuardrails}
        icon={Shield}
        color="var(--accent-green)"
      />
    </StatCardRow>
  );
}
