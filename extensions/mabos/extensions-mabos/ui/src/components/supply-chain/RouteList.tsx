import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import type { Route } from "@/lib/types";

type Props = {
  routes: Route[];
  isLoading?: boolean;
};

function RoutePipeline({ legs }: { legs: Array<{ from: string; to: string }> | null }) {
  if (!legs || legs.length === 0) return <span className="text-[var(--text-muted)]">No legs</span>;

  const points: string[] = [legs[0].from];
  for (const leg of legs) {
    points.push(leg.to);
  }

  return (
    <div className="flex items-center gap-1 flex-wrap">
      {points.map((point, i) => (
        <span key={i} className="flex items-center gap-1">
          <span className="text-xs font-medium text-[var(--text-primary)]">{point}</span>
          {i < points.length - 1 && <span className="text-[var(--text-muted)]">&rarr;</span>}
        </span>
      ))}
    </div>
  );
}

export function RouteList({ routes, isLoading }: Props) {
  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i} className="border-[var(--border-mabos)] shadow-none">
            <CardContent className="py-4 space-y-2">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-60" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  if (routes.length === 0) {
    return <div className="text-center py-6 text-sm text-[var(--text-muted)]">No routes found</div>;
  }

  return (
    <div className="space-y-3">
      {routes.map((route) => (
        <Card
          key={route.id}
          className="border-[var(--border-mabos)] bg-[var(--bg-card)] shadow-none"
        >
          <CardContent className="py-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-[var(--text-primary)]">{route.name}</span>
              <StatusBadge status={route.status} />
            </div>
            <div className="flex items-center justify-between">
              <RoutePipeline legs={route.legs} />
              <span className="text-xs text-[var(--text-muted)]">
                {route.origin} → {route.destination}
              </span>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
