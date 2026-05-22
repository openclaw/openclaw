export declare function formatElevatedUnavailableMessage(params: {
    runtimeSandboxed: boolean;
    failures: Array<{
        gate: string;
        key: string;
    }>;
    sessionKey?: string;
}): string;
