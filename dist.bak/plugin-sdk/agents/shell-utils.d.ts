export declare function resolvePowerShellPath(): string;
export declare function getShellConfig(): {
    shell: string;
    args: string[];
};
export declare function resolveShellFromPath(name: string): string | undefined;
export declare function detectRuntimeShell(): string | undefined;
export declare function sanitizeBinaryOutput(text: string): string;
export declare function killProcessTree(pid: number): void;
