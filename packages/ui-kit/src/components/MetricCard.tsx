import type { ReactNode } from "react";

export interface MetricCardProps {
  icon: ReactNode;
  label: string;
  value: string | number;
  subtitle?: string;
  trend?: "up" | "down" | "flat";
}

export function MetricCard({ icon, label, value, subtitle, trend }: MetricCardProps) {
  return (
    <div
      className="rounded-lg border p-4"
      style={{ borderColor: "var(--border-mabos)", backgroundColor: "var(--bg-secondary)" }}
    >
      <div className="flex items-center gap-2 mb-2">
        {icon}
        <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
          {label}
        </span>
        {trend && (
          <span
            className="ml-auto text-xs"
            style={{
              color:
                trend === "up"
                  ? "var(--accent-green)"
                  : trend === "down"
                    ? "var(--accent-red, #ef4444)"
                    : "var(--text-secondary)",
            }}
          >
            {trend === "up" ? "+" : trend === "down" ? "-" : "~"}
          </span>
        )}
      </div>
      <p className="text-2xl font-bold" style={{ color: "var(--text-primary)" }}>
        {value}
      </p>
      {subtitle && (
        <p className="text-xs mt-1" style={{ color: "var(--text-secondary)" }}>
          {subtitle}
        </p>
      )}
    </div>
  );
}
