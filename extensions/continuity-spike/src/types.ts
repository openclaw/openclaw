/** Bounded synthetic decisions; these are not arbitrary messages or a wire protocol. */
export type Direction = "A" | "B";
export type ConsistencyMode = "next-turn" | "operation";
export type StepCount = 1 | 2 | 3;

export type ActivityPolicy = {
  execute: boolean;
  statusRead: boolean;
  cancel: boolean;
};

export type DecisionRevision = {
  revision: number;
  direction: Direction;
  requestId: string;
};

export type TurnSnapshot = {
  runId: string;
  sessionKey: string;
  decisionRevision: number;
  direction: Direction;
  authorityGeneration: number;
  attachmentGeneration: number;
  state: "active" | "finished" | "interrupted" | "stopped";
};

/** Hash is exact-content binding, NOT remote identity or authorization. */
export type AdmittedOperation = {
  id: string;
  activityId: string;
  destinationId: string;
  runId: string;
  decisionRevision: number;
  direction: Direction;
  step: StepCount;
  authorityGeneration: number;
  attachmentGeneration: number;
  expectedDestinationRevision: number;
  hash: string;
};

export type OperationReceipt = {
  operationId: string;
  operationHash: string;
  activityId: string;
  destinationId: string;
  destinationRevision: number;
  outcome: "succeeded" | "rejected" | "cancelled";
  reason: "artifact-written" | "destination-revision-conflict" | "step-conflict" | "cancelled";
  artifactId: string | null;
};

export type OperationRecord = {
  operation: AdmittedOperation;
  state: "admitted" | "dispatched" | "outcome-unknown" | "succeeded" | "rejected" | "cancelled";
  receipt: OperationReceipt | null;
};

export type ActivityState = {
  kind: "home-activity";
  schemaVersion: 1;
  id: string;
  sessionKey: string;
  destinationId: string;
  objective: string;
  targetSteps: StepCount;
  mode: ConsistencyMode;
  currentDecision: DecisionRevision;
  decisions: DecisionRevision[];
  turns: TurnSnapshot[];
  operations: OperationRecord[];
  policy: ActivityPolicy;
  authorityGeneration: number;
  attachment: { connected: boolean; generation: number; destinationRevision: number };
  stopped: boolean;
  completedSteps: StepCount[];
  status: "pending" | "running" | "blocked" | "completed" | "stopped";
  blockedReason: string | null;
};

export type EnrollActivity = {
  id: string;
  sessionKey: string;
  destinationId: string;
  mode: ConsistencyMode;
  objective?: string;
  targetSteps?: StepCount;
};

export type SyntheticArtifact = {
  id: string;
  operationId: string;
  operationHash: string;
  activityId: string;
  direction: Direction;
  decisionRevision: number;
  step: StepCount;
  text: string;
};

export type DestinationState = {
  kind: "destination-activity";
  schemaVersion: 1;
  id: string;
  destinationId: string;
  revision: number;
  targetSteps: StepCount;
  policy: ActivityPolicy;
  records: Array<{ operation: AdmittedOperation; receipt: OperationReceipt }>;
  artifacts: SyntheticArtifact[];
};

export type DestinationStatus =
  | { outcome: "not-found" }
  | { outcome: "found"; receipt: OperationReceipt };
