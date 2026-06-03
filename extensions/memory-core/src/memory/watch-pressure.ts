import type { FSWatcher } from "chokidar";

export const MEMORY_WATCH_PRESSURE_WARNING_THRESHOLD = 2_000;

export type MemoryWatchPressureUnit = "directories" | "paths";

export function countChokidarWatchedEntries(watcher: FSWatcher): number {
  const watched = watcher.getWatched();
  let count = Object.keys(watched).length;
  for (const entries of Object.values(watched)) {
    count += entries.length;
  }
  return count;
}

export class MemoryWatchPressureWarning {
  private shown = false;

  constructor(
    private readonly warn: (message: string) => void,
    private readonly threshold = MEMORY_WATCH_PRESSURE_WARNING_THRESHOLD,
  ) {}

  get hasShown(): boolean {
    return this.shown;
  }

  warnIfHigh(
    count: number,
    unit: MemoryWatchPressureUnit,
    pressureDetail: string,
    remediation: string,
  ): boolean {
    if (this.shown || count <= this.threshold) {
      return false;
    }
    this.shown = true;
    this.warn(
      `Memory file watching is tracking ${count} ${unit}. ${pressureDetail} ${remediation}`,
    );
    return true;
  }
}
