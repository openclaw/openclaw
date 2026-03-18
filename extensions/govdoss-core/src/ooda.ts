export type OODAStage = "observe" | "orient" | "decide" | "act" | "assess";

export type OODAContext = {
  subject?: string;
  workspaceId?: string;
  sessionId?: string;
  mode?: string;
};

export type OODAEnvelope<T = any> = {
  stage: OODAStage;
  input: T;
  output?: any;
  risk?: "LOW" | "MEDIUM" | "HIGH";
  confidence?: number;
  timestamp: number;
};

export function createEnvelope(stage: OODAStage, input: any): OODAEnvelope {
  return {
    stage,
    input,
    timestamp: Date.now()
  };
}
