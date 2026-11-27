export function encodeTextSignatureV1(id: string, phase?: "commentary" | "final_answer"): string {
  return JSON.stringify({ v: 1, id, ...(phase ? { phase } : {}) });
}

export function parseOpenAIResponsesTextSignature(
  signature: string | undefined,
): { id?: string; phase?: "commentary" | "final_answer"; sources?: string } | undefined {
  if (!signature) {
    return undefined;
  }
  if (signature.startsWith("{")) {
    try {
      // SAFETY: Every parsed field is unknown and checked before use.
      const parsed = JSON.parse(signature) as {
        v?: unknown;
        id?: unknown;
        phase?: unknown;
        sources?: unknown;
      };
      if (parsed.v === 1) {
        const id = typeof parsed.id === "string" ? parsed.id : undefined;
        const phase =
          parsed.phase === "commentary" || parsed.phase === "final_answer"
            ? parsed.phase
            : undefined;
        // A reasoning-dropped replay keeps the phase but omits the paired id.
        if (id !== undefined || phase !== undefined) {
          return {
            id,
            phase,
            ...(typeof parsed.sources === "string" ? { sources: parsed.sources } : {}),
          };
        }
        return undefined;
      }
    } catch {
      // Keep legacy plain-string behavior below.
    }
  }
  return { id: signature };
}
