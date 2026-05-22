export declare class PromptInputClosedError extends Error {
    constructor();
}
export declare function promptYesNo(question: string, defaultYes?: boolean): Promise<boolean>;
