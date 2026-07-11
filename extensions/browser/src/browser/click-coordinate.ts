const DECIMAL_COORDINATE_PATTERN = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;

export function parseBrowserClickCoordinate(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  if (!DECIMAL_COORDINATE_PATTERN.test(normalized)) {
    return undefined;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}
