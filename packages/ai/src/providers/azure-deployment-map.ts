/** Parses AZURE_OPENAI_DEPLOYMENT_MAP-style model=deployment entries. */
export function parseAzureDeploymentNameMap(value: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!value) {
    return map;
  }
  for (const entry of value.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const modelId = trimmed.slice(0, separator).trim();
    const deploymentName = trimmed.slice(separator + 1).trim();
    if (!modelId || !deploymentName) {
      continue;
    }
    map.set(modelId, deploymentName);
  }
  return map;
}

// Azure deployment maps come from a stable env var, so the resolver runs on hot paths
// (streams, lifecycle hooks) with the same string every call. Cache the parsed lookups
// per raw string to avoid re-parsing, with a small bound so memory stays flat even if a
// caller ever varies the input.
const MAX_CACHED_DEPLOYMENT_MAPS = 32;

interface DeploymentNameLookup {
  /** Exact-case keys, preserving the original deployment-map semantics. */
  exact: Map<string, string>;
  /** Lowercased keys, used only as a case-insensitive fallback. */
  lower: Map<string, string>;
}

const deploymentLookupCache = new Map<string, DeploymentNameLookup>();

/** Returns a cached exact + lowercased lookup pair for a deployment-map string. */
function getCachedDeploymentLookup(deploymentMap: string | undefined): DeploymentNameLookup {
  const cacheKey = deploymentMap ?? "";
  const cached = deploymentLookupCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const exact = parseAzureDeploymentNameMap(deploymentMap);
  // Lowercased index for the case-insensitive fallback; deployment names (the values)
  // stay verbatim because Azure requires the exact deployment name.
  const lower = new Map<string, string>();
  for (const [modelId, deploymentName] of exact) {
    lower.set(modelId.toLowerCase(), deploymentName);
  }
  if (deploymentLookupCache.size >= MAX_CACHED_DEPLOYMENT_MAPS) {
    const oldest = deploymentLookupCache.keys().next().value;
    if (oldest !== undefined) {
      deploymentLookupCache.delete(oldest);
    }
  }
  const lookup: DeploymentNameLookup = { exact, lower };
  deploymentLookupCache.set(cacheKey, lookup);
  return lookup;
}

/**
 * Resolves the Azure deployment name for a model id, falling back to the model id.
 *
 * An exact-case match always wins, so configs that intentionally distinguish keys by
 * case keep their exact mappings; a case-insensitive match is only used as a fallback
 * (e.g. `GPT-4o` against a `gpt-4o=...` map) to avoid 404s from casing differences.
 */
export function resolveAzureDeploymentNameFromMap(params: {
  modelId: string;
  deploymentMap?: string;
}): string {
  const { exact, lower } = getCachedDeploymentLookup(params.deploymentMap);
  return exact.get(params.modelId) ?? lower.get(params.modelId.toLowerCase()) ?? params.modelId;
}

export const testing = {
  getCachedDeploymentLookup,
  resetDeploymentNameMapCache: (): void => {
    deploymentLookupCache.clear();
  },
};
