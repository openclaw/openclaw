export type DebugCommand = {
    action: "show";
} | {
    action: "reset";
} | {
    action: "set";
    path: string;
    value: unknown;
} | {
    action: "unset";
    path: string;
} | {
    action: "error";
    message: string;
};
export declare function parseDebugCommand(raw: string): DebugCommand | null;
