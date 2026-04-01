import type { LucideIcon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

type StatCardProps = {
  label: string;
  value: string | number;
  icon: LucideIcon;
  color: string;
  trend?: { delta: string; direction: "up" | "down" | "flat" };
};

export function StatCard({ label, value, icon: Icon, color, trend }: StatCardProps) {
  return (
    <Card className="bg-[var(--bg-card)] border-[var(--border-mabos)] hover:border-[var(--border-hover)] transition-colors py-4">
      <CardContent className="flex items-center gap-4">
        <div
          className="flex items-center justify-center w-10 h-10 rounded-lg shrink-0"
          style={{ backgroundColor: `color-mix(in srgb, ${color} 15%, transparent)` }}
        >
          <Icon className="w-5 h-5" style={{ color }} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider">
            {label}
          </p>
          <p className="text-2xl font-bold text-[var(--text-primary)] mt-0.5">{value}</p>
          {trend && (
            <p
              className="text-xs mt-0.5"
              style={{
                color:
                  trend.direction === "up"
                    ? "var(--accent-green)"
                    : trend.direction === "down"
                      ? "var(--accent-red)"
                      : "var(--text-secondary)",
              }}
            >
              {trend.direction === "up"
                ? "\u2191"
                : trend.direction === "down"
                  ? "\u2193"
                  : "\u2192"}{" "}
              {trend.delta}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export function StatCardSkeleton() {
  return (
    <Card className="bg-[var(--bg-card)] border-[var(--border-mabos)] py-4">
      <CardContent className="flex items-center gap-4">
        <Skeleton className="h-10 w-10 rounded-lg" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-6 w-12" />
          <Skeleton className="h-3 w-24" />
        </div>
      </CardContent>
    </Card>
  );
}

export function StatCardRow({
  children,
  isLoading,
  count = 4,
}: {
  children?: React.ReactNode;
  isLoading?: boolean;
  count?: number;
}) {
  if (isLoading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: count }).map((_, i) => (
          <StatCardSkeleton key={i} />
        ))}
      </div>
    );
  }
  return <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">{children}</div>;
}
