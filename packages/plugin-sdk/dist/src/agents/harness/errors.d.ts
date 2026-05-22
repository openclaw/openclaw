export declare class MissingAgentHarnessError extends Error {
    readonly harnessId: string;
    constructor(harnessId: string);
}
export declare function isMissingAgentHarnessError(err: unknown): err is MissingAgentHarnessError;
