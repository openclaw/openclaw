import { n as FailoverReason } from "./types-DKoVBm0H.js";

//#region src/agents/failover-error.d.ts
declare class FailoverError extends Error {
  readonly reason: FailoverReason;
  readonly provider?: string;
  readonly model?: string;
  readonly profileId?: string;
  readonly status?: number;
  readonly code?: string;
  readonly rawError?: string;
  readonly sessionId?: string;
  readonly lane?: string;
  readonly suspend?: boolean;
  constructor(message: string, params: {
    reason: FailoverReason;
    provider?: string;
    model?: string;
    profileId?: string;
    status?: number;
    code?: string;
    rawError?: string;
    sessionId?: string;
    lane?: string;
    cause?: unknown;
    suspend?: boolean;
  });
}
declare function isFailoverError(err: unknown): err is FailoverError;
declare function describeFailoverError(err: unknown): {
  message: string;
  rawError?: string;
  reason?: FailoverReason;
  status?: number;
  code?: string;
  provider?: string;
  model?: string;
  profileId?: string;
  sessionId?: string;
  lane?: string;
};
//#endregion
export { isFailoverError as n, describeFailoverError as t };