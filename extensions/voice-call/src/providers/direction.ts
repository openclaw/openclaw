export type NormalizedDirection = "inbound" | "outbound";

type EndpointValue = string | null | undefined;

function normalizePhoneLike(value: EndpointValue): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  // Keep leading "+" and digits only so E.164-like comparisons are stable.
  const normalized = trimmed.replace(/[^\d+]/g, "");
  return normalized || undefined;
}

/**
 * Normalize provider-specific direction values to internal direction.
 */
export function parseProviderDirection(direction: string | null | undefined): NormalizedDirection | undefined {
  const normalized = direction?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "inbound" || normalized === "incoming") {
    return "inbound";
  }
  if (
    normalized === "outbound" ||
    normalized === "outgoing" ||
    normalized === "outbound-api" ||
    normalized === "outbound-dial"
  ) {
    return "outbound";
  }
  return undefined;
}

/**
 * Infer direction when providers omit a dedicated direction field.
 */
export function inferDirectionFromEndpoints(params: {
  from: EndpointValue;
  to: EndpointValue;
  fromNumber: EndpointValue;
}): NormalizedDirection | undefined {
  const from = normalizePhoneLike(params.from);
  const to = normalizePhoneLike(params.to);
  const configuredFrom = normalizePhoneLike(params.fromNumber);
  if (!configuredFrom) {
    return undefined;
  }
  if (to === configuredFrom) {
    return "inbound";
  }
  if (from === configuredFrom) {
    return "outbound";
  }
  return undefined;
}
