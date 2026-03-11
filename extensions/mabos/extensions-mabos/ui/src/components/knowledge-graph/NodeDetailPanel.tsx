import type { Node } from "@xyflow/react";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";

type NodeDetailPanelProps = {
  node: Node | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sheetSide?: "right" | "bottom";
};

export function NodeDetailPanel({
  node,
  open,
  onOpenChange,
  sheetSide = "right",
}: NodeDetailPanelProps) {
  if (!node) return null;

  const isActor = node.type === "actorNode";
  const data = node.data as any;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={sheetSide}
        className={`bg-[var(--bg-primary)] overflow-y-auto ${sheetSide === "bottom" ? "h-[85vh] border-t" : "w-full sm:max-w-sm border-l"} border-[var(--border-mabos)]`}
      >
        <SheetHeader className="pb-0">
          <SheetTitle className="text-lg text-[var(--text-primary)]">{data.label}</SheetTitle>
          <SheetDescription className="text-[var(--text-muted)]">
            {isActor ? "Actor" : "Goal"} Details
          </SheetDescription>
        </SheetHeader>

        <div className="px-4 space-y-4">
          {isActor ? (
            <>
              <div>
                <p className="text-xs text-[var(--text-muted)]">Type</p>
                <Badge
                  variant="outline"
                  className="text-[10px] capitalize border-[var(--border-mabos)] text-[var(--text-secondary)] mt-0.5"
                >
                  {data.type}
                </Badge>
              </div>
              <div>
                <p className="text-xs text-[var(--text-muted)]">Goals</p>
                <p className="text-sm text-[var(--text-secondary)]">
                  {data.goalCount} goal{data.goalCount !== 1 ? "s" : ""}
                </p>
              </div>
            </>
          ) : (
            <>
              <div>
                <p className="text-xs text-[var(--text-muted)]">Level</p>
                <Badge
                  variant="outline"
                  className="text-[10px] capitalize border-[var(--border-mabos)] text-[var(--text-secondary)] mt-0.5"
                >
                  {data.level}
                </Badge>
              </div>
              <div>
                <p className="text-xs text-[var(--text-muted)]">Type</p>
                <Badge
                  variant="outline"
                  className="text-[10px] capitalize border-[var(--border-mabos)] text-[var(--text-secondary)] mt-0.5"
                >
                  {data.type}
                </Badge>
              </div>
              <div>
                <p className="text-xs text-[var(--text-muted)]">Priority</p>
                <div className="flex items-center gap-2 mt-0.5">
                  <div className="flex-1 h-1.5 rounded-full bg-[var(--bg-tertiary)]">
                    <div
                      className="h-full rounded-full bg-[var(--accent-blue)]"
                      style={{ width: `${(data.priority || 0.5) * 100}%` }}
                    />
                  </div>
                  <span className="text-xs text-[var(--text-secondary)]">
                    {((data.priority || 0.5) * 100).toFixed(0)}%
                  </span>
                </div>
              </div>
              <div>
                <p className="text-xs text-[var(--text-muted)]">Actor</p>
                <p className="text-sm text-[var(--text-secondary)] capitalize">{data.actor}</p>
              </div>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
