export type ToolPlanContractErrorCode = "duplicate-tool-name" | "missing-executor";
export declare class ToolPlanContractError extends Error {
    readonly code: ToolPlanContractErrorCode;
    readonly toolName: string;
    constructor(params: {
        code: ToolPlanContractErrorCode;
        toolName: string;
        message: string;
    });
}
