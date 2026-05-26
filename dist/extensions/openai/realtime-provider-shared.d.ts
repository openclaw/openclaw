import { c as normalizeOptionalString } from "../../string-coerce-CXN6d3lE.js";

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
type OpenAIRealtimeClientSecretResult = {
  value: string;
  expiresAt?: number;
};
declare function createOpenAIRealtimeClientSecret(params: {
  authToken: string;
  auditContext: string;
  session: Record<string, unknown>;
}): Promise<OpenAIRealtimeClientSecretResult>;
declare function createOpenAIRealtimeTranscriptionClientSecret(params: {
  authToken: string;
  auditContext: string;
  session: Record<string, unknown>;
}): Promise<OpenAIRealtimeClientSecretResult>;
//#endregion
export { OpenAIRealtimeClientSecretResult, asFiniteNumber, asObjectRecord, captureOpenAIRealtimeWsClose, createOpenAIRealtimeClientSecret, createOpenAIRealtimeTranscriptionClientSecret, readRealtimeErrorDetail, resolveOpenAIProviderConfigRecord, trimToUndefined };