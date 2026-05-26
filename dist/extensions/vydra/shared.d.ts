import { i as OpenClawConfig } from "../../types.openclaw-BLF4DJTX.js";
import { c as normalizeOptionalString } from "../../string-coerce-CXN6d3lE.js";
import { h as resolveProviderHttpRequestConfig } from "../../provider-http-ByynA2MJ.js";
import { o as resolveApiKeyForProvider } from "../../provider-auth-runtime-ByT9yRat.js";

//#region extensions/vydra/shared.d.ts
declare const DEFAULT_VYDRA_BASE_URL = "https://www.vydra.ai/api/v1";
declare const DEFAULT_VYDRA_IMAGE_MODEL = "grok-imagine";
declare const DEFAULT_VYDRA_VIDEO_MODEL = "veo3";
declare const DEFAULT_VYDRA_SPEECH_MODEL = "elevenlabs/tts";
declare const DEFAULT_VYDRA_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";
type VydraAuthStore = Parameters<typeof resolveApiKeyForProvider>[0]["store"];
type VydraMediaKind = "audio" | "image" | "video";
declare const trimToUndefined: typeof normalizeOptionalString;
declare function normalizeVydraBaseUrl(value: string | undefined): string;
declare function resolveVydraRequestContext(params: {
  cfg: OpenClawConfig;
  agentDir?: string;
  authStore?: VydraAuthStore;
  capability: "image" | "video";
}): Promise<{
  fetchFn: typeof fetch;
  baseUrl: string;
  allowPrivateNetwork: boolean;
  headers: Headers;
  dispatcherPolicy: ReturnType<typeof resolveProviderHttpRequestConfig>["dispatcherPolicy"];
}>;
declare function resolveVydraResponseJobId(payload: unknown): string | undefined;
declare function resolveVydraResponseStatus(payload: unknown): string | undefined;
declare function extractVydraResultUrls(payload: unknown, kind: VydraMediaKind): string[];
declare function downloadVydraAsset(params: {
  url: string;
  kind: VydraMediaKind;
  timeoutMs?: number;
  fetchFn: typeof fetch;
}): Promise<{
  buffer: Buffer;
  mimeType: string;
  fileName: string;
}>;
declare function resolveCompletedVydraPayload(params: {
  submitted: unknown;
  baseUrl: string;
  headers: Headers;
  timeoutMs?: number;
  fetchFn: typeof fetch;
  kind: VydraMediaKind;
  missingJobIdMessage: string;
}): Promise<unknown>;
//#endregion
export { DEFAULT_VYDRA_BASE_URL, DEFAULT_VYDRA_IMAGE_MODEL, DEFAULT_VYDRA_SPEECH_MODEL, DEFAULT_VYDRA_VIDEO_MODEL, DEFAULT_VYDRA_VOICE_ID, downloadVydraAsset, extractVydraResultUrls, normalizeVydraBaseUrl, resolveCompletedVydraPayload, resolveVydraRequestContext, resolveVydraResponseJobId, resolveVydraResponseStatus, trimToUndefined };