import type { ImageGenerationRequest } from "openclaw/plugin-sdk/image-generation";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";

export async function resolveGoogleGenerationApiKey(
  req: Pick<ImageGenerationRequest, "cfg" | "agentDir" | "authStore">,
): Promise<string> {
  const { apiKey } = await resolveApiKeyForProvider({
    provider: "google",
    cfg: req.cfg,
    agentDir: req.agentDir,
    store: req.authStore,
  });
  if (!apiKey) {
    throw new Error("Google API key missing");
  }
  return apiKey;
}
