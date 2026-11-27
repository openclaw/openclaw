import type { MediaUnderstandingProvider } from "openclaw/plugin-sdk/media-understanding";
import { LLAMA_CPP_PROVIDER_ID } from "./defaults.js";

/** The setup verifier and local_image tool consume this registered media entry point. */
export function createLlamaCppMediaProvider(): MediaUnderstandingProvider {
  return {
    id: LLAMA_CPP_PROVIDER_ID,
    capabilities: ["image"],
    describeImage: async (req) =>
      (await import("./media-provider.runtime.js")).describeLlamaCppImage(req),
    describeImages: async (req) =>
      (await import("./media-provider.runtime.js")).describeLlamaCppImages(req),
  };
}
