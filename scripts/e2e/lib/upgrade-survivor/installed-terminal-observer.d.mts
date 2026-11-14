export function installedTerminalDescendants(
  rows: Record<string, unknown>[],
  root: number,
): Set<number>;

export function readInstalledTerminalHasher(
  root: string,
  identity: {
    files: Record<string, { sha256?: string }>;
  },
  capture?: (contract: { path: string; sha256: string; source: string }) => void,
): { path: string; sha256: string; source: string };

export function readInstalledTerminalEvents(
  directory: string,
  spec?: {
    root?: string;
    historical?: boolean;
    compileCacheBase?: string;
    stateDatabase?: string;
    agentDatabase?: string;
    journal?: string;
    processAbsence?: InstalledTerminalProcessAbsence[];
    hashWorker?: { path: string; sha256: string };
    heartbeatWorkers?: {
      relativePath: string;
      sha256: string;
      sourceCommit: string;
      inventorySha256: string;
      dependencies: { identity: string; entries: number; sha256: string };
      dependencyReferenceSha256: string;
      closedEntries?: Omit<InstalledTerminalClosedEntry, "source">[];
    }[];
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

export function readInstalledTerminalHeartbeat(
  root: string,
  identity: {
    buildInfo: { commit: string };
    files: Record<string, { sha256?: string }>;
  },
): {
  relativePath: string;
  sha256: string;
  source: string;
  sourceCommit: string;
  inventorySha256: string;
};

export type InstalledTerminalClosedEntry = {
  role: string;
  relativePath: string;
  sha256: string;
  source: string;
  contractRevision: string;
};
export function readInstalledTerminalClosedEntries(
  root: string,
  identity: { buildInfo: { commit: string }; files: Record<string, { sha256?: string }> },
  historical?: boolean,
): InstalledTerminalClosedEntry[];

export function publishInstalledTerminalEvidence(
  directory: string,
  summary: {
    status: string;
    commands: { name: string }[];
    cells: { name: string }[];
  },
): void;
