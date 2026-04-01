import { CheckCircle2, XCircle, Clock } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useResolveDecision } from "@/hooks/useDecisions";
import type { Decision, DecisionUrgency } from "@/lib/types";

const urgencyColors: Record<DecisionUrgency, string> = {
  critical: "var(--accent-red)",
  high: "var(--accent-orange)",
  medium: "var(--accent-blue)",
  low: "var(--accent-green)",
};

type DecisionDetailDialogProps = {
  decision: Decision | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function DecisionDetailDialog({ decision, open, onOpenChange }: DecisionDetailDialogProps) {
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");
  const resolveDecision = useResolveDecision();

  if (!decision) return null;

  const borderColor = urgencyColors[decision.urgency];

  function handleAction(action: "approve" | "reject" | "defer") {
    if (!decision) return;
    resolveDecision.mutate(
      {
        id: decision.id,
        resolution: {
          optionId: selectedOption || decision.options[0]?.id || "",
          feedback: feedback || undefined,
          action,
        },
      },
      {
        onSuccess: () => {
          onOpenChange(false);
          setSelectedOption(null);
          setFeedback("");
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-[var(--bg-card)] border-[var(--border-mabos)] text-[var(--text-primary)] max-w-xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-lg">{decision.title}</DialogTitle>
          <div className="flex items-center gap-2 pt-1">
            <Badge
              variant="outline"
              className="text-[10px] capitalize"
              style={{
                borderColor: `color-mix(in srgb, ${borderColor} 40%, transparent)`,
                color: borderColor,
              }}
            >
              {decision.urgency}
            </Badge>
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
        </DialogHeader>

        <p className="text-sm text-[var(--text-secondary)] leading-relaxed">{decision.summary}</p>

        {/* Options */}
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            Options
          </p>
          {decision.options.map((option) => (
            <Card
              key={option.id}
              className={`cursor-pointer transition-colors py-3 ${
                selectedOption === option.id
                  ? "border-[var(--accent-purple)] bg-[color-mix(in_srgb,var(--accent-purple)_5%,var(--bg-card))]"
                  : "border-[var(--border-mabos)] bg-[var(--bg-secondary)] hover:border-[var(--border-hover)]"
              }`}
              onClick={() => setSelectedOption(option.id)}
            >
              <CardContent className="space-y-1">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium text-[var(--text-primary)]">{option.label}</p>
                  {option.recommended && (
                    <Badge className="text-[10px] bg-[var(--accent-purple)] text-white">
                      Recommended
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-[var(--text-secondary)]">{option.description}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Agent Recommendation */}
        {decision.agentRecommendation && (
          <div className="p-3 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-mabos)]">
            <p className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-1">
              Agent Recommendation
            </p>
            <p className="text-sm text-[var(--text-secondary)]">{decision.agentRecommendation}</p>
          </div>
        )}

        {/* Feedback */}
        <div className="space-y-1">
          <label className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            Feedback (optional)
          </label>
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="Add notes or reasoning..."
            rows={3}
            className="w-full px-3 py-2 text-sm rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-mabos)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-purple)] resize-none"
          />
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2 pt-2">
          <Button
            onClick={() => handleAction("approve")}
            disabled={resolveDecision.isPending}
            className="flex-1 bg-[var(--accent-green)] text-white hover:bg-[var(--accent-green)]/90 gap-1.5"
          >
            <CheckCircle2 className="w-4 h-4" />
            Approve
          </Button>
          <Button
            onClick={() => handleAction("reject")}
            disabled={resolveDecision.isPending}
            variant="outline"
            className="flex-1 border-[var(--accent-red)]/40 text-[var(--accent-red)] hover:bg-[var(--accent-red)]/10 gap-1.5"
          >
            <XCircle className="w-4 h-4" />
            Reject
          </Button>
          <Button
            onClick={() => handleAction("defer")}
            disabled={resolveDecision.isPending}
            variant="outline"
            className="flex-1 border-[var(--border-mabos)] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] gap-1.5"
          >
            <Clock className="w-4 h-4" />
            Defer
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
