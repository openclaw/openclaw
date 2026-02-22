import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";

type TimelineEvent = {
  id?: string;
  label?: string;
  phase?: string;
  startWeek?: number;
  durationWeeks?: number;
  week?: number;
  color?: string;
};

type TimelineEventDetailProps = {
  event: TimelineEvent | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sheetSide?: "right" | "bottom";
};

export function TimelineEventDetail({
  event,
  open,
  onOpenChange,
  sheetSide = "right",
}: TimelineEventDetailProps) {
  if (!event) return null;

  const isMilestone = event.week !== undefined && !event.startWeek;
  const color = event.color || "var(--accent-blue)";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={sheetSide}
        className={`bg-[var(--bg-primary)] overflow-y-auto ${sheetSide === "bottom" ? "h-[85vh] border-t" : "w-full sm:max-w-sm border-l"} border-[var(--border-mabos)]`}
      >
        <SheetHeader className="pb-0">
          <SheetTitle className="text-lg text-[var(--text-primary)]">
            {event.label || "Timeline Event"}
          </SheetTitle>
          <SheetDescription asChild>
            <div className="flex items-center gap-2 pt-1">
              <Badge
                variant="outline"
                className="text-[10px]"
                style={{
                  borderColor: `color-mix(in srgb, ${color} 40%, transparent)`,
                  color,
                }}
              >
                {isMilestone ? "Milestone" : "Phase"}
              </Badge>
              {event.phase && (
                <Badge
                  variant="outline"
                  className="text-[10px] border-[var(--border-mabos)] text-[var(--text-muted)]"
                >
                  {event.phase}
                </Badge>
              )}
            </div>
          </SheetDescription>
        </SheetHeader>

        <div className="px-4">
          <Separator className="bg-[var(--border-mabos)]" />
        </div>

        <div className="px-4 space-y-4">
          {isMilestone ? (
            <div className="space-y-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-1">
                  Target Week
                </p>
                <p className="text-lg font-semibold" style={{ color }}>
                  Week {event.week}
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="text-xs text-[var(--text-muted)]">Start</p>
                  <p className="text-sm text-[var(--text-secondary)]">Week {event.startWeek}</p>
                </div>
                <div>
                  <p className="text-xs text-[var(--text-muted)]">Duration</p>
                  <p className="text-sm text-[var(--text-secondary)]">
                    {event.durationWeeks} week{event.durationWeeks !== 1 ? "s" : ""}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-[var(--text-muted)]">End</p>
                  <p className="text-sm text-[var(--text-secondary)]">
                    Week {(event.startWeek || 0) + (event.durationWeeks || 0)}
                  </p>
                </div>
                {event.phase && (
                  <div>
                    <p className="text-xs text-[var(--text-muted)]">Phase Group</p>
                    <p className="text-sm text-[var(--text-secondary)]">{event.phase}</p>
                  </div>
                )}
              </div>

              {/* Visual bar */}
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-2">
                  Timeline
                </p>
                <div
                  className="h-4 rounded"
                  style={{
                    backgroundColor: `color-mix(in srgb, ${color} 25%, transparent)`,
                    border: `1px solid color-mix(in srgb, ${color} 40%, transparent)`,
                  }}
                />
              </div>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
