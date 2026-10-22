import { resolveAgentDir } from "openclaw/plugin-sdk/agent-scope-runtime";
import {
  isProviderAuthProfileConfigured,
  isProviderAuthProfileConfiguredAsync,
  isProviderApiKeyConfiguredAsync,
} from "openclaw/plugin-sdk/provider-auth";
import {
  createXaiVideoGenerationProviderMetadata as createXaiVideoGenerationProviderMetadataCore,
  createXaiRealtimeVoiceProviderMetadata as createXaiRealtimeVoiceProviderMetadataCore,
} from "./capability-provider-metadata-factory.js";

export {
  DEFAULT_XAI_VIDEO_BASE_URL,
  DEFAULT_XAI_VIDEO_MODEL,
  XAI_IMAGE_DEFAULT_TIMEOUT_MS,
  XAI_SUPPORTED_IMAGE_ASPECT_RATIOS,
  XAI_VIDEO_ASPECT_RATIOS,
  XAI_VIDEO_DEFAULT_TIMEOUT_MS,
  assertXaiRealtimeVoiceRequestSupported,
  createXaiImageGenerationProviderMetadata,
  createXaiMediaUnderstandingProviderMetadata,
  isXaiVideo15Model,
} from "./capability-provider-metadata-factory.js";
export function createXaiVideoGenerationProviderMetadata() {
  return createXaiVideoGenerationProviderMetadataCore({ isProviderApiKeyConfiguredAsync });
}
export function createXaiRealtimeVoiceProviderMetadata() {
  return createXaiRealtimeVoiceProviderMetadataCore({
    isProviderAuthProfileConfigured,
    isProviderAuthProfileConfiguredAsync,
    resolveAgentDir,
  });
}
