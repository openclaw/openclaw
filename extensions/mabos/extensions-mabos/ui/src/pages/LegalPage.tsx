import { Scale } from "lucide-react";
import { useState } from "react";
import { ContractTable } from "@/components/legal/ContractTable";
import { CorporateDocList } from "@/components/legal/CorporateDocList";
import { GuardrailTable } from "@/components/legal/GuardrailTable";
import { LegalStatsRow } from "@/components/legal/LegalStatsRow";
import { LegalStructureCard } from "@/components/legal/LegalStructureCard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  usePartnershipContracts,
  useFreelancerContracts,
  useCorporateDocuments,
  useLegalStructure,
  useComplianceGuardrails,
} from "@/hooks/useLegal";

const tabs = ["Contracts", "Corporate Documents", "Business Info"] as const;
const contractSubTabs = ["Partnership", "Freelancer"] as const;

export function LegalPage() {
  const [activeTab, setActiveTab] = useState<(typeof tabs)[number]>("Contracts");
  const [contractTab, setContractTab] = useState<(typeof contractSubTabs)[number]>("Partnership");

  const { data: partnerData, isLoading: partnerLoading } = usePartnershipContracts();
  const { data: freelancerData, isLoading: freelancerLoading } = useFreelancerContracts();
  const { data: docsData, isLoading: docsLoading } = useCorporateDocuments();
  const { data: structureData } = useLegalStructure();
  const { data: guardrailsData, isLoading: guardrailsLoading } = useComplianceGuardrails();

  const partnerContracts = partnerData?.contracts ?? [];
  const freelancerContracts = freelancerData?.contracts ?? [];
  const corporateDocs = docsData?.documents ?? [];
  const structure = structureData?.structure ?? null;
  const guardrails = guardrailsData?.guardrails ?? [];

  const isLoading = partnerLoading || freelancerLoading || docsLoading || guardrailsLoading;

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
          <Scale className="w-5 h-5 text-[var(--accent-purple)]" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)]">Legal</h1>
          <p className="text-sm text-[var(--text-secondary)]">
            Contracts, corporate documents, and compliance
          </p>
        </div>
      </div>

      {/* Stats */}
      <LegalStatsRow
        partnerContracts={partnerContracts}
        freelancerContracts={freelancerContracts}
        corporateDocs={corporateDocs}
        guardrails={guardrails}
        isLoading={isLoading}
      />

      {/* Main tabs */}
      <Card className="border-[var(--border-mabos)] bg-[var(--bg-card)] shadow-none">
        <CardHeader className="pb-2">
          <div className="flex gap-1">
            {tabs.map((tab) => (
              <button
                key={tab}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  activeTab === tab
                    ? "bg-[var(--accent-purple)] text-white"
                    : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                }`}
                onClick={() => setActiveTab(tab)}
              >
                {tab}
              </button>
            ))}
          </div>
        </CardHeader>
        <CardContent>
          {activeTab === "Contracts" && (
            <div className="space-y-4">
              <div className="flex gap-1">
                {contractSubTabs.map((sub) => (
                  <button
                    key={sub}
                    className={`px-2.5 py-1 text-[11px] font-medium rounded transition-colors ${
                      contractTab === sub
                        ? "bg-[var(--bg-tertiary)] text-[var(--text-primary)]"
                        : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
                    }`}
                    onClick={() => setContractTab(sub)}
                  >
                    {sub}
                  </button>
                ))}
              </div>
              {contractTab === "Partnership" ? (
                <ContractTable
                  type="partnership"
                  contracts={partnerContracts}
                  isLoading={partnerLoading}
                />
              ) : (
                <ContractTable
                  type="freelancer"
                  contracts={freelancerContracts}
                  isLoading={freelancerLoading}
                />
              )}
            </div>
          )}

          {activeTab === "Corporate Documents" && (
            <CorporateDocList documents={corporateDocs} isLoading={docsLoading} />
          )}

          {activeTab === "Business Info" && (
            <div className="space-y-4">
              <LegalStructureCard structure={structure} />
              <Card className="border-[var(--border-mabos)] shadow-none">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-[var(--text-secondary)]">
                    Compliance Guardrails
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <GuardrailTable guardrails={guardrails} isLoading={guardrailsLoading} />
                </CardContent>
              </Card>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
