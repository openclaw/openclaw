// Pure MiniMax VLM route predicates, deliberately in a module with NO imports.
//
// minimax-vlm.ts itself pulls in the provider HTTP transport, SSRF policy, and
// secret normalization. Callers that only need to *identify* the route must not
// drag that in -- the lazy structured-extraction chunk exists precisely to keep
// model/provider code out until extraction runs, and importing the full module
// there would defeat it. Keep this file dependency-free.

export function isMinimaxVlmProvider(provider: string): boolean {
  const normalized = provider.trim().toLowerCase();
  return (
    normalized === "minimax" ||
    normalized === "minimax-cn" ||
    normalized === "minimax-portal" ||
    normalized === "minimax-portal-cn"
  );
}

export function isMinimaxVlmModel(provider: string, modelId: string): boolean {
  return isMinimaxVlmProvider(provider) && modelId.trim() === "MiniMax-VL-01";
}
