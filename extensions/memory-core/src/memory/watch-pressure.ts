const MEMORY_WATCH_PRESSURE_WARNING_THRESHOLD = 2_000;

export type MemoryWatchPressureUnit = "registered directories" | "observed directories";

export type MemoryWatchPressureWarningState = {
  shown: boolean;
};

export function warnIfMemoryWatchPressureHigh(
  state: MemoryWatchPressureWarningState,
  count: number,
  unit: MemoryWatchPressureUnit,
  pressureDetail: string,
  remediation: string,
  warn: (message: string) => void,
): boolean {
  if (state.shown || count <= MEMORY_WATCH_PRESSURE_WARNING_THRESHOLD) {
    return false;
  }
  state.shown = true;
  warn(`Memory file watching is tracking ${count} ${unit}. ${pressureDetail} ${remediation}`);
  return true;
}
