export type OperatorMode =
  | "read-only"
  | "suggest-only"
  | "approval-required"
  | "bounded-autonomy";

export type OperatorObservation = {
  app: string;
  windowTitle?: string;
  textBlocks: string[];
  elements: Array<{
    label: string;
    type: string;
    bounds?: number[];
    confidence?: number;
  }>;
  timestamp: number;
};

export type OperatorAction = {
  type: "click" | "type" | "scroll" | "navigate" | "command";
  target?: string;
  value?: string;
  metadata?: Record<string, unknown>;
};

export type OperatorPlanStep = {
  step: string;
  action?: OperatorAction;
  expected?: string;
};

export type OperatorPlan = {
  goal: string;
  steps: OperatorPlanStep[];
  risk: "LOW" | "MEDIUM" | "HIGH";
  confidence: number;
};

export type OperatorPolicyResult = {
  allowed: boolean;
  requiresApproval?: boolean;
  reason?: string;
};

export type OperatorExecutionResult = {
  success: boolean;
  message?: string;
};

export type OperatorVerificationResult = {
  success: boolean;
  reason?: string;
  shouldRetry?: boolean;
};

export type OperatorAuditEvent = {
  type: string;
  timestamp: number;
  payload: Record<string, unknown>;
};

export type OperatorContext = {
  mode: OperatorMode;
  workspaceId?: string;
  sessionId?: string;
};
