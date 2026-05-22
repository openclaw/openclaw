import { c as normalizeOptionalString } from "../../string-coerce-Dtx8bWZr.js";
//#region extensions/openai/realtime-provider-shared.d.ts
declare const trimToUndefined: typeof normalizeOptionalString;
declare function asFiniteNumber(value: unknown): number | undefined;
declare function asObjectRecord(value: unknown): Record<string, unknown> | undefined;
declare function readRealtimeErrorDetail(error: unknown): string;
declare function resolveOpenAIProviderConfigRecord(config: Record<string, unknown>): Record<string, unknown> | undefined;
declare function captureOpenAIRealtimeWsClose(params: {
  url: string;
  flowId: string;
  capability: "realtime-transcription" | "realtime-voice";
  code: unknown;
  reasonBuffer: unknown;
}): void;
//#endregion
export { asFiniteNumber, asObjectRecord, captureOpenAIRealtimeWsClose, readRealtimeErrorDetail, resolveOpenAIProviderConfigRecord, trimToUndefined };