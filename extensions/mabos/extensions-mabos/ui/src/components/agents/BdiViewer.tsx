import { Brain, Sparkles, Target, Zap } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { AgentDetail } from "@/lib/types";

type BdiSummaryProps = {
  agent: AgentDetail;
  onClickSection?: (fileTab: string) => void;
};

type BdiStat = {
  label: string;
  icon: LucideIcon;
  color: string;
  countKey: "beliefCount" | "desireCount" | "goalCount" | "intentionCount";
  fileTab: string;
};

const stats: BdiStat[] = [
  {
    label: "Beliefs",
    icon: Brain,
    color: "var(--accent-blue)",
    countKey: "beliefCount",
    fileTab: "Beliefs.md",
  },
  {
    label: "Desires",
    icon: Sparkles,
    color: "var(--accent-purple)",
    countKey: "desireCount",
    fileTab: "Desires.md",
  },
  {
    label: "Goals",
    icon: Target,
    color: "var(--accent-green)",
    countKey: "goalCount",
    fileTab: "Goals.md",
  },
  {
    label: "Intentions",
    icon: Zap,
    color: "var(--accent-orange)",
    countKey: "intentionCount",
    fileTab: "Intentions.md",
  },
];

export function BdiSummaryBar({ agent, onClickSection }: BdiSummaryProps) {
  return (
    <div className="flex items-center gap-1 px-2 py-2 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-mabos)] overflow-x-auto">
      {stats.map((stat, i) => {
        const Icon = stat.icon;
        const count = agent[stat.countKey];
        return (
          <button
            key={stat.label}
            type="button"
            onClick={() => onClickSection?.(stat.fileTab)}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md hover:bg-[var(--bg-hover)] transition-colors shrink-0 cursor-pointer"
          >
            <Icon className="w-3.5 h-3.5" style={{ color: stat.color }} />
            <span className="text-xs font-medium text-[var(--text-secondary)]">{stat.label}</span>
            <span className="text-xs font-bold tabular-nums" style={{ color: stat.color }}>
              {count}
            </span>
            {i < stats.length - 1 && (
              <span className="text-[var(--border-mabos)] ml-1 select-none">|</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
