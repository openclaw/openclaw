import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import type { Decision, DecisionUrgency } from "@/lib/types";

const urgencyColors: Record<DecisionUrgency, string> = {
  critical: "var(--accent-red)",
  high: "var(--accent-orange)",
  medium: "var(--accent-blue)",
  low: "var(--accent-green)",
};

type DecisionCardProps = {
  decision: Decision;
  onClick: () => void;
};

export function DecisionCard({ decision, onClick }: DecisionCardProps) {
  const borderColor = urgencyColors[decision.urgency];

  return (
    <Card
      className="bg-[var(--bg-card)] border-[var(--border-mabos)] py-4 cursor-pointer hover:border-[var(--border-hover)] transition-colors"
      style={{ borderLeftWidth: 3, borderLeftColor: borderColor }}
      onClick={onClick}
    >
      <CardContent className="space-y-3">
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-sm font-medium text-[var(--text-primary)] line-clamp-2">
            {decision.title}
          </h3>
          <Badge
            variant="outline"
            className="shrink-0 text-[10px] capitalize"
            style={{
              borderColor: `color-mix(in srgb, ${borderColor} 40%, transparent)`,
              color: borderColor,
            }}
          >
            {decision.urgency}
          </Badge>
        </div>

        <p className="text-xs text-[var(--text-secondary)] line-clamp-2">{decision.summary}</p>

        <div className="flex items-center gap-2 flex-wrap">
          <Badge
            variant="outline"
            className="text-[10px] border-[var(--accent-purple)]/30 text-[var(--accent-purple)]"
          >
            {decision.agentName}
          </Badge>
          <Badge
            variant="outline"
            className="text-[10px] border-[var(--border-mabos)] text-[var(--text-muted)]"
          >
            {decision.businessName}
          </Badge>
        </div>
      </CardContent>
    </Card>
  );
}
