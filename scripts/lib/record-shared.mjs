export function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function trimString(value) {
  return typeof value === "string" ? value.trim() : "";
}
