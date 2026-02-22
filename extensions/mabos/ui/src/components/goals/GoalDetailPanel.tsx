import { WorkflowSteps } from "@/components/goals/WorkflowSteps";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { BusinessGoal, GoalLevel } from "@/lib/types";

const levelColors: Record<GoalLevel, string> = {
  strategic: "var(--accent-purple)",
  tactical: "var(--accent-blue)",
  operational: "var(--accent-orange)",
};

type GoalDetailPanelProps = {
  goal: BusinessGoal | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sheetSide?: "right" | "bottom";
};

export function GoalDetailPanel({
  goal,
  open,
  onOpenChange,
  sheetSide = "right",
}: GoalDetailPanelProps) {
  if (!goal) return null;

  const borderColor = levelColors[goal.level];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={sheetSide}
        className={`bg-[var(--bg-primary)] overflow-y-auto ${sheetSide === "bottom" ? "h-[85vh] border-t" : "w-full sm:max-w-lg border-l"} border-[var(--border-mabos)]`}
      >
        <SheetHeader className="pb-0">
          <SheetTitle className="text-lg text-[var(--text-primary)]">{goal.name}</SheetTitle>
          <SheetDescription asChild>
            <div className="flex items-center gap-2 pt-1">
              <Badge
                variant="outline"
                className="text-[10px] capitalize"
                style={{
                  borderColor: `color-mix(in srgb, ${borderColor} 40%, transparent)`,
                  color: borderColor,
                }}
              >
                {goal.level}
              </Badge>
              <Badge
                variant="outline"
                className="text-[10px] border-[var(--border-mabos)] text-[var(--text-muted)]"
              >
                {goal.type}
              </Badge>
            </div>
          </SheetDescription>
        </SheetHeader>

        <div className="px-4">
          <Separator className="bg-[var(--border-mabos)]" />
        </div>

        <div className="px-4 flex-1">
          <Tabs defaultValue="details">
            <TabsList className="bg-[var(--bg-secondary)]">
              <TabsTrigger
                value="details"
                className="text-[var(--text-secondary)] data-[state=active]:text-[var(--text-primary)] data-[state=active]:bg-[var(--bg-tertiary)]"
              >
                Details
              </TabsTrigger>
              <TabsTrigger
                value="smart"
                className="text-[var(--text-secondary)] data-[state=active]:text-[var(--text-primary)] data-[state=active]:bg-[var(--bg-tertiary)]"
              >
                SMART
              </TabsTrigger>
              <TabsTrigger
                value="workflows"
                className="text-[var(--text-secondary)] data-[state=active]:text-[var(--text-primary)] data-[state=active]:bg-[var(--bg-tertiary)]"
              >
                Workflows
              </TabsTrigger>
            </TabsList>

            {/* Details Tab */}
            <TabsContent value="details" className="mt-4 space-y-4">
              {/* Priority */}
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-2">
                  Priority
                </p>
                <div className="flex items-center gap-3">
                  <div className="flex-1 h-2 rounded-full bg-[var(--bg-tertiary)]">
                    <div
                      className="h-full rounded-full transition-all"
                      style={{
                        width: `${goal.priority * 100}%`,
                        backgroundColor: borderColor,
                      }}
                    />
                  </div>
                  <span className="text-sm font-medium text-[var(--text-secondary)]">
                    {(goal.priority * 100).toFixed(0)}%
                  </span>
                </div>
              </div>

              {/* Description */}
              {goal.description && (
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-2">
                    Description
                  </p>
                  <p className="text-sm text-[var(--text-secondary)] leading-relaxed">
                    {goal.description}
                  </p>
                </div>
              )}

              {/* Desires */}
              {goal.desires && goal.desires.length > 0 && (
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-2">
                    Desires
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {goal.desires.map((desire) => (
                      <span
                        key={desire}
                        className="px-2.5 py-1 text-xs rounded-full text-[var(--accent-purple)]"
                        style={{
                          backgroundColor: `color-mix(in srgb, var(--accent-purple) 10%, transparent)`,
                        }}
                      >
                        {desire}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Metadata */}
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-2">
                  Properties
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <p className="text-xs text-[var(--text-muted)]">Level</p>
                    <p className="text-sm capitalize" style={{ color: borderColor }}>
                      {goal.level}
                    </p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs text-[var(--text-muted)]">Type</p>
                    <p className="text-sm text-[var(--text-secondary)] capitalize">{goal.type}</p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs text-[var(--text-muted)]">Workflows</p>
                    <p className="text-sm text-[var(--text-secondary)]">
                      {goal.workflows?.length || 0}
                    </p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs text-[var(--text-muted)]">ID</p>
                    <p className="text-sm text-[var(--text-secondary)] font-mono truncate">
                      {goal.id}
                    </p>
                  </div>
                </div>
              </div>
            </TabsContent>

            {/* SMART Tab */}
            <TabsContent value="smart" className="mt-4 space-y-4">
              <p className="text-xs text-[var(--text-muted)] mb-3">SMART goal framework analysis</p>
              {[
                {
                  letter: "S",
                  label: "Specific",
                  description: goal.name,
                  color: "var(--accent-purple)",
                },
                {
                  letter: "M",
                  label: "Measurable",
                  description: `Priority metric: ${(goal.priority * 100).toFixed(0)}%`,
                  color: "var(--accent-blue)",
                },
                {
                  letter: "A",
                  label: "Achievable",
                  description: `${goal.workflows?.length || 0} workflow${(goal.workflows?.length || 0) !== 1 ? "s" : ""} defined`,
                  color: "var(--accent-green)",
                },
                {
                  letter: "R",
                  label: "Relevant",
                  description: `${goal.level} level ${goal.type}`,
                  color: "var(--accent-orange)",
                },
                {
                  letter: "T",
                  label: "Time-bound",
                  description: goal.workflows?.some((w) => w.status === "active")
                    ? "Active workflows in progress"
                    : "No active timeline set",
                  color: "var(--accent-red)",
                },
              ].map((item) => (
                <div
                  key={item.letter}
                  className="flex items-start gap-3 p-3 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-mabos)]"
                >
                  <div
                    className="flex items-center justify-center w-8 h-8 rounded-md shrink-0 text-sm font-bold"
                    style={{
                      backgroundColor: `color-mix(in srgb, ${item.color} 15%, transparent)`,
                      color: item.color,
                    }}
                  >
                    {item.letter}
                  </div>
                  <div>
                    <p className="text-sm font-medium text-[var(--text-primary)]">{item.label}</p>
                    <p className="text-xs text-[var(--text-secondary)]">{item.description}</p>
                  </div>
                </div>
              ))}
            </TabsContent>

            {/* Workflows Tab */}
            <TabsContent value="workflows" className="mt-4 space-y-3">
              {goal.workflows && goal.workflows.length > 0 ? (
                goal.workflows.map((workflow) => (
                  <WorkflowSteps key={workflow.id} workflow={workflow} />
                ))
              ) : (
                <p className="text-sm text-[var(--text-muted)] italic">
                  No workflows linked to this goal.
                </p>
              )}
            </TabsContent>
          </Tabs>
        </div>
      </SheetContent>
    </Sheet>
  );
}
