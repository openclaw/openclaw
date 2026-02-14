export type ConfigBuilderMode = "landing" | "explorer" | "wizard";

export function parseModeFromHash(hash: string): ConfigBuilderMode {
  const normalized = hash.trim().toLowerCase();
  if (!normalized) {
    return "landing";
  }

  if (normalized === "#/wizard" || normalized === "#wizard") {
    return "wizard";
  }
  if (normalized === "#/explorer" || normalized === "#explorer") {
    return "explorer";
  }
  if (normalized === "#/" || normalized === "#") {
    return "landing";
  }
  return "landing";
}

export function modeToHash(mode: ConfigBuilderMode): string {
  if (mode === "wizard") {
    return "#/wizard";
  }
  if (mode === "explorer") {
    return "#/explorer";
  }
  return "#/";
}
