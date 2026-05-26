export type ProcessWarning = {
    code?: string;
    name?: string;
    message?: string;
};
export declare function shouldIgnoreWarning(warning: ProcessWarning): boolean;
export declare function installProcessWarningFilter(): void;
