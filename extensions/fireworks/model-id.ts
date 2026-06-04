// Fireworks plugin module implements model id behavior.
export function isFireworksGlmModelId(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  const lastSegment = normalized.split("/").pop() ?? normalized;
  return /^glm[-_.]/.test(lastSegment);
}

export function isFireworksKimiModelId(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  const lastSegment = normalized.split("/").pop() ?? normalized;
  return /^kimi-k2(?:p[56]|[.-][56])(?:[-_].+)?$/.test(lastSegment);
}
