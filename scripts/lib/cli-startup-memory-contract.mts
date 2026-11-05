// Saved CLI reports must not compare last-exiting-process RSS with attributed runtime RSS.
export const CLI_RUNTIME_MEMORY_METRIC = "cli-runtime-max-rss-v1";

export type CliStartupExecutionMode = "native" | "transport";

export function cliStartupExecutionMode(suite: unknown): CliStartupExecutionMode {
  const mode =
    typeof suite === "object" && suite !== null && "executionMode" in suite
      ? suite.executionMode
      : undefined;
  // Reports predating transport measured native execution only.
  if (mode === undefined) {
    return "native";
  }
  if (mode !== "native" && mode !== "transport") {
    throw new Error(`Unknown CLI execution mode: ${JSON.stringify(mode)}`);
  }
  return mode;
}

export function assertCompatibleCliStartupExecutionModes(
  baseline: unknown,
  candidate: unknown,
): void {
  const before = cliStartupExecutionMode(baseline);
  const after = cliStartupExecutionMode(candidate);
  if (before !== after) {
    throw new Error(
      `Incompatible CLI execution modes: ${before} vs ${after}. Collect both reports with the same execution mode; transport startup is part of the measurement.`,
    );
  }
}

export function cliStartupMemoryMetric(suite: unknown): string {
  const metric =
    typeof suite === "object" && suite !== null && "memoryMetric" in suite
      ? suite.memoryMetric
      : undefined;
  if (metric === undefined) {
    return "legacy-last-marker";
  }
  if (metric !== CLI_RUNTIME_MEMORY_METRIC) {
    throw new Error(`Unknown CLI RSS metric: ${JSON.stringify(metric)}`);
  }
  return metric;
}

export function assertCompatibleCliStartupMemoryMetrics(
  baseline: unknown,
  candidate: unknown,
): void {
  const before = cliStartupMemoryMetric(baseline);
  const after = cliStartupMemoryMetric(candidate);
  if (before !== after) {
    throw new Error(
      `Incompatible CLI RSS metrics: ${before} vs ${after}. Collect both reports with the same benchmark metric; historical RSS cannot be relabeled.`,
    );
  }
}
