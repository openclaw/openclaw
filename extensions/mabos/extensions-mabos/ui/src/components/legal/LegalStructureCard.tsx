import { Building2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { LegalStructure } from "@/lib/types";

type Props = {
  structure: LegalStructure | null | undefined;
};

export function LegalStructureCard({ structure }: Props) {
  if (!structure) {
    return (
      <Card className="border-[var(--border-mabos)] bg-[var(--bg-card)] shadow-none">
        <CardContent className="py-6 text-center text-sm text-[var(--text-muted)]">
          No legal structure configured
        </CardContent>
      </Card>
    );
  }

  const fields = [
    { label: "Business Name", value: structure.business_name },
    { label: "Legal Name", value: structure.legal_name },
    { label: "Entity Type", value: structure.entity_type?.toUpperCase() },
    { label: "EIN", value: structure.ein },
    { label: "State", value: structure.state_of_formation },
    {
      label: "Formation Date",
      value: structure.formation_date
        ? new Date(structure.formation_date).toLocaleDateString()
        : null,
    },
    { label: "Registered Agent", value: structure.registered_agent },
    { label: "Address", value: structure.principal_address },
  ];

  return (
    <Card className="border-[var(--border-mabos)] bg-[var(--bg-card)] shadow-none">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-[var(--text-secondary)] flex items-center gap-2">
          <Building2 className="w-4 h-4" /> Legal Entity
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-3">
          {fields.map(({ label, value }) => (
            <div key={label}>
              <p className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
                {label}
              </p>
              <p className="text-sm text-[var(--text-primary)] mt-0.5">{value || "—"}</p>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
