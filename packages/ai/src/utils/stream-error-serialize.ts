/** Serialize a stream error safely — guards against circular non-Error values. */
export function serializeStreamError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "symbol" || typeof error === "bigint") return String(error);
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
