import { cn } from "@/lib/utils";

type Priority = "critical" | "high" | "medium" | "low";
type Effort = "quick" | "medium" | "large";

const priorityStyles: Record<Priority, string> = {
  critical: "bg-red-500/10 text-red-400 border-red-500/20",
  high: "bg-orange-500/10 text-orange-400 border-orange-500/20",
  medium: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  low: "bg-zinc-500/10 text-zinc-400 border-zinc-500/20",
};

const effortStyles: Record<Effort, string> = {
  quick: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  medium: "bg-amber-500/10 text-amber-400 border-amber-500/20",
  large: "bg-purple-500/10 text-purple-400 border-purple-500/20",
};

interface BadgeProps {
  className?: string;
}

export function PriorityBadge({ priority, className }: BadgeProps & { priority: Priority }) {
  return (
    <span
      className={cn(
        "inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded-md border",
        priorityStyles[priority],
        className
      )}
    >
      {priority}
    </span>
  );
}

export function EffortBadge({ effort, className }: BadgeProps & { effort: Effort }) {
  return (
    <span
      className={cn(
        "inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded-md border",
        effortStyles[effort],
        className
      )}
    >
      {effort}
    </span>
  );
}
