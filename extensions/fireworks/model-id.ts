// Fireworks plugin module implements model id behavior.
function lastModelIdSegment(modelId: string): string {
  const normalized = modelId.trim().toLowerCase();
  return normalized.split("/").pop() ?? normalized;
}

export function isFireworksKimiModelId(modelId: string): boolean {
  return /^kimi-k2(?:p[56]|[.-][56])(?:[-_].+)?$/.test(lastModelIdSegment(modelId));
}

export function isFireworksDeepSeekV4ModelId(modelId: string): boolean {
  const lastSegment = lastModelIdSegment(modelId);
  return /^deepseek[-_.]?v4(?:[-_.]|$)/.test(lastSegment);
}

export function isFireworksMinimaxM2ModelId(modelId: string): boolean {
  const lastSegment = lastModelIdSegment(modelId);
  // Fireworks encodes the minor version with `p` (e.g. `minimax-m2p7`). The
  // no-off effort surface is verified for m2p7+; older/bare m2 ids keep the
  // generic thinking menu.
  return /^minimax[-_.]?m2p(?:[7-9]|\d{2,})(?:[-_.]|$)/.test(lastSegment);
}

export function isFireworksGlmModelId(modelId: string): boolean {
  return /^glm[-_.]/.test(lastModelIdSegment(modelId));
}

export function isFireworksGlmReasoningModelId(modelId: string): boolean {
  const lastSegment = lastModelIdSegment(modelId);
  // `glm-5p1` style ids use `p` as the minor-version separator on Fireworks.
  // GLM-5+ only: the binary off/on profile is verified for the 5.x family;
  // older dynamic GLM ids keep the generic thinking menu. Same `glm` +
  // separator rule as isFireworksGlmModelId so the family matchers agree.
  return /^glm[-_.](?:[5-9]|\d{2,})(?:[-_.p]|$)/.test(lastSegment);
}

export function isFireworksGptOss120bModelId(modelId: string): boolean {
  return lastModelIdSegment(modelId) === "gpt-oss-120b";
}
