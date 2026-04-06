export function trimToUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asObjectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function readRealtimeErrorDetail(error: unknown): string {
  if (typeof error === "string" && error) {
    return error;
  }
  const message = asObjectRecord(error)?.message;
  if (typeof message === "string" && message) {
    return message;
  }
  return "Unknown error";
}

export function resolveOpenAIProviderConfigRecord(
  config: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const providers = asObjectRecord(config.providers);
  return (
    asObjectRecord(providers?.openai) ?? asObjectRecord(config.openai) ?? asObjectRecord(config)
  );
}
