import { resolveGlobalSingleton } from "../shared/global-singleton.js";

// Keep committed effects and failed cleanup terminal across bundled chunks and frozen errors.
const modelFallbackStops = resolveGlobalSingleton(
  Symbol.for("openclaw.modelFallbackStops"),
  () => new WeakSet<Error>(),
);

export function recordModelFallbackStop(error: Error): void {
  modelFallbackStops.add(error);
}

export function isRecordedModelFallbackStop(error: unknown): boolean {
  return error instanceof Error && modelFallbackStops.has(error);
}
