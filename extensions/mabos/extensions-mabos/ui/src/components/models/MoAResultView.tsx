import { ChevronDown, ChevronRight, Cpu, DollarSign, BarChart3 } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";

type ReferenceResponse = {
  model: string;
  response: string;
};

type MoAResult = {
  finalAnswer: string;
  referenceResponses: ReferenceResponse[];
  agreement: number;
  totalCost: number;
};

type MoAResultViewProps = {
  result: MoAResult;
};

function agreementColor(score: number): string {
  if (score >= 0.8) return "var(--accent-green)";
  if (score >= 0.5) return "var(--accent-blue)";
  if (score >= 0.3) return "var(--accent-orange)";
  return "var(--accent-red)";
}

function agreementLabel(score: number): string {
  if (score >= 0.8) return "High";
  if (score >= 0.5) return "Moderate";
  if (score >= 0.3) return "Low";
  return "Divergent";
}

export function MoAResultView({ result }: MoAResultViewProps) {
  const [expandedModels, setExpandedModels] = useState<Set<number>>(new Set());

  function toggleModel(idx: number) {
    setExpandedModels((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }

  function expandAll() {
    setExpandedModels(new Set(result.referenceResponses.map((_, i) => i)));
  }

  function collapseAll() {
    setExpandedModels(new Set());
  }

  const allExpanded = expandedModels.size === result.referenceResponses.length;
  const agreeColor = agreementColor(result.agreement);

  return (
    <div className="space-y-4">
      {/* Summary badges */}
      <div className="flex items-center gap-3 flex-wrap">
        <Badge
          className="text-xs px-2.5 py-1 gap-1.5"
          style={{
            backgroundColor: `color-mix(in srgb, ${agreeColor} 15%, transparent)`,
            color: agreeColor,
          }}
        >
          <BarChart3 className="w-3 h-3" />
          {agreementLabel(result.agreement)} Agreement ({Math.round(result.agreement * 100)}%)
        </Badge>
        <Badge
          variant="outline"
          className="text-xs px-2.5 py-1 gap-1.5"
          style={{ borderColor: "var(--border-mabos)", color: "var(--text-secondary)" }}
        >
          <DollarSign className="w-3 h-3" />${result.totalCost.toFixed(4)}
        </Badge>
        <Badge
          variant="outline"
          className="text-xs px-2.5 py-1 gap-1.5"
          style={{ borderColor: "var(--border-mabos)", color: "var(--text-secondary)" }}
        >
          <Cpu className="w-3 h-3" />
          {result.referenceResponses.length} model
          {result.referenceResponses.length !== 1 ? "s" : ""}
        </Badge>
      </div>

      {/* Final answer */}
      <Card className="bg-[var(--bg-card)] border-[var(--border-mabos)] overflow-hidden">
        <div className="px-4 py-3 border-b border-[var(--border-mabos)]">
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">Ensemble Answer</h3>
        </div>
        <div className="px-4 py-4">
          <pre
            className="text-sm leading-relaxed whitespace-pre-wrap break-words"
            style={{ color: "var(--text-primary)" }}
          >
            {result.finalAnswer}
          </pre>
        </div>
      </Card>

      {/* Reference responses */}
      <Card className="bg-[var(--bg-card)] border-[var(--border-mabos)] overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-mabos)]">
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">Reference Responses</h3>
          <button
            onClick={allExpanded ? collapseAll : expandAll}
            className="text-[10px] text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
          >
            {allExpanded ? "Collapse all" : "Expand all"}
          </button>
        </div>
        <div>
          {result.referenceResponses.map((ref, idx) => {
            const expanded = expandedModels.has(idx);
            return (
              <div key={idx} className="border-b border-[var(--border-mabos)] last:border-b-0">
                <button
                  onClick={() => toggleModel(idx)}
                  className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-[var(--bg-secondary)] transition-colors"
                >
                  {expanded ? (
                    <ChevronDown className="w-4 h-4 text-[var(--text-muted)] shrink-0" />
                  ) : (
                    <ChevronRight className="w-4 h-4 text-[var(--text-muted)] shrink-0" />
                  )}
                  <div
                    className="flex items-center justify-center w-6 h-6 rounded shrink-0"
                    style={{
                      backgroundColor: "color-mix(in srgb, var(--accent-blue) 15%, transparent)",
                    }}
                  >
                    <Cpu className="w-3 h-3" style={{ color: "var(--accent-blue)" }} />
                  </div>
                  <span className="text-sm font-medium text-[var(--text-primary)] truncate">
                    {ref.model}
                  </span>
                  {!expanded && (
                    <span className="text-xs text-[var(--text-muted)] truncate ml-auto max-w-[40%]">
                      {ref.response.slice(0, 80)}...
                    </span>
                  )}
                </button>
                {expanded && (
                  <div className="px-4 pb-4 pl-14">
                    <pre
                      className="text-xs leading-relaxed whitespace-pre-wrap break-words p-3 rounded-lg"
                      style={{
                        backgroundColor: "var(--bg-secondary)",
                        color: "var(--text-secondary)",
                      }}
                    >
                      {ref.response}
                    </pre>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}
