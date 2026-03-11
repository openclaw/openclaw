const defaultColorMap: Record<string, string> = {
  // Green
  active: "var(--accent-green)",
  paid: "var(--accent-green)",
  delivered: "var(--accent-green)",
  completed: "var(--accent-green)",
  resolved: "var(--accent-green)",
  received: "var(--accent-green)",
  approved: "var(--accent-green)",
  // Orange
  pending: "var(--accent-orange)",
  draft: "var(--accent-orange)",
  partial: "var(--accent-orange)",
  paused: "var(--accent-orange)",
  warning: "var(--accent-orange)",
  submitted: "var(--accent-orange)",
  // Red
  overdue: "var(--accent-red)",
  error: "var(--accent-red)",
  critical: "var(--accent-red)",
  cancelled: "var(--accent-red)",
  failed: "var(--accent-red)",
  rejected: "var(--accent-red)",
  // Blue
  in_transit: "var(--accent-blue)",
  sent: "var(--accent-blue)",
  processing: "var(--accent-blue)",
  in_progress: "var(--accent-blue)",
  shipped: "var(--accent-blue)",
  // Purple
  info: "var(--accent-purple)",
  new: "var(--accent-purple)",
};

type StatusBadgeProps = {
  status: string;
  colorMap?: Record<string, string>;
};

export function StatusBadge({ status, colorMap }: StatusBadgeProps) {
  const map = colorMap ?? defaultColorMap;
  const color = map[status.toLowerCase()] ?? "var(--text-secondary)";

  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium capitalize whitespace-nowrap"
      style={{
        backgroundColor: `color-mix(in srgb, ${color} 15%, transparent)`,
        color,
      }}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}
