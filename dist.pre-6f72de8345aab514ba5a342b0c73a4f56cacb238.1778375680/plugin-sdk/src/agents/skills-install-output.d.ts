type InstallCommandResult = {
    code: number | null;
    stdout: string;
    stderr: string;
};
export declare function formatInstallFailureMessage(result: InstallCommandResult): string;
export {};
