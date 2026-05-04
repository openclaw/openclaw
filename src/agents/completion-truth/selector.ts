import type { CompletionTruthCandidates, CompletionTruthResolution } from "./types.js";

export function selectCompletionTruth<T>(
  candidates: CompletionTruthCandidates<T>,
): CompletionTruthResolution<T> {
  if (candidates.toolResult !== undefined) {
    return {
      kind: "resolved",
      source: "toolResult",
      confidence: "high",
      result: candidates.toolResult,
      notes: ["selected explicit tool result"],
    };
  }

  if (candidates.transcriptResult !== undefined) {
    return {
      kind: "resolved",
      source: "transcriptResult",
      confidence: "high",
      result: candidates.transcriptResult,
      notes: ["selected explicit transcript completion record"],
    };
  }

  if (candidates.verificationArtifact?.packet !== undefined) {
    return {
      kind: "resolved",
      source: "verificationArtifact",
      confidence: "medium",
      result: candidates.verificationArtifact.packet,
      notes: ["selected explicit verification artifact packet"],
    };
  }

  if (candidates.realtimeHint !== undefined) {
    return {
      kind: "resolved",
      source: "realtimeHint",
      confidence: "low",
      result: candidates.realtimeHint,
      notes: ["selected realtime hint fallback"],
    };
  }

  return {
    kind: "none",
    source: "none",
    confidence: "none",
    notes: ["no completion truth candidate available"],
  };
}

export const resolveCompletionTruth = selectCompletionTruth;
