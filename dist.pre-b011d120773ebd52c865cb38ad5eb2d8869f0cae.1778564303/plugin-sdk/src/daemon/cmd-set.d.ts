type CmdSetAssignment = {
    key: string;
    value: string;
};
export declare function assertNoCmdLineBreak(value: string, field: string): void;
export declare function parseCmdSetAssignment(line: string): CmdSetAssignment | null;
export declare function renderCmdSetAssignment(key: string, value: string): string;
export {};
