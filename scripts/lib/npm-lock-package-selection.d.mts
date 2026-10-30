export function listManagedNpmLockPackageDirs(rootDir: string): string[];
export function npmLockPackageDirsForChangedPaths(
  changedPaths: readonly string[],
  rootDir: string,
): string[];
