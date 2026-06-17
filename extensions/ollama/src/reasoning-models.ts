// Lightweight Ollama model-name heuristics shared by discovery and policy surfaces.
export function isReasoningModelHeuristic(modelId: string): boolean {
  return /r1|reasoning|think|reason/i.test(modelId);
}
