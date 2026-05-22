export type GlobalInstallManager = "npm" | "pnpm" | "bun";
export type CommandRunner = (argv: string[], options: {
    timeoutMs: number;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
}) => Promise<{
    stdout: string;
    stderr: string;
    code: number | null;
}>;
type ResolvedGlobalInstallCommand = {
    manager: GlobalInstallManager;
    command: string;
};
export type ResolvedGlobalInstallTarget = ResolvedGlobalInstallCommand & {
    globalRoot: string | null;
    packageRoot: string | null;
};
export declare const OPENCLAW_MAIN_PACKAGE_SPEC = "github:openclaw/openclaw#main";
export type NpmGlobalPrefixLayout = {
    prefix: string;
    globalRoot: string;
    binDir: string;
};
export declare function isMainPackageTarget(value: string): boolean;
export declare function isExplicitPackageInstallSpec(value: string): boolean;
export declare function resolveExpectedInstalledVersionFromSpec(packageName: string, spec: string): string | null;
export declare function collectInstalledGlobalPackageErrors(params: {
    packageRoot: string;
    expectedVersion?: string | null;
}): Promise<string[]>;
export declare function canResolveRegistryVersionForPackageTarget(value: string): boolean;
export declare function resolveGlobalInstallSpec(params: {
    packageName: string;
    tag: string;
    env?: NodeJS.ProcessEnv;
}): string;
export declare function createGlobalInstallEnv(env?: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv | undefined>;
export declare function resolveNpmGlobalPrefixLayoutFromGlobalRoot(globalRoot?: string | null): NpmGlobalPrefixLayout | null;
export declare function resolveNpmGlobalPrefixLayoutFromPrefix(prefix: string): NpmGlobalPrefixLayout;
export declare function resolveGlobalInstallCommand(manager: GlobalInstallManager, pkgRoot?: string | null): ResolvedGlobalInstallCommand;
export declare function resolveGlobalRoot(managerOrCommand: GlobalInstallManager | ResolvedGlobalInstallCommand, runCommand: CommandRunner, timeoutMs: number, pkgRoot?: string | null): Promise<string | null>;
export declare function resolveGlobalPackageRoot(managerOrCommand: GlobalInstallManager | ResolvedGlobalInstallCommand, runCommand: CommandRunner, timeoutMs: number, pkgRoot?: string | null): Promise<string | null>;
export declare function resolveGlobalInstallTarget(params: {
    manager: GlobalInstallManager | ResolvedGlobalInstallCommand;
    runCommand: CommandRunner;
    timeoutMs: number;
    pkgRoot?: string | null;
}): Promise<ResolvedGlobalInstallTarget>;
export declare function detectGlobalInstallManagerForRoot(runCommand: CommandRunner, pkgRoot: string, timeoutMs: number): Promise<GlobalInstallManager | null>;
export declare function detectGlobalInstallManagerByPresence(runCommand: CommandRunner, timeoutMs: number): Promise<GlobalInstallManager | null>;
export declare function globalInstallArgs(managerOrCommand: GlobalInstallManager | ResolvedGlobalInstallCommand, spec: string, pkgRoot?: string | null, installPrefix?: string | null): string[];
export declare function globalInstallFallbackArgs(managerOrCommand: GlobalInstallManager | ResolvedGlobalInstallCommand, spec: string, pkgRoot?: string | null, installPrefix?: string | null): string[] | null;
export declare function cleanupGlobalRenameDirs(params: {
    globalRoot: string;
    packageName: string;
}): Promise<{
    removed: string[];
}>;
export {};
