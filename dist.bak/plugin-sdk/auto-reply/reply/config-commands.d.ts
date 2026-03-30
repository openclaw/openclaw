export type ConfigCommand = {
    action: "show";
    path?: string;
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
export declare function parseConfigCommand(raw: string): ConfigCommand | null;
