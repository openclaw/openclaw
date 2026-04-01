import { CheckCircle, Edit3, SkipForward, Sparkles } from "lucide-react";

export type SkillProposal = {
  name: string;
  description: string;
  confidence: number;
  toolsUsed: string[];
};

export type SkillCreationReviewProps = {
  proposal: SkillProposal;
  onApprove: () => void;
  onEdit: () => void;
  onSkip: () => void;
};

export function SkillCreationReview({
  proposal,
  onApprove,
  onEdit,
  onSkip,
}: SkillCreationReviewProps) {
  const confidencePct = Math.round(proposal.confidence * 100);

  // Color the bar based on confidence level
  const barColor =
    confidencePct >= 80
      ? "var(--accent-green)"
      : confidencePct >= 50
        ? "var(--accent-orange)"
        : "var(--accent-red)";

  return (
    <div
      className="rounded-lg p-4 flex flex-col gap-4"
      style={{
        backgroundColor: "var(--bg-card)",
        borderWidth: 1,
        borderStyle: "solid",
        borderColor: "var(--border-mabos)",
      }}
    >
      {/* Header */}
      <div className="flex items-center gap-2">
        <Sparkles size={16} style={{ color: "var(--accent-purple)" }} />
        <h3 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
          Skill Proposal: {proposal.name}
        </h3>
      </div>

      {/* Description */}
      <p className="text-xs leading-relaxed" style={{ color: "var(--text-secondary)" }}>
        {proposal.description}
      </p>

      {/* Confidence bar */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>
            Confidence
          </span>
          <span className="text-xs font-semibold" style={{ color: barColor }}>
            {confidencePct}%
          </span>
        </div>
        <div
          className="h-2 rounded-full overflow-hidden"
          style={{ backgroundColor: "var(--bg-secondary)" }}
        >
          <div
            className="h-full rounded-full transition-all duration-300"
            style={{
              width: `${confidencePct}%`,
              backgroundColor: barColor,
            }}
          />
        </div>
      </div>

      {/* Tools used */}
      {proposal.toolsUsed.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>
            Tools Used
          </span>
          <div className="flex flex-wrap gap-1.5">
            {proposal.toolsUsed.map((tool) => (
              <span
                key={tool}
                className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                style={{
                  backgroundColor: `color-mix(in srgb, var(--accent-blue) 15%, transparent)`,
                  color: "var(--accent-blue)",
                }}
              >
                {tool}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={onApprove}
          className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer"
          style={{
            backgroundColor: "var(--accent-green)",
            color: "#fff",
          }}
        >
          <CheckCircle size={12} />
          Approve
        </button>
        <button
          type="button"
          onClick={onEdit}
          className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer"
          style={{
            backgroundColor: "transparent",
            color: "var(--accent-blue)",
            borderWidth: 1,
            borderStyle: "solid",
            borderColor: "var(--accent-blue)",
          }}
        >
          <Edit3 size={12} />
          Edit
        </button>
        <button
          type="button"
          onClick={onSkip}
          className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer"
          style={{
            backgroundColor: "transparent",
            color: "var(--text-muted)",
            borderWidth: 1,
            borderStyle: "solid",
            borderColor: "var(--border-mabos)",
          }}
        >
          <SkipForward size={12} />
          Skip
        </button>
      </div>
    </div>
  );
}
