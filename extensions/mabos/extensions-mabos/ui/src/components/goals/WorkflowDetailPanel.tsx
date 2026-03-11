import { ScheduleTab } from "@/components/goals/ScheduleTab";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getAgentIcon, getAgentName } from "@/lib/agent-icons";
import type { Workflow, WorkflowStatus } from "@/lib/types";

const statusColors: Record<WorkflowStatus, string> = {
  active: "var(--accent-green)",
  completed: "var(--accent-blue)",
  paused: "var(--accent-orange)",
  pending: "var(--text-muted)",
};

type WorkflowDetailPanelProps = {
  workflow: (Workflow & { goalName: string }) | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sheetSide?: "right" | "bottom";
};

export function WorkflowDetailPanel({
  workflow,
  open,
  onOpenChange,
  sheetSide = "right",
}: WorkflowDetailPanelProps) {
  if (!workflow) return null;

  const statusColor = statusColors[workflow.status];
  const sortedSteps = [...workflow.steps].sort((a, b) => a.order - b.order);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={sheetSide}
        className={`bg-[var(--bg-primary)] overflow-y-auto ${sheetSide === "bottom" ? "h-[85vh] border-t" : "w-full sm:max-w-lg border-l"} border-[var(--border-mabos)]`}
      >
        <SheetHeader className="pb-0">
          <SheetTitle className="text-lg text-[var(--text-primary)]">{workflow.name}</SheetTitle>
          <SheetDescription asChild>
            <div className="flex items-center gap-2 pt-1">
              <Badge
                variant="outline"
                className="text-[10px] capitalize"
                style={{
                  borderColor: `color-mix(in srgb, ${statusColor} 40%, transparent)`,
                  color: statusColor,
                }}
              >
                {workflow.status}
              </Badge>
              <Badge
                variant="outline"
                className="text-[10px] border-[var(--accent-purple)]/30 text-[var(--accent-purple)]"
              >
                {workflow.goalName}
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
                value="diagram"
                className="text-[var(--text-secondary)] data-[state=active]:text-[var(--text-primary)] data-[state=active]:bg-[var(--bg-tertiary)]"
              >
                Diagram
              </TabsTrigger>
              <TabsTrigger
                value="schedule"
                className="text-[var(--text-secondary)] data-[state=active]:text-[var(--text-primary)] data-[state=active]:bg-[var(--bg-tertiary)]"
              >
                Schedule
              </TabsTrigger>
            </TabsList>

            {/* Details Tab */}
            <TabsContent value="details" className="mt-4 space-y-4">
              {/* Metadata */}
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-2">
                  Properties
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <p className="text-xs text-[var(--text-muted)]">Status</p>
                    <p className="text-sm capitalize" style={{ color: statusColor }}>
                      {workflow.status}
                    </p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs text-[var(--text-muted)]">Parent Goal</p>
                    <p className="text-sm text-[var(--accent-purple)]">{workflow.goalName}</p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs text-[var(--text-muted)]">Steps</p>
                    <p className="text-sm text-[var(--text-secondary)]">{workflow.steps.length}</p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs text-[var(--text-muted)]">Agents</p>
                    <p className="text-sm text-[var(--text-secondary)]">
                      {workflow.agents.length || "None"}
                    </p>
                  </div>
                </div>
              </div>

              {/* Steps - vertical numbered list */}
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-3">
                  Steps
                </p>
                <div className="space-y-2">
                  {sortedSteps.map((step, idx) => (
                    <div
                      key={step.id}
                      className="flex items-center gap-3 p-2.5 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-mabos)]"
                    >
                      <div
                        className="flex items-center justify-center w-6 h-6 rounded-full text-[10px] font-bold shrink-0"
                        style={{
                          backgroundColor: `color-mix(in srgb, ${statusColor} 15%, transparent)`,
                          color: statusColor,
                        }}
                      >
                        {idx + 1}
                      </div>
                      <span className="text-sm text-[var(--text-primary)]">{step.name}</span>
                    </div>
                  ))}
                  {sortedSteps.length === 0 && (
                    <p className="text-sm text-[var(--text-muted)] italic">No steps defined.</p>
                  )}
                </div>
              </div>

              {/* Assigned Agents */}
              {workflow.agents.length > 0 && (
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-3">
                    Assigned Agents
                  </p>
                  <div className="flex flex-col gap-2">
                    {workflow.agents.map((agentId) => {
                      const Icon = getAgentIcon(agentId);
                      const name = getAgentName(agentId);
                      return (
                        <div
                          key={agentId}
                          className="flex items-center gap-2.5 p-2 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-mabos)]"
                        >
                          <div className="flex items-center justify-center w-7 h-7 rounded-full bg-[var(--bg-tertiary)]">
                            <Icon className="w-3.5 h-3.5 text-[var(--text-secondary)]" />
                          </div>
                          <span className="text-sm text-[var(--text-primary)]">{name}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </TabsContent>

            {/* Diagram Tab */}
            <TabsContent value="diagram" className="mt-4">
              <Card className="bg-[var(--bg-secondary)] border-[var(--border-mabos)]">
                <CardContent className="py-6">
                  {/* Simple vertical flow diagram */}
                  <div className="flex flex-col items-center gap-0">
                    {/* Start node */}
                    <div
                      className="w-10 h-10 rounded-full flex items-center justify-center text-xs font-bold"
                      style={{
                        backgroundColor: `color-mix(in srgb, ${statusColor} 20%, transparent)`,
                        color: statusColor,
                        border: `2px solid ${statusColor}`,
                      }}
                    >
                      S
                    </div>

                    {sortedSteps.map((step, idx) => (
                      <div key={step.id} className="flex flex-col items-center">
                        {/* Connector line */}
                        <div className="w-0.5 h-6" style={{ backgroundColor: statusColor }} />
                        {/* Step node */}
                        <div
                          className="px-4 py-2.5 rounded-lg border max-w-[200px] text-center"
                          style={{
                            backgroundColor: `color-mix(in srgb, ${statusColor} 5%, var(--bg-card))`,
                            borderColor: `color-mix(in srgb, ${statusColor} 30%, transparent)`,
                          }}
                        >
                          <span className="text-[10px] font-bold" style={{ color: statusColor }}>
                            {idx + 1}
                          </span>
                          <p className="text-xs text-[var(--text-primary)] mt-0.5">{step.name}</p>
                        </div>
                      </div>
                    ))}

                    {/* End connector + node */}
                    <div className="w-0.5 h-6" style={{ backgroundColor: statusColor }} />
                    <div
                      className="w-10 h-10 rounded-full flex items-center justify-center text-xs font-bold"
                      style={{
                        backgroundColor: `color-mix(in srgb, ${statusColor} 20%, transparent)`,
                        color: statusColor,
                        border: `2px solid ${statusColor}`,
                      }}
                    >
                      E
                    </div>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            {/* Schedule Tab */}
            <TabsContent value="schedule" className="mt-4">
              <ScheduleTab workflow={workflow} />
            </TabsContent>
          </Tabs>
        </div>
      </SheetContent>
    </Sheet>
  );
}
