// Policy doctor shared types.
import type { HealthFinding } from "openclaw/plugin-sdk/health";
import type { PolicyEvidence } from "../policy-state.js";

export type PolicyEvaluation = {
  readonly policyPath: string;
  readonly policy?: {
    readonly value: unknown;
    readonly hash: string;
  };
  readonly evidence: PolicyEvidence;
  readonly expectedAttestationHash?: string;
  readonly findings: readonly HealthFinding[];
  readonly attestedFindings: readonly HealthFinding[];
};
