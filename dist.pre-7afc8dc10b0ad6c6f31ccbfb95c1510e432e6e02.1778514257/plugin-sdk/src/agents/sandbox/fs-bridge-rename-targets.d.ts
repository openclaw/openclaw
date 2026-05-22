export declare function resolveWritableRenameTargets<T extends {
    containerPath: string;
}>(params: {
    from: string;
    to: string;
    cwd?: string;
    action?: string;
    resolveTarget: (params: {
        filePath: string;
        cwd?: string;
    }) => T;
    ensureWritable: (target: T, action: string) => void;
}): {
    from: T;
    to: T;
};
export declare function resolveWritableRenameTargetsForBridge<T extends {
    containerPath: string;
}>(params: {
    from: string;
    to: string;
    cwd?: string;
    action?: string;
}, resolveTarget: (params: {
    filePath: string;
    cwd?: string;
}) => T, ensureWritable: (target: T, action: string) => void): {
    from: T;
    to: T;
};
export declare function createWritableRenameTargetResolver<T extends {
    containerPath: string;
}>(resolveTarget: (params: {
    filePath: string;
    cwd?: string;
}) => T, ensureWritable: (target: T, action: string) => void): (params: {
    from: string;
    to: string;
    cwd?: string;
}) => {
    from: T;
    to: T;
};
