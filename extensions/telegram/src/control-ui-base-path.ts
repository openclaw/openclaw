export function normalizeControlUiBasePath(trimmed: string, trailing: "one" | "all"): string {
  if (!trimmed || trimmed === "/") {
    return "";
  }
  const withLeading = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return trailing === "all" ? withLeading.replace(/\/+$/, "") : withLeading.replace(/\/$/, "");
}
