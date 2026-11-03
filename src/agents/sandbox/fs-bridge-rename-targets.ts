/** Resolve both rename endpoints before checking either endpoint's write permission. */
export function createWritableRenameTargetResolver<T extends { containerPath: string }>(
  resolveTarget: (params: { filePath: string; cwd?: string }) => T,
  ensureWritable: (target: T, action: string) => void,
): (params: { from: string; to: string; cwd?: string }) => { from: T; to: T } {
  return (params) => {
    const from = resolveTarget({ filePath: params.from, cwd: params.cwd });
    const to = resolveTarget({ filePath: params.to, cwd: params.cwd });
    ensureWritable(from, "rename files");
    ensureWritable(to, "rename files");
    return { from, to };
  };
}
