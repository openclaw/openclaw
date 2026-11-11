export function installedTerminalDescendants(
  rows: Record<string, unknown>[],
  root: number,
): Set<number>;

export function readInstalledTerminalEvents(
  directory: string,
  spec?: {
    processAbsence?: InstalledTerminalProcessAbsence[];
  },
): Record<string, unknown>[];

export type InstalledTerminalProcessAbsence = {
  pid: number;
  thread: number;
  spawnId: number;
  child: number;
  sourceKind: "linux-pid-absence";
  observerPid: number;
  time: string;
  errorCode: string | null;
  ownExitCode: null;
};

export function captureInstalledTerminalProcessAbsence(
  directory: string,
): InstalledTerminalProcessAbsence[];

export function publishInstalledTerminalEvidence(
  directory: string,
  summary: {
    status: string;
    commands: { name: string }[];
    cells: { name: string }[];
  },
): void;
