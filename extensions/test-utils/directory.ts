export function createDirectoryTestRuntime() {
  return {
    log: () => {},
    error: () => {},
    exit: (code: number): never => {
      throw new Error(`exit ${code}`);
    },
  };
}

export function expectDirectorySurface(
  directory:
    | {
        listPeers?: unknown;
        listGroups?: unknown;
      }
    | null
    | undefined,
) {
  if (!directory) {
    throw new Error("expected directory");
  }
  if (!directory.listPeers) {
    throw new Error("expected listPeers");
  }
  if (!directory.listGroups) {
    throw new Error("expected listGroups");
  }
  return directory as {
    listPeers: NonNullable<typeof directory.listPeers>;
    listGroups: NonNullable<typeof directory.listGroups>;
  };
}
