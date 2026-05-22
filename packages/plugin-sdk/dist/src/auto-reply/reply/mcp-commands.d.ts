export type McpCommand = {
    action: "show";
    name?: string;
} | {
    action: "set";
    name: string;
    value: unknown;
} | {
    action: "unset";
    name: string;
} | {
    action: "error";
    message: string;
};
export declare function parseMcpCommand(raw: string): McpCommand | null;
