import { i as OpenClawConfig } from "./types.openclaw-DIZy8jcb.js";
import { s as AuthProfileStore } from "./types-Biu67nNB.js";
import { a as fetchWithSsrFGuard } from "./fetch-guard-Bx-8dg5s.js";
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
declare function _setComfyFetchGuardForTesting(impl: typeof fetchWithSsrFGuard | null): void;
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
export { runComfyWorkflow as a, isComfyCapabilityConfigured as i, _setComfyFetchGuardForTesting as n, getComfyConfig as r, DEFAULT_COMFY_MODEL as t };