import { useState } from "react";
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
import type { BpmnElement, TaskType, GatewayType, EventTrigger } from "@/lib/bpmn-types";

type BpmnNodeDetailPanelProps = {
  element: BpmnElement | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdate?: (id: string, data: Record<string, unknown>) => void;
  sheetSide?: "right" | "bottom";
};

const taskTypeOptions: TaskType[] = [
  "user",
  "service",
  "script",
  "businessRule",
  "send",
  "receive",
  "manual",
];
const gatewayTypeOptions: GatewayType[] = [
  "exclusive",
  "parallel",
  "inclusive",
  "eventBased",
  "complex",
];
const eventTriggerOptions: EventTrigger[] = [
  "none",
  "message",
  "timer",
  "signal",
  "error",
  "terminate",
];

const tabTriggerClass =
  "text-[var(--text-secondary)] data-[state=active]:text-[var(--text-primary)] data-[state=active]:bg-[var(--bg-tertiary)]";

export function BpmnNodeDetailPanel({
  element,
  open,
  onOpenChange,
  onUpdate,
  sheetSide = "right",
}: BpmnNodeDetailPanelProps) {
  const [localName, setLocalName] = useState(element?.name || "");
  const [localDoc, setLocalDoc] = useState(element?.documentation || "");

  if (!element) return null;

  const handleFieldChange = (field: string, value: unknown) => {
    onUpdate?.(element.id, { [field]: value });
  };

  const isEvent =
    element.type === "startEvent" ||
    element.type === "endEvent" ||
    element.type === "intermediateEvent";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={sheetSide}
        className={`bg-[var(--bg-primary)] overflow-y-auto ${sheetSide === "bottom" ? "h-[85vh] border-t" : "w-full sm:max-w-md border-l"} border-[var(--border-mabos)]`}
      >
        <SheetHeader className="pb-0">
          <SheetTitle className="text-lg text-[var(--text-primary)]">
            {element.name || element.type}
          </SheetTitle>
          <SheetDescription asChild>
            <div className="flex items-center gap-2 pt-1">
              <Badge
                variant="outline"
                className="text-[10px] capitalize border-[var(--accent-blue)]/30 text-[var(--accent-blue)]"
              >
                {element.type}
              </Badge>
              {element.taskType && (
                <Badge
                  variant="outline"
                  className="text-[10px] capitalize border-[var(--accent-purple)]/30 text-[var(--accent-purple)]"
                >
                  {element.taskType}
                </Badge>
              )}
              {element.gatewayType && (
                <Badge
                  variant="outline"
                  className="text-[10px] capitalize border-[var(--accent-orange)]/30 text-[var(--accent-orange)]"
                >
                  {element.gatewayType}
                </Badge>
              )}
            </div>
          </SheetDescription>
        </SheetHeader>

        <div className="px-4">
          <Separator className="bg-[var(--border-mabos)]" />
        </div>

        <div className="px-4 flex-1">
          <Tabs defaultValue="properties">
            <TabsList className="bg-[var(--bg-secondary)]">
              <TabsTrigger value="properties" className={tabTriggerClass}>
                Properties
              </TabsTrigger>
              <TabsTrigger value="connections" className={tabTriggerClass}>
                Connections
              </TabsTrigger>
              <TabsTrigger value="context" className={tabTriggerClass}>
                Context
              </TabsTrigger>
            </TabsList>

            {/* Properties Tab */}
            <TabsContent value="properties" className="space-y-4 mt-4">
              {/* Name */}
              <div>
                <label className="text-xs font-medium text-[var(--text-muted)] block mb-1">
                  Name
                </label>
                <input
                  className="w-full px-3 py-1.5 text-sm rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-mabos)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-blue)]"
                  value={localName}
                  onChange={(e) => setLocalName(e.target.value)}
                  onBlur={() => handleFieldChange("name", localName)}
                />
              </div>

              {/* ID (read-only) */}
              <div>
                <label className="text-xs font-medium text-[var(--text-muted)] block mb-1">
                  ID
                </label>
                <p className="text-xs text-[var(--text-secondary)] font-mono bg-[var(--bg-secondary)] px-3 py-1.5 rounded-lg border border-[var(--border-mabos)]">
                  {element.id}
                </p>
              </div>

              {/* Task-specific: task type */}
              {element.type === "task" && (
                <div>
                  <label className="text-xs font-medium text-[var(--text-muted)] block mb-1">
                    Task Type
                  </label>
                  <select
                    className="w-full px-3 py-1.5 text-sm rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-mabos)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-blue)]"
                    value={element.taskType || "user"}
                    onChange={(e) => handleFieldChange("taskType", e.target.value)}
                  >
                    {taskTypeOptions.map((t) => (
                      <option key={t} value={t}>
                        {t.charAt(0).toUpperCase() + t.slice(1)}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Gateway-specific: gateway type */}
              {element.type === "gateway" && (
                <div>
                  <label className="text-xs font-medium text-[var(--text-muted)] block mb-1">
                    Gateway Type
                  </label>
                  <select
                    className="w-full px-3 py-1.5 text-sm rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-mabos)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-blue)]"
                    value={element.gatewayType || "exclusive"}
                    onChange={(e) => handleFieldChange("gatewayType", e.target.value)}
                  >
                    {gatewayTypeOptions.map((g) => (
                      <option key={g} value={g}>
                        {g.charAt(0).toUpperCase() + g.slice(1)}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Event-specific: trigger type */}
              {isEvent && (
                <div>
                  <label className="text-xs font-medium text-[var(--text-muted)] block mb-1">
                    Event Trigger
                  </label>
                  <select
                    className="w-full px-3 py-1.5 text-sm rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-mabos)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-blue)]"
                    value={element.eventTrigger || "none"}
                    onChange={(e) => handleFieldChange("eventTrigger", e.target.value)}
                  >
                    {eventTriggerOptions.map((t) => (
                      <option key={t} value={t}>
                        {t.charAt(0).toUpperCase() + t.slice(1)}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Assignee */}
              {element.type === "task" && (
                <div>
                  <label className="text-xs font-medium text-[var(--text-muted)] block mb-1">
                    Assignee Agent
                  </label>
                  <input
                    className="w-full px-3 py-1.5 text-sm rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-mabos)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-blue)]"
                    value={element.assignee || ""}
                    onChange={(e) => handleFieldChange("assignee", e.target.value)}
                    placeholder="e.g., vw-ceo"
                  />
                </div>
              )}

              {/* Action/Tool */}
              {element.type === "task" && (
                <div>
                  <label className="text-xs font-medium text-[var(--text-muted)] block mb-1">
                    Action Tool
                  </label>
                  <input
                    className="w-full px-3 py-1.5 text-sm rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-mabos)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-blue)]"
                    value={element.action || ""}
                    onChange={(e) => handleFieldChange("action", e.target.value)}
                    placeholder="Tool name to execute"
                  />
                </div>
              )}

              {/* Documentation */}
              <div>
                <label className="text-xs font-medium text-[var(--text-muted)] block mb-1">
                  Documentation
                </label>
                <textarea
                  className="w-full px-3 py-1.5 text-sm rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-mabos)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-blue)] min-h-[80px] resize-y"
                  value={localDoc}
                  onChange={(e) => setLocalDoc(e.target.value)}
                  onBlur={() => handleFieldChange("documentation", localDoc)}
                  rows={3}
                />
              </div>
            </TabsContent>

            {/* Connections Tab */}
            <TabsContent value="connections" className="mt-4">
              <p className="text-xs text-[var(--text-muted)]">
                Connection details will be shown here. Edit flow conditions from this panel.
              </p>
            </TabsContent>

            {/* Context Tab */}
            <TabsContent value="context" className="mt-4 space-y-3">
              <div>
                <label className="text-xs font-medium text-[var(--text-muted)] block mb-1">
                  Position
                </label>
                <p className="text-xs text-[var(--text-secondary)]">
                  x: {Math.round(element.position.x)}, y: {Math.round(element.position.y)}
                </p>
              </div>
              <div>
                <label className="text-xs font-medium text-[var(--text-muted)] block mb-1">
                  Size
                </label>
                <p className="text-xs text-[var(--text-secondary)]">
                  {element.size.w} x {element.size.h}
                </p>
              </div>
              {element.laneId && (
                <div>
                  <label className="text-xs font-medium text-[var(--text-muted)] block mb-1">
                    Lane
                  </label>
                  <p className="text-xs text-[var(--text-secondary)]">{element.laneId}</p>
                </div>
              )}
            </TabsContent>
          </Tabs>
        </div>
      </SheetContent>
    </Sheet>
  );
}
