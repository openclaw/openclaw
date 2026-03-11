import type { WorkflowStatus, CronScheduleInfo } from "./types";

// ── Element type discriminators ──────────────────────────────────────────

export type BpmnElementType =
  | "startEvent"
  | "endEvent"
  | "intermediateEvent"
  | "task"
  | "subprocess"
  | "callActivity"
  | "gateway"
  | "dataObject"
  | "dataStore"
  | "textAnnotation"
  | "group";

export type EventPosition = "start" | "intermediate" | "end";

export type EventTrigger =
  | "none"
  | "message"
  | "timer"
  | "signal"
  | "error"
  | "escalation"
  | "compensation"
  | "cancel"
  | "conditional"
  | "link"
  | "terminate"
  | "multiple"
  | "parallelMultiple";

export type TaskType =
  | "user"
  | "service"
  | "script"
  | "businessRule"
  | "send"
  | "receive"
  | "manual";

export type GatewayType = "exclusive" | "parallel" | "inclusive" | "eventBased" | "complex";

export type LoopType = "none" | "standard" | "multiInstanceSequential" | "multiInstanceParallel";

export type SubProcessType = "embedded" | "event" | "transaction" | "adHoc";

export type FlowType = "sequence" | "message" | "association";

// ── Full element shape ───────────────────────────────────────────────────

export interface BpmnElement {
  id: string;
  workflowId: string;
  type: BpmnElementType;
  name?: string;
  position: { x: number; y: number };
  size: { w: number; h: number };
  laneId?: string;
  documentation?: string;
  // Event
  eventPosition?: EventPosition;
  eventTrigger?: EventTrigger;
  eventCatching?: boolean;
  eventDefinition?: Record<string, unknown>;
  // Activity
  taskType?: TaskType;
  loopType?: LoopType;
  isForCompensation?: boolean;
  subProcessType?: SubProcessType;
  calledElement?: string;
  // Gateway
  gatewayType?: GatewayType;
  defaultFlowId?: string;
  // Assignment
  assignee?: string;
  action?: string;
  schedule?: CronScheduleInfo;
}

export interface BpmnFlow {
  id: string;
  workflowId: string;
  type: FlowType;
  sourceId: string;
  targetId: string;
  name?: string;
  conditionExpression?: string;
  isDefault?: boolean;
  waypoints?: { x: number; y: number }[];
}

export interface BpmnPool {
  id: string;
  workflowId: string;
  name: string;
  participantRef?: string;
  isBlackBox?: boolean;
}

export interface BpmnLane {
  id: string;
  poolId: string;
  name: string;
  assignee?: string;
}

export interface BpmnWorkflow {
  id: string;
  name: string;
  status: WorkflowStatus;
  description?: string;
  version?: number;
  goalId?: string;
  projectId?: string;
  elements: BpmnElement[];
  flows: BpmnFlow[];
  pools: BpmnPool[];
  lanes: BpmnLane[];
  createdAt?: string;
  updatedAt?: string;
}

// ── Validation ───────────────────────────────────────────────────────────

export interface BpmnValidationError {
  elementId: string;
  message: string;
  severity: "error" | "warning";
}

// ── Helpers: map element type to React Flow node type ────────────────────

export function elementTypeToNodeType(type: BpmnElementType): string {
  switch (type) {
    case "startEvent":
    case "endEvent":
    case "intermediateEvent":
      return "bpmnEvent";
    case "task":
      return "bpmnTask";
    case "gateway":
      return "bpmnGateway";
    case "subprocess":
    case "callActivity":
      return "bpmnSubProcess";
    case "dataObject":
    case "dataStore":
      return "bpmnData";
    case "textAnnotation":
      return "bpmnAnnotation";
    default:
      return "bpmnTask";
  }
}

export function flowTypeToEdgeType(type: FlowType): string {
  switch (type) {
    case "sequence":
      return "bpmnSequence";
    case "message":
      return "bpmnMessage";
    case "association":
      return "bpmnAssociation";
    default:
      return "bpmnSequence";
  }
}
