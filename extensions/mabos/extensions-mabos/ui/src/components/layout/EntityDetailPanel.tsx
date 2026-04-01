import { AgentDetailPanel } from "@/components/agents/AgentDetailPanel";
import { DecisionDetailPanel } from "@/components/decisions/DecisionDetailPanel";
import { GoalDetailPanel } from "@/components/goals/GoalDetailPanel";
import { WorkflowDetailPanel } from "@/components/goals/WorkflowDetailPanel";
import { NodeDetailPanel } from "@/components/knowledge-graph/NodeDetailPanel";
import { TaskDetail } from "@/components/tasks/TaskDetail";
import { TimelineEventDetail } from "@/components/timeline/TimelineEventDetail";
import { usePanels } from "@/contexts/PanelContext";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import type { Decision, BusinessGoal, Task, Workflow } from "@/lib/types";

export function EntityDetailPanel() {
  const { detailPanel, closeDetailPanel } = usePanels();
  const isMobile = useMediaQuery("(max-width: 768px)");

  if (!detailPanel.open || !detailPanel.entityType) return null;

  const sheetSide = isMobile ? ("bottom" as const) : ("right" as const);
  const onOpenChange = (open: boolean) => {
    if (!open) closeDetailPanel();
  };

  switch (detailPanel.entityType) {
    case "decision":
      return (
        <DecisionDetailPanel
          decision={detailPanel.entityData as Decision}
          open={true}
          onOpenChange={onOpenChange}
          sheetSide={sheetSide}
        />
      );
    case "agent":
      return (
        <AgentDetailPanel
          agentId={detailPanel.entityId}
          open={true}
          onOpenChange={onOpenChange}
          sheetSide={sheetSide}
          mode={detailPanel.mode ?? "view"}
        />
      );
    case "goal":
      return (
        <GoalDetailPanel
          goal={detailPanel.entityData as BusinessGoal}
          open={true}
          onOpenChange={onOpenChange}
          sheetSide={sheetSide}
        />
      );
    case "task":
      return (
        <TaskDetail
          task={detailPanel.entityData as Task}
          open={true}
          onOpenChange={onOpenChange}
          sheetSide={sheetSide}
        />
      );
    case "workflow":
      return (
        <WorkflowDetailPanel
          workflow={detailPanel.entityData as Workflow & { goalName: string }}
          open={true}
          onOpenChange={onOpenChange}
          sheetSide={sheetSide}
        />
      );
    case "knowledge-graph-node":
      return (
        <NodeDetailPanel
          node={detailPanel.entityData as any}
          open={true}
          onOpenChange={onOpenChange}
          sheetSide={sheetSide}
        />
      );
    case "timeline-event":
      return (
        <TimelineEventDetail
          event={detailPanel.entityData as any}
          open={true}
          onOpenChange={onOpenChange}
          sheetSide={sheetSide}
        />
      );
    default:
      return null;
  }
}
