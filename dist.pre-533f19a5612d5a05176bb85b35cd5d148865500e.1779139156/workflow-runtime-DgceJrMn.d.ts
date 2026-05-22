import { i as OpenClawConfig } from "./types.openclaw-Bpxi7OSY.js";
import { s as AuthProfileStore } from "./types-G2uE8rLd.js";
import { a as fetchWithSsrFGuard } from "./fetch-guard-BrZJ1X5M.js";
//#region extensions/comfy/workflow-runtime.d.ts
declare const DEFAULT_COMFY_MODEL = "workflow";
type ComfyCapability = "image" | "music" | "video";
type ComfyOutputKind = "audio" | "gifs" | "images" | "videos";
type ComfyProviderConfig = Record<string, unknown>;
type ComfySourceImage = {
  buffer: Buffer;
  mimeType: string;
  fileName?: string;
};
type ComfyGeneratedAsset = {
  buffer: Buffer;
  mimeType: string;
  fileName: string;
  nodeId: string;
};
type ComfyWorkflowResult = {
  assets: ComfyGeneratedAsset[];
  model: string;
  promptId: string;
  outputNodeIds: string[];
};
declare function setComfyFetchGuardForTesting(impl: typeof fetchWithSsrFGuard | null): void;
declare function getComfyConfig(cfg?: OpenClawConfig): ComfyProviderConfig;
declare function isComfyCapabilityConfigured(params: {
  cfg?: OpenClawConfig;
  agentDir?: string;
  capability: ComfyCapability;
}): boolean;
declare function runComfyWorkflow(params: {
  cfg: OpenClawConfig;
  agentDir?: string;
  authStore?: AuthProfileStore;
  prompt: string;
  model?: string;
  timeoutMs?: number;
  capability: ComfyCapability;
  outputKinds: readonly ComfyOutputKind[];
  inputImage?: ComfySourceImage;
}): Promise<ComfyWorkflowResult>;
//#endregion
export { setComfyFetchGuardForTesting as a, runComfyWorkflow as i, getComfyConfig as n, isComfyCapabilityConfigured as r, DEFAULT_COMFY_MODEL as t };