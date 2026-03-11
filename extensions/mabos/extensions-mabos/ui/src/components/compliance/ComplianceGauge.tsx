import type { CompliancePolicy, Violation } from "@/lib/types";

type Props = {
  policies: CompliancePolicy[] | undefined;
  violations: Violation[] | undefined;
};

export function ComplianceGauge({ policies, violations }: Props) {
  const activePolicies = policies?.filter((p) => p.status === "active").length ?? 0;
  const openViolations = violations?.filter((v) => v.status !== "resolved").length ?? 0;
  const total = activePolicies || 1;
  const compliant = Math.max(0, activePolicies - openViolations);
  const pct = Math.round((compliant / total) * 100);

  const color =
    pct >= 80 ? "var(--accent-green)" : pct >= 50 ? "var(--accent-orange)" : "var(--accent-red)";

  // CSS ring gauge
  const size = 120;
  const stroke = 10;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (pct / 100) * circumference;

  return (
    <div className="flex items-center gap-6">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="-rotate-90">
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="var(--bg-tertiary)"
            strokeWidth={stroke}
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={color}
            strokeWidth={stroke}
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            strokeLinecap="round"
            className="transition-all duration-500"
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-2xl font-bold" style={{ color }}>
            {pct}%
          </span>
        </div>
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium text-[var(--text-primary)]">Compliance Score</p>
        <p className="text-xs text-[var(--text-secondary)]">
          {compliant} of {activePolicies} policies without open violations
        </p>
      </div>
    </div>
  );
}
