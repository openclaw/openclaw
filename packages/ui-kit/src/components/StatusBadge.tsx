import { cn } from "../utils.js";

export interface StatusBadgeProps {
  status: string;
  className?: string;
}

const STATUS_COLORS: Record<string, string> = {
  active: "bg-green-500/15 text-green-400",
  idle: "bg-gray-500/15 text-gray-400",
  error: "bg-red-500/15 text-red-400",
  paused: "bg-yellow-500/15 text-yellow-400",
  healthy: "bg-green-500/15 text-green-400",
  degraded: "bg-yellow-500/15 text-yellow-400",
  offline: "bg-red-500/15 text-red-400",
  pending: "bg-blue-500/15 text-blue-400",
  success: "bg-green-500/15 text-green-400",
  denied: "bg-red-500/15 text-red-400",
};

export function StatusBadge({ status, className }: StatusBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        STATUS_COLORS[status] ?? "bg-gray-500/15 text-gray-400",
        className,
      )}
    >
      {status}
    </span>
  );
}
