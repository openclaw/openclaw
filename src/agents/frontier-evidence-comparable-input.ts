export type FrontierEvidenceVolatileBindings = {
  workspacePath: string;
  sessionId: string;
  currentTurnTimestampEnvelope: string;
};

const PLACEHOLDERS: Record<keyof FrontierEvidenceVolatileBindings, string> = {
  workspacePath: "<FRONTIER_EVIDENCE_WORKSPACE>",
  sessionId: "<FRONTIER_EVIDENCE_SESSION>",
  currentTurnTimestampEnvelope: "<FRONTIER_EVIDENCE_CURRENT_TURN_TIMESTAMP> ",
};

export class FrontierEvidenceComparableInputBindingError extends Error {
  constructor() {
    super("frontier evidence comparable input binding mismatch");
    this.name = "FrontierEvidenceComparableInputBindingError";
  }
}

export function substituteFrontierEvidenceComparableInput(
  value: unknown,
  bindings: FrontierEvidenceVolatileBindings,
): unknown {
  const entries = (
    Object.entries(bindings) as Array<[keyof FrontierEvidenceVolatileBindings, string]>
  ).toSorted((left, right) => right[1].length - left[1].length);
  const matches = new Map<keyof FrontierEvidenceVolatileBindings, number>(
    entries.map(([key]) => [key, 0]),
  );
  const substitute = (entry: unknown): unknown => {
    if (Array.isArray(entry)) {
      return entry.map(substitute);
    }
    if (entry && typeof entry === "object") {
      return Object.fromEntries(
        Object.entries(entry as Record<string, unknown>).map(([key, child]) => [
          key,
          substitute(child),
        ]),
      );
    }
    if (typeof entry !== "string") {
      return entry;
    }
    if (Object.values(PLACEHOLDERS).some((placeholder) => entry.includes(placeholder))) {
      throw new FrontierEvidenceComparableInputBindingError();
    }
    let substituted = entry;
    for (const [key, binding] of entries) {
      const count = substituted.split(binding).length - 1;
      if (count > 0) {
        matches.set(key, (matches.get(key) ?? 0) + count);
        substituted = substituted.replaceAll(binding, PLACEHOLDERS[key]);
      }
    }
    return substituted;
  };
  const result = substitute(value);
  if (entries.some(([key]) => (matches.get(key) ?? 0) === 0)) {
    throw new FrontierEvidenceComparableInputBindingError();
  }
  return result;
}
