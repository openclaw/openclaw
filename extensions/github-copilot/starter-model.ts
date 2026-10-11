// Resolves a safe setup default from the authenticated Copilot model catalog.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { DEFAULT_COPILOT_MODEL } from "./model-metadata.js";
import { fetchCopilotModelCatalog, PROVIDER_ID, selectCopilotStarterModel } from "./models.js";
import { resolveCopilotRuntimeAuth } from "./runtime-auth.js";
import { buildCopilotRuntimeHeaders } from "./runtime-identity.js";

const PREFERRED_COPILOT_STARTER_MODEL_ID = DEFAULT_COPILOT_MODEL.slice(PROVIDER_ID.length + 1);

export async function resolveCopilotStarterModel(params: {
  githubToken: string;
  env?: NodeJS.ProcessEnv;
  githubDomain?: string;
  config?: OpenClawConfig;
}): Promise<string> {
  const auth = await resolveCopilotRuntimeAuth({
    githubToken: params.githubToken,
    ...(params.env ? { env: params.env } : {}),
    ...(params.githubDomain ? { githubDomain: params.githubDomain } : {}),
    ...(params.config ? { config: params.config } : {}),
  });
  const models = await fetchCopilotModelCatalog({
    copilotApiToken: auth.apiKey,
    baseUrl: auth.baseUrl,
    headers: buildCopilotRuntimeHeaders({ config: params.config }),
  });
  const selected = selectCopilotStarterModel(models, PREFERRED_COPILOT_STARTER_MODEL_ID);
  if (!selected) {
    throw new Error(
      "GitHub Copilot did not return an enabled, picker-visible chat model with streaming and tool-call support.",
    );
  }
  return `${PROVIDER_ID}/${selected.id}`;
}
