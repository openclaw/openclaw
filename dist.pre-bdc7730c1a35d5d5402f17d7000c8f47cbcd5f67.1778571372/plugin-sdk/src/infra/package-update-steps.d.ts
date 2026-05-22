import { type CommandRunner, type ResolvedGlobalInstallTarget } from "./update-global.js";
export type PackageUpdateStepResult = {
    name: string;
    command: string;
    cwd: string;
    durationMs: number;
    exitCode: number | null;
    stdoutTail?: string | null;
    stderrTail?: string | null;
};
type PackageUpdateStepRunner = (params: {
    name: string;
    argv: string[];
    cwd?: string;
    timeoutMs: number;
    env?: NodeJS.ProcessEnv;
}) => Promise<PackageUpdateStepResult>;
export declare function runGlobalPackageUpdateSteps(params: {
    installTarget: ResolvedGlobalInstallTarget;
    installSpec: string;
    packageName: string;
    packageRoot?: string | null;
    runCommand: CommandRunner;
    runStep: PackageUpdateStepRunner;
    timeoutMs: number;
    env?: NodeJS.ProcessEnv;
    installCwd?: string;
    postVerifyStep?: (packageRoot: string) => Promise<PackageUpdateStepResult | null>;
}): Promise<{
    steps: PackageUpdateStepResult[];
    verifiedPackageRoot: string | null;
    afterVersion: string | null;
    failedStep: PackageUpdateStepResult | null;
}>;
export {};
