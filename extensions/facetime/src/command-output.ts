export function firstLine(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim().split(/\r?\n/u)[0] || undefined : undefined;
}
