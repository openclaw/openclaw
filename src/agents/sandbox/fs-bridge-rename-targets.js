export function resolveWritableRenameTargets(params) {
    const action = params.action ?? "rename files";
    const from = params.resolveTarget({ filePath: params.from, cwd: params.cwd });
    const to = params.resolveTarget({ filePath: params.to, cwd: params.cwd });
    params.ensureWritable(from, action);
    params.ensureWritable(to, action);
    return { from, to };
}
export function resolveWritableRenameTargetsForBridge(params, resolveTarget, ensureWritable) {
    return resolveWritableRenameTargets({
        ...params,
        resolveTarget,
        ensureWritable,
    });
}
export function createWritableRenameTargetResolver(resolveTarget, ensureWritable) {
    return (params) => resolveWritableRenameTargetsForBridge(params, resolveTarget, ensureWritable);
}
