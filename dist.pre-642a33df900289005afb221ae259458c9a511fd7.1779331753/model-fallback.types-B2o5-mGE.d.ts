import { n as FailoverReason } from "./types-DKoVBm0H.js";

//#region src/agents/model-fallback.types.d.ts
type FallbackAttempt = {
  provider: string;
  model: string;
  error: string;
  reason?: FailoverReason;
  status?: number;
  code?: string;
};
//#endregion
export { FallbackAttempt as t };