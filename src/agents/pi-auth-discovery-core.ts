import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  listProviderEnvAuthLookupKeys,
  resolveProviderEnvApiKeyCandidates,
  resolveProviderEnvAuthEvidence,
} from "./model-auth-env-vars.js";
import { resolveEnvApiKey } from "./model-auth-env.js";
import type { PiCredentialMap } from "./pi-auth-credentials.js";

export type PiDiscoveryAuthLookupOptions = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
};

export function addEnvBackedPiCredentials(
  credentials: PiCredentialMap,
  options: PiDiscoveryAuthLookupOptions = {},
): PiCredentialMap {
  const env = options.env ?? process.env;
  const lookupParams = {
    config: options.config,
    workspaceDir: options.workspaceDir,
    env,
  };
  const candidateMap = resolveProviderEnvApiKeyCandidates(lookupParams);
  const authEvidenceMap = resolveProviderEnvAuthEvidence(lookupParams);
  const next = { ...credentials };
  // pi-coding-agent hides providers from its registry when auth storage lacks
  // a matching credential entry. Mirror env-backed provider auth here so
  // live/model discovery sees the same providers runtime auth can use.
  for (const provider of listProviderEnvAuthLookupKeys({
    envCandidateMap: candidateMap,
    authEvidenceMap,
  })) {
    if (next[provider]) {
      continue;
    }
    const resolved = resolveEnvApiKey(provider, env, {
      config: options.config,
      workspaceDir: options.workspaceDir,
      candidateMap,
      authEvidenceMap,
    });
    if (!resolved?.apiKey) {
      continue;
    }
    next[provider] = {
      type: "api_key",
      key: resolved.apiKey,
    };
  }
  return next;
}
