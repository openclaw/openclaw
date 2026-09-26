import type { MediaUnderstandingCapability } from "./types.js";

type MediaCapabilityProvider = {
  capabilities?: readonly MediaUnderstandingCapability[];
  transcribeAudio?: unknown;
  transcribeAudioWithContext?: unknown;
  describeImage?: unknown;
  describeVideo?: unknown;
};

// Capability checks for media-understanding provider objects.

/** Image providers can use shared model dispatch; audio/video require registered methods. */
export function providerSupportsCapability(
  provider: MediaCapabilityProvider | undefined,
  capability: MediaUnderstandingCapability,
): boolean {
  if (!provider) {
    return false;
  }
  if (capability === "audio") {
    return Boolean(provider.transcribeAudioWithContext || provider.transcribeAudio);
  }
  if (capability === "image") {
    return Boolean(provider.describeImage || provider.capabilities?.includes("image"));
  }
  return Boolean(provider.describeVideo);
}
