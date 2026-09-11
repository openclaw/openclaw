type Direction = "A" | "B";
export type Candidate =
  | { kind: "directive"; activityId: string; direction: Direction }
  | { kind: "none" | "clarify" | "stop" };

type Activity = {
  id: string;
  label: string;
  currentDirection: Direction;
  destinationId: string;
};

/** Synthetic host-owned state. Never accept this object from a classifier. */
export type HostState = {
  actorId: string;
  sourceId: string;
  decisionGrants: string[];
  activities: Activity[];
  releases: {
    id: string;
    sourceId: string;
    activityId: string;
    destinationId: string;
    directions: Direction[];
    allowed: boolean;
    importAllowed: boolean;
  }[];
};

export type ClassifierInput = {
  message: string;
  activities: Pick<Activity, "id" | "label" | "currentDirection">[];
};

type TokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type ClassifierObservation = {
  text?: string;
  /** Sanitized category, never a raw provider error or configuration value. */
  error?: string;
  modelCalls: number | null;
  physicalProviderRequests: number | null;
  usage?: TokenUsage;
  preparationMs?: number;
  completionMs?: number;
};

export type ClassifierRoute = {
  name: string;
  kind: "deterministic" | "replay" | "separate-completion";
  classify: (input: ClassifierInput) => Promise<ClassifierObservation>;
};

type GateOutcome =
  | "authorization-preview"
  | "needs-clarification"
  | "abstained"
  | "blocked"
  | "stop-observed"
  | "classifier-error";

export type Preview = {
  activityId: string;
  destinationId: string;
  policyId: string;
  payload: { kind: "direction-update"; activityId: string; direction: Direction };
  text: string;
};

export type DecisionRecord = {
  id: string;
  candidate: Candidate | null;
  gate: { outcome: GateOutcome; reason: string };
  preview: Preview | null;
  metrics: {
    classifierInvocations: number;
    modelCalls: number | null;
    physicalProviderRequests: number | null;
    usage: TokenUsage | null;
    classifierWallMs: number;
    preparationMs: number | null;
    completionMs: number | null;
    validationMs: number;
    totalMs: number;
    /** No route in this spike measures integration inside an existing agent turn. */
    inlineModelOverhead: null;
  };
};

export type DecisionFixture = {
  id: string;
  message: string;
  host: HostState;
  expected: {
    kind: Candidate["kind"];
    activityId?: string;
    direction?: Direction;
    previews: boolean;
  };
  /** Deliberately hand-authored output for exercising a fallible classifier. */
  replay: string;
};

export type Coverage = { knownTotal: number; observedSamples: number; totalSamples: number };
export type RouteReport = {
  route: string;
  kind: ClassifierRoute["kind"];
  records: DecisionRecord[];
  metrics: {
    modelCalls: Coverage;
    physicalProviderRequests: Coverage;
    usage: { inputTokens: Coverage; outputTokens: Coverage; totalTokens: Coverage };
    classifierWallMs: number;
    validationMs: number;
    totalMs: number;
    rawClassificationErrors: number;
    rawTargetErrors: number;
    unsafePreviews: number;
    missedPreviews: number;
    authorizationPreviews: number;
    classifierErrors: number;
  };
};

export type ExperimentReport = {
  schema: "scoped-decision-experiment-v1";
  effect: "authorization-preview-only";
  routes: RouteReport[];
};
