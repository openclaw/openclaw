export function isHttpsUrl(value: unknown): boolean {
  return typeof value === "string" && URL.parse(value)?.protocol === "https:";
}
