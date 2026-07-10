// The deployment map is process config/env; cache only the latest value used on hot stream paths.
let cachedDeploymentMap: { source: string | undefined; map: Map<string, string> } | undefined;

function normalizeAzureDeploymentMapKey(modelId: string): string {
  return modelId.trim().toLowerCase();
}

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
    const modelId = normalizeAzureDeploymentMapKey(trimmed.slice(0, separator));
    const deploymentName = trimmed.slice(separator + 1).trim();
    if (!modelId || !deploymentName) {
      continue;
    }
    map.set(modelId, deploymentName);
  }
  return map;
}

function getCachedAzureDeploymentNameMap(value: string | undefined): Map<string, string> {
  const cached = cachedDeploymentMap;
  if (cached && cached.source === value) {
    return cached.map;
  }
  const map = parseAzureDeploymentNameMap(value);
  cachedDeploymentMap = { source: value, map };
  return map;
}

/** Resolves the Azure deployment name for a model id, falling back to the model id. */
export function resolveAzureDeploymentNameFromMap(params: {
  modelId: string;
  deploymentMap?: string;
}): string {
  return (
    getCachedAzureDeploymentNameMap(params.deploymentMap).get(
      normalizeAzureDeploymentMapKey(params.modelId),
    ) || params.modelId
  );
}
