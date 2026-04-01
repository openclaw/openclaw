type Props = {
  label: string;
  spent: number;
  limit: number;
  reserved?: number;
};

export function BudgetGauge({ label, spent, limit, reserved = 0 }: Props) {
  const usedPct = limit > 0 ? Math.min((spent / limit) * 100, 100) : 0;
  const reservedPct = limit > 0 ? Math.min((reserved / limit) * 100, 100 - usedPct) : 0;
  const remaining = Math.max(0, limit - spent - reserved);

  const barColor =
    usedPct >= 95
      ? "var(--accent-red)"
      : usedPct >= 80
        ? "var(--accent-orange)"
        : "var(--accent-green)";

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-[var(--text-secondary)] uppercase tracking-wider">
          {label}
        </span>
        <span className="text-xs text-[var(--text-muted)]">
          ${spent.toFixed(2)} / ${limit.toFixed(2)}
        </span>
      </div>

      {/* Progress bar */}
      <div
        className="relative h-3 rounded-full overflow-hidden"
        style={{ backgroundColor: "var(--bg-tertiary)" }}
      >
        <div
          className="absolute inset-y-0 left-0 rounded-full transition-all duration-500"
          style={{ width: `${usedPct}%`, backgroundColor: barColor }}
        />
        {reserved > 0 && (
          <div
            className="absolute inset-y-0 rounded-full opacity-40 transition-all duration-500"
            style={{
              left: `${usedPct}%`,
              width: `${reservedPct}%`,
              backgroundColor: barColor,
            }}
          />
        )}
      </div>

      <div className="flex items-center justify-between text-xs">
        <span style={{ color: barColor }} className="font-medium">
          {usedPct.toFixed(0)}% used
        </span>
        <span className="text-[var(--text-muted)]">${remaining.toFixed(2)} remaining</span>
      </div>
    </div>
  );
}
