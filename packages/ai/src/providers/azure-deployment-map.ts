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

type CachedDeploymentNameMap = {
  source: string;
  deploymentsByLowerModelId: Map<string, string>;
};

let cachedDeploymentNameMap: CachedDeploymentNameMap | undefined;

function getAzureDeploymentNameMap(value: string | undefined): Map<string, string> | undefined {
  if (!value) {
    return undefined;
  }

  if (cachedDeploymentNameMap?.source === value) {
    return cachedDeploymentNameMap.deploymentsByLowerModelId;
  }

  const deploymentsByLowerModelId = new Map<string, string>();
  for (const [modelId, deploymentName] of parseAzureDeploymentNameMap(value)) {
    deploymentsByLowerModelId.set(modelId.toLowerCase(), deploymentName);
  }
  cachedDeploymentNameMap = { source: value, deploymentsByLowerModelId };
  return deploymentsByLowerModelId;
}

/** Resolves the Azure deployment name for a model id, falling back to the model id. */
export function resolveAzureDeploymentNameFromMap(params: {
  modelId: string;
  deploymentMap?: string;
}): string {
  return (
    getAzureDeploymentNameMap(params.deploymentMap)?.get(params.modelId.toLowerCase()) ||
    params.modelId
  );
}
