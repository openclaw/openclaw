export declare function parseProcCmdline(raw: string): string[];
/**
 * Parse a Windows command line string into argv-style tokens,
 * handling double-quoted paths (e.g. `"C:\Program Files\node.exe" gateway run`).
 */
export declare function parseWindowsCmdline(raw: string): string[];
export declare function isGatewayArgv(args: string[], opts?: {
    allowGatewayBinary?: boolean;
}): boolean;
