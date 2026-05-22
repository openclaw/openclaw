import { n as RuntimeEnv } from "./runtime-Bxifh4bY.js";

//#region src/infra/transport-ready.d.ts
type TransportReadyResult = {
  ok: boolean;
  error?: string | null;
};
type WaitForTransportReadyParams = {
  label: string;
  timeoutMs: number;
  logAfterMs?: number;
  logIntervalMs?: number;
  pollIntervalMs?: number;
  abortSignal?: AbortSignal;
  runtime: RuntimeEnv;
  check: () => Promise<TransportReadyResult>;
};
declare function waitForTransportReady(params: WaitForTransportReadyParams): Promise<void>;
//#endregion
export { WaitForTransportReadyParams as n, waitForTransportReady as r, TransportReadyResult as t };