export type CliArgvInvocation = {
    argv: string[];
    commandPath: string[];
    primary: string | null;
    hasHelpOrVersion: boolean;
    isRootHelpInvocation: boolean;
};
export declare function resolveCliArgvInvocation(argv: string[]): CliArgvInvocation;
