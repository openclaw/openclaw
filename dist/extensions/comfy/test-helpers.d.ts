import { i as OpenClawConfig } from "../../types.openclaw-BLF4DJTX.js";
import { o as resolveApiKeyForProvider } from "../../provider-auth-runtime-ByT9yRat.js";
import { vi } from "vitest";

//#region extensions/comfy/test-helpers.d.ts
type FetchGuardMock = ReturnType<typeof vi.fn>;
type ComfyCloudJobResponseOptions = {
  body: BodyInit;
  contentType: string;
  filename: string;
  outputKind: "gifs" | "images";
  promptId: string;
  redirectLocation: string;
};
declare function buildComfyConfig(config: Record<string, unknown>): OpenClawConfig;
declare function buildLegacyComfyConfig(config: Record<string, unknown>): OpenClawConfig;
declare function parseComfyJsonBody(fetchWithSsrFGuardMock: FetchGuardMock, call: number): Record<string, unknown>;
declare function mockComfyProviderApiKey(apiKey?: string): import("vitest").Mock<typeof resolveApiKeyForProvider>;
declare function mockComfyCloudJobResponses(fetchWithSsrFGuardMock: FetchGuardMock, options: ComfyCloudJobResponseOptions): void;
//#endregion
export { buildComfyConfig, buildLegacyComfyConfig, mockComfyCloudJobResponses, mockComfyProviderApiKey, parseComfyJsonBody };